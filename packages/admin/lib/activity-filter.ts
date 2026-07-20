// =============================================================================
// packages/admin — hide retired Framer-sync noise from activity surfaces.
//
// Framer push was removed (2026-07); sync_log and audit_log still contain
// historical rows. Activity UIs filter these so operators only see live pipelines.
// =============================================================================

import type { AuditRow } from './activity-format';

/** Legacy sync_log sources that should not appear in operator-facing activity. */
const HIDDEN_SYNC_SOURCES = new Set(['framer', 'framer-push', 'renderings']);

export function normalizeSyncSource(source: string | null | undefined): string {
  return (source ?? '').trim().toLowerCase();
}

export function isHiddenSyncSource(source: string | null | undefined): boolean {
  const s = normalizeSyncSource(source);
  return s !== '' && HIDDEN_SYNC_SOURCES.has(s);
}

/** SQL WHERE fragment excluding legacy Framer/renderings sync rows. */
export const SYNC_LOG_ACTIVITY_WHERE = `LOWER(TRIM(COALESCE(source, ''))) NOT IN ('framer', 'framer-push', 'renderings')`;

export function isHiddenAuditRow(row: Pick<AuditRow, 'entity' | 'field' | 'action' | 'actor'>): boolean {
  const blob = [row.entity, row.field, row.action, row.actor]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return blob.includes('framer');
}

export function filterAuditRows<T extends AuditRow>(rows: T[]): T[] {
  return rows.filter((r) => !isHiddenAuditRow(r));
}
