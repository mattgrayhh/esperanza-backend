// =============================================================================
// Close-Out Community price_from resolution. When communities.close_out = 1 the
// public "homes from" price is the MIN starting price across the community's
// OFFERED, PUBLISHED floor plans (the Floor Plans Offered picker — community_ids
// CSV) instead of Snowflake's dev-wide synced_price_from. Precedence:
//   override_price_from  >  (close-out: min offered published plan)  >  synced_price_from
// Verified against BOTH the public view (v_public_communities) and the
// framer-push read query (selectAllSql) so the API and Framer agree.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';

const def = COLLECTION_DEFS.communities;
const COM = 'recCOMcloseout01';
const OTHER = 'recCOMother00002';

interface Plan {
  id: string;
  published?: number;
  community_ids?: string;
  synced_starting_price?: number | null;
  override_starting_price?: number | null;
}

function setup(opts: { closeOut?: boolean; override?: number | null; plans?: Plan[] }) {
  const db = freshDb();
  insertRow(db, 'communities', {
    id: COM,
    name: 'Cascada at Tres Lagos',
    slug: 'cascada-at-tres-lagos',
    published: 1,
    synced_price_from: 282990, // Snowflake dev-wide MIN (catches a non-offered cheap plan)
    override_price_from: opts.override ?? null,
    close_out: opts.closeOut ? 1 : 0,
  });
  for (const p of opts.plans ?? []) {
    insertRow(db, 'floor_plans', {
      id: p.id,
      name: p.id,
      published: p.published ?? 1,
      community_ids: p.community_ids ?? COM,
      synced_starting_price: p.synced_starting_price ?? null,
      override_starting_price: p.override_starting_price ?? null,
    });
  }
  return db;
}

/** price_from from the public view (what the API serves). */
function viewPrice(db: ReturnType<typeof freshDb>): number | null {
  const row = db.prepare('SELECT price_from FROM v_public_communities WHERE id = ?').get(COM) as
    | { price_from: number | null }
    | undefined;
  return row ? row.price_from : null;
}

/** price_from from the framer-push read query (what gets pushed to Framer). */
function mapperPrice(db: ReturnType<typeof freshDb>): number | null {
  const row = db.prepare(def.selectByIdSql).get(COM) as Record<string, unknown>;
  return (row['price_from'] as number | null) ?? null;
}

const OFFERED_HI: Plan[] = [
  { id: 'recFPa', community_ids: COM, synced_starting_price: 437990 },
  { id: 'recFPb', community_ids: COM, synced_starting_price: 468000 },
  { id: 'recFPcheapNotOffered', community_ids: OTHER, synced_starting_price: 250000 },
  { id: 'recFPcheapUnpublished', community_ids: COM, published: 0, synced_starting_price: 199000 },
];

describe('Close-Out Community price_from', () => {
  it('close_out=0 → uses synced_price_from (unchanged behavior)', () => {
    const db = setup({ closeOut: false, plans: OFFERED_HI });
    expect(viewPrice(db)).toBe(282990);
    expect(mapperPrice(db)).toBe(282990);
  });

  it('close_out=1 → MIN of published OFFERED plans, excluding non-offered + unpublished', () => {
    const db = setup({ closeOut: true, plans: OFFERED_HI });
    expect(viewPrice(db)).toBe(437990); // not 250000 (not offered) and not 199000 (unpublished)
    expect(mapperPrice(db)).toBe(437990);
  });

  it('close_out=1 → per-plan override_starting_price wins inside the MIN', () => {
    const db = setup({
      closeOut: true,
      plans: [
        { id: 'recFPa', community_ids: COM, synced_starting_price: 437990, override_starting_price: 420000 },
        { id: 'recFPb', community_ids: COM, synced_starting_price: 468000 },
      ],
    });
    expect(viewPrice(db)).toBe(420000);
    expect(mapperPrice(db)).toBe(420000);
  });

  it('close_out=1 but override_price_from set → manual override wins', () => {
    const db = setup({ closeOut: true, override: 450000, plans: OFFERED_HI });
    expect(viewPrice(db)).toBe(450000);
    expect(mapperPrice(db)).toBe(450000);
  });

  it('close_out=1 with no qualifying offered plan → falls through to synced_price_from', () => {
    const db = setup({
      closeOut: true,
      plans: [
        { id: 'recFPcheapNotOffered', community_ids: OTHER, synced_starting_price: 250000 },
        { id: 'recFPcheapUnpublished', community_ids: COM, published: 0, synced_starting_price: 199000 },
      ],
    });
    expect(viewPrice(db)).toBe(282990);
    expect(mapperPrice(db)).toBe(282990);
  });
});
