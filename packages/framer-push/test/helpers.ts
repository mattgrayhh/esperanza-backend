// =============================================================================
// framer-push test harness. Loads the REAL DDL + views (packages/db/migrations/
// 0000_init.sql + views.sql) into in-memory better-sqlite3 — the same SQL
// `wrangler d1 migrations apply` runs against D1 — wrapped in a thin D1Like
// adapter so the async producer/consumer code runs unmodified against it.
// (Same pattern as packages/ingest/test/helpers.ts.)
// =============================================================================

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { D1Like } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/framer-push/test → packages/db
const DB_DIR = join(__dirname, '..', '..', 'db');

export const INIT_SQL = readFileSync(join(DB_DIR, 'migrations', '0000_init.sql'), 'utf8');
export const VIEWS_SQL = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');

export function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(INIT_SQL);
  db.exec(VIEWS_SQL);
  return db;
}

/** Wrap a better-sqlite3 Database in the async D1Like surface. */
export function d1(db: Database.Database): D1Like {
  return {
    prepare(query: string) {
      const stmt = db.prepare(query);
      return {
        bind(...values: unknown[]) {
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
      return statements;
    },
  };
}

/** Insert a row into `table` from a snake_case column→value object. */
export function insertRow(
  db: Database.Database,
  table: string,
  values: Record<string, unknown>
): void {
  const cols = Object.keys(values);
  const placeholders = cols.map(() => '?').join(', ');
  const vals = cols.map((c) => {
    const v = values[c];
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as never;
  });
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`).run(
    ...(vals as never[])
  );
}
