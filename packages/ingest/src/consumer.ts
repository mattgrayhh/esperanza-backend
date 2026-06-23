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

import { deriveAvailabilityText, isAutoAvailabilityText } from './availability.js';
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

// =============================================================================
// Framer-push hand-off (event-driven D1 → Framer). After a successful synced
// D1 write the consumer enqueues onto esperanza-framer-queue using the EXACT
// shape framer-push's consumer expects (FramerSyncMessage in
// packages/framer-push/src/types.ts): { collection, action:'upsert', id }.
// The message carries NO field values — framer-push re-reads the full row from
// D1 by id. We only ever emit 'upsert' (an unpublish re-reads as published=0 →
// framer-push pushes it with draft:true, which hides the page). This type is
// declared locally (ingest does not depend on framer-push) but is identical to
// the contract enforced there.
// =============================================================================

/** A subset of the framer-push CollectionKey union — the three ingest can touch. */
export type FramerCollectionKey = 'qmi' | 'communities' | 'floor_plans';

/** The framer-push queue message shape (id-only; framer-push re-reads the row). */
export interface FramerSyncMessage {
  collection: FramerCollectionKey;
  action: 'upsert';
  id: string;
}

/** Cloudflare Queues producer binding (the subset we use). */
export interface FramerQueueProducer {
  send(body: unknown): Promise<void>;
  sendBatch(messages: { body: unknown }[]): Promise<void>;
}

