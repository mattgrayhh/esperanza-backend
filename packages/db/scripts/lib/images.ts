// =============================================================================
// esperanza-cf — the shared "resolve every image field on a mapped row to stable
// urls" pass. Used by BOTH import-from-airtable.ts (inline, default) and
// migrate-images.ts (standalone re-run against the live DB rows / Airtable).
//
// It knows, per entity, which D1 columns are image-bearing and whether they hold
// a single url (TEXT) or a JSON array of {url,filename} / double-wrapped [[{url}]].
// For each, it rewrites any signed/attachment url to a stable R2 url via
// migrateImageUrl(), leaving already-stable urls untouched. After this pass, the
// importer's hard guard (findAirtableUrl) must find ZERO offending urls.
// =============================================================================

import { migrateImageUrl, isSignedAirtableUrl, type MigrateOptions } from './r2.js';
import { findAirtableUrl } from './coerce.js';

/** image columns that hold a single url string. */
const SINGLE_URL_COLS: Record<string, string[]> = {
  qmi: ['image_url', 'og_image_url', 'page_url', 'dynamic_pdf'],
  communities: [
    'featured_image_url',
    'secondary_image_url',
    'photo_gallery_image_url',
    'description_image_url',
    'community_logo_url',
    'features_download_url',
    'resources_download_url',
  ],
  cities: ['hero_image_url'],
  floor_plans: ['image_url', 'hero_image_2', 'hero_image_3', 'brochure_pdf_url', 'brochure_pdf'],
  promotions: ['image_url'],
  collections: ['header_image'],
  images: ['file_url'],
  blogs: ['featured_image'],
  testimonials: ['image_url', 'floor_plan_image'],
};

/** image columns that hold a JSON array of {url,filename}. */
const ARRAY_URL_COLS: Record<string, string[]> = {
  qmi: ['featured_image', 'image_2', 'image_3', 'image_4', 'image_5'],
  floor_plans: [
    'synced_image_url',
    'elevation_renderings',
    'elevation_gallery',
    'photo_gallery_urls',
    'photo_gallery',
    'additional_images',
    'additional_images_gallery',
    // FP:* image lookups now sourced from floor_plans (moved off qmi). Stored as a
    // JSON array of {url,filename} so the [{...}] / single-element shape survives.
    'fp_image',
    'fp_additional_images',
  ],
};

/** FP:* columns that are DOUBLE-wrapped [[{url}]] (image lookups). None remain
 *  after the qmi.fp_* removal; fp_image/fp_additional_images moved to floor_plans
 *  as single-level JSON arrays handled by ARRAY_URL_COLS above. */
const DOUBLE_WRAPPED_COLS: Record<string, string[]> = {};

/**
 * Columns that hold a JSON OBJECT whose values include image-url STRING fields
 * mixed in with non-image copy. cities collapses its parallel copy/image groups
 * into city_copy_blocks_json / city_venue_blocks_json (see mappers.ts); those
 * blocks embed bare attachment urls (firstAttachmentUrl) at keys like
 * `live_in_image`, `image_0`, `section_1_image`, `eat_image`, … Because a
 * JSON-blocks column is NOT a SINGLE/ARRAY image column, nothing migrated those
 * urls before — so the signed airtableusercontent urls survived inside the blob
 * and the importer's whole-row guard flagged EVERY city row (nulling the entire
 * block, copy and all). We migrate the embedded image urls in place so the block
 * keeps its R2 urls and carries ZERO forbidden urls. An image key is any object
 * key ending in `_image` or starting with `image_` (matches the mapper naming).
 */
const JSON_OBJECT_IMAGE_COLS: Record<string, string[]> = {
  cities: ['city_copy_blocks_json', 'city_venue_blocks_json'],
};

/** True for a blocks-object key whose value is an embedded image url string. */
function isEmbeddedImageKey(key: string): boolean {
  return key.endsWith('_image') || key.startsWith('image_');
}

export interface ImagePassStats {
  scanned: number;
  uploaded: number;
  bytes: number;
}

/**
 * Rewrite every image-bearing column on `row` (a mapped D1 row for `table`) to
 * stable urls. Mutates `row` in place. Returns per-row stats.
 */
