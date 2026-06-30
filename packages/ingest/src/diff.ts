// =============================================================================
// esperanza-cf — Snowflake↔D1 diff + queue message contract. Migration Plan v2,
// Phase 3. Pure functions (no I/O) so they're unit-testable and the cron handler
// just wires DB reads → these → SYNC_QUEUE.send.
//
// Message shapes the queue carries (one per changed record):
//   { kind: 'qmi.upsert',  ... }   new spec OR changed existing
//   { kind: 'qmi.unpublish', ... } sold/removed → force published=0 (NEVER =1)
//   { kind: 'community.upsert', ... } square_footage_range changed
//
// Link resolution (Decision #11): the producer resolves Floor Plan / Community /
// City NAMES to D1 row ids via lookup maps built from D1 (lowercased name → id),
// exactly mirroring data-sync's floorPlanLookup / communityLookup / cityLookup.
// singleSelect *name* fields write only when the option already exists in D1
// (validCities/validCommunities/validFloorPlans); the link-by-id always writes
// when an id resolves. Both behaviors are preserved here.
// =============================================================================

import type {
  SnowflakeQmiRow,
  SnowflakeCommunityRow,
  SnowflakeFloorPlanRow,
} from './snowflake.js';
import { squareFootageRange, countRange } from './snowflake.js';
import type { SyncedQmiValues, SyncedCommunityValues, SyncedFloorPlanValues } from './synced.js';
import { snowflakeKey } from './synced.js';

// -- queue message contract --

export interface QmiUpsertMessage {
  kind: 'qmi.upsert';
  /** DM_HOUSE natural key (eci_key) — diff match key & importer coordination. */
  snowflakeKey: string;
  /** Existing D1 row id when matched (recXXXX); null → consumer inserts new. */
  qmiId: string | null;
  /** Allow-listed synced values (camelCase). Consumer runs these through applySynced. */
  values: SyncedQmiValues;
  /** True when this is a brand-new spec (consumer inserts published=0, seeds slug). */
  isNew: boolean;
  /** Address used to derive the slug on create (lowercased-kebab). */
  slugSource: string | null;
  /** Price seeding hint (consumer applies last_synced_price override-protection). */
  ratifiedSalesPrice: number | null;
}

export interface QmiUnpublishMessage {
  kind: 'qmi.unpublish';
  snowflakeKey: string;
  qmiId: string;
}

export interface CommunityUpsertMessage {
  kind: 'community.upsert';
  /** Community D1 row id (resolved by name). */
  communityId: string;
  values: SyncedCommunityValues;
}

export interface FloorPlanUpsertMessage {
  kind: 'floorplan.upsert';
  /** Floor plan D1 row id (resolved by name). */
  floorPlanId: string;
  values: SyncedFloorPlanValues;
}

export type SyncMessage =
  | QmiUpsertMessage
  | QmiUnpublishMessage
  | CommunityUpsertMessage
  | FloorPlanUpsertMessage;

// -- the minimal D1 snapshot the diff needs (read by the cron handler) --

/** One existing QMI row, as the diff needs to see it (raw synced_* + override + identity). */
export interface ExistingQmi {
  id: string;
  eci_key: string | null;
  housenumber: string | null;
  synced_community_name: string | null;
  published: number; // 0 | 1
  // current synced values (to detect a real change and avoid no-op churn)
  synced_address: string | null;
  synced_postal_code: number | null;
  synced_bedroom_count: number | null;
  synced_bathroom_count: number | null;
  synced_half_bathroom_count: number | null;
  synced_living_square_footage: number | null;
  synced_total_square_footage: number | null;
  synced_elevation: string | null;
  synced_construction_stage: string | null;
  synced_move_in_date: string | null;
  synced_lot_number: string | null;
  synced_elevation_type: string | null;
  synced_material_type: string | null;
  synced_is_model_home: number | null;
  synced_start_type: string | null;
  synced_construction_stage_index: number | null;
  synced_estimated_settlement_date: string | null;
  synced_city_id: string | null;
  synced_city_name: string | null;
  synced_community_id: string | null;
  synced_floor_plan_id: string | null;
  synced_floor_plan_name: string | null;
  synced_price: number | null;
  last_synced_price: number | null;
  mark_job_number: string | null;
}

