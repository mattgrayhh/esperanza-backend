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
  type ConsumerEnv,
} from './consumer.js';
import {
  CRON_LOOKBACK_MINUTES,
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

export async function runLookback(env: Env, nowMs = Date.now()): Promise<{ enqueued: number }> {
  const startedAt = new Date(nowMs).toISOString();
  const start = Date.now();
  const lookbackMinutes = resolveLookbackMinutes(env.CRON_LOOKBACK_MINUTES);
  try {
    const messages = await collectChangedMessages(env, nowMs, lookbackMinutes);
    if (messages.length > 0) await enqueue(env, messages);
    await writeFramerSyncLog(env, {
      status: 'success',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationS: (Date.now() - start) / 1000,
      notes: `nightly backstop lookback (${lookbackMinutes}m) enqueued ${messages.length} message(s)`,
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
    _event: unknown,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ): Promise<void> {
    ctx.waitUntil(runLookback(env));
  },

  async queue(
    batch: MessageBatchLike<FramerSyncMessage>,
    env: Env
  ): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
};

// re-export for the backfill driver
export { runBackfill };
