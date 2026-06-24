import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './_d1adapter';
import { resolveFiltered, renderFilteredJob } from '../src/filtered';

const DB = join(__dirname, '../../db');
function mkDb() {
  const d = new Database(':memory:');
  readdirSync(join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort().forEach(f => d.exec(readFileSync(join(DB, 'migrations', f), 'utf8')));
  d.exec(readFileSync(join(DB, 'views.sql'), 'utf8'));
  d.exec(`INSERT INTO cities (id,slug,city_name) VALUES ('ci1','mcallen','McAllen')`);
  d.exec(`INSERT INTO communities (id,name,slug,city_id,published) VALUES ('c1','Anaqua','anaqua','ci1',1)`);
  d.exec(`INSERT INTO qmi (id,published,synced_city_id,synced_community_id,synced_address,synced_price,synced_bedroom_count) VALUES
    ('q1',1,'ci1','c1','100 A St',300000,4),
    ('q2',1,'ci1','c1','200 B St',420000,3)`);
  return d1FromSqlite(d);
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

describe('renderFilteredJob', () => {
  it('renders the filtered list once and stores it at the resolved R2 key', async () => {
    const env = { DB: mkDb(), PDF_PUBLIC_BASE_URL: 'https://pdf.test' } as any;
    const store = new Map<string, Uint8Array>();
    const render = vi.fn(async () => PDF_BYTES);
    const deps = {
      render,
      getObject: async (k: string) => (store.has(k) ? { body: store.get(k)! } : null),
      putObject: async (k: string, b: Uint8Array) => { store.set(k, b); },
    };

    const { key } = await resolveFiltered(env, 'qmis', new URLSearchParams('?city=mcallen'));
    const result = await renderFilteredJob(env, 'qmis', '?city=mcallen', deps);

    expect(result).toBe('rendered');
    expect(render).toHaveBeenCalledTimes(1);
    // render must be called with the generous bulk timeout (4th arg), not the 30s default.
    expect((render.mock.calls[0] as any[])[3]).toBeGreaterThan(30_000);
    expect(store.has(key)).toBe(true);
  });

  it('is idempotent: skips rendering when the object already exists (dupe send / retry)', async () => {
    const env = { DB: mkDb(), PDF_PUBLIC_BASE_URL: 'https://pdf.test' } as any;
    const { key } = await resolveFiltered(env, 'qmis', new URLSearchParams('?city=mcallen'));
    const store = new Map<string, Uint8Array>([[key, PDF_BYTES]]); // already rendered
    const render = vi.fn(async () => PDF_BYTES);
    const deps = {
      render,
      getObject: async (k: string) => (store.has(k) ? { body: store.get(k)! } : null),
      putObject: async (k: string, b: Uint8Array) => { store.set(k, b); },
    };

    const result = await renderFilteredJob(env, 'qmis', '?city=mcallen', deps);

    expect(result).toBe('cached');
    expect(render).not.toHaveBeenCalled();
  });

  it('different filters resolve to different keys', async () => {
    const env = { DB: mkDb(), PDF_PUBLIC_BASE_URL: 'https://pdf.test' } as any;
    const a = await resolveFiltered(env, 'qmis', new URLSearchParams('?city=mcallen'));
    const b = await resolveFiltered(env, 'qmis', new URLSearchParams('?city=mcallen&minBeds=4'));
    expect(a.key).not.toBe(b.key);
  });
});
