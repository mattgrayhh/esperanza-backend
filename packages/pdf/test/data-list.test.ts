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
  it('master locations (city="all") = every published community across cities', async () => {
    const raw = new Database(':memory:');
    readdirSync(join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort().forEach(f => raw.exec(readFileSync(join(DB, 'migrations', f), 'utf8')));
    raw.exec(readFileSync(join(DB, 'views.sql'), 'utf8'));
    raw.exec(`INSERT INTO cities (id,slug,city_name) VALUES ('ci1','mcallen','McAllen'),('ci2','laredo','Laredo')`);
    raw.exec(`INSERT INTO communities (id,name,slug,city_id,published) VALUES ('c1','Anaqua','anaqua','ci1',1),('c2','Wolf Creek','wolf-creek','ci2',1),('c3','Hidden','hidden','ci1',0)`);
    const data = await loadListData(d1FromSqlite(raw), 'all', 'locations');
    expect(data?.isMaster).toBe(true);
    const names = data?.cards.map((c) => c.name) ?? [];
    expect(names).toContain('Anaqua');
    expect(names).toContain('Wolf Creek');
    expect(names).not.toContain('Hidden'); // unpublished excluded
  });
  it('master plans (city="all") = every published floor plan (not gated on a QMI)', async () => {
    const raw = new Database(':memory:');
    readdirSync(join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort().forEach(f => raw.exec(readFileSync(join(DB, 'migrations', f), 'utf8')));
    raw.exec(readFileSync(join(DB, 'views.sql'), 'utf8'));
    raw.exec(`INSERT INTO floor_plans (id,name,slug,published) VALUES ('fp1','Hickory','hickory',1),('fp2','Oak','oak',1),('fp3','Draft','draft',0)`);
    const data = await loadListData(d1FromSqlite(raw), 'all', 'plans');
    expect(data?.isMaster).toBe(true);
    const names = data?.cards.map((c) => c.name) ?? [];
    expect(names).toContain('Hickory');
    expect(names).toContain('Oak');
    expect(names).not.toContain('Draft');
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

  it('community "plans" = floor plans whose community_ids contains the community id', async () => {
    const raw = new Database(':memory:');
    readdirSync(join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort().forEach(f => raw.exec(readFileSync(join(DB, 'migrations', f), 'utf8')));
    raw.exec(readFileSync(join(DB, 'views.sql'), 'utf8'));
    raw.exec(`INSERT INTO cities (id,slug,city_name) VALUES ('ci1','mcallen','McAllen')`);
    raw.exec(`INSERT INTO communities (id,name,slug,city_id,published) VALUES ('c1','Anaqua at Tres Lagos','anaqua-at-tres-lagos','ci1',1)`);
    raw.exec(`INSERT INTO floor_plans (id,name,slug,published,community_ids) VALUES ('fp1','Hickory','hickory',1,'c1,c2'),('fp2','Oak','oak',1,'c2'),('fp3','Birch','birch',1,'c1')`);
    const data = await loadListData(d1FromSqlite(raw), 'anaqua-at-tres-lagos', 'plans', undefined, 'community');
    expect(data?.cityName).toBe('Anaqua at Tres Lagos');
    const names = data?.cards.map((c) => c.name) ?? [];
    expect(names).toContain('Hickory');
    expect(names).toContain('Birch');
    expect(names).not.toContain('Oak'); // not in c1
  });

  it('community "qmis" = homes in that community; unknown community → null', async () => {
    const raw = new Database(':memory:');
    readdirSync(join(DB, 'migrations')).filter(f => f.endsWith('.sql')).sort().forEach(f => raw.exec(readFileSync(join(DB, 'migrations', f), 'utf8')));
    raw.exec(readFileSync(join(DB, 'views.sql'), 'utf8'));
    raw.exec(`INSERT INTO cities (id,slug,city_name) VALUES ('ci1','mcallen','McAllen')`);
    raw.exec(`INSERT INTO communities (id,name,slug,city_id,published) VALUES ('c1','Anaqua','anaqua','ci1',1),('c2','Other','other','ci1',1)`);
    raw.exec(`INSERT INTO qmi (id,published,synced_city_id,synced_community_id,synced_address,image_url,synced_price) VALUES ('q1',1,'ci1','c1','6529 Anaqua Loop','https://x/q1',379990),('q2',1,'ci1','c2','999 Other St','https://x/q2',1)`);
    const db2 = d1FromSqlite(raw);
    const data = await loadListData(db2, 'anaqua', 'qmis', undefined, 'community');
    const addrs = data?.qmis.map((c) => c.address) ?? [];
    expect(addrs).toContain('6529 Anaqua Loop');
    expect(addrs).not.toContain('999 Other St'); // different community
    expect(await loadListData(db2, 'nope', 'qmis', undefined, 'community')).toBeNull();
  });
});
