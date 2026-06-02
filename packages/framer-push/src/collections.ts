// =============================================================================
// esperanza-cf framer-push — the 9 managed-collection definitions: the SQL that
// reads the FULL per-entity field set from D1, the draft (soft-delete) gate, and
// the mapper that builds a Framer ManagedCollectionItemInput.
//
// PORTED from esperanza-sync's index.ts mappers, but the SOURCE changed: instead
// of raw Airtable records (attachment arrays, formula fields), we read D1 columns
// where image URLs are ALREADY stable single strings (Decision-log #9: never
// persist expiring airtableusercontent URLs). So `firstAttUrl(...)` collapses to
// "read the *_url column"; galleries are stored as JSON arrays / newline strings.
//
// KEY INVARIANTS preserved from the port spec:
//   * UPSERT KEY = item.id = the D1/Airtable record id. Slug is NOT the key.
//   * Always emit the COMPLETE fieldData (addItems will switch to full-replace in
//     framer-api v4) — compactFields only drops genuinely-absent (undefined) values
//     so empty numbers never leak "0" to the live site.
//   * draft:true is SOFT-DELETE — the item & url persist, just hidden in prod.
//   * brochure_pdf_url stays type "string" (never "link") — "link" makes addItems
//     throw and aborts the batch.
//   * slugs for QMI & Testimonials are normalized dashes→underscores (toUnderscore).
//
// READ STRATEGY (soft-delete-safe): we DO NOT read v_public_* directly because
// those views filter out unpublished/draft rows (so a just-unpublished row would
// vanish instead of being pushed as draft:true). Instead each collection has a
// `selectSql` that reads the BASE table with the SAME column projection the view
// exposes (COALESCE(override,synced) for the QMI write-set), PLUS the gate columns
// (published/draft/status/inactive) needed to compute `draft`. That is the
// "full per-entity field set from v_public_*" semantics without the publish filter.
// =============================================================================

import {
  type FieldData,
  type ManagedCollectionItemInput,
  type AnyFieldValue,
  str,
  num,
  bool,
  image,
  link,
  formattedText,
  galleryArray,
} from './framer-types.js';
import { markdownToHtml } from './markdown.js';
import type { CollectionKey } from './types.js';

export type Row = Record<string, unknown>;

// =============================================================================
// mapper helpers (port of index.ts:447-503)
// =============================================================================

/** Join arrays to a string; pass scalars through; null/undefined → undefined. */
export function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const joined = v.filter((x) => x != null).join(', ');
    return joined === '' ? undefined : joined;
  }
  const s = String(v);
  return s === '' ? undefined : s;
}

/**
 * A valid absolute http(s) URL, else undefined. Feeds image() and link() fields,
 * which framer-api passes to `new URL(...)` — a non-URL value (e.g. a stringified
 * attachment object that imported as the literal "[object Object]") would throw
 * "Invalid URL" and ABORT the whole item upsert. Dropping the bad value instead
 * keeps the rest of the item (and every other item in the batch) syncing.
 */
export function urlOf(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === '') return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/** numField: empty → undefined (dropped) so "0" never leaks to the live site. */
export function numField(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** SQLite boolean (0/1) → JS boolean. */
export function asBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

/** dashes → underscores (project convention: `tres-lagos` → `tres_lagos`). */
export function toUnderscore(s: string): string {
  return s.replace(/-/g, '_');
}

/** kebab-case a name for slug derivation. */
export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parse a JSON-array column (stored TEXT). Returns [] on null/empty/parse-fail. */
export function parseJsonArray(raw: unknown): unknown[] {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Parse a JSON-object column (stored TEXT). Returns {} on null/empty/parse-fail. */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Coerce a stored gallery column into a list of url strings. Accepts:
 *   - JSON array of strings:            ["https://a","https://b"]
 *   - JSON array of {url} objects:      [{"url":"https://a"},...]  (Airtable shape)
 *   - newline-joined string:            "https://a\nhttps://b"
 */
export function galleryUrls(raw: unknown): string[] {
  if (raw == null || raw === '') return [];
  // newline string?
  if (typeof raw === 'string' && raw.indexOf('\n') !== -1 && raw.trim()[0] !== '[') {
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  const arr = parseJsonArray(raw);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s) out.push(s);
    } else if (item && typeof item === 'object') {
      const u = (item as Record<string, unknown>)['url'];
      if (typeof u === 'string' && u.trim()) out.push(u.trim());
    }
  }
  // single bare string (no newline, not JSON array)
  if (out.length === 0 && typeof raw === 'string' && raw.trim() && raw.trim()[0] !== '[') {
    out.push(raw.trim());
  }
  return out;
}

