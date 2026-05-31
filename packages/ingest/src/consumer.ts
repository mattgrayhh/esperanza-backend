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
//
// Price (Decision #6): in the D1 bucketed model the admin's manual price lives in
// `override_price` (the view COALESCEs override over synced). Ingest owns
// `synced_price` + the `last_synced_price` shadow and updates them freely from
// Snowflake — it NEVER touches override_price, so an admin override survives every
// ingest cycle structurally. last_synced_price is kept in lockstep with
// synced_price as the divergence anchor / diagnostic.
// =============================================================================

import {
  applySynced,
  assertQmiPatchAllowed,
  applySyncedCommunity,
  assertCommunityPatchAllowed,
} from './synced.js';
import type {
  SyncMessage,
  QmiUpsertMessage,
  QmiUnpublishMessage,
  CommunityUpsertMessage,
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
 * Apply a single message. Exported so tests can drive it against a better-sqlite3
 * DB via a thin D1Like adapter. Returns a small result for sync_log aggregation.
 */
export async function applyMessage(
  env: ConsumerEnv,
  msg: SyncMessage
): Promise<{ created: number; updated: number; unpublished: number; communities: number; priceUpdated: number }> {
  switch (msg.kind) {
    case 'qmi.upsert':
      return applyQmiUpsert(env, msg);
    case 'qmi.unpublish':
      return applyQmiUnpublish(env, msg);
    case 'community.upsert':
      return applyCommunityUpsert(env, msg);
  }
}

async function applyQmiUpsert(env: ConsumerEnv, msg: QmiUpsertMessage) {
  const result = { created: 0, updated: 0, unpublished: 0, communities: 0, priceUpdated: 0 };

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
    const slug = msg.slugSource ? deriveSlug(msg.slugSource) : null;
    const id = newQmiId();
    const cols = ['id', 'published', 'slug', 'created_at', 'updated_at', ...Object.keys(patch)];
    const placeholders = cols.map(() => '?').join(', ');
    const vals = [id, 0, slug, nowIso(), nowIso(), ...Object.values(patch)];
    await env.DB.prepare(
      `INSERT INTO qmi (${cols.join(', ')}) VALUES (${placeholders})`
    )
      .bind(...vals)
      .run();
    result.created = 1;
    return result;
  }

  // UPDATE existing: synced patch only (Published untouched on updates).
  if (!msg.qmiId) return result; // defensive: no id, nothing to update
  if (Object.keys(patch).length === 0) return result;
  const setClause = Object.keys(patch)
    .map((c) => `${c} = ?`)
    .join(', ');
  const vals = [...Object.values(patch), nowIso(), msg.qmiId];
  await env.DB.prepare(
    `UPDATE qmi SET ${setClause}, updated_at = ? WHERE id = ?`
  )
    .bind(...vals)
    .run();
  result.updated = 1;
  return result;
}

async function applyQmiUnpublish(env: ConsumerEnv, msg: QmiUnpublishMessage) {
  const result = { created: 0, updated: 0, unpublished: 0, communities: 0, priceUpdated: 0 };
  // SOLD/REMOVED: force published = 0 ONLY. The query guards published=1 so an
  // already-unpublished row is a no-op, and there is NO branch that sets =1.
  await env.DB.prepare(
    `UPDATE qmi SET published = 0, updated_at = ? WHERE id = ? AND published = 1`
  )
    .bind(nowIso(), msg.qmiId)
    .run();
  result.unpublished = 1;
  return result;
}

async function applyCommunityUpsert(env: ConsumerEnv, msg: CommunityUpsertMessage) {
  const result = { created: 0, updated: 0, unpublished: 0, communities: 0, priceUpdated: 0 };
  const patch = applySyncedCommunity(msg.values); // only square_footage_range
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
  return result;
}

/** New QMI id. Pre-migration ids are Airtable recXXXX; new specs get a rec-like uuid. */
export function newQmiId(): string {
  return 'rec' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
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
        communities_updated, prices_updated, unresolved_links, notes, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  const agg = { created: 0, updated: 0, unpublished: 0, communities: 0, priceUpdated: 0 };
  let errors = 0;
  let lastError: string | null = null;

  for (const m of batch.messages) {
    try {
      const r = await applyMessage(env, m.body);
      agg.created += r.created;
      agg.updated += r.updated;
      agg.unpublished += r.unpublished;
      agg.communities += r.communities;
      agg.priceUpdated += r.priceUpdated;
      m.ack();
    } catch (err) {
      errors++;
      lastError = err instanceof Error ? err.message : String(err);
      m.retry(); // independent retry → DLQ after max_retries
    }
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
    pricesUpdated: agg.priceUpdated,
    notes: `consumer batch of ${batch.messages.length} message(s)`,
    errorMessage: lastError,
  });
}