export interface ConsumerEnv {
  DB: D1Like;
  /**
   * Producer binding for esperanza-framer-queue. Optional so unit tests that
   * exercise only the D1 write path can omit it; in production index.ts's Env
   * always binds it (wrangler.toml [[queues.producers]] FRAMER_QUEUE).
   */
  FRAMER_QUEUE?: FramerQueueProducer;
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
 * Result of applying one message. Counters feed sync_log aggregation; `framer`
 * carries the Framer-push messages to enqueue for the rows this write touched
 * (only populated after a successful D1 write — see each apply* function).
 */
export interface ApplyResult {
  created: number;
  updated: number;
  unpublished: number;
  communities: number;
  floorPlans: number;
  priceUpdated: number;
  /** Framer-push hand-off messages for the row(s) written by this message. */
  framer: FramerSyncMessage[];
}

const emptyResult = (): ApplyResult => ({
  created: 0,
  updated: 0,
  unpublished: 0,
  communities: 0,
  floorPlans: 0,
  priceUpdated: 0,
  framer: [],
});

/**
 * Apply a single message. Exported so tests can drive it against a better-sqlite3
 * DB via a thin D1Like adapter. Returns a small result for sync_log aggregation
 * plus the Framer-push messages to enqueue for the affected row(s).
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

  if (msg.isNew) {
    // INSERT new spec: published=0, seed slug from address, plus the synced patch.
    // availability_text (derived, NOT part of the synced allow-list — see header)
    // is seeded from the move-in date so the Framer badge never falls back to the
    // raw ISO date. No date → leave it absent (NULL).
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
    // Event-driven push: the new (draft) home flows to Framer immediately and
    // surfaces as draft:true (hidden) until admin publishes — which is correct.
    result.framer.push({ collection: 'qmi', action: 'upsert', id });
    // TODO(pdf): call ensurePdfRender(q, r, 'qmi', id, baseUrl) here on synced create.
    // Wire at cutover: add PDF_PUBLIC_BASE_URL to ConsumerEnv + thread baseUrl from env.
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

  const setClause = [...Object.keys(patch).map((c) => `${c} = ?`), ...setExtra].join(', ');
  const vals = [...Object.values(patch), ...valsExtra, nowIso(), msg.qmiId];
  await env.DB.prepare(
    `UPDATE qmi SET ${setClause}, updated_at = ? WHERE id = ?`
  )
    .bind(...vals)
    .run();
  result.updated = 1;
  // Event-driven push: the changed synced values flow to Framer immediately.
  result.framer.push({ collection: 'qmi', action: 'upsert', id: msg.qmiId });
  return result;
}

async function applyQmiUnpublish(env: ConsumerEnv, msg: QmiUnpublishMessage): Promise<ApplyResult> {
  const result = emptyResult();
  // SOLD/REMOVED: force published = 0 ONLY. The query guards published=1 so an
  // already-unpublished row is a no-op, and there is NO branch that sets =1.
  await env.DB.prepare(
    `UPDATE qmi SET published = 0, updated_at = ? WHERE id = ? AND published = 1`
  )
    .bind(nowIso(), msg.qmiId)
    .run();
  result.unpublished = 1;
  // Event-driven push: framer-push re-reads the row, sees published=0, and pushes
  // it with draft:true (soft-delete — the page is hidden). Always 'upsert'.
  result.framer.push({ collection: 'qmi', action: 'upsert', id: msg.qmiId });
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
  // Event-driven push: the changed square-footage range flows to Framer.
  result.framer.push({ collection: 'communities', action: 'upsert', id: msg.communityId });
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
  // Event-driven push: the changed synced plan values flow to Framer.
  result.framer.push({ collection: 'floor_plans', action: 'upsert', id: msg.floorPlanId });
  return result;
}

/** New QMI id. Pre-migration ids are Airtable recXXXX; new specs get a rec-like uuid. */
export function newQmiId(): string {
  return 'rec' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
}

/**
 * The linked floor plan's header image, preferring the admin-set image_url and
 * falling back to the synced rendering — the same source framer-push uses for the
 * promotions/testimonials floor-plan image fallback. Returns null when the plan
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
  const agg = { created: 0, updated: 0, unpublished: 0, communities: 0, floorPlans: 0, priceUpdated: 0 };
  let errors = 0;
  let lastError: string | null = null;
  // Framer-push hand-off messages accumulated ONLY from successful D1 writes.
  const framerOut: FramerSyncMessage[] = [];

  for (const m of batch.messages) {
    try {
      const r = await applyMessage(env, m.body);
      agg.created += r.created;
      agg.updated += r.updated;
      agg.unpublished += r.unpublished;
      agg.communities += r.communities;
      agg.floorPlans += r.floorPlans;
      agg.priceUpdated += r.priceUpdated;
      // Enqueue the Framer push only after the D1 write succeeded (applyMessage
      // returned without throwing). A throwing message lands in the catch below
      // and contributes NO framer hand-off.
      framerOut.push(...r.framer);
      m.ack();
    } catch (err) {
      errors++;
      lastError = err instanceof Error ? err.message : String(err);
      m.retry(); // independent retry → DLQ after max_retries
    }
  }

  // Event-driven D1 → Framer: push the changed rows onto esperanza-framer-queue.
  // framer-push's consumer re-reads each row by id and upserts it into Framer.
  // Best-effort: a transport failure here must not fail the ingest write (the
  // nightly framer-push lookback backstop re-covers any dropped row).
  if (framerOut.length > 0) {
    await enqueueFramer(env, framerOut);
  }

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
    notes: `consumer batch of ${batch.messages.length} message(s); framer-push enqueued ${framerOut.length}`,
    errorMessage: lastError,
  });
}

/**
 * Enqueue Framer-push hand-off messages in chunks (Queues sendBatch cap is
 * 100/256KB; chunk at 100). No-op when FRAMER_QUEUE is unbound (unit tests). A
 * send failure is swallowed (logged) so it never poisons the ingest write — the
 * nightly framer-push lookback re-covers anything dropped here.
 */
export async function enqueueFramer(env: ConsumerEnv, messages: FramerSyncMessage[]): Promise<void> {
  const q = env.FRAMER_QUEUE;
  if (!q || messages.length === 0) return;
  const CHUNK = 100;
  try {
    for (let i = 0; i < messages.length; i += CHUNK) {
      const slice = messages.slice(i, i + CHUNK).map((body) => ({ body }));
      await q.sendBatch(slice);
    }
  } catch (err) {
    // Don't fail the batch on a framer-queue transport error — the rows are
    // already in D1 and the nightly lookback backstop will re-enqueue them.
    console.error('framer-push enqueue failed (backstop will recover):', err);
  }
}
