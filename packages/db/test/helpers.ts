// =============================================================================
// Test harness: load 0000_init.sql + views.sql into an in-memory better-sqlite3
// DB. This is the same SQL that `wrangler d1 migrations apply` runs against D1,
// exercised against SQLite directly (D1 IS SQLite), so the tests validate the
// real DDL/views, not a re-implementation.
// =============================================================================

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..');

export const INIT_SQL = readFileSync(join(DB_DIR, 'migrations', '0000_init.sql'), 'utf8');
export const VIEWS_SQL = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');

export function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(INIT_SQL);
  db.exec(VIEWS_SQL);
  return db;
}

/**
 * Invariant helper reused by the importer: assert no value in a row (or set of
 * rows) contains an expiring Airtable attachment host. Throws on violation.
 * Used by both the "no airtable URL persisted" test and (in spirit) the Phase 2
 * importer's pre-write guard.
 */
export const FORBIDDEN_IMAGE_HOST = 'airtableusercontent.com';

export function assertNoAirtableUrls(value: unknown, where = 'value'): void {
  const hit = findAirtableUrl(value);
  if (hit !== null) {
    throw new Error(
      `Forbidden ${FORBIDDEN_IMAGE_HOST} URL persisted at ${where}: ${hit}`
    );
  }
}

/** Returns the first offending string found, or null. Recurses into JSON-ish values. */
export function findAirtableUrl(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    // value might be a JSON-encoded array/object (FP:* / gallery columns) —
    // recurse into it FIRST so we return the inner offending URL, not the whole blob.
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = findAirtableUrl(parsed);
        if (nested) return nested;
        // parsed cleanly and contained no offending url
        return null;
      } catch {
        // not actually JSON — fall through to plain-string check
      }
    }
    return value.includes(FORBIDDEN_IMAGE_HOST) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findAirtableUrl(v);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findAirtableUrl(v);
      if (hit) return hit;
    }
  }
  return null;
}