/** Newline-join a list of urls (the *_urls string-field shape). */
export function joinUrls(urls: string[]): string | undefined {
  return urls.length ? urls.join('\n') : undefined;
}

/**
 * compactFields: drop entries whose value is undefined / empty-string / NaN-number.
 * Mirrors the esperanza-sync contract — undefined numbers must be DROPPED, never
 * sent as 0. Note: explicit `false` booleans and the number 0 ARE kept when the
 * mapper deliberately emits them (e.g. published=false); only `undefined` builders
 * are dropped because the builders below return `undefined` (not a 0-value) for absent.
 */
export function compactFields(entries: Record<string, AnyFieldValue | undefined>): FieldData {
  const out: FieldData = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// -- conditional builders: return undefined (→ dropped) when the source is absent --
const sIf = (v: unknown) => {
  const s = asString(v);
  return s === undefined ? undefined : str(s);
};
const nIf = (v: unknown) => {
  const n = numField(v);
  return n === undefined ? undefined : num(n);
};
const imgIf = (v: unknown) => {
  const u = urlOf(v);
  return u === undefined ? undefined : image(u);
};
const linkIf = (v: unknown) => {
  const u = urlOf(v);
  return u === undefined ? undefined : link(u);
};
const ftIf = (v: unknown) => {
  const html = markdownToHtml(asString(v));
  return html === '' ? undefined : formattedText(html);
};
const galIf = (urls: string[]) => (urls.length ? galleryArray(urls) : undefined);

// =============================================================================
// Collection definition
// =============================================================================

export interface CollectionDef {
  key: CollectionKey;
  /** Default Framer collection NAME; env FRAMER_COLLECTION_<KEY> overrides. */
  defaultCollectionName: string;
  /** Env var that overrides the collection name. */
  collectionEnvVar: string;
  /** SELECT that returns the FULL field set + gate columns for one row by id. */
  selectByIdSql: string;
  /** SELECT that returns ALL rows (for backfill / orphan reconciliation). */
  selectAllSql: string;
  /** Map a D1 row → Framer item (id = record id, draft gate applied). */
  map(row: Row): ManagedCollectionItemInput;
}

// ---------------------------------------------------------------------------
// SQL projection fragments. QMI is the only table with synced_/override_ pairs,
// so its projection COALESCEs (mirroring v_public_qmi) but reads the base table
// (no published filter) and additionally selects the gate columns.
// ---------------------------------------------------------------------------

const QMI_PROJECTION = `
  q.id AS id,
  COALESCE(q.override_address,             q.synced_address)             AS address,
  COALESCE(q.override_postal_code,         q.synced_postal_code)         AS postal_code,
  COALESCE(q.override_bedroom_count,       q.synced_bedroom_count)       AS bedroom_count,
  COALESCE(q.override_bathroom_count,      q.synced_bathroom_count)      AS bathroom_count,
  COALESCE(q.override_half_bathroom_count, q.synced_half_bathroom_count) AS half_bathroom_count,
  COALESCE(q.override_living_square_footage, q.synced_living_square_footage) AS living_square_footage,
  COALESCE(q.override_total_square_footage,  q.synced_total_square_footage)  AS total_square_footage,
  COALESCE(q.override_elevation,           q.synced_elevation)           AS elevation,
  COALESCE(q.override_construction_stage,  q.synced_construction_stage)  AS construction_stage,
  COALESCE(q.override_city_id,             q.synced_city_id)             AS city_id,
  COALESCE(q.override_community_id,        q.synced_community_id)        AS community_id,
  COALESCE(q.override_floor_plan_id,       q.synced_floor_plan_id)       AS floor_plan_id,
  COALESCE(q.override_price,               q.synced_price)               AS price,
  q.synced_city_name        AS city,
  q.synced_community_name   AS community,
  q.synced_floor_plan_name  AS floor_plan,
  q.eci_key, q.mark_job_number, q.housenumber,
  q.slug, q.seo_slug, q.rich_slug, q.viewer_slug,
  q.latitude, q.longitude, q.geo_latitude, q.geo_longitude,
  q.collection, q.estimated_monthly_price, q.estimated_monthly_payment, q.monthly_energy_cost,
  q.car_garage_count, q.stories_count, q.stories,
  q.available_now, q.self_tour_available, q.include_in_xml_feed,
  q.image_url, q.og_image_url, q.page_url, q.dynamic_pdf,
  q.featured_image, q.image_2, q.image_3, q.image_4, q.image_5,
  q.description, q.upgrades, q.incentive, q.virtual_tour_url, q.elevation_type,
  q.mls_id, q.mls_number, q.lot_number, q.year_built, q.lot_size_sqft, q.move_in_date,
  q.hers_score, q.arm_rate, q.promo_text, q.availability_text, q.nter_now, q.cities,
  q.posted, q.publish_date, q.last_modified_time,
  -- FP:* lookups resolved from the linked floor plan (qmi.fp_* removed — D1
  -- 100-col limit; mirrors v_public_qmi's LEFT JOIN). Same output names so the
  -- mapper below is unchanged. fp_image / fp_additional_images carry attachment
  -- JSON and live on floor_plans.
  fp.bedroom_min            AS fp_bedrooms_min,
  fp.bedroom_max            AS fp_bedrooms_max,
  fp.bathroom_max           AS fp_bathrooms_max,
  fp.car_garage_count       AS fp_garage,
  fp.living_square_footage  AS fp_living_sqft,
  fp.total_square_footage   AS fp_total_sqft,
  fp.description            AS fp_description,
  fp.fp_image               AS fp_image,
  fp.fp_additional_images   AS fp_additional_images,
  fp.starting_price         AS fp_starting_price,
  fp.virtual_tour_url       AS fp_virtual_tour,
  fp.plan_viewer_url        AS fp_plan_viewer,
  fp.collection             AS fp_collection,
  fp.master_bed_location    AS fp_master_bed_location,
  q.published,
  q.coming_soon
FROM qmi q
LEFT JOIN floor_plans fp
  ON fp.id = COALESCE(q.override_floor_plan_id, q.synced_floor_plan_id)`;

// FP:* lookup columns are stored as JSON single-element arrays; unwrap to scalar.
function fpScalar(raw: unknown): unknown {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length ? parsed[0] : undefined;
    return parsed;
  } catch {
    return raw;
  }
}
function fpScalarUrl(raw: unknown): unknown {
  const inner = fpScalar(raw);
  if (inner == null) return undefined;
  if (typeof inner === 'object') {
    const u = (inner as Record<string, unknown>)['url'];
    return typeof u === 'string' ? u : undefined;
  }
  return inner;
}

