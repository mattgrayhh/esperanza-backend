// =============================================================================
// esperanza-cf framer-push — queue consumer + push orchestration.
//
// Drains esperanza-framer-queue. For each message it reads the FULL per-entity
// field set from D1 BY ID (it does NOT trust enqueued field values), maps it to a
// Framer ManagedCollectionItemInput, and upserts via the FramerClient (upsert key
// = the record id). Unpublished/draft rows are still pushed — with draft:true —
// so the live page is hidden WITHOUT removing the CMS item (soft-delete). A true
// `action:"delete"` (or a row that has disappeared from D1) → removeItems([id]).
//
// 429 / rate-limit handling (esperanza-sync had NONE at the app layer): we wrap
// every Framer call in retryWithBackoff() — exponential backoff with jitter on a
// retryable (429 / timeout / transient WS) error; after the local retries are
// exhausted the message is `retry({delaySeconds})`'d back onto the queue so the
// Cloudflare Queues retry/backoff + DLQ machinery takes over.
//
// Telemetry: one sync_log row per batch. To dodge the restricted single-select
// 422 the legacy worker hit, we write source='framer' and put the per-collection
// detail in `notes` (the schema's sync_log columns are generic counters/text).
// =============================================================================

import {
  COLLECTION_DEFS,
  resolveCollectionName,
  dedupeSlugs,
  type CollectionDef,
  type Row,
} from './collections.js';
import type {
  D1Like,
  FramerSyncMessage,
  CollectionKey,
  MessageBatchLike,
} from './types.js';
import type { ManagedCollectionItemInput } from './framer-types.js';
import {
  type FramerClient,
  type FramerConnect,
  type FramerEnv,
  type FramerCollection,
  type ManagedField,
  type ManagedFieldInput,
  connectFramer,
} from './framer.js';
import {
  type FieldDef,
  loadFieldDefs,
  applyTypeOverrides,
  emitCustomFields,
} from './type-overrides.js';

export interface ConsumerEnv extends FramerEnv {
  DB: D1Like;
  /** Optional Framer collection-name overrides (FRAMER_COLLECTION_*). */
  [key: string]: unknown;
}

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// =============================================================================
// 429 / retryable backoff
// =============================================================================

/** Heuristic: is this error worth retrying (429, timeout, transient WS)? */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const anyErr = err as { status?: number; code?: number | string };
  const status = anyErr?.status ?? anyErr?.code;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('websocket') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up')
  );
}

