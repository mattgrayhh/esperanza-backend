// =============================================================================
// Ingest test harness. Loads the REAL DDL + views (packages/db/migrations/
// 0000_init.sql + views.sql) into an in-memory better-sqlite3 DB — the same SQL
// `wrangler d1 migrations apply` runs against D1 (D1 IS SQLite) — and wraps it in
// a thin D1Like adapter so the async consumer code runs unmodified against it.
// =============================================================================

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Like } from '../src/consumer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/ingest/test → packages/db
const DB_DIR = join(__dirname, '..', '..', 'db');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

// Load the FULL migration chain (0000 → 0005…) in lexical order — the same SQL
// `wrangler d1 migrations apply` runs against D1 — so views.sql, which references
// columns added/renamed by later migrations (0005's published/coming_soon, the
// promotions active→published rename), loads faithfully.
export const INIT_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');
export const VIEWS_SQL = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');

export function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(INIT_SQL);
  db.exec(VIEWS_SQL);
  return db;
}

/**
 * Wrap a better-sqlite3 Database in the async D1Like surface the consumer uses.
 * SQLite is synchronous; we just resolve immediately. Matches the subset of the
 * D1 API the consumer calls (prepare → bind → run / first / all, and batch).
 */
export function d1(db: Database.Database): D1Like {
  return {
    prepare(query: string) {
      const stmt = db.prepare(query);
      return {
        bind(...values: unknown[]) {
          // better-sqlite3 can't bind `undefined` — coerce to null defensively.
          const bound = values.map((v) => (v === undefined ? null : v));
          return {
            async run() {
              return stmt.run(...(bound as never[]));
            },
            async first<T = unknown>(colName?: string): Promise<T | null> {
              const row = stmt.get(...(bound as never[])) as Record<string, unknown> | undefined;
              if (!row) return null;
              return (colName ? (row[colName] as T) : (row as unknown as T)) ?? null;
            },
            async all<T = unknown>() {
              return { results: stmt.all(...(bound as never[])) as T[] };
            },
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      return statements; // unused by the consumer; present for type-completeness
    },
  };
}