// =============================================================================
// 1. FLOOR PLANS  (draft = !published — published is formula NOT({Inactive?}))
// =============================================================================
const floorPlans: CollectionDef = {
  key: 'floor_plans',
  defaultCollectionName: 'Floor Plans',
  collectionEnvVar: 'FRAMER_COLLECTION_FLOOR_PLANS',
  selectByIdSql: `SELECT * FROM floor_plans WHERE id = ?`,
  selectAllSql: `SELECT * FROM floor_plans`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['name']) ? kebab(String(row['name'])) : id);
    const draft = !asBool(row['published']);
    const photo = galleryUrls(row['photo_gallery']);
    const photoUrlsStr = asString(row['photo_gallery_urls']) ?? joinUrls(photo);
    const elevGallery = galleryUrls(row['elevation_gallery']);
    const addl = galleryUrls(row['additional_images_gallery']);
    const fieldData = compactFields({
      name: sIf(row['name']),
      slug: str(slug),
      collection: sIf(row['collection']),
      starting_price: nIf(row['starting_price']),
      bedroom_count_minimum: nIf(row['bedroom_min']),
      bedroom_count_maximum: nIf(row['bedroom_max']),
      // Live Floor Plans (Managed) field ids are *_minimum/_maximum (match bedrooms);
      // emitting *_min/_max silently dropped bathroom data. Reuse the existing live fields.
      bathroom_count_minimum: nIf(row['bathroom_min']),
      bathroom_count_maximum: nIf(row['bathroom_max']),
      car_garage_count: nIf(row['car_garage_count']),
      stories_count: nIf(row['stories_count']),
      living_square_footage: nIf(row['living_square_footage']),
      total_square_footage: nIf(row['total_square_footage']),
      image_url: imgIf(urlOf(row['image_url']) ?? urlOf(row['synced_image_url'])),
      hero_image_2: imgIf(row['hero_image_2']),
      hero_image_3: imgIf(row['hero_image_3']),
      description: sIf(row['description']),
      plan_viewer_url: sIf(row['plan_viewer_url']),
      virtual_tour_url: sIf(row['virtual_tour_url']),
      master_bed_location: sIf(row['master_bed_location']),
      incentive: sIf(row['incentive']),
      coming_soon: bool(asBool(row['coming_soon'])),
      // brochure_pdf_url MUST stay "string" (link type breaks live binding & aborts batch)
      brochure_pdf_url: sIf(row['brochure_pdf_url']),
      brochure_pdf: sIf(row['brochure_pdf']),
      hers_score: nIf(row['hers_score']),
      energy_cost_esperanza_monthly: nIf(row['energy_cost_low']),
      energy_cost_preowned_monthly: nIf(row['energy_cost_high']),
      energy_cost_monthly_savings: nIf(row['energy_cost_avg']),
      communities: sIf(row['communities']),
      community_count: nIf(row['community_count']),
      photo_gallery_urls: photoUrlsStr === undefined ? undefined : str(photoUrlsStr),
      photo_gallery: galIf(photo),
      elevation_renderings: sIf(row['elevation_renderings']),
      elevation_gallery: galIf(elevGallery),
      additional_images: sIf(row['additional_images']),
      additional_images_gallery: galIf(addl),
      quick_move_in_ids: sIf(row['quick_move_in_ids']),
      promotion_ids: sIf(row['promotion_ids']),
    });
    return { id, slug, draft, fieldData };
  },
};

