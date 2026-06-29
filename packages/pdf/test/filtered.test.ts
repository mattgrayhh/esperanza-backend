import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { d1FromSqlite } from './_d1adapter';
import { loadFiltered, renderFilteredPrintPage, parseListFilters } from '../src/filtered';

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

describe('parseListFilters', () => {
  it('maps query params to filters (status=available → availableNow)', () => {
    const f = parseListFilters(new URLSearchParams('city=mcallen&minBeds=4&maxPrice=400000&status=available'));
    expect(f).toMatchObject({ city: 'mcallen', minBeds: 4, maxPrice: 400000, availableNow: true });
  });
});

describe('loadFiltered', () => {
  it('loads the active theme + filtered QMI data for the query', async () => {
    const env = { DB: mkDb(), PDF_PUBLIC_BASE_URL: 'https://pdf.test' } as any;
    const { theme, data } = await loadFiltered(env, 'qmis', new URLSearchParams('city=mcallen&minBeds=4'));
    expect(theme).toBeTruthy();
    const addrs = data.qmis.map((q: any) => q.address);
    expect(addrs).toContain('100 A St');  // 4bd
    expect(addrs).not.toContain('200 B St'); // 3bd filtered out
  });
});

describe('renderFilteredPrintPage', () => {
  it('returns a full HTML doc with the list content plus a print toolbar + auto-print', async () => {
    const env = { DB: mkDb(), PDF_PUBLIC_BASE_URL: 'https://pdf.test' } as any;
    const { theme, data } = await loadFiltered(env, 'qmis', new URLSearchParams('city=mcallen'));
    const html = renderFilteredPrintPage(theme, data);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('window.print()');       // manual button
    expect(html).toContain('class="print-toolbar"'); // toolbar present
    expect(html).toContain('@media print');          // toolbar hidden when printing
    expect(html).toContain('100 A St');              // real list content rendered
    // toolbar injected inside the body, before the closing tag
    expect(html.indexOf('print-toolbar')).toBeLessThan(html.indexOf('</body>'));
  });
});