export async function resolveRowImages(
  table: string,
  recordId: string,
  row: Record<string, unknown>,
  opts: MigrateOptions
): Promise<ImagePassStats> {
  const stats: ImagePassStats = { scanned: 0, uploaded: 0, bytes: 0 };

  // single-url columns
  for (const col of SINGLE_URL_COLS[table] ?? []) {
    const v = row[col];
    if (typeof v !== 'string' || !v) continue;
    stats.scanned++;
    const res = await migrateImageUrl(table, recordId, v, undefined, opts);
    row[col] = res.url;
    if (res.uploaded) {
      stats.uploaded++;
      stats.bytes += res.bytes ?? 0;
    }
  }

  // JSON-array columns [{url,filename},...]
  for (const col of ARRAY_URL_COLS[table] ?? []) {
    const json = row[col];
    if (typeof json !== 'string' || !json) continue;
    let arr: any[];
    try {
      arr = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(arr) || arr.length === 0) continue;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (item && typeof item === 'object' && typeof item.url === 'string') {
        stats.scanned++;
        const res = await migrateImageUrl(table, recordId, item.url, item.filename, opts);
        item.url = res.url;
        if (res.uploaded) {
          stats.uploaded++;
          stats.bytes += res.bytes ?? 0;
        }
      }
    }
    row[col] = JSON.stringify(arr);
  }

  // double-wrapped [[{url}]] columns (FP:* image lookups)
  for (const col of DOUBLE_WRAPPED_COLS[table] ?? []) {
    const json = row[col];
    if (typeof json !== 'string' || !json) continue;
    let outer: any[];
    try {
      outer = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(outer)) continue;
    for (const inner of outer) {
      if (!Array.isArray(inner)) continue;
      for (const item of inner) {
        if (item && typeof item === 'object' && typeof item.url === 'string') {
          stats.scanned++;
          const res = await migrateImageUrl(table, recordId, item.url, item.filename, opts);
          if (res.uploaded) {
            stats.uploaded++;
            stats.bytes += res.bytes ?? 0;
          }
          item.url = res.url;
        }
      }
    }
    row[col] = JSON.stringify(outer);
  }

  // JSON-object blocks columns: rewrite embedded image-url string fields in place.
  for (const col of JSON_OBJECT_IMAGE_COLS[table] ?? []) {
    const json = row[col];
    if (typeof json !== 'string' || !json) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(json);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    let changed = false;
    for (const [key, value] of Object.entries(obj)) {
      if (!isEmbeddedImageKey(key) || typeof value !== 'string' || !value) continue;
      stats.scanned++;
      const res = await migrateImageUrl(table, recordId, value, undefined, opts);
      obj[key] = res.url;
      changed = true;
      if (res.uploaded) {
        stats.uploaded++;
        stats.bytes += res.bytes ?? 0;
      }
    }
    if (changed) row[col] = JSON.stringify(obj);
  }

  return stats;
}

/**
 * Strip (null/empty) every image-bearing column that still holds a signed/
 * attachment url. Used by import --skip-images so a row is NEVER persisted with a
 * forbidden url; migrate-images.ts fills them in a later pass.
 */
export function stripUnmigratedImages(table: string, row: Record<string, unknown>): number {
  let stripped = 0;
  for (const col of SINGLE_URL_COLS[table] ?? []) {
    const v = row[col];
    if (typeof v === 'string' && isSignedAirtableUrl(v)) {
      row[col] = null;
      stripped++;
    }
  }
  for (const col of [...(ARRAY_URL_COLS[table] ?? []), ...(DOUBLE_WRAPPED_COLS[table] ?? [])]) {
    const v = row[col];
    if (typeof v === 'string' && findAirtableUrl(v)) {
      row[col] = null;
      stripped++;
    }
  }
  // JSON-object blocks: null ONLY the offending embedded image keys (keep the copy).
  for (const col of JSON_OBJECT_IMAGE_COLS[table] ?? []) {
    const v = row[col];
    if (typeof v !== 'string' || !v) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(v);
    } catch {
      // un-parseable but still carrying a forbidden url — null the whole column.
      if (findAirtableUrl(v)) {
        row[col] = null;
        stripped++;
      }
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    let changed = false;
    for (const [key, value] of Object.entries(obj)) {
      if (isEmbeddedImageKey(key) && typeof value === 'string' && findAirtableUrl(value)) {
        delete obj[key];
        changed = true;
        stripped++;
      }
    }
    if (changed) row[col] = Object.keys(obj).length ? JSON.stringify(obj) : null;
  }
  return stripped;
}

/** All image-bearing column names for a table (for verification scans). */
export function imageColumns(table: string): string[] {
  return [
    ...(SINGLE_URL_COLS[table] ?? []),
    ...(ARRAY_URL_COLS[table] ?? []),
    ...(DOUBLE_WRAPPED_COLS[table] ?? []),
    ...(JSON_OBJECT_IMAGE_COLS[table] ?? []),
  ];
}
