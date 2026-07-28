// =============================================================================
// esperanza-cf — queue consumer. Migration Plan v2, Phase 3 / Decision #10.
//
// Drains esperanza-sync-queue and applies ONLY allow-listed synced columns via
// applySynced(). The consumer has NO code path that can write an admin-owned or
// override_* column:
//   * applySynced(values) draws its output keys EXCLUSIVELY from QMI_SYNCED_COLUMNS.
//   * assertQmiPatchAllowed() re-checks the final patch before the DB write
//     (defense-in-depth — a hand-built patch can't smuggle a forbidden column).
//   * published is written by a SEPARATE, narrow path that can only set 0
//     (forceUnpublish) on the sold/removed transition; insert seeds 0; NEVER 1.
//   * availability_text is a SEPARATE, narrow DERIVED path (it is NOT in the
//     allow-list and never flows through applySynced): on insert, and on update
//     when the EFFECTIVE move-in date (COALESCE(override, synced)) actually
//     changes, the consumer writes the canonical "Available JUN/JUL 2026" /
//     "Available Now" text — but ONLY when the stored value is empty or itself
//     machine-generated (isAutoAvailabilityText). Admin-authored copy survives
//     every ingest cycle. See ./availability.ts.
//
// Price (Decision #6): in the D1 bucketed model the admin's manual price lives in
// `override_price` (the view COALESCEs override over synced). Ingest owns
// `synced_price` + the `last_synced_price` shadow and updates them freely from
// Snowflake — it NEVER touches override_price, so an admin override survives every
// ingest cycle structurally. last_synced_price is kept in lockstep with
// synced_price as the divergence anchor / diagnostic.
// =============================================================================

import {
  deriveAvailabilityText,
  firstFilled,
  isAutoAvailabilityText,
  isPublishReady,
} from './availability.js';
import { ensurePdfRender } from '@esperanza/db/pdf-ensure';
import { affectedRenderKeys } from '@esperanza/db/pdf-invalidate';
import { PUBLIC_CACHE_ALWAYS, purgePublicCacheEntities } from '@esperanza/db/public-cache-purge';
import {
  applySynced,
  assertQmiPatchAllowed,
  applySyncedCommunity,
  assertCommunityPatchAllowed,
  applySyncedFloorPlan,
  assertFloorPlanPatchAllowed,
} from './synced.js';
import type {
  SyncMessage,
  QmiUpsertMessage,
  QmiUnpublishMessage,
  QmiPublishMessage,
  CommunityUpsertMessage,
  FloorPlanUpsertMessage,
} from './diff.js';

/** Minimal D1 surface (the subset of @cloudflare/workers-types D1Database we use). */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(colName?: string): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

