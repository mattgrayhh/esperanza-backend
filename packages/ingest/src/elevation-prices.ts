// =============================================================================
// Close-out elevation prices (0019). The community_elevation_prices table is a
// small, FULLY-DERIVED lookup (per community × offered model × elevation), not a
// queue/diff target like qmi/communities/floor_plans. Each ingest run rebuilds it
// wholesale: resolve every Snowflake per-elevation price row to a D1 community +
// floor-plan id, then DELETE-all + INSERT in one atomic D1 batch.
//
// Read path: the close-out price_from resolution (views.sql / api / pdf)
// takes MIN(sales_price) for the community's chosen close_out_elevation label
// among its offered published plans. See migration 0019.
// =============================================================================

import {
  normalizeCommunityName,
  normalizeFloorPlanName,
  type SnowflakeElevationPriceRow,
} from './snowflake.js';
import type { Lookups } from './diff.js';
import type { D1Like } from './consumer.js';

export interface ElevationPriceRow {
  id: string;
  communityId: string;
  floorPlanId: string;
  elevationType: string;
  materialType: string;
  elevationLabel: string; // "Type / Material"
  salesPrice: number;
}

/** Label shown in the admin dropdown and matched by close_out_elevation. The
 *  separator lives here ONLY — keep field-config's option strings identical. */
export function elevationLabel(type: string, material: string): string {
  return `${type} / ${material}`;
}

/**
 * Resolve raw Snowflake per-elevation rows to D1-keyed rows. A row is dropped
 * when its development doesn't map to a known community or its model to a known
 * floor plan (those simply can't be priced by a community's offered-plan picker).
 * Duplicate (community, plan, elevation) keys collapse to the MIN price.
 */
export function buildElevationPriceRows(
  snowflakeRows: SnowflakeElevationPriceRow[],
  lookups: Lookups
): { rows: ElevationPriceRow[]; skipped: number } {
  const byId = new Map<string, ElevationPriceRow>();
  let skipped = 0;
  for (const r of snowflakeRows) {
    const communityId = lookups.communityByName.get(normalizeCommunityName(r.developmentName).toLowerCase());
    const floorPlanId = lookups.floorPlanByName.get(normalizeFloorPlanName(r.modelName).toLowerCase());
    if (!communityId || !floorPlanId) {
      skipped++;
      continue;
    }
    const label = elevationLabel(r.elevationType, r.materialType);
    const id = `${communityId}:${floorPlanId}:${label}`;
    const existing = byId.get(id);
    if (!existing || r.price < existing.salesPrice) {
      byId.set(id, {
        id,
        communityId,
        floorPlanId,
        elevationType: r.elevationType,
        materialType: r.materialType,
        elevationLabel: label,
        salesPrice: r.price,
      });
    }
  }
  return { rows: [...byId.values()], skipped };
}

/**
 * Replace the whole table: DELETE-all, then INSERT in chunked D1 batches (the
 * derived set can be several hundred rows; one giant batch risks D1's per-call
 * limits). Each batch is its own transaction — if a later chunk fails the table
 * is partial, but the close-out price safely falls back to the auto-MIN (never
 * blank) and the next run rebuilds it.
 */
export async function writeElevationPrices(db: D1Like, rows: ElevationPriceRow[]): Promise<void> {
  await db.batch([db.prepare('DELETE FROM community_elevation_prices').bind()]);
  const insert = db.prepare(
    `INSERT INTO community_elevation_prices
       (id, community_id, floor_plan_id, elevation_type, material_type, elevation_label, sales_price)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const stmts = rows
      .slice(i, i + CHUNK)
      .map((r) =>
        insert.bind(r.id, r.communityId, r.floorPlanId, r.elevationType, r.materialType, r.elevationLabel, r.salesPrice)
      );
    await db.batch(stmts);
  }
}