/** Existing community synced values (change detection — avoid queue/framer churn). */
export interface ExistingCommunity {
  id: string;
  synced_square_footage_range: string | null;
  synced_bed_count: string | null;
  synced_bath_count: string | null;
  synced_price_from: number | null;
}

/** Existing floor plan synced values (matched by lowercased name). */
export interface ExistingFloorPlan {
  id: string;
  name: string | null;
  synced_bedroom_min: number | null;
  synced_bedroom_max: number | null;
  synced_bathroom_min: number | null;
  synced_bathroom_max: number | null;
  synced_living_square_footage: number | null;
  synced_total_square_footage: number | null;
  synced_starting_price: number | null;
}

/** Lookups: lowercased name → D1 row id; plus the set of valid singleSelect names. */
export interface Lookups {
  cityByName: Map<string, string>; // lower(city_name) → id
  communityByName: Map<string, string>; // lower(name) → id
  floorPlanByName: Map<string, string>; // lower(name) → id
  validCities: Set<string>; // exact City names that exist as options
  validCommunities: Set<string>;
  validFloorPlans: Set<string>;
}

export interface DiffResult {
  messages: SyncMessage[];
  stats: {
    qmisCreated: number;
    qmisUpdated: number;
    qmisUnpublished: number;
    qmisInSnowflake: number;
    communitiesUpdated: number;
    floorPlansUpdated: number;
    unresolvedLinks: number;
  };
  /** Mass-unpublish safety guard outcome (see evaluateUnpublishGuard). */
  unpublishGuard: UnpublishGuardResult;
}

// =============================================================================
// MASS-UNPUBLISH SAFETY GUARD — 2026-06-11 incident.
//
// The 08:00 producer run received a TRUNCATED Snowflake QMI result (60 rows
// where every adjacent 4-hourly run sees 321-324 — the REST client was reading
// only the first inline chunk) and, because the unpublish rule treats "published
// row's eci_key absent from the Snowflake result" as sold/removed, it enqueued
// 118 qmi.unpublish messages and mass-unpublished the live catalog.
//
// The client is fixed (snowflake.ts now follows data.chunks), but as defense in
// depth the diff refuses to emit ANY unpublish messages for a run whose
// Snowflake result is anomalously small. Upserts are unaffected — a guarded run
// still processes creates/updates normally; only the destructive unpublish leg
// is skipped (and surfaced as a loud sync_log warning by the producer).
// =============================================================================

/**
 * Guard only engages at/above this many would-be unpublishes. Below it, even a
 * proportionally large unpublish (e.g. 1 of 2 published rows genuinely selling)
 * is plausible and must keep working.
 */
export const UNPUBLISH_GUARD_MIN_CANDIDATES = 5;

/**
 * Trip when the run would unpublish more than this fraction of the currently
 * published, eci-keyed rows. A healthy run unpublishes a handful of solds; the
 * 2026-06-11 incident run would have unpublished ~44% of the catalog.
 */
export const UNPUBLISH_GUARD_MAX_PUBLISHED_FRACTION = 0.2;

/**
 * Trip when the Snowflake QMI row count falls below this fraction of the
 * existing eci-keyed D1 rows (the incident shape: 60 returned vs ~330 known —
 * a truncated/partial result, not 270 simultaneous sales).
 */
export const UNPUBLISH_GUARD_MIN_SNOWFLAKE_RATIO = 0.5;

export interface UnpublishGuardResult {
  tripped: boolean;
  /** How many qmi.unpublish messages the run WOULD have emitted. */
  candidateCount: number;
  /** Currently published, eci-keyed D1 rows (the fraction-rule denominator). */
  publishedEciCount: number;
  /** All eci-keyed D1 rows (the shrink-rule denominator). */
  eciKeyedCount: number;
  /** QMI rows the Snowflake query returned this run. */
  snowflakeCount: number;
  /** Loud, human-readable explanation when tripped; null otherwise. */
  reason: string | null;
}