// =============================================================================
// 2. QMI  (draft = published !== true || inactive — here strictly !published,
//          since D1 published is the single live gate)
// =============================================================================
const qmi: CollectionDef = {
  key: 'qmi',
  defaultCollectionName: 'Quick Move-Ins',
  collectionEnvVar: 'FRAMER_COLLECTION_QMI',
  selectByIdSql: `SELECT ${QMI_PROJECTION} WHERE q.id = ?`,
  selectAllSql: `SELECT ${QMI_PROJECTION}`,
  map(row) {
    const id = String(row['id']);
    const recSuffix = id.length >= 11 ? id.slice(3, 11) : id.replace(/^rec/, '');
    const baseSlug =
      asString(row['viewer_slug']) ??
      asString(row['seo_slug']) ??
      asString(row['rich_slug']) ??
      asString(row['slug']) ??
      (asString(row['address'])
        ? `${kebab(String(row['address']))}-${recSuffix}`
        : id);
    const slug = toUnderscore(baseSlug);
    const draft = !asBool(row['published']);

    const fpImageUrl = fpScalarUrl(row['fp_image']);
    const fpAddl = galleryUrls(row['fp_additional_images']);
    const floorPlanSlug = asString(row['floor_plan'])
      ? kebab(String(row['floor_plan']))
      : undefined;

    const fieldData = compactFields({
      address: sIf(row['address']),
      slug: str(slug),
      city: sIf(row['city']),
      postal_code: sIf(row['postal_code']), // live field is type string ("ZIP") — emit string, not number
      latitude: nIf(row['latitude']),
      longitude: nIf(row['longitude']),
      community: sIf(row['community']),
      floor_plan: sIf(row['floor_plan']),
      floor_plan_slug: floorPlanSlug === undefined ? undefined : str(floorPlanSlug),
      collection: sIf(row['collection']),
      price: nIf(row['price']),
      estimated_monthly_price: nIf(row['estimated_monthly_price']),
      // Snowflake-first, FP-lookup fallback
      bedroom_count: nIf(row['bedroom_count'] ?? fpScalar(row['fp_bedrooms_max'])),
      bathroom_count: nIf(row['bathroom_count'] ?? fpScalar(row['fp_bathrooms_max'])),
      car_garage_count: nIf(row['car_garage_count'] ?? fpScalar(row['fp_garage'])),
      stories_count: nIf(row['stories_count'] ?? row['stories']),
      living_square_footage: nIf(row['living_square_footage'] ?? fpScalar(row['fp_living_sqft'])),
      total_square_footage: nIf(row['total_square_footage'] ?? fpScalar(row['fp_total_sqft'])),
      self_tour_available: bool(asBool(row['self_tour_available'])),
      available_now: bool(asBool(row['available_now'])),
      image_url: imgIf(
        urlOf(row['image_url']) ??
          urlOf(row['og_image_url']) ??
          fpScalarUrl(row['fp_image'])
      ),
      dynamic_pdf: sIf(row['dynamic_pdf']),
      featured_image: imgIf(row['featured_image']),
      image_2: imgIf(row['image_2']),
      image_3: imgIf(row['image_3']),
      image_4: imgIf(row['image_4']),
      image_5: imgIf(row['image_5']),
      description: sIf(row['description']),
      upgrades: sIf(row['upgrades']),
      incentive: sIf(row['incentive']),
      virtual_tour_url: sIf(row['virtual_tour_url']),
      elevation_type: sIf(row['elevation_type'] ?? row['elevation']),
      housenumber: sIf(row['housenumber']),
      mls_id: sIf(row['mls_id']),
      lot_number: sIf(row['lot_number']),
      year_built: nIf(row['year_built']),
      lot_size_sqft: nIf(row['lot_size_sqft']),
      move_in_date: sIf(row['move_in_date']),
      estimated_monthly_payment: nIf(row['estimated_monthly_payment']),
      published: bool(asBool(row['published'])),
      coming_soon: bool(asBool(row['coming_soon'])),
      // FP:* flattened
      fp_description: sIf(fpScalar(row['fp_description'])),
      fp_virtual_tour: sIf(fpScalar(row['fp_virtual_tour'])),
      fp_plan_viewer: sIf(fpScalar(row['fp_plan_viewer'])),
      fp_master_bed_location: sIf(fpScalar(row['fp_master_bed_location'])),
      fp_image: imgIf(fpImageUrl),
      fp_additional_images:
        joinUrls(fpAddl) === undefined ? undefined : str(joinUrls(fpAddl) as string),
      fp_additional_images_gallery: galIf(fpAddl),
      fp_starting_price: nIf(fpScalar(row['fp_starting_price'])),
      fp_collection: sIf(fpScalar(row['fp_collection'])),
    });
    return { id, slug, draft, fieldData };
  },
};

