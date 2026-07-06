// =============================================================================
// Community price_from resolution (0025 — the elevation PRICE SOURCE, honored for
// EVERY community). Precedence:
//   override_price_from
//     > elevation-sourced price from community_elevation_prices across the
//       community's PUBLISHED development plans: pinned close_out_elevation
//       > 'Traditional / Brick' where offered (Viri's default) > cheapest offered
//       elevation (NULL when the community has no cep rows)
//     > close_out = 1: MIN starting price across OFFERED, PUBLISHED plans (0018)
//     > synced_price_from
// Verified against BOTH the public view (v_public_communities) and the
// framer-push read query (selectByIdSql) so the API and Framer agree.
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

interface Elev {
  planId: string;
  label: string; // "Type / Material"
  price: number;
  community?: string; // cep.community_id (defaults to COM); a different value = another dev
}

interface Qmi {
  id: string;
  published?: number;
  synced_price?: number | null;
  override_price?: number | null;
  community?: string; // defaults to COM
}

function setup(opts: {
  closeOut?: boolean;
  override?: number | null;
  closeOutElevation?: string | null;
  plans?: Plan[];
  elevations?: Elev[];
  qmis?: Qmi[];
}) {
  const db = freshDb();
  insertRow(db, 'communities', {
    id: COM,
    name: 'Cascada at Tres Lagos',
    slug: 'cascada-at-tres-lagos',
    published: 1,
    synced_price_from: 282990, // Snowflake dev-wide MIN (catches a non-offered cheap plan)
    override_price_from: opts.override ?? null,
    close_out: opts.closeOut ? 1 : 0,
    close_out_elevation: opts.closeOutElevation ?? null,
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
  for (const e of opts.elevations ?? []) {
    const [type, material] = e.label.split(' / ');
    const community = e.community ?? COM;
    insertRow(db, 'community_elevation_prices', {
      id: `${community}:${e.planId}:${e.label}`,
      community_id: community,
      floor_plan_id: e.planId,
      elevation_type: type,
      material_type: material,
      elevation_label: e.label,
      sales_price: e.price,
    });
  }
  // A second community for "belongs elsewhere" cases (qmi.synced_community_id is a real FK).
  if ((opts.qmis ?? []).some((q) => q.community && q.community !== COM)) {
    insertRow(db, 'communities', { id: OTHER, name: 'Other Dev', slug: 'other-dev', published: 1 });
  }
  for (const q of opts.qmis ?? []) {
    insertRow(db, 'qmi', {
      id: q.id,
      published: q.published ?? 1,
      synced_community_id: q.community ?? COM,
      synced_price: q.synced_price ?? null,
      override_price: q.override_price ?? null,
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

// Per-elevation prices. "Tuscan / Stucco" exists on the two in-community published
// plans (455k/470k) AND on an unpublished plan (190k) and a plan belonging to ANOTHER
// community's development (240k) — both of which must NOT count. The price is scoped by
// cep.community_id + published, NOT the "Floor Plans Offered" picker (0021).
// "Traditional / Brick" exists only on recFPa.
const ELEVS: Elev[] = [
  { planId: 'recFPa', label: 'Tuscan / Stucco', price: 455000 },
  { planId: 'recFPa', label: 'Traditional / Brick', price: 448000 },
  { planId: 'recFPb', label: 'Tuscan / Stucco', price: 470000 },
  { planId: 'recFPcheapNotOffered', label: 'Tuscan / Stucco', price: 240000, community: OTHER },
  { planId: 'recFPcheapUnpublished', label: 'Tuscan / Stucco', price: 190000 },
];

describe('Close-Out Community price_from', () => {
  it('close_out=0 → uses synced_price_from (unchanged behavior)', () => {
    const db = setup({ closeOut: false, plans: OFFERED_HI });
    expect(viewPrice(db)).toBe(282990);
    expect(mapperPrice(db)).toBe(282990);
  });

  it('close_out=1, no elevation → MIN of published OFFERED plans, excluding non-offered + unpublished', () => {
    const db = setup({ closeOut: true, plans: OFFERED_HI });
    expect(viewPrice(db)).toBe(437990); // not 250000 (not offered) and not 199000 (unpublished)
    expect(mapperPrice(db)).toBe(437990);
  });

  it('close_out=1, no elevation → per-plan override_starting_price wins inside the MIN', () => {
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

  // --- close_out_elevation (auto-pulled per-elevation price) layer ---------------

  it('close_out=1 + elevation → MIN price of that elevation across this community’s PUBLISHED plans', () => {
    const db = setup({ closeOut: true, closeOutElevation: 'Tuscan / Stucco', plans: OFFERED_HI, elevations: ELEVS });
    // min(455000 recFPa, 470000 recFPb); 240000 (another community) + 190000 (unpublished) excluded.
    expect(viewPrice(db)).toBe(455000);
    expect(mapperPrice(db)).toBe(455000);
  });

  it('close_out=1 + elevation resolves from dev plans even when Floor Plans Offered is EMPTY (0021)', () => {
    // The real close-out case: no offered plans (community_ids empty), so the auto-MIN
    // fallback is null — but the elevation price still resolves from the cep rows, which
    // are community-scoped via the development map.
    const db = setup({
      closeOut: true,
      closeOutElevation: 'Traditional / Brick',
      plans: [{ id: 'recFPx', community_ids: '', synced_starting_price: 300000 }], // published, NOT offered
      elevations: [{ planId: 'recFPx', label: 'Traditional / Brick', price: 312000 }],
    });
    expect(viewPrice(db)).toBe(312000);
    expect(mapperPrice(db)).toBe(312000);
  });

  it('close_out=1 + elevation present on only one offered plan → that plan’s price', () => {
    const db = setup({ closeOut: true, closeOutElevation: 'Traditional / Brick', plans: OFFERED_HI, elevations: ELEVS });
    expect(viewPrice(db)).toBe(448000);
    expect(mapperPrice(db)).toBe(448000);
  });

  it('close_out=1 + elevation that matches nothing → falls back to the DEFAULT rule (TDB here)', () => {
    // 0025: a pin that matches no row no longer skips straight to the offered-plan
    // MIN — the default elevation rule still applies (Traditional / Brick on recFPa).
    const db = setup({ closeOut: true, closeOutElevation: 'Contemporary / Hardie', plans: OFFERED_HI, elevations: ELEVS });
    expect(viewPrice(db)).toBe(448000);
    expect(mapperPrice(db)).toBe(448000);
  });

  it('close_out=0 + elevation set → HONORED since 0025 (wright-ranch regression)', () => {
    // The legacy O'Neill site priced non-close-out communities from their pinned
    // elevation too; before 0025 the pin was silently ignored unless close_out=1.
    const db = setup({ closeOut: false, closeOutElevation: 'Tuscan / Stucco', plans: OFFERED_HI, elevations: ELEVS });
    expect(viewPrice(db)).toBe(455000);
    expect(mapperPrice(db)).toBe(455000);
  });

  it('close_out=0, no pin, cep rows exist → Traditional / Brick where offered (default)', () => {
    const db = setup({ closeOut: false, plans: OFFERED_HI, elevations: ELEVS });
    // TDB exists on recFPa at 448000 → beats synced_price_from 282990 (dev-wide min).
    expect(viewPrice(db)).toBe(448000);
    expect(mapperPrice(db)).toBe(448000);
  });

  it('close_out=0, no pin, no TDB offered → cheapest offered elevation', () => {
    const db = setup({
      closeOut: false,
      plans: OFFERED_HI,
      elevations: ELEVS.filter((e) => e.label !== 'Traditional / Brick'),
    });
    // min(455000 recFPa, 470000 recFPb); other-community + unpublished rows excluded.
    expect(viewPrice(db)).toBe(455000);
    expect(mapperPrice(db)).toBe(455000);
  });

  it('close_out=1 + override_price_from AND elevation both set → override wins', () => {
    const db = setup({ closeOut: true, override: 450000, closeOutElevation: 'Tuscan / Stucco', plans: OFFERED_HI, elevations: ELEVS });
    expect(viewPrice(db)).toBe(450000);
    expect(mapperPrice(db)).toBe(450000);
  });

  // --- close_out QMI-min layer (0025): a close-out community sells what's standing ---

  it('close_out=1 with published QMIs → cheapest published QMI wins (Wright Ranch rule)', () => {
    const db = setup({
      closeOut: true,
      closeOutElevation: 'Tuscan / Stucco',
      plans: OFFERED_HI,
      elevations: ELEVS,
      qmis: [
        { id: 'recQMIa', synced_price: 274990 },
        { id: 'recQMIb', synced_price: 305000 },
        { id: 'recQMIunpub', published: 0, synced_price: 199000 },       // excluded
        { id: 'recQMIother', community: OTHER, synced_price: 150000 },   // other community
      ],
    });
    expect(viewPrice(db)).toBe(274990);
    expect(mapperPrice(db)).toBe(274990);
  });

  it('close_out=1 QMI min honors per-home override_price', () => {
    const db = setup({
      closeOut: true,
      qmis: [{ id: 'recQMIa', synced_price: 280000, override_price: 260000 }],
    });
    expect(viewPrice(db)).toBe(260000);
    expect(mapperPrice(db)).toBe(260000);
  });

  it('close_out=1 with NO published QMIs → falls back to the elevation rule', () => {
    const db = setup({
      closeOut: true,
      closeOutElevation: 'Tuscan / Stucco',
      plans: OFFERED_HI,
      elevations: ELEVS,
      qmis: [{ id: 'recQMIunpub', published: 0, synced_price: 199000 }],
    });
    expect(viewPrice(db)).toBe(455000);
    expect(mapperPrice(db)).toBe(455000);
  });

  it('close_out=0 → QMI prices do NOT drive price_from', () => {
    const db = setup({
      closeOut: false,
      qmis: [{ id: 'recQMIa', synced_price: 100000 }],
    });
    expect(viewPrice(db)).toBe(282990); // synced (no cep rows)
    expect(mapperPrice(db)).toBe(282990);
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

// The close_out flag itself is pushed to Framer (a boolean field) so a City/community
// page can badge close-out communities or branch layout on it — separate from its price
// effect, which is already baked into price_from above.
describe('Close-Out flag pass-through to Framer', () => {
  const mapFlag = (db: ReturnType<typeof freshDb>) => {
    const row = db.prepare(def.selectByIdSql).get(COM) as Record<string, unknown>;
    return def.map(row).fieldData['close_out'];
  };

  it('emits close_out: true for a close-out community', () => {
    expect(mapFlag(setup({ closeOut: true }))).toEqual({ type: 'boolean', value: true });
  });

  it('emits close_out: false for a normal community', () => {
    expect(mapFlag(setup({ closeOut: false }))).toEqual({ type: 'boolean', value: false });
  });
});