/** Pure guard evaluation (exported for tests). */
export function evaluateUnpublishGuard(
  candidateCount: number,
  publishedEciCount: number,
  eciKeyedCount: number,
  snowflakeCount: number,
  /**
   * Operator force (manual `POST /run?force=1` only): bypass the over-published
   * FRACTION heuristic, which is a proxy that mis-fires on a legitimate bulk of
   * real sales (e.g. the 2026-06-30 sale-lifecycle fix: 32 genuinely-sold homes
   * unpublishing at once = 24% > 20%). The truncation tripwire (snowflakeShrunk)
   * is NEVER bypassed — a forced run on a shrunk/partial Snowflake result still
   * refuses to unpublish, since that is the actual 2026-06-11 incident signal.
   */
  forceUnpublish = false
): UnpublishGuardResult {
  const base: UnpublishGuardResult = {
    tripped: false,
    candidateCount,
    publishedEciCount,
    eciKeyedCount,
    snowflakeCount,
    reason: null,
  };
  if (candidateCount < UNPUBLISH_GUARD_MIN_CANDIDATES) return base;

  const overPublishedFraction =
    !forceUnpublish &&
    publishedEciCount > 0 &&
    candidateCount > UNPUBLISH_GUARD_MAX_PUBLISHED_FRACTION * publishedEciCount;
  const snowflakeShrunk =
    eciKeyedCount > 0 && snowflakeCount < UNPUBLISH_GUARD_MIN_SNOWFLAKE_RATIO * eciKeyedCount;

  if (!overPublishedFraction && !snowflakeShrunk) return base;

  const reasons: string[] = [];
  if (overPublishedFraction) {
    reasons.push(
      `would unpublish ${candidateCount}/${publishedEciCount} published rows (> ${UNPUBLISH_GUARD_MAX_PUBLISHED_FRACTION * 100}%)`
    );
  }
  if (snowflakeShrunk) {
    reasons.push(
      `snowflake returned ${snowflakeCount} QMI rows vs ${eciKeyedCount} eci-keyed D1 rows (< ${UNPUBLISH_GUARD_MIN_SNOWFLAKE_RATIO * 100}%)`
    );
  }
  return {
    ...base,
    tripped: true,
    reason:
      `UNPUBLISH GUARD TRIPPED — skipped ${candidateCount} qmi.unpublish message(s): ` +
      reasons.join('; ') +
      '. Likely truncated/partial Snowflake result (2026-06-11 incident shape); upserts processed normally.',
  };
}

const W = (v: number | null | undefined) => v !== null && v !== undefined && v > 0;

/**
 * Build the allow-listed synced values for one Snowflake QMI row, applying the
 * SAME partial-update guards as esperanza-data-sync's `sf` object:
 *  - singleSelect names (city/community/floor_plan) only when the option exists
 *  - link-by-id only when a lookup resolves
 *  - numeric fields only when > 0 (half-bath: written when not null, 0 allowed)
 *  - eci/job/housenumber/address/elevation/stage only when truthy
 * Returns {values, unresolved} where unresolved counts links that didn't map.
 */
export function buildQmiSyncedValues(
  row: SnowflakeQmiRow,
  lk: Lookups
): { values: SyncedQmiValues; unresolved: number } {
  const values: SyncedQmiValues = {};
  let unresolved = 0;

  // identity / join keys (always when truthy)
  values.eciKey = row.eciKey || null;
  if (row.jobNumber) values.markJobNumber = row.jobNumber;
  if (row.housenumber) values.housenumber = row.housenumber;

  if (row.address) values.address = row.address;
  if (row.postalCode != null) values.postalCode = row.postalCode;
  if (row.elevation) values.elevation = row.elevation;
  if (row.constructionStage) values.constructionStage = row.constructionStage;

  if (W(row.bedroomCount)) values.bedroomCount = row.bedroomCount!;
  if (W(row.bathroomCount)) values.bathroomCount = row.bathroomCount!;
  if (row.halfBathroomCount != null) values.halfBathroomCount = row.halfBathroomCount; // 0 allowed
  if (W(row.livingSquareFootage)) values.livingSquareFootage = row.livingSquareFootage!;
  if (W(row.totalSquareFootage)) values.totalSquareFootage = row.totalSquareFootage!;

  // 0007 expansion — partial-update guards mirror the legacy `if (value)` style.
  if (row.moveInDate) values.moveInDate = row.moveInDate;
  if (row.lotNumber) values.lotNumber = row.lotNumber;
  if (row.elevationType) values.elevationType = row.elevationType;
  if (row.materialType) values.materialType = row.materialType;
  values.isModelHome = row.isModelHome; // 0|1 — always known
  if (row.startType) values.startType = row.startType;
  if (row.constructionStageIndex != null) values.constructionStageIndex = row.constructionStageIndex;
  if (row.estimatedSettlementDate) values.estimatedSettlementDate = row.estimatedSettlementDate;

  // City: singleSelect name (option-gated) + link-by-id (always when resolves)
  if (row.city) {
    if (lk.validCities.has(row.city)) values.cityName = row.city;
    const cid = lk.cityByName.get(row.city.toLowerCase());
    if (cid) values.cityId = cid;
    else unresolved++;
  }

  // Community: normalized name
  if (row.communityName) {
    if (lk.validCommunities.has(row.communityName)) values.communityName = row.communityName;
    const comm = lk.communityByName.get(row.communityName.toLowerCase());
    if (comm) values.communityId = comm;
    else unresolved++;
  }

  // Floor Plan: MODEL_NAME (already null when 'UNKNOWN')
  if (row.floorPlan) {
    if (lk.validFloorPlans.has(row.floorPlan)) values.floorPlanName = row.floorPlan;
    const fp = lk.floorPlanByName.get(row.floorPlan.toLowerCase());
    if (fp) values.floorPlanId = fp;
    else unresolved++;
  }

  // price is NOT placed here — its override-protected application is the
  // consumer's job (it needs the row's current Price/last_synced_price). The
  // raw ratifiedSalesPrice rides on the message instead.

  return { values, unresolved };
}

