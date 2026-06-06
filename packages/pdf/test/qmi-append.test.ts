import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './_d1adapter';
import { loadQmiData } from '../src/data/qmi';
import { renderTemplate } from '../src/templates';
import { defaultTheme } from '../src/theme';

const DB = join(__dirname, '../../db');
function db() {
  const d = new Database(':memory:');
  readdirSync(join(DB,'migrations')).filter(f=>f.endsWith('.sql')).sort().forEach(f=>d.exec(readFileSync(join(DB,'migrations',f),'utf8')));
  d.exec(readFileSync(join(DB,'views.sql'),'utf8'));
  d.exec(`INSERT INTO floor_plans (id,name,published,description,synced_total_square_footage,synced_bedroom_max,elevation_gallery) VALUES ('fpE','Elm',1,'Elm desc',2571,4,'["https://x/e1.jpg"]')`);
  d.exec(`INSERT INTO qmi (id,published,synced_address,synced_floor_plan_id,override_price) VALUES ('q1',1,'6529 Anaqua Loop','fpE',379990)`);
  return d1FromSqlite(d);
}

describe('QMI floor-plan append', () => {
  it('loads the linked floor plan when appendFloorPlanPages is true', async () => {
    const data = await loadQmiData(db(), 'q1', { appendFloorPlanPages: true });
    expect(data?.floorPlan?.name).toBe('Elm');
  });
  it('omits the floor plan when appendFloorPlanPages is false', async () => {
    const data = await loadQmiData(db(), 'q1', { appendFloorPlanPages: false });
    expect(data?.floorPlan == null).toBe(true);
  });
  it('renders both the QMI stats and the appended floor-plan pages', async () => {
    const data = await loadQmiData(db(), 'q1', { appendFloorPlanPages: true });
    const html = renderTemplate('qmi', defaultTheme, data);
    expect(html).toContain('6529 Anaqua Loop');         // QMI header
    expect(html).toContain('Elm');                        // appended floor-plan cover
    expect(html).toContain('break-before:page');          // append starts on a new page (inline style)
  });
});
