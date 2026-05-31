// =============================================================================
// packages/admin — server-side list builder. Reads the configured list columns for an
// entity and returns plain rows for the generic list page.
//
// READ STRATEGY: we read the BASE table (not v_public_*) so DRAFT/unpublished rows are
// visible to the operator (the public views filter them out). For QMI we additionally
// COALESCE(override_x, synced_x) for the effective `address` and `price` display
// columns (mirroring v_public_qmi) since the base table only has the pair columns.
// =============================================================================

import { sql } from 'drizzle-orm';
import { getReadDb } from './db';
import { type EntityKey } from './entities';
import { fieldConfigFor, publishGateColumn, type ListColumn } from './field-config';

export interface ListRow {
  id: string;
  cells: Array<{ field: string; value: string; kind: ListColumn['kind'] }>;
  /** raw gate value for the published indicator (true=live). */
  live: boolean | null;
}

export interface ListView {
  columns: ListColumn[];
  rows: ListRow[];
  gateColumn: string | null;
  truncated: boolean;
}

const LIMIT = 200;

// Per-entity SELECT. Most are SELECT *; QMI projects effective COALESCE columns.
function selectSqlFor(key: EntityKey): string {
  if (key === 'qmi') {
    return `SELECT
        id,
        COALESCE(override_address, synced_address) AS address,
        COALESCE(override_price,   synced_price)   AS price,
        synced_community_name,
        synced_floor_plan_name,
        available_now,
        last_modified_time,
        published
      FROM qmi
      ORDER BY last_modified_time DESC
      LIMIT ${LIMIT}`;
  }
  return `SELECT * FROM ${tableName(key)} LIMIT ${LIMIT}`;
}

function tableName(key: EntityKey): string {
  switch (key) {
    case 'qmi':
      return 'qmi';
    case 'communities':
      return 'communities';
    case 'cities':
      return 'cities';
    case 'floor_plans':
      return 'floor_plans';
    case 'promotions':
      return 'promotions';
    case 'collections':
      return 'collections';
    case 'images':
      return 'images';
    case 'blogs':
      return 'blogs';
    case 'testimonials':
      return 'testimonials';
  }
}

function fmt(v: unknown, kind: ListColumn['kind']): string {
  if (v == null || v === '') return '';
  if (kind === 'boolean') return v === 1 || v === true || v === '1' ? 'yes' : 'no';
  return String(v);
}

/** Is this entity's gate value "live"? null when the entity has no gate. */
function isLive(key: EntityKey, gate: string | null, row: Record<string, unknown>): boolean | null {
  if (!gate) return null;
  if (gate === 'status') return row['status'] !== 'Draft';
  return Boolean(row[gate]);
}

export async function buildListView(key: EntityKey): Promise<ListView> {
  const cfg = fieldConfigFor(key);
  const gate = publishGateColumn(key);
  const db = getReadDb();

  const raw = await db.all<Record<string, unknown>>(sql.raw(selectSqlFor(key)));

  const rows: ListRow[] = raw.map((r) => ({
    id: String(r['id']),
    cells: cfg.listColumns.map((c) => ({
      field: c.field,
      value: fmt(r[c.field], c.kind),
      kind: c.kind,
    })),
    live: isLive(key, gate, r),
  }));

  return {
    columns: cfg.listColumns,
    rows,
    gateColumn: gate,
    truncated: raw.length >= LIMIT,
  };
}
