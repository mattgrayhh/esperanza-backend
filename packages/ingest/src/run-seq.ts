// =============================================================================
// esperanza-cf — producer run sequence (migration 0031). Queue-intent freshness.
//
// WHY THIS EXISTS
// Cloudflare Queues gives no ordering guarantee and retries on failure, so every
// message the producer sends is an INTENT that may be delivered late. For data
// upserts that is harmless (last write wins, and the next run re-syncs anyway).
// For `qmi.publish` it is not: an intent decided by run N can execute after run
// N+1 has decided the opposite, which puts an unready home on the live site
// through the exact path the readiness gate exists to close.
//
// Re-reading current D1 state in the consumer — which is what this code did
// before 2026-07-28 — closes the "state changed BEFORE delivery" half and misses
// the "state changes AFTER delivery" half. Three schedules were independently
// reproduced in review:
//
//   1. publish(run N) lands, passes against run N's data, and is then overtaken
//      by run N+1's upsert → home live, stage 'Build Pad'.
//   2. The home leaves the Snowflake available set. Run N+1 emits no unpublish
//      (the row was hidden at snapshot time), so a delayed publish(run N) revives
//      a home that is no longer for sale.
//   3. An admin sets an override hold between the consumer's readiness SELECT and
//      its write, which guarded only `published = 0` → publish over the hold.
//
// THE RULE
// A single monotonic counter, bumped by the producer under sync_lock before it
// enqueues anything, stamped on every QMI intent. The consumer applies an intent
// only while its run is still the current one. Schedules 1 and 2 both require the
// stale intent to execute after a newer run has started, so both are refused here;
// schedule 3 is closed by the compare-and-set in the consumer's publish path.
//
// Losing an intent this way costs nothing: publish candidates are re-derived from
// D1 on every run, so a dropped intent that is still true comes back next cycle.
// =============================================================================

import type { D1Like } from './consumer.js';

/** Single counter row — one producer, one sequence. */
export const SYNC_RUN_NAME = 'ingest';

/**
 * Bump the run counter and return the new value. Called by runIngest AFTER it has
 * taken sync_lock, so the read-back cannot see another producer's bump.
 *
 * Throws if the table is missing (migration not applied). That is deliberate: the
 * caller records an `error` sync_log row and rethrows, which is exactly how 0029
 * SHOULD have failed when it shipped to code but not to remote D1 — instead it
 * threw outside the try and the sync silently stopped for six days.
 */
export async function nextRunSeq(db: D1Like, nowIso = new Date().toISOString()): Promise<number> {
  await db
    .prepare(
      `INSERT INTO sync_run_seq (name, seq, at) VALUES (?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET seq = sync_run_seq.seq + 1, at = excluded.at`
    )
    .bind(SYNC_RUN_NAME, nowIso)
    .run();
  const row = await db
    .prepare(`SELECT seq FROM sync_run_seq WHERE name = ?`)
    .bind(SYNC_RUN_NAME)
    .first<{ seq: number }>();
  const seq = Number(row?.seq ?? 0);
  if (!Number.isFinite(seq) || seq <= 0) {
    throw new Error(`sync_run_seq bump produced no usable sequence (got ${String(row?.seq)})`);
  }
  return seq;
}

/**
 * The current run sequence, or null when it cannot be established.
 *
 * Null is NOT treated as "everything is fresh" by the caller — the consumer fails
 * closed and skips publishes, which the next run re-derives. Swallowing the error
 * here rather than throwing keeps a missing table or a transient D1 blip from
 * dead-lettering the batch's data messages, which are safe to apply regardless.
 */
export async function currentRunSeq(db: D1Like): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT seq FROM sync_run_seq WHERE name = ?`)
      .bind(SYNC_RUN_NAME)
      .first<{ seq: number }>();
    if (row?.seq == null) return null;
    const seq = Number(row.seq);
    return Number.isFinite(seq) ? seq : null;
  } catch (err) {
    console.error('[ingest:run-seq] could not read sync_run_seq:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Is an intent stamped `msgSeq` still current, given `currentSeq`?
 *
 *  - An intent from an OLDER run is stale — a newer run has already re-decided.
 *  - An UNSTAMPED intent (pre-0031 message in flight across a deploy) carries no
 *    freshness evidence. Callers on the publish path treat that as stale; the data
 *    paths accept it, since applying a slightly-old upsert is what the next run
 *    would do anyway.
 *  - A seq AHEAD of the counter cannot happen (the producer bumps before it
 *    enqueues) but is accepted rather than dropped: refusing it would strand real
 *    work if the counter were ever restored from a backup.
 */
export function isCurrentIntent(msgSeq: number | undefined, currentSeq: number | null): boolean {
  if (msgSeq == null) return false;
  if (currentSeq == null) return false;
  return msgSeq >= currentSeq;
}
