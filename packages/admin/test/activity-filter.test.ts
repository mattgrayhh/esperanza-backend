import { describe, expect, it } from 'vitest';
import {
  filterAuditRows,
  isHiddenAuditRow,
  isHiddenSyncSource,
  normalizeSyncSource,
} from '../lib/activity-filter';

describe('activity-filter', () => {
  it('normalizes sync sources', () => {
    expect(normalizeSyncSource(' Framer ')).toBe('framer');
    expect(normalizeSyncSource(null)).toBe('');
  });

  it('flags legacy sync sources', () => {
    expect(isHiddenSyncSource('framer')).toBe(true);
    expect(isHiddenSyncSource('Framer')).toBe(true);
    expect(isHiddenSyncSource(' framer-push ')).toBe(true);
    expect(isHiddenSyncSource('renderings')).toBe(true);
    expect(isHiddenSyncSource('snowflake')).toBe(false);
    expect(isHiddenSyncSource(null)).toBe(false);
  });

  it('flags framer-related audit rows', () => {
    expect(
      isHiddenAuditRow({ entity: 'field_definitions', field: 'framer_type', action: 'update', actor: 'a@b.com' })
    ).toBe(true);
    expect(
      isHiddenAuditRow({ entity: 'qmi', field: 'description', action: 'update', actor: 'framer-push' })
    ).toBe(true);
    expect(
      isHiddenAuditRow({ entity: 'qmi', field: 'description', action: 'update', actor: 'a@b.com' })
    ).toBe(false);
  });

  it('filterAuditRows drops hidden rows', () => {
    const rows = filterAuditRows([
      { entity: 'qmi', field: 'price', action: 'update', actor: 'a@b.com', at: '2026-07-20T00:00:00Z' },
      { entity: 'field_definitions', field: 'framer_type', action: 'update', actor: 'a@b.com', at: '2026-07-19T00:00:00Z' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.field).toBe('price');
  });
});