/** Has any allow-listed synced value actually changed vs the existing D1 row? */
export function qmiSyncedChanged(values: SyncedQmiValues, existing: ExistingQmi): boolean {
  const eq = (a: unknown, b: unknown) => {
    if (a === undefined) return true; // field not present in this sync → no change claim
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.001;
    return (a ?? null) === (b ?? null);
  };
  return !(
    eq(values.address, existing.synced_address) &&
    eq(values.postalCode, existing.synced_postal_code) &&
    eq(values.bedroomCount, existing.synced_bedroom_count) &&
    eq(values.bathroomCount, existing.synced_bathroom_count) &&
    eq(values.halfBathroomCount, existing.synced_half_bathroom_count) &&
    eq(values.livingSquareFootage, existing.synced_living_square_footage) &&
    eq(values.totalSquareFootage, existing.synced_total_square_footage) &&
    eq(values.elevation, existing.synced_elevation) &&
    eq(values.constructionStage, existing.synced_construction_stage) &&
    eq(values.moveInDate, existing.synced_move_in_date) &&
    eq(values.lotNumber, existing.synced_lot_number) &&
    eq(values.elevationType, existing.synced_elevation_type) &&
    eq(values.materialType, existing.synced_material_type) &&
    eq(values.isModelHome, existing.synced_is_model_home) &&
    eq(values.startType, existing.synced_start_type) &&
    eq(values.constructionStageIndex, existing.synced_construction_stage_index) &&
    eq(values.estimatedSettlementDate, existing.synced_estimated_settlement_date) &&
    eq(values.cityId, existing.synced_city_id) &&
    eq(values.cityName, existing.synced_city_name) &&
    eq(values.communityId, existing.synced_community_id) &&
    eq(values.floorPlanId, existing.synced_floor_plan_id) &&
    eq(values.floorPlanName, existing.synced_floor_plan_name) &&
    eq(values.markJobNumber, existing.mark_job_number)
  );
}

/**
 * The diff. Compares the Snowflake spec-home set against the existing D1 rows and
 * emits per-record messages.
 *
 *  - matched by snowflakeKey(eci) → existingByEci; fallback housenumber|community
 *  - NEW (no match)               → qmi.upsert{isNew:true} (consumer inserts pub=0)
 *  - EXISTING + synced changed    → qmi.upsert{isNew:false}
 *  - EXISTING with eci NOT in the Snowflake set AND currently published===1
 *                                 → qmi.unpublish (force published=0). Rows
 *                                   WITHOUT eci_key (pre-migration) are skipped.
 *  - Communities: square_footage_range changed → community.upsert
 */
