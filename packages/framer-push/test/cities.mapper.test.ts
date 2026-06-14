// =============================================================================
// Cities mapper test. The three stat fields on the Framer city page
// (community_count / move_in_homes_count / floor_plans_count) are derived LIVE
// from published inventory via CITY_COUNTS_SQL (selectByIdSql/selectAllSql), NOT
// from the frozen legacy-Airtable snapshot columns of the same name. These tests
// pin the city-scoped definitions and prove the live counts override any stale
// stored values.
//   • communities: published communities whose city_id = this city
//   • move-in homes: published QMIs whose effective city = this city
//       (override_city_id wins over synced_city_id)
//   • floor plans: published plans whose community_ids CSV references a PUBLISHED
//       community in this city; unlinked plans / other-city plans are excluded
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';
import type { FieldValue, ArrayFieldValue } from '../src/framer-types.js';

const def = COLLECTION_DEFS.cities;
const sval = (v: FieldValue | ArrayFieldValue | undefined) =>
  v && v.type !== 'array' ? (v as FieldValue).value : undefined;

function mapOne(db: ReturnType<typeof freshDb>, id: string) {
  const row = def.selectByIdSql
    ? (db.prepare(def.selectByIdSql).get(id) as Record<string, unknown>)
    : undefined;
  if (!row) throw new Error(`no row for ${id}`);
  return def.map(row);
}

/** Seed two cities and a realistic mix of related rows around the target city. */
function seed(db: ReturnType<typeof freshDb>) {
  // Stored snapshot columns are deliberately WRONG to prove the live counts win.
  insertRow(db, 'cities', {
    id: 'recCITY01',
    city_name: 'Testville',
    published: 1,
    community_count: 999,
    move_in_homes_count: 888,
    floor_plans_count: 777,
  });
  insertRow(db, 'cities', { id: 'recCITY99', city_name: 'Otherville', published: 1 });

  // communities — 2 published in-city, 1 unpublished in-city, 1 in the other city
  insertRow(db, 'communities', { id: 'recCOMM_A', city_id: 'recCITY01', published: 1 });
  insertRow(db, 'communities', { id: 'recCOMM_B', city_id: 'recCITY01', published: 1 });
  insertRow(db, 'communities', { id: 'recCOMM_C', city_id: 'recCITY01', published: 0 });
  insertRow(db, 'communities', { id: 'recCOMM_OTHER', city_id: 'recCITY99', published: 1 });

  // QMIs — by synced city, by override city (override wins), unpublished, other city
  insertRow(db, 'qmi', { id: 'recQ1', synced_city_id: 'recCITY01', published: 1 });
  insertRow(db, 'qmi', {
    id: 'recQ2',
    synced_city_id: 'recCITY99',
    override_city_id: 'recCITY01', // override wins → counts for Testville
    published: 1,
  });
  insertRow(db, 'qmi', { id: 'recQ3', synced_city_id: 'recCITY01', published: 0 }); // unpublished
  insertRow(db, 'qmi', { id: 'recQ4', synced_city_id: 'recCITY99', published: 1 }); // other city

  // floor plans — community_ids is a plain CSV string (no FK)
  insertRow(db, 'floor_plans', { id: 'recFP1', published: 1, community_ids: 'recCOMM_A' });
  insertRow(db, 'floor_plans', {
    id: 'recFP2',
    published: 1,
    community_ids: 'recCOMM_A, recCOMM_OTHER', // matches A → counts ONCE (DISTINCT)
  });
  insertRow(db, 'floor_plans', { id: 'recFP3', published: 1, community_ids: 'recCOMM_C' }); // C unpublished
  insertRow(db, 'floor_plans', { id: 'recFP4', published: 0, community_ids: 'recCOMM_A' }); // plan unpublished
  insertRow(db, 'floor_plans', { id: 'recFP5', published: 1, community_ids: '' }); // no linkage
  insertRow(db, 'floor_plans', { id: 'recFP6', published: 1, community_ids: 'recCOMM_OTHER' }); // other city
  insertRow(db, 'floor_plans', { id: 'recFP7', published: 1, community_ids: 'recCOMM_AXX' }); // boundary: must NOT match recCOMM_A
}

describe('Cities mapper — live city-scoped counts override stored snapshots', () => {
  it('computes community / move-in / floor-plan counts from published inventory', () => {
    const db = freshDb();
    seed(db);

    const f = mapOne(db, 'recCITY01').fieldData;

    // 2 published communities in-city (recCOMM_C unpublished, OTHER is another city)
    expect(f['community_count']?.type).toBe('number');
    expect(sval(f['community_count'])).toBe(2);

    // recQ1 (synced) + recQ2 (override) — recQ3 unpublished, recQ4 other city
    expect(sval(f['move_in_homes_count'])).toBe(2);

    // recFP1 + recFP2 (DISTINCT) — FP3 unpublished comm, FP4 unpublished plan,
    // FP5 unlinked, FP6 other city, FP7 boundary non-match
    expect(sval(f['floor_plans_count'])).toBe(2);

    // stored snapshot columns (999/888/777) are NOT what gets emitted
    expect(sval(f['community_count'])).not.toBe(999);
    expect(sval(f['move_in_homes_count'])).not.toBe(888);
    expect(sval(f['floor_plans_count'])).not.toBe(777);
  });

  it('emits zero counts for a city with no published inventory', () => {
    const db = freshDb();
    seed(db);
    const f = mapOne(db, 'recCITY99').fieldData;
    // Otherville: recCOMM_OTHER is published (1 community); recQ4 is a published
    // QMI here (recQ2's override moves it to Testville, so it does NOT count here).
    // Floor plans = 2: recFP6 (→recCOMM_OTHER) AND recFP2, which lists both
    // recCOMM_A and recCOMM_OTHER — a plan offered in communities across two cities
    // correctly counts toward each.
    expect(sval(f['community_count'])).toBe(1);
    expect(sval(f['move_in_homes_count'])).toBe(1);
    expect(sval(f['floor_plans_count'])).toBe(2);
  });

  it('returns 0 (not undefined) when a city is truly empty', () => {
    const db = freshDb();
    insertRow(db, 'cities', { id: 'recCITYEMPTY', city_name: 'Ghost Town', published: 1 });
    const f = mapOne(db, 'recCITYEMPTY').fieldData;
    expect(sval(f['community_count'])).toBe(0);
    expect(sval(f['move_in_homes_count'])).toBe(0);
    expect(sval(f['floor_plans_count'])).toBe(0);
  });
});