export interface BackoffOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests (defaults to real sleep). */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`, retrying on retryable errors with exponential backoff + full jitter.
 * Throws the last error if all attempts fail (caller then re-queues the message).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const doSleep = opts.sleepFn ?? sleep;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryableError(err)) throw err;
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * exp; // full jitter
      await doSleep(jitter);
    }
  }
}

// =============================================================================
// D1 reads
// =============================================================================

/** Read the full field-set row for one record id, or null if it no longer exists. */
export async function loadRowById(
  env: ConsumerEnv,
  def: CollectionDef,
  id: string
): Promise<Row | null> {
  const row = await env.DB.prepare(def.selectByIdSql).bind(id).first<Row>();
  if (!row) return null;
  return await enrichRow(env, def.key, row);
}

/** Read all rows for a collection (backfill / reconcile). */
export async function loadAllRows(env: ConsumerEnv, def: CollectionDef): Promise<Row[]> {
  const { results } = await env.DB.prepare(def.selectAllSql).bind().all<Row>();
  const out: Row[] = [];
  for (const row of results) out.push(await enrichRow(env, def.key, row));
  return out;
}

/**
 * Per-collection enrichment the mapper can't do alone:
 *   - promotions: resolve image fallback (own → first linked community →
 *     first linked FP) and rename target-id csvs to floor_plan_ids/collection_ids
 *     the mapper expects.
 *   - testimonials: resolve floor_plan_image from the linked Floor Plan's render.
 */
async function enrichRow(env: ConsumerEnv, key: CollectionKey, row: Row): Promise<Row> {
  if (key === 'promotions') {
    const communityIds = csv(row['community_ids']);
    const floorPlanIds = csv(row['floor_plan_ids']); // (no FP target_type today → [])
    // the mapper reads community_ids / floor_plan_ids / collection_ids strings;
    // surface them consistently (collection_ids has no target_type → '').
    row['floor_plan_ids'] = row['floor_plan_ids'] ?? null;
    row['collection_ids'] = row['collection_ids'] ?? null;

    let imageUrl = strOrNull(row['image_url']);
    if (!imageUrl && communityIds.length) {
      imageUrl = await firstNonNull(
        env,
        `SELECT featured_image_url AS u FROM communities WHERE id = ?`,
        communityIds
      );
    }
    if (!imageUrl && floorPlanIds.length) {
      imageUrl = await firstNonNull(
        env,
        `SELECT COALESCE(image_url, synced_image_url) AS u FROM floor_plans WHERE id = ?`,
        floorPlanIds
      );
    }
    row['image_url'] = imageUrl;
    return row;
  }

  if (key === 'testimonials') {
    if (!strOrNull(row['floor_plan_image'])) {
      const fpId = strOrNull(row['floor_plan_id']);
      if (fpId) {
        const u = await env.DB.prepare(
          `SELECT COALESCE(image_url, synced_image_url) AS u FROM floor_plans WHERE id = ?`
        )
          .bind(fpId)
          .first<{ u: string | null }>();
        if (u?.u) row['floor_plan_image'] = u.u;
      }
    }
    return row;
  }

  return row;
}

function csv(v: unknown): string[] {
  if (v == null || v === '') return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
async function firstNonNull(
  env: ConsumerEnv,
  sql: string,
  ids: string[]
): Promise<string | null> {
  for (const id of ids) {
    const r = await env.DB.prepare(sql).bind(id).first<{ u: string | null }>();
    if (r?.u) return r.u;
  }
  return null;
}

// =============================================================================
// Item build = mapper + config-driven type overrides + custom-field push
// =============================================================================

/**
 * Map a row to a Framer item, then apply the field_definitions-driven type
 * overrides and append CUSTOM-field values from the row's custom_fields JSON.
 *
 * Order matters: def.map(row) builds the base fieldData with the mappers' emitted
 * types; applyTypeOverrides re-types only the keys whose configured framer_type
 * differs (a guaranteed no-op for the reconciled steady state); emitCustomFields
 * then adds the user-defined fields (custom=1) — merged LAST so a custom key never
 * silently shadows a system field (custom keys are disjoint by construction).
 *
 * defs are loaded once per entity via the passed cache (scoped to one invocation).
 */
export async function buildItem(
  env: ConsumerEnv,
  def: CollectionDef,
  row: Row,
  defsCache: Map<string, FieldDef[]>
): Promise<ManagedCollectionItemInput> {
  const item = def.map(row);
  let defs: FieldDef[] = [];
  try {
    defs = await loadFieldDefs(env.DB, def.key, defsCache);
  } catch {
    // field_definitions unavailable (e.g. pre-migration) → skip overrides entirely;
    // the mapper output is the safe default. Never let a missing registry abort push.
    return item;
  }
  applyTypeOverrides(def.key, item.fieldData, defs);
  const custom = emitCustomFields(row['custom_fields'], defs);
  for (const [k, v] of Object.entries(custom)) item.fieldData[k] = v;
  return item;
}

// =============================================================================
// Per-message push
// =============================================================================

export interface PushResult {
  upserted: number;
  deleted: number;
}

/** Apply ONE message against an already-connected Framer collection. */
export async function pushMessage(
  env: ConsumerEnv,
  framer: FramerClient,
  msg: FramerSyncMessage,
  opts: { backoff?: BackoffOptions; defsCache?: Map<string, FieldDef[]> } = {}
): Promise<PushResult> {
  const def = COLLECTION_DEFS[msg.collection];
  if (!def) throw new Error(`unknown collection key: ${msg.collection}`);
  const name = resolveCollectionName(def, env as Record<string, string | undefined>);
  const collection = await framer.getCollectionByName(name);
  if (!collection) throw new Error(`Framer collection not found by name: "${name}"`);

  if (msg.action === 'delete') {
    await retryWithBackoff(() => collection.removeItems([msg.id]), opts.backoff);
    return { upserted: 0, deleted: 1 };
  }

  // upsert: read full row; if gone, treat as delete (it was removed before drain).
  const row = await loadRowById(env, def, msg.id);
  if (!row) {
    await retryWithBackoff(() => collection.removeItems([msg.id]), opts.backoff);
    return { upserted: 0, deleted: 1 };
  }
  const item = await buildItem(env, def, row, opts.defsCache ?? new Map());
  await retryWithBackoff(() => collection.addItems([item]), opts.backoff);
  return { upserted: 1, deleted: 0 };
}

// =============================================================================
// Queue batch handler
// =============================================================================

export async function handleQueueBatch(
  batch: MessageBatchLike<FramerSyncMessage>,
  env: ConsumerEnv,
  connect: FramerConnect = connectFramer
): Promise<void> {
  const startedAt = nowIso();
  const start = Date.now();
  const perCollection: Record<string, { upserted: number; deleted: number }> = {};
  let errors = 0;
  let lastError: string | null = null;
  let pushedAny = false;
  let deploymentId: string | null = null;

  // One field_definitions cache for the whole batch → each entity's defs load once.
  const defsCache = new Map<string, FieldDef[]>();

  const framer = await connect(env);
  try {
    for (const m of batch.messages) {
      try {
        const r = await pushMessage(env, framer, m.body, { defsCache });
        const bucket = (perCollection[m.body.collection] ??= { upserted: 0, deleted: 0 });
        bucket.upserted += r.upserted;
        bucket.deleted += r.deleted;
        if (r.upserted || r.deleted) pushedAny = true;
        m.ack();
      } catch (err) {
        errors++;
        lastError = err instanceof Error ? err.message : String(err);
        // retryable → delayed re-queue (Queues backoff + DLQ after max_retries).
        const delaySeconds = isRetryableError(err) ? 30 : undefined;
        m.retry(delaySeconds !== undefined ? { delaySeconds } : undefined);
      }
    }

    // publish + deploy ONCE per batch, only if something actually changed.
    if (pushedAny) {
      try {
        const res = await retryWithBackoff(() => framer.publishAndDeploy());
        deploymentId = res.deploymentId;
      } catch (err) {
        errors++;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    await framer.disconnect().catch(() => {});
  }

  await writeFramerSyncLog(env, {
    status: errors === 0 ? 'success' : 'partial',
    startedAt,
    finishedAt: nowIso(),
    durationS: (Date.now() - start) / 1000,
    notes: summarize(perCollection, batch.messages.length, deploymentId),
    errorMessage: lastError,
  });
}

function summarize(
  per: Record<string, { upserted: number; deleted: number }>,
  total: number,
  deploymentId: string | null
): string {
  const parts = Object.entries(per).map(
    ([k, v]) => `${k}:+${v.upserted}/-${v.deleted}`
  );
  const dep = deploymentId ? ` deploy=${deploymentId}` : '';
  return `framer-push batch of ${total} message(s) [${parts.join(' ')}]${dep}`;
}

// =============================================================================
// sync_log writer (generic columns; framer detail in notes — avoids the
// restricted single-select 422 the legacy worker hit).
// =============================================================================
export async function writeFramerSyncLog(
  env: ConsumerEnv,
  row: {
    status: string;
    startedAt: string;
    finishedAt: string;
    durationS: number;
    notes?: string | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_log
       (run_id, source, status, started_at, finished_at, duration_s, notes, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      'framer',
      row.status,
      row.startedAt,
      row.finishedAt,
      row.durationS,
      row.notes ?? null,
      row.errorMessage ?? null
    )
    .run();
}

// =============================================================================
// BACKFILL — push EVERY row of (optionally a subset of) collections. Connects
// once, addItems in chunks, publishes+deploys once per collection at the end. Also
// reconciles orphans: getItemIds() − D1 ids → removeItems in batches of 100.
// =============================================================================

export interface BackfillOptions {
  /** Subset of collection keys to backfill (default: all 9). */
  keys?: CollectionKey[];
  /** addItems chunk size (Framer throughput knob). */
  chunkSize?: number;
  /** Remove Framer items with no matching D1 row (default true). */
  reconcileOrphans?: boolean;
  backoff?: BackoffOptions;
}

export interface BackfillCollectionResult {
  key: CollectionKey;
  collectionName: string;
  upserted: number;
  orphansRemoved: number;
  deploymentId: string | null;
  error?: string;
}

export async function runBackfill(
  env: ConsumerEnv,
  opts: BackfillOptions = {},
  connect: FramerConnect = connectFramer
): Promise<BackfillCollectionResult[]> {
  const keys = opts.keys ?? (Object.keys(COLLECTION_DEFS) as CollectionKey[]);
  const chunkSize = opts.chunkSize ?? 50;
  const reconcile = opts.reconcileOrphans ?? true;
  const results: BackfillCollectionResult[] = [];

  // One field_definitions cache for the whole backfill → each entity loads once.
  const defsCache = new Map<string, FieldDef[]>();

  const framer = await connect(env);
  try {
    for (const key of keys) {
      const def = COLLECTION_DEFS[key];
      const collectionName = resolveCollectionName(def, env as Record<string, string | undefined>);
      const res: BackfillCollectionResult = {
        key,
        collectionName,
        upserted: 0,
        orphansRemoved: 0,
        deploymentId: null,
      };
      try {
        const collection = await framer.getCollectionByName(collectionName);
        if (!collection) throw new Error(`collection not found by name: "${collectionName}"`);

        const rows = await loadAllRows(env, def);
        // Dedupe slugs across the WHOLE collection before chunking — a stateless
        // per-row map() can't see a sibling sharing a precomputed slug, so two homes
        // at the same address would both emit e.g. `2004_s_lake_texoma_st` and the
        // second would abort with Framer's "Duplicate slug". (id-keyed upsert is fine;
        // it's the unique-slug constraint that fails.)
        // buildItem applies the field_definitions type overrides + custom-field push
        // per row (defs cached per entity); sequential to keep the cache single-load.
        const built: ManagedCollectionItemInput[] = [];
        for (const r of rows) built.push(await buildItem(env, def, r, defsCache));
        const items = dedupeSlugs(built);
        await pushInChunks(collection, items, chunkSize, opts.backoff);
        res.upserted = items.length;

        if (reconcile) {
          const liveIds = new Set(items.map((i) => i.id));
          const existing = await retryWithBackoff(() => collection.getItemIds(), opts.backoff);
          const orphans = existing.filter((id) => !liveIds.has(id));
          await removeInChunks(collection, orphans, 100, opts.backoff);
          res.orphansRemoved = orphans.length;
        }

        const dep = await retryWithBackoff(() => framer.publishAndDeploy(), opts.backoff);
        res.deploymentId = dep.deploymentId;
      } catch (err) {
        res.error = err instanceof Error ? err.message : String(err);
      }
      results.push(res);

      await writeFramerSyncLog(env, {
        status: res.error ? 'error' : 'success',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        durationS: 0,
        notes: `backfill ${key}: +${res.upserted} -${res.orphansRemoved} orphans${
          res.deploymentId ? ` deploy=${res.deploymentId}` : ''
        }`,
        errorMessage: res.error ?? null,
      });
    }
  } finally {
    await framer.disconnect().catch(() => {});
  }
  return results;
}

async function pushInChunks(
  collection: FramerCollection,
  items: ManagedCollectionItemInput[],
  chunkSize: number,
  backoff?: BackoffOptions
): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    if (slice.length) await retryWithBackoff(() => collection.addItems(slice), backoff);
  }
}

async function removeInChunks(
  collection: FramerCollection,
  ids: string[],
  chunkSize: number,
  backoff?: BackoffOptions
): Promise<void> {
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    if (slice.length) await retryWithBackoff(() => collection.removeItems(slice), backoff);
  }
}

// =============================================================================
// SCHEMA — POST /schema: re-type existing Framer fields / create missing ones.
// Append-only setFields pattern: read the live field set, rebuild it preserving
// EVERY existing field, change the type of a requested existing field (retyped) or
// append a requested missing field (created), then setFields the full new set. After
// the schema change, RE-PUSH the collection (re-typing clears Framer values) by
// reusing runBackfill for that single collection key so values repopulate.
// =============================================================================

/** One field the caller wants set/created on a collection. framer_type == CMS type. */
export interface SchemaFieldRequest {
  key: string; // Framer field id (== field_definitions.key by convention)
  framer_type: string; // target CMS field type
  label?: string; // display name (for a newly-created field; existing names preserved)
}

export type SchemaFieldAction = 'retyped' | 'created' | 'unchanged' | 'error';

export interface SchemaFieldResult {
  key: string;
  action: SchemaFieldAction;
  detail: string;
}

export interface ApplySchemaResult {
  collection: CollectionKey;
  collectionName: string;
  fields: SchemaFieldResult[];
  /** deploymentId from the post-schema re-push, or null if nothing repushed. */
  deploymentId: string | null;
  error?: string;
}

// CMS field types framer-push supports setting via /schema. `enum` is intentionally
// excluded from CREATE (needs `cases`); a re-type TO enum is rejected per-field.
const SETTABLE_TYPES = new Set<string>([
  'string',
  'number',
  'boolean',
  'image',
  'link',
  'formattedText',
  'date',
  'array',
  'file',
]);

/**
 * Re-type and/or create Framer fields on a collection, then re-push it.
 *
 *  - getFields() → the live schema.
 *  - ABORT if ANY existing field is type "unsupported" (rebuilding the set would
 *    drop/garble it — Framer can't round-trip an unsupported field through setFields).
 *  - For each requested field: re-type an existing field (action=retyped), or append
 *    a new one (action=created). A request whose type already matches → unchanged.
 *  - Preserve every other existing field verbatim (append-only pattern).
 *  - setFields(nextSet); then re-push the collection (reuse runBackfill) so values
 *    repopulate in the new type.
 */
export async function applySchema(
  env: ConsumerEnv,
  framer: FramerClient,
  collectionKey: CollectionKey,
  requests: SchemaFieldRequest[],
  opts: { backoff?: BackoffOptions; repush?: boolean } = {}
): Promise<ApplySchemaResult> {
  const def = COLLECTION_DEFS[collectionKey];
  if (!def) throw new Error(`unknown collection key: ${collectionKey}`);
  const collectionName = resolveCollectionName(def, env as Record<string, string | undefined>);
  const result: ApplySchemaResult = {
    collection: collectionKey,
    collectionName,
    fields: [],
    deploymentId: null,
  };

  const collection = await framer.getCollectionByName(collectionName);
  if (!collection) {
    result.error = `Framer collection not found by name: "${collectionName}"`;
    result.fields = requests.map((r) => ({ key: r.key, action: 'error', detail: result.error! }));
    return result;
  }

  const existing = await retryWithBackoff(() => collection.getFields(), opts.backoff);

  // Abort the WHOLE schema change if any existing field is unsupported — rebuilding
  // the field set would lose it (we can't reconstruct an unsupported field input).
  const unsupported = existing.find((f) => f.type === 'unsupported');
  if (unsupported) {
    result.error = `collection has an unsupported field ("${unsupported.id}"); aborting to avoid data loss`;
    result.fields = requests.map((r) => ({ key: r.key, action: 'error', detail: result.error! }));
    return result;
  }

  // Build the next field set as inputs, preserving every existing field.
  const byId = new Map<string, ManagedField>();
  for (const f of existing) byId.set(f.id, f);
  const nextById = new Map<string, ManagedFieldInput>();
  for (const f of existing) nextById.set(f.id, { id: f.id, type: f.type, name: f.name });

  const fieldResults: SchemaFieldResult[] = [];
  for (const req of requests) {
    if (!SETTABLE_TYPES.has(req.framer_type)) {
      fieldResults.push({
        key: req.key,
        action: 'error',
        detail: `unsupported target type "${req.framer_type}"`,
      });
      continue;
    }
    const cur = byId.get(req.key);
    if (!cur) {
      // create missing
      nextById.set(req.key, {
        id: req.key,
        type: req.framer_type,
        name: req.label ?? req.key,
      });
      fieldResults.push({ key: req.key, action: 'created', detail: `created as ${req.framer_type}` });
    } else if (cur.type === req.framer_type) {
      fieldResults.push({ key: req.key, action: 'unchanged', detail: `already ${req.framer_type}` });
    } else {
      // re-type existing (preserve its name)
      nextById.set(req.key, { id: req.key, type: req.framer_type, name: cur.name });
      fieldResults.push({
        key: req.key,
        action: 'retyped',
        detail: `${cur.type} → ${req.framer_type}`,
      });
    }
  }
  result.fields = fieldResults;

  // Only call setFields when something actually changed (created/retyped present).
  const changed = fieldResults.some((r) => r.action === 'created' || r.action === 'retyped');
  if (!changed) return result; // pure no-op: leave the schema + values untouched.

  const nextSet = [...nextById.values()];
  try {
    await retryWithBackoff(() => collection.setFields(nextSet), opts.backoff);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    // mark the would-change fields as errored
    for (const r of result.fields) {
      if (r.action === 'created' || r.action === 'retyped') {
        r.action = 'error';
        r.detail = `setFields failed: ${result.error}`;
      }
    }
    return result;
  }

  // Re-push the collection so values repopulate in the new type. Reuse the backfill
  // path for this single key. (Re-typing a field clears its Framer values.)
  if (opts.repush !== false) {
    const [bf] = await runBackfill(
      env,
      { keys: [collectionKey], reconcileOrphans: false, backoff: opts.backoff },
      async () => framer // reuse the already-connected client (don't reconnect/disconnect)
    );
    if (bf?.error) result.error = `repush: ${bf.error}`;
    result.deploymentId = bf?.deploymentId ?? null;
  }

  return result;
}