export interface ConsumerEnv {
  DB: D1Like;
  /**
   * Public base of the esperanza-pdf worker (e.g.
   * https://esperanza-pdf.<sub>.workers.dev). When set, a synced QMI create
   * self-registers a pdf_renders row + backfills qmi.dynamic_pdf so the home's
   * Dynamic PDF exists without a manual seed (renders on first fetch, same as
   * seed-renders). Optional so unit tests can omit it.
   */
  PDF_PUBLIC_BASE_URL?: string;
  /**
   * Public base of the esperanza-api worker. When set, the consumer purges the
   * api's edge cache for each entity type a batch touched (GET ?purge=1 with
   * X-Purge-Key) so synced changes show before the TTL. Optional for tests.
   */
  API_PUBLIC_URL?: string;
  /** Secret the api requires on authenticated purges (X-Purge-Key header). */
  PURGE_KEY?: string;
  /** Service binding to esperanza-api (preferred for post-batch cache purges). */
  API?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

/** kebab slug from an address (worker.js:503-505): lower, [^a-z0-9]+→'-', strip trailing '-'. */
export function deriveSlug(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const nowIso = () => new Date().toISOString();

/**
 * Result of applying one message. Counters feed sync_log aggregation.
 */
export interface ApplyResult {
  created: number;
  updated: number;
  unpublished: number;
  published: number;
  communities: number;
  floorPlans: number;
  priceUpdated: number;
}

/**
 * Mark the PDF brochures affected by a synced update stale, so the pdf worker
 * re-renders them on next read (serve.ts stale-present path) — the same
 * affectedRenderKeys fan-out + UPDATE-stale pattern the admin uses
 * (packages/admin/lib/actions.ts postWrite). No queue producer here by design:
 * stale rows re-render lazily. Best-effort — a PDF hiccup never fails the
 * synced D1 write.
 */
async function markPdfStale(
  env: ConsumerEnv,
  entity: 'qmi' | 'communities' | 'floor_plans',
  id: string
): Promise<void> {
  try {
    const q = async (sql: string, binds: unknown[]) =>
      (await env.DB.prepare(sql).bind(...binds).all()).results as any[];
    const keys = await affectedRenderKeys(q, entity, id);
    for (const k of keys) {
      if (k.type === 'list') {
        await env.DB.prepare(
          `UPDATE pdf_renders SET status='stale' WHERE type='list' AND city_slug=? AND status<>'rendering'`
        )
          .bind(k.citySlug)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE pdf_renders SET status='stale' WHERE type=? AND entity_id=? AND status<>'rendering'`
        )
          .bind(k.type, k.entityId)
          .run();
      }
    }
  } catch (e) {
    console.error('[ingest:pdf-stale]', entity, id, e);
  }
}

const emptyResult = (): ApplyResult => ({
  created: 0,
  updated: 0,
  unpublished: 0,
  published: 0,
  communities: 0,
  floorPlans: 0,
  priceUpdated: 0,
});

/**
 * Apply a single message. Exported so tests can drive it against a better-sqlite3
 * DB via a thin D1Like adapter. Returns a small result for sync_log aggregation.
 */
export async function applyMessage(
  env: ConsumerEnv,
  msg: SyncMessage
): Promise<ApplyResult> {
  switch (msg.kind) {
    case 'qmi.upsert':
      return applyQmiUpsert(env, msg);
    case 'qmi.unpublish':
      return applyQmiUnpublish(env, msg);
    case 'qmi.publish':
      return applyQmiPublish(env, msg);
    case 'community.upsert':
      return applyCommunityUpsert(env, msg);
    case 'floorplan.upsert':
      return applyFloorPlanUpsert(env, msg);
  }
}

async function applyQmiUpsert(env: ConsumerEnv, msg: QmiUpsertMessage): Promise<ApplyResult> {
  const result = emptyResult();

  // Build the synced patch — STRUCTURALLY only allow-listed columns can appear.
  const patch = applySynced(msg.values);

  // Price: ingest owns synced_price + last_synced_price. Write both in lockstep
  // when Snowflake has a real price. override_price is never referenced here.
  if (msg.ratifiedSalesPrice != null && msg.ratifiedSalesPrice > 0) {
    patch['synced_price'] = msg.ratifiedSalesPrice;
    patch['last_synced_price'] = msg.ratifiedSalesPrice;
    result.priceUpdated = 1;
  }

  // Defense-in-depth: no forbidden column may be present.
  assertQmiPatchAllowed(patch);

  // Dup guard (0025; real incident: 4122 Westway Court inserted twice with the same
  // eci_key 003HC00000046 when the diff missed the existing row). eci_key is the
  // DM_HOUSE natural key — if a row already carries this one, route the message to
  // the UPDATE path against that row instead of inserting a duplicate.
  if (msg.isNew && patch['eci_key'] != null) {
    const dup = await env.DB.prepare('SELECT id FROM qmi WHERE eci_key = ?')
      .bind(patch['eci_key'])
      .first<{ id: string }>();
    if (dup) msg = { ...msg, isNew: false, qmiId: dup.id };
  }

  if (msg.isNew) {
    // INSERT new spec: published=0, seed slug from address, plus the synced patch.
    // availability_text (derived, NOT part of the synced allow-list — see header)
    // is seeded from the move-in date so the availability badge never falls back
    // to the raw ISO date. No date → leave it absent (NULL).
    const slug = msg.slugSource ? deriveSlug(msg.slugSource) : null;
    const id = newQmiId();
    const availabilityText = deriveAvailabilityText(
      msg.values.moveInDate,
      undefined,
      msg.values.constructionStage
    );
    // Header image: a new housenumber usually already carries a floor plan, so seed
    // qmi.image_url from that plan's rendering. image_url is admin-owned (NOT in the
    // synced allow-list — see synced.ts), so the seed lives here outside applySynced,
    // the same "derived, seed-on-insert, never-clobber-on-update" path availability_text
    // uses. The marketing user can override it; with it set, the home renders on the
    // /new-homes/available listing (which hides imageless cards). NULL → leave absent.
    const seedImageUrl = msg.values.floorPlanId
      ? await floorPlanImageUrl(env, msg.values.floorPlanId)
      : null;
    const cols = ['id', 'published', 'slug', 'created_at', 'updated_at', ...Object.keys(patch)];
    const vals: unknown[] = [id, 0, slug, nowIso(), nowIso(), ...Object.values(patch)];
    if (availabilityText !== null) {
      cols.push('availability_text');
      vals.push(availabilityText);
    }
    if (seedImageUrl !== null) {
      cols.push('image_url');
      vals.push(seedImageUrl);
    }
    const placeholders = cols.map(() => '?').join(', ');
    await env.DB.prepare(
      `INSERT INTO qmi (${cols.join(', ')}) VALUES (${placeholders})`
    )
      .bind(...vals)
      .run();
    result.created = 1;
    // Self-register the Dynamic PDF: create a not_built pdf_renders row + backfill
    // qmi.dynamic_pdf. The PDF renders on first fetch (serve.ts cold-render path),
    // the same lazy mechanism seed-renders relies on — no render-queue binding here.
    // Best-effort: a PDF hiccup must never fail the synced D1 write.
    if (env.PDF_PUBLIC_BASE_URL) {
      try {
        const q = async (sql: string, binds: unknown[]) =>
          (await env.DB.prepare(sql).bind(...binds).all()).results as any[];
        const r = async (sql: string, binds: unknown[]) => {
          await env.DB.prepare(sql).bind(...binds).run();
        };
        await ensurePdfRender(q, r, 'qmi', id, env.PDF_PUBLIC_BASE_URL);
      } catch (e) {
        console.error('[ingest:ensurePdfRender]', id, e);
      }
    }
    return result;
  }

  // UPDATE existing: synced patch only (Published untouched on updates).
  if (!msg.qmiId) return result; // defensive: no id, nothing to update
  if (Object.keys(patch).length === 0) return result;

  // Derived availability_text refresh (separate narrow path — see header).
  // Only considered when the message carries a move-in date; the text is
  // recomputed ONLY when the EFFECTIVE date (COALESCE(override, synced))
  // actually changes, and ONLY over an empty/machine-generated stored value.
  const setExtra: string[] = [];
  const valsExtra: unknown[] = [];
  // Refresh the derived availability_text when the effective move-in DATE or the
  // CONSTRUCTION STAGE changes (a home reaching 'Buyer Sign Off' becomes "Available
  // Now"), but only over machine-generated text — admin-authored copy is preserved.
  if ('synced_move_in_date' in patch || 'synced_construction_stage' in patch) {
    const current = await env.DB.prepare(
      `SELECT synced_move_in_date, override_move_in_date, availability_text,
              synced_construction_stage, override_construction_stage
         FROM qmi WHERE id = ?`
    )
      .bind(msg.qmiId)
      .first<{
        synced_move_in_date: string | null;
        override_move_in_date: string | null;
        availability_text: string | null;
        synced_construction_stage: string | null;
        override_construction_stage: string | null;
      }>();
    if (current && isAutoAvailabilityText(current.availability_text)) {
      const oldDate = current.override_move_in_date ?? current.synced_move_in_date;
      const newDate =
        current.override_move_in_date ??
        ('synced_move_in_date' in patch
          ? (patch['synced_move_in_date'] as string | null)
          : current.synced_move_in_date);
      const oldStage = current.override_construction_stage ?? current.synced_construction_stage;
      const newStage =
        current.override_construction_stage ??
        ('synced_construction_stage' in patch
          ? (patch['synced_construction_stage'] as string | null)
          : current.synced_construction_stage);
      if (newDate !== oldDate || newStage !== oldStage) {
        const text = deriveAvailabilityText(newDate, undefined, newStage);
        if (text !== null) {
          setExtra.push('availability_text = ?');
          valsExtra.push(text);
        }
      }
    }
  }

  // Header image self-heal: fill image_url from the linked plan when it is still NULL.
  // The insert-seed only runs at CREATE, so a home that landed before its plan had a
  // rendering (or before the plan link resolved) stayed imageless forever — that is why a
  // whole class of available homes never surfaced (imaged-only publish gate). Fill ONLY
  // over NULL — an admin-set image is never overridden (same ownership rule as
  // availability_text). This makes the seed durable instead of a one-shot backfill.
  const curImg = await env.DB.prepare(
    `SELECT image_url, COALESCE(override_floor_plan_id, synced_floor_plan_id) AS fp_id
       FROM qmi WHERE id = ?`
  )
    .bind(msg.qmiId)
    .first<{ image_url: string | null; fp_id: string | null }>();
  if (curImg && curImg.image_url == null && curImg.fp_id) {
    const seed = await floorPlanImageUrl(env, curImg.fp_id);
    if (seed !== null) {
      setExtra.push('image_url = ?');
      valsExtra.push(seed);
    }
  }

  const setClause = [...Object.keys(patch).map((c) => `${c} = ?`), ...setExtra].join(', ');
  const vals = [...Object.values(patch), ...valsExtra, nowIso(), msg.qmiId];
  await env.DB.prepare(
    `UPDATE qmi SET ${setClause}, updated_at = ? WHERE id = ?`
  )
    .bind(...vals)
    .run();
  result.updated = 1;
  // Synced changes (price/spec/stage) make the home's Dynamic PDF stale — the
  // insert path self-registers (PR#99) but updates used to leave the old PDF
  // forever. Ensure the render row exists, then mark the fan-out stale.
  if (env.PDF_PUBLIC_BASE_URL) {
    try {
      const q = async (sql: string, binds: unknown[]) =>
        (await env.DB.prepare(sql).bind(...binds).all()).results as any[];
      const r = async (sql: string, binds: unknown[]) => {
        await env.DB.prepare(sql).bind(...binds).run();
      };
      await ensurePdfRender(q, r, 'qmi', msg.qmiId, env.PDF_PUBLIC_BASE_URL);
    } catch (e) {
      console.error('[ingest:ensurePdfRender]', msg.qmiId, e);
    }
  }
  await markPdfStale(env, 'qmi', msg.qmiId);
  return result;
}

// ── Attribution for machine publish/unpublish ────────────────────────────────
// The ingest writes sync_log; the admin's own edit history reads audit_log. Until
// 2026-07-28 a sync-driven publish therefore left NO actor and NO row anywhere the
// admin surfaces, so ~150 auto-published homes looked like anonymous edits and the
// marketing team could not tell who had put them live ("shows published, but this was
// not published by me"). Every machine flip of `published` now records itself with a
// machine actor, so the admin can answer "why is this home live?".
//
// GUARANTEED, not best-effort (2026-07-28 review). The flip and its audit row go out as
// ONE D1 batch, which D1 runs in a single implicit transaction: either the home changes
// state AND the row says who changed it, or neither happens. An earlier version wrote the
// audit afterwards and swallowed its failure, which meant a publish could still land with
// no actor — recreating, in the narrow failure case, the exact "shows published, but not
// by me" confusion this code exists to end. A silently unattributed flip is the bug; a
// publish deferred to the next cycle is not. handleQueueBatch retries the message
// independently and DLQs it after max_retries, so a persistent audit failure surfaces in
// sync_log rather than quietly shedding attribution.
export const INGEST_ACTOR = 'ingest-autopublish';

/**
 * Flip `published` and record who did it, atomically. Returns the number of rows the
 * flip actually changed (0 = already in that state, nothing written).
 *
 * The audit INSERT goes FIRST and is guarded on the PRE-flip value via INSERT…SELECT, so
 * within the transaction it matches exactly the rows the UPDATE is about to change. That
 * is what keeps a no-op flip from writing an audit row claiming a change that never
 * happened — the previous `if (changedRows > 0)` check could not be used here, because
 * both statements are submitted together and there is no point between them to branch on.
 */
async function flipPublishedWithAudit(
  env: ConsumerEnv,
  qmiId: string,
  to: 0 | 1,
  reason: string
): Promise<number> {
  const from = to === 1 ? 0 : 1;
  const action = to === 1 ? 'publish' : 'unpublish';
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_log (entity, entity_id, field, action, old_value, new_value, actor)
         SELECT 'qmi', id, 'published', ?, ?, ?, ?
           FROM qmi WHERE id = ? AND published = ?`
      ).bind(action, String(from), String(to), INGEST_ACTOR, qmiId, from),
      env.DB.prepare(
        `UPDATE qmi SET published = ?, updated_at = ? WHERE id = ? AND published = ?`
      ).bind(to, nowIso(), qmiId, from),
    ]);
    return changedRows(results[1]);
  } catch (err) {
    // Rethrow: the batch rolled back, so the home did NOT change state. Failing the
    // message is what gets it retried; swallowing here would drop the flip silently.
    console.error(
      `[ingest:publish-flip] ${action} ${qmiId} (${reason}) failed and rolled back:`,
      err instanceof Error ? err.message : err
    );
    throw err;
  }
}

async function applyQmiUnpublish(env: ConsumerEnv, msg: QmiUnpublishMessage): Promise<ApplyResult> {
  const result = emptyResult();
  // SOLD/REMOVED: force published = 0 ONLY. The statement guards published=1 so an
  // already-unpublished row is a no-op, and there is NO branch that sets =1.
  await flipPublishedWithAudit(env, msg.qmiId, 0, 'no longer in the Snowflake available set');
  result.unpublished = 1;
  return result;
}

/** D1 reports writes under meta.changes; better-sqlite3 (tests) under changes. */
function changedRows(res: unknown): number {
  const r = res as { meta?: { changes?: number }; changes?: number } | null;
  return r?.meta?.changes ?? r?.changes ?? 0;
}

async function applyQmiPublish(env: ConsumerEnv, msg: QmiPublishMessage): Promise<ApplyResult> {
  const result = emptyResult();
  // RE-AVAILABLE + imaged: set published = 1. The query guards published = 0 so it only
  // flips a currently-hidden row (never touches a live one, and re-running is a no-op).
  // The diff only emits this for homes in the current available Snowflake set that carry
  // an image — the sale-gate + image precondition are enforced upstream. Mirror of
  // applyQmiUnpublish in the opposite direction (the direction ingest previously lacked).
  //
  // READINESS RE-CHECK (2026-07-28 review). The diff enforces isPublishReady before
  // emitting this message, but the message carries only an id — it is an INTENT, and a
  // queue message can be delivered late or retried after a failure. By the time it lands
  // the home's stage or move-in date may have moved, or an admin may have set an override
  // to hold it back; flipping published = 1 on that stale intent would put an unready
  // home on the site through the very path this gate exists to close. So the decision is
  // re-made here against the row as it stands NOW.
  //
  // Deliberately fail-closed. Queues do not guarantee ordering, so this run's
  // qmi.upsert may not have landed yet and D1 may still hold pre-run values — in which
  // case a genuinely-ready home is skipped and the next cycle publishes it. A one-cycle
  // delay is the correct trade against publishing a pad.
  //
  // No incoming-feed value is available here, and that is the point: current D1 state
  // (override first, exactly as v_public_qmi COALESCEs) is what a visitor would see.
  //
  // image_url is re-read for the same reason. It is the producer's OTHER precondition —
  // un-imaged homes are held back so no card renders blank — and an admin can clear an
  // image between the diff and delivery just as easily as a stage can move.
  //
  // The one precondition that CANNOT be re-checked here is presence in the Snowflake
  // available set: the consumer has no feed. That gap is self-healing rather than
  // unguarded — a home published while absent from the feed is published = 1 on the next
  // run, which is exactly what the unpublish leg triggers on, so the following cycle
  // takes it back down. Readiness drift is the case that does NOT self-heal, which is
  // why the diff reports it for a human instead.
  const row = await env.DB.prepare(
    `SELECT published, image_url, override_construction_stage, synced_construction_stage,
            override_move_in_date, synced_move_in_date
       FROM qmi WHERE id = ?`
  )
    .bind(msg.qmiId)
    .first<{
      published: number | null;
      image_url: string | null;
      override_construction_stage: string | null;
      synced_construction_stage: string | null;
      override_move_in_date: string | null;
      synced_move_in_date: string | null;
    }>();

  // Row deleted since the message was queued, or already live — nothing to do. (The
  // guarded UPDATE would be a no-op anyway; returning early keeps the log quiet.)
  if (!row || Number(row.published) === 1) return result;

  const stage = firstFilled(row.override_construction_stage, row.synced_construction_stage);
  const moveIn = firstFilled(row.override_move_in_date, row.synced_move_in_date);
  const imaged = (row.image_url ?? '').trim() !== '';
  if (!imaged || !isPublishReady(stage, moveIn)) {
    console.warn(
      `[ingest:publish] SKIPPED ${msg.qmiId} (${msg.snowflakeKey}): stale publish intent — ` +
        `stage=${stage ?? 'none'} moveIn=${moveIn ?? 'none'} imaged=${imaged} ` +
        `no longer passes the publish preconditions`
    );
    return result;
  }

  // Atomic flip + attribution. changedRows is 0 only if the row was flipped between the
  // SELECT above and this batch, in which case there is nothing to attribute.
  const changed = await flipPublishedWithAudit(
    env,
    msg.qmiId,
    1,
    'available in Snowflake, imaged, inside the readiness horizon'
  );
  if (changed > 0) result.published = 1;
  return result;
}

async function applyCommunityUpsert(env: ConsumerEnv, msg: CommunityUpsertMessage): Promise<ApplyResult> {
  const result = emptyResult();
  const patch = applySyncedCommunity(msg.values); // 0007: sqft/bed/bath ranges + price_from
  assertCommunityPatchAllowed(patch);
  if (Object.keys(patch).length === 0) return result;
  const setClause = Object.keys(patch)
    .map((c) => `${c} = ?`)
    .join(', ');
  const vals = [...Object.values(patch), nowIso(), msg.communityId];
  await env.DB.prepare(
    `UPDATE communities SET ${setClause}, updated_at = ? WHERE id = ?`
  )
    .bind(...vals)
    .run();
  result.communities = 1;
  // Rows are already registered (admin/seed) — stale-mark only, no ensure.
  await markPdfStale(env, 'communities', msg.communityId);
  return result;
}

async function applyFloorPlanUpsert(env: ConsumerEnv, msg: FloorPlanUpsertMessage): Promise<ApplyResult> {
  const result = emptyResult();
  const patch = applySyncedFloorPlan(msg.values); // 0007: DM_FLOOR_PLAN write-set
  assertFloorPlanPatchAllowed(patch);
  if (Object.keys(patch).length === 0) return result;
  const setClause = Object.keys(patch)
    .map((c) => `${c} = ?`)
    .join(', ');
  const vals = [...Object.values(patch), nowIso(), msg.floorPlanId];
  await env.DB.prepare(
    `UPDATE floor_plans SET ${setClause}, updated_at = ? WHERE id = ?`
  )
    .bind(...vals)
    .run();
  result.floorPlans = 1;
  // Rows are already registered (admin/seed) — stale-mark only, no ensure.
  await markPdfStale(env, 'floor_plans', msg.floorPlanId);
  return result;
}

/** New QMI id. Pre-migration ids are Airtable recXXXX; new specs get a rec-like uuid. */
export function newQmiId(): string {
  return 'rec' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
}

/**
 * The linked floor plan's header image, preferring the admin-set image_url and
 * falling back to the synced rendering — the same source the public API uses for
 * the promotions/testimonials floor-plan image fallback. Returns null when the plan
 * has no usable image (so the QMI seed stays absent rather than empty-string).
 */
export async function floorPlanImageUrl(
  env: ConsumerEnv,
  floorPlanId: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(image_url, synced_image_url) AS u FROM floor_plans WHERE id = ?`
  )
    .bind(floorPlanId)
    .first<{ u: string | null }>();
  const u = row?.u;
  return typeof u === 'string' && u.trim() !== '' ? u : null;
}

/** Write a sync_log row (operational telemetry, not entity data). */
export async function writeSyncLog(
  env: ConsumerEnv,
  row: {
    runId: string;
    source: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationS: number;
    qmisUpdated?: number;
    qmisCreated?: number;
    qmisUnpublished?: number;
    qmisInSnowflake?: number;
    communitiesUpdated?: number;
    floorPlansUpdated?: number;
    pricesUpdated?: number;
    unresolvedLinks?: number;
    notes?: string | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_log
       (run_id, source, status, started_at, finished_at, duration_s,
        qmis_updated, qmis_created, qmis_unpublished, qmis_in_snowflake,
        communities_updated, floor_plans_updated, prices_updated, unresolved_links, notes, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.runId,
      row.source,
      row.status,
      row.startedAt,
      row.finishedAt,
      row.durationS,
      row.qmisUpdated ?? 0,
      row.qmisCreated ?? 0,
      row.qmisUnpublished ?? 0,
      row.qmisInSnowflake ?? 0,
      row.communitiesUpdated ?? 0,
      row.floorPlansUpdated ?? 0,
      row.pricesUpdated ?? 0,
      row.unresolvedLinks ?? 0,
      row.notes ?? null,
      row.errorMessage ?? null
    )
    .run();
}

// =============================================================================
// Cloudflare Queues entrypoint glue (typed loosely so this module stays testable
// without pulling the full worker types). The real Worker (index.ts) re-exports
// a `queue` handler that calls this.
// =============================================================================

export interface QueueMessageLike<Body> {
  body: Body;
  ack(): void;
  retry(): void;
}
export interface MessageBatchLike<Body> {
  messages: QueueMessageLike<Body>[];
}

// Message kind → api entities to purge (mirrors @esperanza/db/public-cache-purge deps).
const PURGE_DEPS: Record<SyncMessage['kind'], string[]> = {
  'qmi.upsert': ['qmi'],
  'qmi.unpublish': ['qmi'],
  'qmi.publish': ['qmi'],
  'community.upsert': ['communities', 'cities', 'qmi'],
  'floorplan.upsert': ['floorplans', 'qmi'],
};

async function purgeTouchedEntities(env: ConsumerEnv, kinds: Set<SyncMessage['kind']>): Promise<void> {
  if (kinds.size === 0) return;
  const entities = new Set<string>(['promotions', ...PUBLIC_CACHE_ALWAYS]);
  for (const k of kinds) for (const e of PURGE_DEPS[k]) entities.add(e);
  await purgePublicCacheEntities(env, entities);
}

/**
 * Drain a batch. Per-message ack/retry so one poison message doesn't fail the
 * batch (it retries independently up to max_retries, then → DLQ). Aggregates a
 * single sync_log row for the batch.
 */
export async function handleQueueBatch(
  batch: MessageBatchLike<SyncMessage>,
  env: ConsumerEnv
): Promise<void> {
  const startedAt = nowIso();
  const start = Date.now();
  const agg = { created: 0, updated: 0, unpublished: 0, published: 0, communities: 0, floorPlans: 0, priceUpdated: 0 };
  const touchedKinds = new Set<SyncMessage['kind']>();
  let errors = 0;
  let lastError: string | null = null;

  for (const m of batch.messages) {
    try {
      const r = await applyMessage(env, m.body);
      agg.created += r.created;
      agg.updated += r.updated;
      agg.unpublished += r.unpublished;
      agg.published += r.published;
      agg.communities += r.communities;
      agg.floorPlans += r.floorPlans;
      agg.priceUpdated += r.priceUpdated;
      touchedKinds.add(m.body.kind);
      m.ack();
    } catch (err) {
      errors++;
      lastError = err instanceof Error ? err.message : String(err);
      m.retry(); // independent retry → DLQ after max_retries
    }
  }

  // Purge the public api edge cache for the entity types this batch changed so
  // synced edits show before the TTL. One fetch per distinct entity, best-effort.
  await purgeTouchedEntities(env, touchedKinds);

  await writeSyncLog(env, {
    runId: crypto.randomUUID(),
    source: 'snowflake',
    status: errors === 0 ? 'success' : 'partial',
    startedAt,
    finishedAt: nowIso(),
    durationS: (Date.now() - start) / 1000,
    qmisCreated: agg.created,
    qmisUpdated: agg.updated,
    qmisUnpublished: agg.unpublished,
    communitiesUpdated: agg.communities,
    floorPlansUpdated: agg.floorPlans,
    pricesUpdated: agg.priceUpdated,
    notes: `consumer batch of ${batch.messages.length} message(s); ${agg.published} re-published`,
    errorMessage: lastError,
  });
}

/**
 * Drain the DEAD-LETTER queue: one sync_log row per message (status 'dlq') so
 * poison messages are visible on the sync dashboard instead of vanishing, then
 * ack. No re-enqueue — triage the underlying data and re-run the ingest.
 */
export async function handleDlqBatch(
  batch: MessageBatchLike<SyncMessage>,
  env: ConsumerEnv
): Promise<void> {
  for (const m of batch.messages) {
    const body = m.body as Partial<SyncMessage> | undefined;
    try {
      const at = nowIso();
      await writeSyncLog(env, {
        runId: crypto.randomUUID(),
        source: 'snowflake',
        status: 'dlq',
        startedAt: at,
        finishedAt: at,
        durationS: 0,
        notes: `dead-lettered ${body?.kind ?? 'unknown'} message (exhausted max_retries)`,
        errorMessage: JSON.stringify(body ?? null).slice(0, 2000),
      });
      m.ack();
    } catch {
      m.retry(); // sync_log write failed — retry so the dead letter isn't lost silently
    }
  }
}
