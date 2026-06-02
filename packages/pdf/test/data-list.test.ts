import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './_d1adapter';
import { loadListData } from '../src/data/list';

const DB = join(__dirname, '../../db');
function db() {
  const d = new Database(':memory:');
  readdirSync(join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort().forEach(f => d.exec(readFileSync(join(DB, 'migrations', f), 'utf8')));
  d.exec(readFileSync(join(DB, 'views.sql'), 'utf8'));
  d.exec(`INSERT INTO cities (id,slug,city_name) VALUES ('ci1','mcallen','McAllen')`);
  d.exec(`INSERT INTO communities (id,name,slug,city_id,published) VALUES ('c1','Anaqua','anaqua','ci1',1)`);
  return d1FromSqlite(d);
}

describe('loadListData', () => {
  it('locations list = published communities in the city', async () => {
    const data = await loadListData(db(), 'mcallen', 'locations');
    expect(data?.cityName).toBe('McAllen');
    expect(data?.cards.map((c) => c.name)).toContain('Anaqua');
  });
  it('returns null for an unknown city', async () => {
    expect(await loadListData(db(), 'nope', 'locations')).toBeNull();
  });
  it('qmis list resolves from v_public_qmi (no raw address column)', async () => {
    const raw = new Database(':memory:');
    readdirSync(join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort().forEach(f => raw.exec(readFileSync(join(DB, 'migrations', f), 'utf8')));
    raw.exec(readFileSync(join(DB, 'views.sql'), 'utf8'));
    raw.exec(`INSERT INTO cities (id,slug,city_name) VALUES ('ci1','mcallen','McAllen')`);
    raw.exec(`INSERT INTO qmi (id,published,synced_city_id,synced_address,image_url,synced_price,synced_total_square_footage,synced_bedroom_count) VALUES ('q1',1,'ci1','6529 Anaqua Loop','https://x/q1',379990,3057,4)`);
    const data = await loadListData(d1FromSqlite(raw), 'mcallen', 'qmis');
    expect(data?.qmis.map(c => c.address)).toContain('6529 Anaqua Loop');
    expect(data?.qmis[0]!.price).toBe(379990);
  });
});
