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
import { cities } from '@esperanza/db';
import { getReadDb } from './db';
import { type EntityKey } from './entities';
import { publishGateColumn, type ListColumn } from './field-config';
import { resolveFieldConfig } from './field-config-source';

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

// [8] USD currency, no decimals: 425000 -> "$425,000".
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function fmt(v: unknown, kind: ListColumn['kind']): string {
  if (v == null || v === '') return '';
  if (kind === 'boolean') return v === 1 || v === true || v === '1' ? 'yes' : 'no';
  if (kind === 'currency') {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? USD.format(n) : String(v);
  }
  return String(v);
}

/** Is this entity's gate value "live"? null when the entity has no gate. */
function isLive(key: EntityKey, gate: string | null, row: Record<string, unknown>): boolean | null {
  if (!gate) return null;
  if (gate === 'status') return row['status'] !== 'Draft';
  return Boolean(row[gate]);
}

/** [9] cityId -> human city name. The communities list stores a raw city_id; we
 *  resolve it to the city NAME for display (falling back to the raw id when unknown). */
async function loadCityNameMap(): Promise<Map<string, string>> {
  const db = getReadDb();
  const rows = (await db
    .select({ id: cities.id, name: cities.cityName })
    .from(cities)
    .limit(LIMIT)) as Array<{ id: string; name: string | null }>;
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.id, r.name?.trim() || r.id);
  return m;
}

export async function buildListView(key: EntityKey): Promise<ListView> {
  // ENGINE SWAP: list columns now come from field_definitions (D1), with a SAFE FALLBACK
  // to the static lib/field-config.ts when the entity has zero rows. Same `listColumns`
  // shape as before, so the generic list page is unchanged.
  const cfg = await resolveFieldConfig(key);
  const gate = publishGateColumn(key);
  const db = getReadDb();

  const raw = await db.all<Record<string, unknown>>(sql.raw(selectSqlFor(key)));

  // [9] Communities list shows the city by NAME, not the raw city_id record id.
  const cityNames =
    key === 'communities' && cfg.listColumns.some((c) => c.field === 'city_id')
      ? await loadCityNameMap()
      : null;

  const rows: ListRow[] = raw.map((r) => ({
    id: String(r['id']),
    cells: cfg.listColumns.map((c) => {
      if (cityNames && c.field === 'city_id') {
        const cid = r['city_id'];
        const resolved = cid == null || cid === '' ? '' : (cityNames.get(String(cid)) ?? String(cid));
        return { field: c.field, value: resolved, kind: c.kind };
      }
      return {
        field: c.field,
        value: fmt(r[c.field], c.kind),
        kind: c.kind,
      };
    }),
    live: isLive(key, gate, r),
  }));

  return {
    columns: cfg.listColumns,
    rows,
    gateColumn: gate,
    truncated: raw.length >= LIMIT,
  };
}
