// =============================================================================
// esperanza-cf — ingest Worker entrypoint. Migration Plan v2, Phase 3.
//
// TWO roles in one Worker (per wrangler.toml: producer + consumer of the same
// esperanza-sync-queue):
//
//   scheduled() (cron "0 */4 * * *")  — PRODUCER
//     1. Snowflake login + USE WAREHOUSE (ported 1:1 from esperanza-data-sync,
//        account lu51183.us-east-2.aws).
//     2. Run the two queries (Communities aggregate, QMIs/spec homes).
//     3. Read the D1 state needed for the diff (existing QMIs + lookup maps,
//        keyed by snowflake_key = eci_key, the DM_HOUSE natural key — so the diff
//        matches importer rows and never double-creates).
//     4. diff() → per-record SyncMessage[] → SYNC_QUEUE.send (batched).
//
//   queue() — CONSUMER
//     Drains esperanza-sync-queue, writes ONLY allow-listed synced_* columns via
//     applySynced(), applies published precedence (force =0 only). See consumer.ts.
// =============================================================================

import {
  snowflakeLogin,
  snowflakeQuery,
  communitiesSql,
  qmisSql,
  floorPlansSql,
  communityPriceFromSql,
  parseQmiRows,
  parseCommunityRows,
  parseFloorPlanRows,
  parseCommunityPriceFromRows,
  type SnowflakeEnv,
} from './snowflake.js';
import {
  diff,
  type ExistingQmi,
  type ExistingCommunity,
  type ExistingFloorPlan,
  type Lookups,
  type SyncMessage,
} from './diff.js';
import { handleQueueBatch, writeSyncLog, type ConsumerEnv, type D1Like } from './consumer.js';

export interface Env extends SnowflakeEnv, ConsumerEnv {
  DB: D1Like;
  SYNC_QUEUE: { send(body: unknown): Promise<void>; sendBatch(messages: { body: unknown }[]): Promise<void> };
  /**
   * Producer binding for esperanza-framer-queue. After the consumer applies a
   * synced D1 write it enqueues a Framer-push message here so the change reaches
   * Framer immediately (event-driven). Bound in wrangler.toml [[queues.producers]].
   */
  FRAMER_QUEUE: { send(body: unknown): Promise<void>; sendBatch(messages: { body: unknown }[]): Promise<void> };
  /** Optional Bearer secret gating the manual `POST /run` reconciliation trigger. */
  INGEST_TRIGGER_TOKEN?: string;
}

// -- D1 reads for the diff --

async function loadExistingQmis(db: D1Like): Promise<ExistingQmi[]> {
  const { results } = await db
    .prepare(
      `SELECT id, eci_key, housenumber, synced_community_name, published,
              synced_address, synced_postal_code, synced_bedroom_count,
              synced_bathroom_count, synced_half_bathroom_count,
              synced_living_square_footage, synced_total_square_footage,
              synced_elevation, synced_construction_stage,
              synced_move_in_date, synced_lot_number, synced_elevation_type,
              synced_material_type, synced_is_model_home, synced_start_type,
              synced_construction_stage_index, synced_estimated_settlement_date,
              synced_city_id, synced_city_name, synced_community_id,
              synced_floor_plan_id, synced_floor_plan_name,
              synced_price, last_synced_price, mark_job_number
       FROM qmi`
    )
    .bind()
    .all<ExistingQmi>();
  return results;
}

async function loadExistingCommunities(db: D1Like): Promise<ExistingCommunity[]> {
  const { results } = await db
    .prepare(
      `SELECT id, synced_square_footage_range, synced_bed_count, synced_bath_count,
              synced_price_from
       FROM communities`
    )
    .bind()
    .all<ExistingCommunity>();
  return results;
}