// =============================================================================
// 3. COMMUNITIES  (draft = !published — the `draft` column was DROPPED in
//    migration 0005; published is now the single gate, like every other entity)
// =============================================================================
const communities: CollectionDef = {
  key: 'communities',
  defaultCollectionName: 'Communities',
  collectionEnvVar: 'FRAMER_COLLECTION_COMMUNITIES',
  selectByIdSql: `SELECT * FROM communities WHERE id = ?`,
  selectAllSql: `SELECT * FROM communities`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['name']) ? kebab(String(row['name'])) : id);
    // single gate: not published (the `draft` column was dropped in migration 0005)
    const draft = !asBool(row['published']);

    // lat/long: parse from map_coordinates "lat,long" if the numeric cols are null
    let latitude = numField(row['latitude']);
    let longitude = numField(row['longitude']);
    if ((latitude === undefined || longitude === undefined) && asString(row['map_coordinates'])) {
      const m = String(row['map_coordinates']).match(
        /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/
      );
      if (m && m[1] && m[2]) {
        const la = Number(m[1]);
        const lo = Number(m[2]);
        if (!Number.isNaN(la)) latitude = la;
        if (!Number.isNaN(lo)) longitude = lo;
      }
    }

    const photo = galleryUrls(row['photo_gallery_image_url']);

    // HOA links: stored as JSON [{title,link},...] (x7) → hoa_link_title_N + hoa_link_N
    const hoa = parseJsonArray(row['hoa_links_json']);
    const hoaFields: Record<string, AnyFieldValue | undefined> = {};
    for (let i = 0; i < 7; i++) {
      const h = (hoa[i] ?? {}) as Record<string, unknown>;
      const title = asString(h['title']);
      const lnk = urlOf(h['link']);
      hoaFields[`hoa_link_title_${i + 1}`] = title === undefined ? undefined : str(title);
      hoaFields[`hoa_link_${i + 1}`] = lnk === undefined ? undefined : link(lnk);
    }

    const fieldData = compactFields({
      name: sIf(row['name']),
      slug: str(slug),
      floor_plan_plaintext: sIf(row['floor_plan_plaintext']),
      town: sIf(row['town']),
      address: sIf(row['address']),
      get_directions: linkIf(row['directions']),
      lat_long: sIf(row['lat_long'] ?? row['map_coordinates']),
      latitude: latitude === undefined ? undefined : num(latitude),
      longitude: longitude === undefined ? undefined : num(longitude),
      price_from: nIf(row['price_from']),
      bed_range: sIf(row['bed_count']),
      bath_range: sIf(row['bath_count']),
      sqft_range: sIf(row['square_footage_range']),
      description: sIf(row['description']),
      amenities_rich: ftIf(row['amenities']),
      image_url: imgIf(row['featured_image_url']),
      featured_image_alt: sIf(row['featured_image_alt']),
      secondary_image: imgIf(row['secondary_image_url']),
      secondary_image_alt: sIf(row['secondary_image_alt']),
      photo_gallery_image: imgIf(row['photo_gallery_image_url']),
      photo_gallery_urls: joinUrls(photo) === undefined ? undefined : str(joinUrls(photo) as string),
      photo_gallery: galIf(photo),
      photo_gallery_image_alt: sIf(row['photo_gallery_image_alt']),
      description_image: imgIf(row['description_image_url']),
      community_logo: imgIf(row['community_logo_url']),
      community_logo_alt: sIf(row['community_logo_alt']),
      master_planned: bool(asBool(row['master_planned'])),
      coming_soon: bool(asBool(row['coming_soon'])),
      published: bool(asBool(row['published'])),
      featured_video: sIf(row['featured_video']),
      office_phone: sIf(row['office_phone']),
      office_hours: sIf(row['office_hours']),
      schedule_visit: sIf(row['schedule_visit']),
      lending: sIf(row['lending']),
      directions: sIf(row['directions']),
      education_rich: ftIf(row['education_rich']),
      mine_link: sIf(row['mine_link']),
      community_map_embed: sIf(row['community_map_embed']),
      features_download: linkIf(row['features_download_url']),
      resources_download: linkIf(row['resources_download_url']),
      incentive: sIf(row['incentive']),
      // 8 formattedText "*_rich" copy blocks
      design_copy_rich: ftIf(row['design_copy_rich']),
      exterior_construction_copy_rich: ftIf(row['exterior_construction_copy_rich']),
      interior_construction_copy_rich: ftIf(row['interior_construction_copy_rich']),
      conservation_landscape_copy_rich: ftIf(row['conservation_landscape_copy_rich']),
      energy_package_copy_rich: ftIf(row['energy_package_copy_rich']),
      kitchen_features_copy_rich: ftIf(row['kitchen_features_copy_rich']),
      bath_features_copy_rich: ftIf(row['bath_features_copy_rich']),
      esperanza_difference_copy_rich: ftIf(row['esperanza_difference_copy_rich']),
      gas_details_rich: ftIf(row['gas_details_rich']),
      internet_details: sIf(row['internet_details']),
      water_details: sIf(row['water_details']),
      electric_details_rich: ftIf(row['electric_details_rich']),
      security_details: sIf(row['security_details']),
      ...hoaFields,
    });
    return { id, slug, draft, fieldData };
  },
};

