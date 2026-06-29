// =============================================================================
// esperanza-cf framer-push — Worker entrypoint. Migration Plan v2, Phase 6.
//
// TWO roles in one Worker (per wrangler.toml: producer + consumer of the same
// esperanza-framer-queue):
//
//   scheduled() (cron "0 9 * * *")  — PRODUCER (NIGHTLY BACKSTOP)
//     The primary D1 -> Framer path is event-driven (admin + ingest enqueue on
//     write). This nightly run is the safety net: for each of the 9 tables, SELECT
//     ids whose updated_at is within the last CRON_LOOKBACK_MINUTES (default 1500 =
//     25h) and enqueue one { collection, action:'upsert', id } per id. The consumer
//     re-reads the FULL field set per id (so the message stays tiny & the data fresh).
//
//   queue() — CONSUMER
//     Drains esperanza-framer-queue → reads each row from D1 → upserts into the
//     matching Framer Managed collection (record-id upsert key, draft:true
//     soft-delete, 429 backoff). See consumer.ts.
//
//   fetch() — WEBHOOK + MANUAL TRIGGER
//     POST /<collection> routes (Bearer WEBHOOK_TOKEN). Body
//     { action, records?:[{id}], deletedRecordIds?:[] } → enqueue messages
//     (or push synchronously when ?sync=true). POST /cron runs the lookback on
//     demand. Mirrors the legacy framer-sync webhook surface.
// =============================================================================

import {
  handleQueueBatch,
  runBackfill,
  applySchema,
  type ConsumerEnv,
  type SchemaFieldRequest,
} from './consumer.js';
import { connectFramer } from './framer.js';
import {
  CRON_LOOKBACK_MINUTES,
  FULL_RECONCILE_MINUTES,
  resolveLookbackMinutes,
  changedIdsSql,
  lookbackCutoffIso,
  COLLECTION_KEYS,
} from './lookback.js';
import {
  type CollectionKey,
  type FramerSyncMessage,
  type D1Like,
  type QueueProducer,
  type MessageBatchLike,
} from './types.js';
import { writeFramerSyncLog } from './consumer.js';
import { configureImageTransform } from './image-transform.js';

export interface Env extends ConsumerEnv {
  DB: D1Like;
  FRAMER_QUEUE: QueueProducer;
  WEBHOOK_TOKEN: string;
  FRAMER_API_KEY: string;
  FRAMER_PROJECT_URL: string;
  /**
   * Optional override for the nightly backstop lookback window, in minutes
   * (wrangler [vars] are strings). Defaults to CRON_LOOKBACK_MINUTES (1500 = 25h).
   */
  CRON_LOOKBACK_MINUTES?: string | number;
  /**
   * Cloudflare Images delivery origin fronting the R2 bucket, e.g.
   * "https://img.hazardhouse.ai". UNSET → image URLs pass through unchanged
   * (compression off). See image-transform.ts.
   */
  IMAGES_TRANSFORM_BASE?: string;
  /** cdn-cgi option string; defaults to format=auto,quality=80,width=1920. */
  IMAGES_TRANSFORM_OPTS?: string;
  // optional FRAMER_COLLECTION_* name overrides flow through ConsumerEnv index sig.
}

// =============================================================================
// PRODUCER — cron lookback
// =============================================================================

/**
 * Find changed ids per collection within the lookback window. When
 * `lookbackMinutes` is omitted it is resolved from env.CRON_LOOKBACK_MINUTES
 * (default 1500 = 25h, the nightly-backstop window).
 */
export async function collectChangedMessages(
  env: Env,
  nowMs: number,
  lookbackMinutes = resolveLookbackMinutes(env.CRON_LOOKBACK_MINUTES)
): Promise<FramerSyncMessage[]> {
  const cutoff = lookbackCutoffIso(nowMs, lookbackMinutes);
  const messages: FramerSyncMessage[] = [];
  for (const key of COLLECTION_KEYS) {
    const { results } = await env.DB.prepare(changedIdsSql(key))
      .bind(cutoff)
      .all<{ id: string }>();
    for (const r of results) {
      messages.push({ collection: key, action: 'upsert', id: r.id });
    }
  }
  return messages;
}

/** Enqueue in chunks of 100 (Queues sendBatch cap). */
async function enqueue(env: Env, messages: FramerSyncMessage[]): Promise<void> {
  const CHUNK = 100;
  for (let i = 0; i < messages.length; i += CHUNK) {
    const slice = messages.slice(i, i + CHUNK).map((body) => ({ body }));
    await env.FRAMER_QUEUE.sendBatch(slice);
  }
}