async function loadExistingFloorPlans(db: D1Like): Promise<ExistingFloorPlan[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, synced_bedroom_min, synced_bedroom_max, synced_bathroom_min,
              synced_bathroom_max, synced_living_square_footage,
              synced_total_square_footage, synced_starting_price
       FROM floor_plans`
    )
    .bind()
    .all<ExistingFloorPlan>();
  return results;
}

async function loadLookups(db: D1Like): Promise<Lookups> {
  const cities = (
    await db.prepare(`SELECT id, city_name FROM cities`).bind().all<{ id: string; city_name: string | null }>()
  ).results;
  const communities = (
    await db.prepare(`SELECT id, name FROM communities`).bind().all<{ id: string; name: string | null }>()
  ).results;
  const floorPlans = (
    await db.prepare(`SELECT id, name FROM floor_plans`).bind().all<{ id: string; name: string | null }>()
  ).results;

  const cityByName = new Map<string, string>();
  const validCities = new Set<string>();
  for (const c of cities) {
    if (c.city_name) {
      cityByName.set(c.city_name.toLowerCase(), c.id);
      validCities.add(c.city_name);
    }
  }
  const communityByName = new Map<string, string>();
  const validCommunities = new Set<string>();
  for (const c of communities) {
    if (c.name) {
      communityByName.set(c.name.toLowerCase(), c.id);
      validCommunities.add(c.name);
    }
  }
  const floorPlanByName = new Map<string, string>();
  const validFloorPlans = new Set<string>();
  for (const f of floorPlans) {
    if (f.name) {
      floorPlanByName.set(f.name.toLowerCase(), f.id);
      validFloorPlans.add(f.name);
    }
  }

  return {
    cityByName,
    communityByName,
    floorPlanByName,
    validCities,
    validCommunities,
    validFloorPlans,
  };
}

/** Enqueue messages in chunks (Queues sendBatch cap is 100/256KB; chunk at 100). */
async function enqueue(env: Env, messages: SyncMessage[]): Promise<void> {
  const CHUNK = 100;
  for (let i = 0; i < messages.length; i += CHUNK) {
    const slice = messages.slice(i, i + CHUNK).map((body) => ({ body }));
    await env.SYNC_QUEUE.sendBatch(slice);
  }
}

export default {
  // ── PRODUCER: cron diffs Snowflake vs D1 and enqueues per-record changes ──
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(runIngest(env));
  },

  // ── CONSUMER: drain the queue, write only allow-listed synced columns ──
  async queue(batch: { messages: { body: SyncMessage; ack(): void; retry(): void }[] }, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  // ── MANUAL TRIGGER: POST /run (Bearer INGEST_TRIGGER_TOKEN) runs the same
  //    Snowflake→D1 reconciliation as the cron, on demand (e.g. cutover/backfill).
  //    Mirrors framer-push's POST /cron. Any other path → 404. No token set → 403.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/run') {
      const auth = req.headers.get('authorization') || '';
      const expected = env.INGEST_TRIGGER_TOKEN ? `Bearer ${env.INGEST_TRIGGER_TOKEN}` : '';
      if (!expected || auth !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      try {
        await runIngest(env);
        return new Response(JSON.stringify({ ok: true, ran: 'ingest' }), { headers: { 'content-type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), { status: 502, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('Not found', { status: 404 });
  },
};

export async function runIngest(env: Env): Promise<void> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  try {
    const token = await snowflakeLogin(env);
    await snowflakeQuery(token, env, `USE WAREHOUSE ${env.SNOWFLAKE_WAREHOUSE}`);

    const [qmiRowset, commRowset, fpRowset, priceFromRowset] = await Promise.all([
      snowflakeQuery(token, env, qmisSql(env)),
      snowflakeQuery(token, env, communitiesSql(env)),
      snowflakeQuery(token, env, floorPlansSql(env)),
      snowflakeQuery(token, env, communityPriceFromSql(env)),
    ]);

    const snowflakeQmis = parseQmiRows(qmiRowset);
    const snowflakeCommunities = parseCommunityRows(commRowset);
    const snowflakeFloorPlans = parseFloorPlanRows(fpRowset);
    const communityPriceFrom = parseCommunityPriceFromRows(priceFromRowset);

    const [existingQmis, lookups, existingCommunities, existingFloorPlans] = await Promise.all([
      loadExistingQmis(env.DB),
      loadLookups(env.DB),
      loadExistingCommunities(env.DB),
      loadExistingFloorPlans(env.DB),
    ]);

    const { messages, stats } = diff(
      snowflakeQmis,
      snowflakeCommunities,
      existingQmis,
      lookups,
      snowflakeFloorPlans,
      existingCommunities,
      existingFloorPlans,
      communityPriceFrom
    );

    if (messages.length > 0) await enqueue(env, messages);

    // producer-side telemetry (the consumer writes a separate row per batch).
    await writeSyncLog(env, {
      runId: crypto.randomUUID(),
      source: 'snowflake',
      status: 'success',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationS: (Date.now() - start) / 1000,
      qmisCreated: stats.qmisCreated,
      qmisUpdated: stats.qmisUpdated,
      qmisUnpublished: stats.qmisUnpublished,
      qmisInSnowflake: stats.qmisInSnowflake,
      communitiesUpdated: stats.communitiesUpdated,
      floorPlansUpdated: stats.floorPlansUpdated,
      unresolvedLinks: stats.unresolvedLinks,
      notes: `producer enqueued ${messages.length} message(s)`,
    });
  } catch (err) {
    await writeSyncLog(env, {
      runId: crypto.randomUUID(),
      source: 'snowflake',
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationS: (Date.now() - start) / 1000,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