// =============================================================================
// 4. COLLECTIONS  (draft = !published — collections gained a `published` gate in
//    migration 0005; backfilled =1 so previously-always-live items stay live)
// =============================================================================
const collections: CollectionDef = {
  key: 'collections',
  defaultCollectionName: 'Collections',
  collectionEnvVar: 'FRAMER_COLLECTION_COLLECTIONS',
  selectByIdSql: `SELECT * FROM collections WHERE id = ?`,
  selectAllSql: `SELECT * FROM collections`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['title']) ? kebab(String(row['title'])) : id);
    const fieldData = compactFields({
      title: sIf(row['title']),
      slug: str(slug),
      content: sIf(row['content']),
      header_image: imgIf(row['header_image']),
      header_image_alt: sIf(row['header_image_alt']),
      starting_at: nIf(row['starting_at']),
      ending_at: nIf(row['ending_at']),
      incentive: sIf(row['incentive']),
    });
    return { id, slug, draft: !asBool(row['published']), fieldData };
  },
};

// =============================================================================
// 5. IMAGES  (draft = !published — images gained a `published` gate in migration
//    0005; backfilled =1 so previously-always-live items stay live)
// =============================================================================
const images: CollectionDef = {
  key: 'images',
  defaultCollectionName: 'Images',
  collectionEnvVar: 'FRAMER_COLLECTION_IMAGES',
  selectByIdSql: `SELECT * FROM images WHERE id = ?`,
  selectAllSql: `SELECT * FROM images`,
  map(row) {
    const id = String(row['id']);
    const slug = asString(row['slug']) ?? id;
    const fieldData = compactFields({
      slug: str(slug),
      plan_name: sIf(row['plan_name']),
      caption: sIf(row['caption']),
      caption_clean: sIf(row['caption_clean']),
      elevation_style: sIf(row['elevation_style']),
      elevation_material: sIf(row['elevation_material']),
      elevation_parsed: sIf(row['elevation_parsed']),
      file: imgIf(row['file_url']),
    });
    return { id, slug, draft: !asBool(row['published']), fieldData };
  },
};

