// =============================================================================
// esperanza-cf framer-push — cron lookback selector.
//
// Every D1 table carries `updated_at TEXT NOT NULL DEFAULT (ISO8601 now)` and the
// admin worker bumps it on every write (Phase 5). So the lookback "what changed"
// query is uniform across all 9 collections: rows whose updated_at is within the
// last lookback window.
//
// EVENT-DRIVEN NOW, LOOKBACK IS A BACKSTOP:
//   Pushes are normally event-driven — the admin worker and the ingest consumer
//   each enqueue { collection, action:'upsert', id } onto esperanza-framer-queue
//   the moment a row is written. The cron lookback is no longer the every-5-min
//   primary path; it is a once-nightly safety net (cron "0 9 * * *") that re-scans
//   for anything an event-driven send dropped. To catch a FULL day in one nightly
//   run, the window defaults to 25h (1500 minutes) instead of the old 30 minutes.
//   Override per-environment via the CRON_LOOKBACK_MINUTES var in wrangler.toml.
//
//   addItems is upsert-by-id so re-pushing a row already pushed event-driven is
//   idempotent/harmless. The nightly run still enqueues ONLY changed rows (rows
//   whose updated_at falls inside the window) — never a full 9-collection backfill.
//   The window is computed in JS (not SQLite DATEADD) so it's testable & deterministic.
//
// updated_at is an ISO8601 string with millis (strftime '%Y-%m-%dT%H:%M:%fZ'); a
// lexicographic string compare on that fixed-width format equals a chronological
// compare, so `WHERE updated_at >= :cutoff` is correct without date parsing.
// =============================================================================

import type { CollectionKey } from './types.js';
import { COLLECTION_KEYS } from './types.js';

/**
 * Default lookback window for the NIGHTLY backstop run: 25 hours (1500 minutes).
 * The nightly cron fires at 09:00 UTC; a 25h window guarantees a full day plus a
 * 1h overlap is re-scanned even if the previous night's run was slightly late.
 */
export const CRON_LOOKBACK_MINUTES = 1500;

/**
 * Resolve the lookback window from the optional CRON_LOOKBACK_MINUTES env var
 * (wrangler [vars] are strings), falling back to the 25h default. Guards against
 * a missing/blank/non-positive value.
 */
export function resolveLookbackMinutes(raw: unknown): number {
  if (raw == null || raw === '') return CRON_LOOKBACK_MINUTES;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : CRON_LOOKBACK_MINUTES;
}

/** ISO8601 cutoff = now − minutes. */
export function lookbackCutoffIso(nowMs: number, minutes: number): string {
  return new Date(nowMs - minutes * 60_000).toISOString();
}

/** The table name backing each collection key (== schema table). */
export const TABLE_BY_KEY: Record<CollectionKey, string> = {
  floor_plans: 'floor_plans',
  qmi: 'qmi',
  communities: 'communities',
  collections: 'collections',
  images: 'images',
  blogs: 'blogs',
  promotions: 'promotions',
  cities: 'cities',
  testimonials: 'testimonials',
};

/**
 * Build the "ids changed since cutoff" SELECT for a collection. Returns the SQL
 * (one bind param: the ISO cutoff). Selecting only `id` keeps the lookup cheap —
 * the consumer re-reads the full field set per id from D1.
 */
export function changedIdsSql(key: CollectionKey): string {
  const table = TABLE_BY_KEY[key];
  return `SELECT id FROM ${table} WHERE updated_at >= ? ORDER BY updated_at ASC`;
}

export { COLLECTION_KEYS };