export function diff(
  snowflakeQmis: SnowflakeQmiRow[],
  snowflakeCommunities: SnowflakeCommunityRow[],
  existingQmis: ExistingQmi[],
  lookups: Lookups,
  // 0007 expansion (optional for compatibility with pre-0007 callers/tests):
  snowflakeFloorPlans: SnowflakeFloorPlanRow[] = [],
  existingCommunities: ExistingCommunity[] = [],
  existingFloorPlans: ExistingFloorPlan[] = [],
  communityPriceFrom: Map<string, number> = new Map(),
  /** Operator force: bypass the over-published fraction heuristic (see evaluateUnpublishGuard). */
  forceUnpublish = false
): DiffResult {
  const messages: SyncMessage[] = [];
  const stats = {
    qmisCreated: 0,
    qmisUpdated: 0,
    qmisUnpublished: 0,
    qmisInSnowflake: snowflakeQmis.length,
    communitiesUpdated: 0,
    floorPlansUpdated: 0,
    unresolvedLinks: 0,
  };
  const existingCommById = new Map(existingCommunities.map((c) => [c.id, c]));
  const existingFpByName = new Map(
    existingFloorPlans.filter((f) => f.name).map((f) => [f.name!.toLowerCase(), f])
  );

  const existingByEci = new Map<string, ExistingQmi>();
  const existingByHnCommunity = new Map<string, ExistingQmi>();
  for (const e of existingQmis) {
    const k = snowflakeKey(e.eci_key);
    if (k) existingByEci.set(k, e);
    const hn = (e.housenumber ?? '').trim();
    const c = (e.synced_community_name ?? '').trim().toLowerCase();
    if (hn && c) existingByHnCommunity.set(`${hn}|${c}`, e);
  }

  const snowflakeEcis = new Set<string>();

  for (const row of snowflakeQmis) {
    const key = snowflakeKey(row.eciKey);
    if (key) snowflakeEcis.add(key);

    const { values, unresolved } = buildQmiSyncedValues(row, lookups);
    stats.unresolvedLinks += unresolved;

    let match: ExistingQmi | undefined = key ? existingByEci.get(key) : undefined;
    if (!match) {
      const hn = row.housenumber.trim();
      const c = row.communityName.trim().toLowerCase();
      if (hn && c) match = existingByHnCommunity.get(`${hn}|${c}`);
    }

    if (!match) {
      // NEW spec → consumer inserts (published=0, slug from address)
      messages.push({
        kind: 'qmi.upsert',
        snowflakeKey: key ?? '',
        qmiId: null,
        values,
        isNew: true,
        slugSource: row.address || null,
        ratifiedSalesPrice: row.ratifiedSalesPrice,
      });
      stats.qmisCreated++;
    } else if (
      qmiSyncedChanged(values, match) ||
      priceWillChange(row.ratifiedSalesPrice, match)
    ) {
      // EXISTING + something changed → upsert (no Published written on updates)
      messages.push({
        kind: 'qmi.upsert',
        snowflakeKey: key ?? '',
        qmiId: match.id,
        values,
        isNew: false,
        slugSource: null,
        ratifiedSalesPrice: row.ratifiedSalesPrice,
      });
      stats.qmisUpdated++;
    }
    // else: no-op (avoid queue churn)
  }

  // SOLD / REMOVED: existing rows WITH eci_key not present in Snowflake AND
  // currently published → unpublish (force =0). No-eci rows skipped.
  // Candidates are collected first and gated by the mass-unpublish guard: a
  // truncated Snowflake result must NOT unpublish the catalog (2026-06-11).
  const unpublishCandidates: QmiUnpublishMessage[] = [];
  let publishedEciCount = 0;
  let eciKeyedCount = 0;
  for (const e of existingQmis) {
    const k = snowflakeKey(e.eci_key);
    if (!k) continue; // pre-migration row → skip
    eciKeyedCount++;
    if (e.published === 1) publishedEciCount++;
    if (!snowflakeEcis.has(k) && e.published === 1) {
      unpublishCandidates.push({ kind: 'qmi.unpublish', snowflakeKey: k, qmiId: e.id });
    }
  }
  const unpublishGuard = evaluateUnpublishGuard(
    unpublishCandidates.length,
    publishedEciCount,
    eciKeyedCount,
    snowflakeQmis.length,
    forceUnpublish
  );
  if (!unpublishGuard.tripped) {
    messages.push(...unpublishCandidates);
    stats.qmisUnpublished = unpublishCandidates.length;
  }

  // Communities: sqft range + bed/bath ranges + price_from (0007), with change
  // detection so an unchanged community emits NO message (no queue/framer churn).
  for (const c of snowflakeCommunities) {
    const key = c.communityName.toLowerCase();
    const id = lookups.communityByName.get(key);
    if (!id) {
      stats.unresolvedLinks++;
      continue;
    }
    const values: SyncedCommunityValues = {
      squareFootageRange: squareFootageRange(c.minSqft, c.maxSqft),
      bedCountRange: countRange(c.minBeds, c.maxBeds),
      bathCountRange: countRange(c.minBaths, c.maxBaths),
    };
    const priceFrom = communityPriceFrom.get(key);
    if (priceFrom != null) values.priceFrom = priceFrom;

    const existing = existingCommById.get(id);
    if (existing && !communitySyncedChanged(values, existing)) continue;
    messages.push({ kind: 'community.upsert', communityId: id, values });
    stats.communitiesUpdated++;
  }

  // Floor Plans (0007): DM_FLOOR_PLAN aggregates matched to D1 rows by name.
  // Unmatched models are counted as unresolved links (visible in sync_log).
  for (const f of snowflakeFloorPlans) {
    const existing = existingFpByName.get(f.modelName.toLowerCase());
    if (!existing) {
      stats.unresolvedLinks++;
      continue;
    }
    const values: SyncedFloorPlanValues = {};
    if (f.bedroomMin != null) values.bedroomMin = f.bedroomMin;
    if (f.bedroomMax != null) values.bedroomMax = f.bedroomMax;
    if (f.bathroomMin != null) values.bathroomMin = f.bathroomMin;
    if (f.bathroomMax != null) values.bathroomMax = f.bathroomMax;
    if (f.livingSquareFootage != null) values.livingSquareFootage = f.livingSquareFootage;
    if (f.totalSquareFootage != null) values.totalSquareFootage = f.totalSquareFootage;
    if (f.startingPrice != null) values.startingPrice = f.startingPrice;
    if (!floorPlanSyncedChanged(values, existing)) continue;
    messages.push({ kind: 'floorplan.upsert', floorPlanId: existing.id, values });
    stats.floorPlansUpdated++;
  }

  return { messages, stats, unpublishGuard };
}