// =============================================================================
// 6. BLOGS  (draft = !published — D1 published default 1; Inactive?===true → 0)
// =============================================================================
const blogs: CollectionDef = {
  key: 'blogs',
  defaultCollectionName: 'Blogs',
  collectionEnvVar: 'FRAMER_COLLECTION_BLOGS',
  selectByIdSql: `SELECT * FROM blogs WHERE id = ?`,
  selectAllSql: `SELECT * FROM blogs`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['title']) ? kebab(String(row['title'])) : id);
    const draft = !asBool(row['published']);
    const fieldData = compactFields({
      title: sIf(row['title']),
      slug: str(slug),
      category: sIf(row['category']),
      excerpt: sIf(row['excerpt']),
      content: sIf(row['content']),
      publish_date: sIf(row['publish_date']),
      featured_image: imgIf(row['featured_image']),
      seo_description: sIf(row['seo_description']),
    });
    return { id, slug, draft, fieldData };
  },
};

// =============================================================================
// 7. PROMOTIONS  (draft = published === false. The gate column was RENAMED from
//    `active` to `published` in migration 0005; published=false hard-hides.)
//    NOTE: image fallback (own → linked community → linked FP) is resolved by the
//    consumer (it needs the promotion_targets join + linked images); the map() here
//    takes a pre-resolved `image_url` on the row.
// =============================================================================
const promotions: CollectionDef = {
  key: 'promotions',
  defaultCollectionName: 'Promotions',
  collectionEnvVar: 'FRAMER_COLLECTION_PROMOTIONS',
  // selectByIdSql joins promotion_targets → csv id lists; image fallback added by consumer.
  selectByIdSql: `
    SELECT p.*,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'community') AS community_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'qmi') AS qmi_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'city') AS city_ids
    FROM promotions p WHERE p.id = ?`,
  selectAllSql: `
    SELECT p.*,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'community') AS community_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'qmi') AS qmi_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'city') AS city_ids
    FROM promotions p`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['title']) ? kebab(String(row['title'])) : id);
    // canonical gate in D1: `published` (1/0), renamed from `active` in migration 0005.
    // published=false → hard-hide (draft:true).
    const draft = !asBool(row['published']);
    const fieldData = compactFields({
      title: sIf(row['title']),
      banner_text: sIf(row['banner_text']),
      card_badge_text: sIf(row['badge_text']),
      copy: sIf(row['copy']),
      cta_label: sIf(row['cta_label']),
      cta_link: linkIf(row['cta_url']),
      applies_to: sIf(row['applies_to']),
      sort_order: nIf(row['sort_order']),
      published: bool(asBool(row['published'])),
      expiration_date: sIf(row['end_date']),
      // image: consumer pre-resolves the fallback chain onto row['image_url'].
      image: imgIf(row['image_url']),
      community_ids: sIf(row['community_ids']),
      floor_plan_ids: sIf(row['floor_plan_ids']),
      collection_ids: sIf(row['collection_ids']),
    });
    return { id, slug, draft, fieldData };
  },
};

// =============================================================================
// 8. CITIES  (draft = !published — cities gained a `published` gate + `coming_soon`
//    flag in migration 0005)
//    City "section_*" / venue blocks are stored as two JSON columns:
//      city_copy_blocks_json  — { hero_description, national_recognition,
//                                 homes_heading, homes_description, live_in_heading,
//                                 live_in_description, live_in_image, section_1_title,
//                                 section_1_description, section_1_image,
//                                 section_1a_image, image_0, section_2_*, section_3_*,
//                                 pillar_1_title.._4_description }
//      city_venue_blocks_json — { eat_venues, shop_venues, play_venues,
//                                 relax_venues, stay_venues (markdown→formattedText),
//                                 eat_image, shop_image, play_image, relax_image,
//                                 stay_image }
//    Both are flat key→value objects (the admin writes them; absent keys are dropped).
// =============================================================================
const VENUE_FT_KEYS = [
  'eat_venues',
  'shop_venues',
  'play_venues',
  'relax_venues',
  'stay_venues',
] as const;
const VENUE_IMG_KEYS = [
  'eat_image',
  'shop_image',
  'play_image',
  'relax_image',
  'stay_image',
] as const;

