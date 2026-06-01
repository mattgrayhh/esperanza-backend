import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './_d1adapter';
import { serve } from '../src/serve';

const DB = join(__dirname, '../../db');
function mkDb(status: string, themeVer: number | null) {
  const d = new Database(':memory:');
  readdirSync(join(DB,'migrations')).filter(f=>f.endsWith('.sql')).sort().forEach(f=>d.exec(readFileSync(join(DB,'migrations',f),'utf8')));
  d.exec(readFileSync(join(DB,'views.sql'),'utf8'));
  d.exec(`INSERT INTO communities (id,name,slug,published) VALUES ('recC','Anaqua','anaqua',1)`);
  d.exec(`INSERT INTO pdf_renders (type,slug,entity_id,r2_key,status,theme_version) VALUES ('community','anaqua','recC','pdf/community/recC.pdf','${status}',${themeVer ?? 'NULL'})`);
  return d1FromSqlite(d);
}

const objects = new Map<string, Uint8Array>();
const deps = {
  render: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
  putObject: async (k: string, b: Uint8Array) => { objects.set(k, b); },
  getObject: async (k: string) => objects.has(k) ? { body: objects.get(k)!, httpMetadata: { contentType: 'application/pdf' } } : null,
  activeVersion: 5,
};

describe('serve', () => {
  it('never-built → renders inline, stores, marks live, streams PDF', async () => {
    objects.clear(); deps.render.mockClear();
    const db = mkDb('not_built', null);
    const res = await serve({ DB: db } as any, 'community', 'anaqua', deps as any);
    expect(deps.render).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(objects.has('pdf/community/recC.pdf')).toBe(true);
  });
  it('fresh → streams from store WITHOUT rendering', async () => {
    objects.clear(); objects.set('pdf/community/recC.pdf', new Uint8Array([1])); deps.render.mockClear();
    const db = mkDb('live', 5);
    const res = await serve({ DB: db } as any, 'community', 'anaqua', deps as any);
    expect(deps.render).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
  it('stale-present → streams last-good immediately and schedules bg regen', async () => {
    objects.clear(); objects.set('pdf/community/recC.pdf', new Uint8Array([1])); deps.render.mockClear();
    const db = mkDb('stale', 5);
    const waitUntil = vi.fn();
    const res = await serve({ DB: db } as any, 'community', 'anaqua', deps as any, { waitUntil } as any);
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalled();
  });
});