/** Has any synced community value actually changed vs the existing D1 row? */
export function communitySyncedChanged(
  values: SyncedCommunityValues,
  existing: ExistingCommunity
): boolean {
  const eq = (a: unknown, b: unknown) => {
    if (a === undefined) return true;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.001;
    return (a ?? null) === (b ?? null);
  };
  return !(
    eq(values.squareFootageRange, existing.synced_square_footage_range) &&
    eq(values.bedCountRange, existing.synced_bed_count) &&
    eq(values.bathCountRange, existing.synced_bath_count) &&
    eq(values.priceFrom, existing.synced_price_from)
  );
}

/** Has any synced floor-plan value actually changed vs the existing D1 row? */
export function floorPlanSyncedChanged(
  values: SyncedFloorPlanValues,
  existing: ExistingFloorPlan
): boolean {
  const eq = (a: unknown, b: unknown) => {
    if (a === undefined) return true;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.001;
    return (a ?? null) === (b ?? null);
  };
  return !(
    eq(values.bedroomMin, existing.synced_bedroom_min) &&
    eq(values.bedroomMax, existing.synced_bedroom_max) &&
    eq(values.bathroomMin, existing.synced_bathroom_min) &&
    eq(values.bathroomMax, existing.synced_bathroom_max) &&
    eq(values.livingSquareFootage, existing.synced_living_square_footage) &&
    eq(values.totalSquareFootage, existing.synced_total_square_footage) &&
    eq(values.startingPrice, existing.synced_starting_price)
  );
}

/**
 * Will price change under the override-protection rule? Mirrors the consumer
 * logic so the diff doesn't emit a pointless upsert just for price. Only true
 * when Snowflake has a price >0, the row is "in sync" (current==last_synced or
 * either empty), and the new price differs by >= 0.01.
 */
export function priceWillChange(
  ratifiedSalesPrice: number | null,
  existing: ExistingQmi
): boolean {
  if (ratifiedSalesPrice == null || !(ratifiedSalesPrice > 0)) return false;
  const current = existing.synced_price; // ingest compares against the synced anchor
  const lastSynced = existing.last_synced_price;
  const inSync =
    current == null ||
    lastSynced == null ||
    Math.abs(Number(current) - Number(lastSynced)) < 0.01;
  if (!inSync) return false;
  return Math.abs(Number(current ?? 0) - ratifiedSalesPrice) >= 0.01;
}