const cities: CollectionDef = {
  key: 'cities',
  defaultCollectionName: 'Cities',
  collectionEnvVar: 'FRAMER_COLLECTION_CITIES',
  selectByIdSql: `SELECT * FROM cities WHERE id = ?`,
  selectAllSql: `SELECT * FROM cities`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['city_name']) ? kebab(String(row['city_name'])) : id);

    const copy = parseJsonObject(row['city_copy_blocks_json']);
    const venue = parseJsonObject(row['city_venue_blocks_json']);

    // venue blocks: 5 formattedText + 5 image fields
    const venueFields: Record<string, AnyFieldValue | undefined> = {};
    for (const k of VENUE_FT_KEYS) venueFields[k] = ftIf(venue[k]);
    for (const k of VENUE_IMG_KEYS) venueFields[k] = imgIf(venue[k]);

    // copy blocks: section/pillar/heading fields. String vs image distinguished by
    // key suffix (_image → image field; everything else → string).
    const copyFields: Record<string, AnyFieldValue | undefined> = {};
    for (const [k, v] of Object.entries(copy)) {
      if (/_image$/.test(k) || k === 'image_0' || k === 'live_in_image') {
        copyFields[k] = imgIf(v);
      } else {
        copyFields[k] = sIf(v);
      }
    }

    const fieldData = compactFields({
      city_name: sIf(row['city_name']),
      slug: str(slug),
      state: sIf(row['state']),
      status: sIf(row['status']),
      map_latitude: nIf(row['map_latitude']),
      map_longitude: nIf(row['map_longitude']),
      hero_image: imgIf(row['hero_image_url']),
      hero_description: sIf(row['hero_description']),
      national_recognition: sIf(row['national_recognition']),
      community_count: nIf(row['community_count']),
      floor_plans_count: nIf(row['floor_plans_count']),
      move_in_homes_count: nIf(row['move_in_homes_count']),
      incentive: sIf(row['incentive']),
      coming_soon: bool(asBool(row['coming_soon'])),
      ...copyFields,
      ...venueFields,
    });
    // cities gained a published gate in 0005; draft = !published (single gate).
    const draft = !asBool(row['published']);
    return { id, slug, draft, fieldData };
  },
};

// =============================================================================
// 9. TESTIMONIALS  (draft = status === 'Draft' ONLY; empty/unset → LIVE)
//    floor_plan_image is pre-resolved by the consumer (linked FP render).
// =============================================================================
const testimonials: CollectionDef = {
  key: 'testimonials',
  defaultCollectionName: 'Testimonials',
  collectionEnvVar: 'FRAMER_COLLECTION_TESTIMONIALS',
  selectByIdSql: `SELECT * FROM testimonials WHERE id = ?`,
  selectAllSql: `SELECT * FROM testimonials`,
  map(row) {
    const id = String(row['id']);
    const recSuffix = id.length >= 11 ? id.slice(3, 11) : id.replace(/^rec/, '');
    const personName = asString(row['person_name']) ?? '';
    const slug = toUnderscore(`${kebab(personName)}-${recSuffix}`);
    const draft = asString(row['status']) === 'Draft';
    const fpName = asString(row['floor_plan_name']);
    const fieldData = compactFields({
      person_name: sIf(row['person_name']),
      date_posted: sIf(row['date_posted']),
      testimonial_text: sIf(row['testimonial_text']),
      image: imgIf(row['image_url']),
      move_in_year: sIf(row['move_in_year']),
      floor_plan: fpName === undefined ? undefined : str(fpName),
      floor_plan_slug: fpName === undefined ? undefined : str(toUnderscore(kebab(fpName))),
      floor_plan_image: imgIf(row['floor_plan_image']),
      community: sIf(row['community_name']),
      community_slug:
        asString(row['community_name']) === undefined
          ? undefined
          : str(toUnderscore(kebab(String(row['community_name'])))),
      town: sIf(row['town']),
      status: sIf(row['status']),
    });
    return { id, slug, draft, fieldData };
  },
};

// =============================================================================
// Registry
// =============================================================================
export const COLLECTION_DEFS: Record<CollectionKey, CollectionDef> = {
  floor_plans: floorPlans,
  qmi,
  communities,
  collections,
  images,
  blogs,
  promotions,
  cities,
  testimonials,
};

/** Resolve the live Framer collection NAME (env override || default). */
export function resolveCollectionName(
  def: CollectionDef,
  env: Record<string, string | undefined>
): string {
  const override = env[def.collectionEnvVar];
  return override && override.trim() !== '' ? override.trim() : def.defaultCollectionName;
}