export async function runLookback(
  env: Env,
  nowMs = Date.now(),
  lookbackMinutesOverride?: number
): Promise<{ enqueued: number }> {
  const startedAt = new Date(nowMs).toISOString();
  const start = Date.now();
  const lookbackMinutes =
    lookbackMinutesOverride ?? resolveLookbackMinutes(env.CRON_LOOKBACK_MINUTES);
  const mode = lookbackMinutesOverride ? 'weekly full reconcile' : 'nightly backstop';
  try {
    const messages = await collectChangedMessages(env, nowMs, lookbackMinutes);
    if (messages.length > 0) await enqueue(env, messages);
    await writeFramerSyncLog(env, {
      status: 'success',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationS: (Date.now() - start) / 1000,
      notes: `${mode} lookback (${lookbackMinutes}m) enqueued ${messages.length} message(s)`,
    });
    return { enqueued: messages.length };
  } catch (err) {
    await writeFramerSyncLog(env, {
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationS: (Date.now() - start) / 1000,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// =============================================================================
// WEBHOOK routes
// =============================================================================

interface WebhookPayload {
  action: 'create' | 'update' | 'delete';
  records?: Array<{ id: string; fields?: Record<string, unknown> }>;
  deletedRecordIds?: string[];
}

/** pathname → collection key. Bare "/" and "/floor-plans" alias Floor Plans. */
export function routeToKey(pathname: string): CollectionKey | 'cron' | null {
  const p = pathname.replace(/\/+$/, '') || '/';
  switch (p) {
    case '/':
    case '/floorplans':
    case '/floor-plans':
      return 'floor_plans';
    case '/qmi':
    case '/quick-move-ins':
      return 'qmi';
    case '/communities':
      return 'communities';
    case '/collections':
      return 'collections';
    case '/images':
      return 'images';
    case '/blogs':
      return 'blogs';
    case '/promotions':
      return 'promotions';
    case '/cities':
      return 'cities';
    case '/testimonials':
      return 'testimonials';
    case '/cron':
      return 'cron';
    default:
      return null;
  }
}

const ROUTE_LIST = [
  '/floorplans (alias: /, /floor-plans)',
  '/qmi (alias: /quick-move-ins)',
  '/communities',
  '/collections',
  '/images',
  '/blogs',
  '/promotions',
  '/cities',
  '/testimonials',
  '/cron',
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// =============================================================================
// /schema — re-type + create Framer fields, then re-push (Field Types Phase C).
// =============================================================================

const VALID_COLLECTION_KEYS = new Set<CollectionKey>([
  'floor_plans',
  'qmi',
  'communities',
  'collections',
  'images',
  'blogs',
  'promotions',
  'cities',
  'testimonials',
]);

/** Map a few common human collection NAMES → the canonical CollectionKey. */
const NAME_TO_KEY: Record<string, CollectionKey> = {
  'floor plans': 'floor_plans',
  'quick move-ins': 'qmi',
  'quick move ins': 'qmi',
  communities: 'communities',
  collections: 'collections',
  images: 'images',
  blogs: 'blogs',
  promotions: 'promotions',
  cities: 'cities',
  testimonials: 'testimonials',
};

/** Resolve the body's `collection` (a CollectionKey OR a human name) to a key. */
export function resolveCollectionKey(collection: unknown): CollectionKey | null {
  if (typeof collection !== 'string') return null;
  const raw = collection.trim();
  if (VALID_COLLECTION_KEYS.has(raw as CollectionKey)) return raw as CollectionKey;
  const norm = raw.toLowerCase().replace(/\s*\(managed\)\s*$/, '').trim();
  return NAME_TO_KEY[norm] ?? null;
}

interface SchemaPayload {
  collection?: unknown;
  fields?: Array<{ key?: unknown; framer_type?: unknown; label?: unknown }>;
  /** Field keys to DELETE from the collection (drop + its values). Runs before creates. */
  drop?: unknown;
}

async function handleSchema(request: Request, env: Env): Promise<Response> {
  let payload: SchemaPayload;
  try {
    payload = (await request.json()) as SchemaPayload;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const key = resolveCollectionKey(payload.collection);
  if (!key) {
    return json(
      { error: 'unknown or missing `collection`', valid: [...VALID_COLLECTION_KEYS] },
      400
    );
  }

  // Validate + normalize the requested fields.
  const reqFields: SchemaFieldRequest[] = [];
  for (const f of payload.fields ?? []) {
    const k = typeof f?.key === 'string' ? f.key.trim() : '';
    const t = typeof f?.framer_type === 'string' ? f.framer_type.trim() : '';
    if (!k || !t) {
      return json({ error: 'each field needs a non-empty `key` and `framer_type`' }, 400);
    }
    reqFields.push({
      key: k,
      framer_type: t,
      label: typeof f.label === 'string' && f.label.trim() ? f.label.trim() : undefined,
    });
  }

  // Field keys to drop (delete from the collection). Runs before creates in applySchema.
  const dropKeys = Array.isArray(payload.drop)
    ? payload.drop.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map((d) => d.trim())
    : [];

  // Empty fields AND empty drop → valid no-op (route health-check): resolve, return 200.
  if (reqFields.length === 0 && dropKeys.length === 0) {
    return json({ ok: true, collection: key, fields: [], deploymentId: null, noop: true });
  }

  const framer = await connectFramer(env);
  try {
    const result = await applySchema(env, framer, key, reqFields, { drop: dropKeys });
    return json({ ok: !result.error, ...result });
  } finally {
    // applySchema's re-push already disconnects via runBackfill; this is a harmless
    // belt-and-suspenders close (catch swallows a double-disconnect).
    await framer.disconnect().catch(() => {});
  }
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed', allowed: ['POST'] }, 405);
  }

  const url = new URL(request.url);

  // Bearer auth on every route (before any routing work).
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.WEBHOOK_TOKEN}`) {
    return json({ error: 'unauthorized' }, 401);
  }

  // Server-side backfill: POST /backfill?keys=qmi,communities (omit → all 9).
  // Runs runBackfill with the worker's D1 + Framer bindings (no creds in node).
  if (url.pathname.replace(/\/+$/, '') === '/backfill') {
    const keysParam = url.searchParams.get('keys');
    const keys = keysParam
      ? (keysParam.split(',').map((s) => s.trim()).filter(Boolean) as CollectionKey[])
      : undefined;
    const results = await runBackfill(env, { keys });
    return json({ ok: true, results });
  }

  // Schema sync (Field Types Phase C): POST /schema
  //   body { collection, fields: [{ key, framer_type, label }] }
  // Re-types existing Framer fields / creates missing ones, then re-pushes the
  // collection so values repopulate. Returns per-field {key, action, detail}.
  if (url.pathname.replace(/\/+$/, '') === '/schema') {
    return handleSchema(request, env);
  }

  const key = routeToKey(url.pathname);
  if (key === null) {
    return json({ error: 'not found', routes: ROUTE_LIST }, 404);
  }

  // Manual cron trigger.
  if (key === 'cron') {
    const res = await runLookback(env);
    return json({ ok: true, ...res });
  }

  let payload: WebhookPayload;
  try {
    payload = (await request.json()) as WebhookPayload;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  // Build messages from the payload.
  const messages: FramerSyncMessage[] = [];
  if (payload.action === 'delete') {
    for (const id of payload.deletedRecordIds ?? []) {
      messages.push({ collection: key, action: 'delete', id });
    }
  } else {
    for (const rec of payload.records ?? []) {
      if (rec?.id) messages.push({ collection: key, action: 'upsert', id: rec.id });
    }
  }

  // ?sync=true → push immediately (used for low-latency single-record edits &
  // tests); default → enqueue (the queue consumer publishes/deploys).
  const sync = url.searchParams.get('sync') === 'true';
  if (sync) {
    const batch: MessageBatchLike<FramerSyncMessage> = {
      messages: messages.map((body) => ({
        body,
        ack() {},
        retry() {},
      })),
    };
    await handleQueueBatch(batch, env);
    return json({ ok: true, mode: 'sync', count: messages.length });
  }

  if (messages.length > 0) await enqueue(env, messages);
  return json({ ok: true, mode: 'enqueue', count: messages.length });
}

// =============================================================================
// Worker export
// =============================================================================

export default {
  async scheduled(
    event: { scheduledTime?: number },
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ): Promise<void> {
    configureImageTransform(env.IMAGES_TRANSFORM_BASE, env.IMAGES_TRANSFORM_OPTS);
    // The cron fires daily at 09:00 UTC. Six days a week it runs the 25h backstop;
    // on Sundays it widens to a FULL reconcile so any row whose push silently
    // dropped >25h ago (and thus aged out of every nightly window) is re-enqueued.
    const isSunday = new Date(event?.scheduledTime ?? Date.now()).getUTCDay() === 0;
    ctx.waitUntil(runLookback(env, Date.now(), isSunday ? FULL_RECONCILE_MINUTES : undefined));
  },

  async queue(
    batch: MessageBatchLike<FramerSyncMessage>,
    env: Env
  ): Promise<void> {
    configureImageTransform(env.IMAGES_TRANSFORM_BASE, env.IMAGES_TRANSFORM_OPTS);
    await handleQueueBatch(batch, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    configureImageTransform(env.IMAGES_TRANSFORM_BASE, env.IMAGES_TRANSFORM_OPTS);
    return handleFetch(request, env);
  },
};

// re-export for the backfill driver
export { runBackfill };
