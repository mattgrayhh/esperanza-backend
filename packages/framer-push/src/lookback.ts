// =============================================================================
// esperanza-cf framer-push — cron lookback selector.
//
// Every D1 table carries `updated_at TEXT NOT NULL DEFAULT (ISO8601 now)` and the
// admin worker bumps it on every write (Phase 5). So the lookback "what changed"
// query is uniform across all 9 collections: rows whose updated_at is within the
// last CRON_LOOKBACK_MINUTES.
//
// Why a generous window + idempotent push (ported rationale from esperanza-sync):
//   5-min cron + 30-min window ⇒ each edit is covered by ~6 ticks. That's the
//   resilience strategy — a tick that dies on a Framer WS timeout is re-covered by
//   the next, and addItems is upsert-by-id so re-pushing is harmless. The window is
//   computed in JS (not SQLite DATEADD) so it's testable & deterministic.
//
// updated_at is an ISO8601 string with millis (strftime '%Y-%m-%dT%H:%M:%fZ'); a
// lexicographic string compare on that fixed-width format equals a chronological
// compare, so `WHERE updated_at >= :cutoff` is correct without date parsing.
// =============================================================================

import type { CollectionKey } from './types.js';
import { COLLECTION_KEYS } from './types.js';

export const CRON_LOOKBACK_MINUTES = 30;

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
