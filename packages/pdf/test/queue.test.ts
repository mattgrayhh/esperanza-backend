import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './_d1adapter';
import { processJob, enqueueStaleLists } from '../src/queue';

const DB = join(__dirname, '../../db');
function mkDb() {
  const d = new Database(':memory:');
  readdirSync(join(DB,'migrations')).filter(f=>f.endsWith('.sql')).sort().forEach(f=>d.exec(readFileSync(join(DB,'migrations',f),'utf8')));
  d.exec(readFileSync(join(DB,'views.sql'),'utf8'));
  d.exec(`INSERT INTO cities (id,slug,city_name) VALUES ('ci1','mcallen','McAllen')`);
  d.exec(`INSERT INTO pdf_renders (type,slug,entity_id,city_slug,r2_key,status) VALUES ('list','mcallen-locations','list:mcallen:locations','mcallen','pdf/list/list:mcallen:locations.pdf','not_built')`);
  return d1FromSqlite(d);
}
const objects = new Map<string, Uint8Array>();
const deps = {
  render: vi.fn(async () => new Uint8Array([0x25,0x50,0x44,0x46,0x2d])),
  putObject: async (k: string, b: Uint8Array) => { objects.set(k, b); },
  activeVersion: 1,
};
describe('processJob', () => {
  it('renders a queued list job under the lease and marks live', async () => {
    objects.clear(); deps.render.mockClear();
    const db = mkDb();
    const r = await processJob({ DB: db } as any, { type: 'list', slug: 'mcallen-locations', reason: 'test' }, deps as any);
    expect(r).toBe('rendered');
    expect(deps.render).toHaveBeenCalledTimes(1);
    const row = await db.prepare(`SELECT status FROM pdf_renders WHERE slug='mcallen-locations'`).first();
    expect(row.status).toBe('live');
  });
  it('skips when the row is missing entity_id', async () => {
    const db = mkDb();
    await db.prepare(`UPDATE pdf_renders SET entity_id=NULL WHERE slug='mcallen-locations'`).run();
    const r = await processJob({ DB: db } as any, { type: 'list', slug: 'mcallen-locations', reason: 't' }, deps as any);
    expect(r).toBe('skipped');
  });
});

describe('enqueueStaleLists', () => {
  it('sends a job per non-live list row', async () => {
    const sent: any[] = [];
    const env = { DB: mkDb(), RENDER_Q: { send: async (m: any) => { sent.push(m); } } };
    const n = await enqueueStaleLists(env as any);
    expect(n).toBe(1);
    expect(sent[0]).toMatchObject({ type: 'list', slug: 'mcallen-locations', reason: 'nightly' });
  });
});
