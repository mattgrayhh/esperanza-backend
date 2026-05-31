// =============================================================================
// packages/admin — Drizzle client bound to the D1 `DB` binding.
//
// === READ-YOUR-WRITES (D1 Sessions API) ===
// The admin MUST see its own just-committed edits immediately. D1 read replication
// is eventually consistent, so a naive read could hit a stale replica right after a
// write. We open a D1 SESSION constrained to the PRIMARY:
//
//     env.DB.withSession('first-primary')
//
// "first-primary" routes the first query in the session to the primary database and
// pins subsequent queries in that session to be at-least-as-fresh (via the session
// bookmark D1 threads through). Every admin request that reads-then-writes (or
// writes-then-reads) uses one such session, guaranteeing read-your-writes. The PUBLIC
// api Worker, by contrast, uses 'first-unconstrained' (any replica) — see
// packages/api/src/index.ts. The admin NEVER uses 'first-unconstrained'.
//
// Drizzle's drizzle-orm/d1 driver wraps a D1Database. We pass the *session* (which
// implements the same prepare/batch surface) so all Drizzle queries ride the primary
// session. We construct a fresh client per request (server actions / RSC are
// request-scoped) so sessions don't leak across requests.
// =============================================================================

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { schema } from '@esperanza/db';
import type { Column } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';

export type Db = DrizzleD1Database<typeof schema>;

/**
 * Every managed table has a text `id` primary key. Drizzle doesn't surface a generic
 * `.id` property on the abstract SQLiteTable type, so this helper reads it through the
 * runtime shape (all our tables define `id`). Returns the Column for use in eq().
 */
export function idColumn(table: SQLiteTable): Column {
  return (table as unknown as { id: Column }).id;
}

/**
 * A Drizzle client pinned to the PRIMARY D1 session (read-your-writes). Create one
 * per request and use it for BOTH the read (to compute old values for audit) and the
 * write, so the editor always observes a consistent, fresh view.
 */
export function getDb(): { db: Db; session: D1DatabaseSession } {
  const env = getCloudflareContext().env;
  const d1 = env.DB as unknown as D1Database;
  // first-primary: first query hits the primary; the session bookmark keeps the rest
  // at-least-as-fresh. This is the read-your-writes constraint for the admin.
  const session = d1.withSession('first-primary');
  // drizzle-orm/d1 accepts anything with the D1 prepare/batch surface; a session has it.
  const db = drizzle(session as unknown as D1Database, { schema });
  return { db, session };
}

/**
 * Convenience for read-only RSC list/detail pages that won't write in the same
 * request. Still pinned to first-primary so an editor who just saved and navigated
 * sees the fresh row (the bookmark is per-session, but first-primary alone already
 * routes the read to the primary).
 */
export function getReadDb(): Db {
  return getDb().db;
}
