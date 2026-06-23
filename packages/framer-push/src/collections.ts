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
//   * PDF link fields (qmi.dynamic_pdf, floor_plans.brochure_pdf_url) are emitted as
//     strings but pinned to framer_type 'link' in field_definitions (MAPPER_FRAMER_TYPE);
//     applyTypeOverrides coerces them to links before push. The live Framer field MUST be
//     Link type to match — a string-typed Framer field + a link value makes addItems throw
//     and aborts the batch, so field_definitions and the Framer field type must stay in sync.
//     communities.brochure_pdf_url has no field_definitions row, so the mapper emits a link
//     value directly (same Link-field requirement applies).
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
  date,
  galleryArray,
} from './framer-types.js';
import { markdownToHtml } from './markdown.js';
import type { CollectionKey } from './types.js';
import { qmiPublicSlug } from '@esperanza/db/slug';

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

/**
 * Per-item record suffix used to disambiguate a colliding slug. Mirrors the
 * recSuffix the QMI/Testimonials mappers derive: chars 3..11 of `recXXXXXXXX…`
 * (or the id minus a leading `rec`), normalized to the underscore-slug form.
 */
export function recSuffixOf(id: string): string {
  const raw = id.length >= 11 ? id.slice(3, 11) : id.replace(/^rec/, '');
  return toUnderscore(raw).toLowerCase();
}

/**
 * Make every slug in a batch UNIQUE. Framer rejects a second item that reuses a
 * slug ("Duplicate slug: 2004_s_lake_texoma_st" — two homes at the same address
 * whose precomputed viewer/seo slug is identical). Because a stateless per-row
 * mapper can't see its siblings, dedup happens here once the full set is built:
 *   - the FIRST item to claim a slug keeps it (no URL churn, existing tests hold);
 *   - any later item whose slug already taken gets `<slug>_<recSuffix>` appended
 *     (the record suffix is globally unique, so this resolves the collision and is
 *     stable across runs); on the vanishingly rare chance that is *also* taken we
 *     append a numeric counter.
 * Mutates each item's `slug` in place and returns the same array for chaining.
 */
export function dedupeSlugs(items: ManagedCollectionItemInput[]): ManagedCollectionItemInput[] {
  const seen = new Set<string>();
  for (const it of items) {
    if (!seen.has(it.slug)) {
      seen.add(it.slug);
      continue;
    }
    const suffix = recSuffixOf(it.id);
    let candidate = suffix ? `${it.slug}_${suffix}` : `${it.slug}_${it.id}`;
    let n = 2;
    while (seen.has(candidate)) candidate = `${it.slug}_${suffix || it.id}_${n++}`;
    it.slug = candidate;
    seen.add(candidate);
  }
  return items;
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

/**
 * Build the `elevations_json` string field from `elevation_gallery`: a JSON array of
 * { url, type } so the live plan page can render a labeled elevation grid. The admin
 * stores the elevation type per image (auto-derived from the filename, editable); we
 * emit it verbatim (empty string when unset). Accepts the {url,type}, legacy
 * {url,filename}, and bare-string array shapes. Returns undefined when empty so the
 * field is omitted rather than emitted blank.
 */
export function elevationsJson(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  const arr = parseJsonArray(raw);
  const out: { url: string; type: string }[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      const u = item.trim();
      if (u) out.push({ url: u, type: '' });
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const u = typeof rec['url'] === 'string' ? rec['url'].trim() : '';
      if (!u) continue;
      const t = typeof rec['type'] === 'string' ? rec['type'].trim() : '';
      out.push({ url: u, type: t });
    }
  }
  return out.length ? JSON.stringify(out) : undefined;
}

/** Newline-join a list of urls (the *_urls string-field shape). */
export function joinUrls(urls: string[]): string | undefined {
  return urls.length ? urls.join('\n') : undefined;
}

/**
 * compactFields: drop only entries whose value is `undefined`. The conditional builders
 * (nIf/imgIf/linkIf/ftIf/galIf) return `undefined` for absent values so they're dropped
 * here — undefined numbers must NEVER be sent as 0, and empty links/images would throw.
 * Note: explicit `false` booleans, the number 0, and explicit empty strings (str(''),
 * emitted by sIf to propagate a cleared field) ARE kept — only `undefined` is dropped.
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
// EXCEPT sIf: string fields mirror D1 exactly, including the empty case. An empty/null
// column emits str('') (NOT undefined) so a cleared value actually reaches Framer.
// addItems MERGES — a field dropped from the payload keeps its previous value on the
// live site, so dropping an emptied string field made it "repopulate" with the stale
// value (a space was the only workaround). Emitting str('') propagates the clear and
// lets "hide field when empty" fire. Safe: str('') passes applyTypeOverrides untouched
// for string-typed fields; sIf fields pinned to link/image (e.g. *_pdf_url) are coerced
// there and an empty URL is dropped, so this never sends an invalid empty link/image.
const sIf = (v: unknown) => str(asString(v) ?? '');
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
// htmlFt — for fields whose D1 value is already sanitized HTML (Framer-subset:
// h2-h6/p/strong/em/a/ul/ol/li/blockquote/br/img), e.g. blogs.content after the
// legacy re-scrape and the admin TipTap WYSIWYG. Passes HTML through verbatim so
// inline images/links/headings survive. Falls back to markdownToHtml for any
// legacy plain-text/markdown value (no tags yet) so paragraphs still render. The
// field_definitions pin (formattedText) makes applyTypeOverrides a no-op here.
const htmlFt = (v: unknown) => {
  const raw = asString(v) ?? '';
  if (raw.trim() === '') return undefined;
  const html = /<[a-z][\s\S]*>/i.test(raw) ? raw : markdownToHtml(raw);
  return html === '' ? undefined : formattedText(html);
};
// dateIf — emits a real Framer date field (ISO via framer-types' date()). Empty
// drops the field (you can't set an empty date; clears don't propagate, which is
// fine for publish dates). field_definitions must pin the column to 'date'.
const dateIf = (v: unknown) => {
  const s = asString(v);
  return s && s.trim() !== '' ? date(s) : undefined;
};
const galIf = (urls: string[]) => (urls.length ? galleryArray(urls) : undefined);
// Lot number stripped to its numeric part for display: drops the community
// letter-prefix and any leading zeros ("RC169" → "169", "RC069" → "69"), falling
// back to the raw value when it has no digits ("MODEL" → "MODEL"). Same rule the
// PDF renderer applies (packages/pdf/src/data/qmi.ts lotDisplay). Absent/empty →
// str('') (matching sIf), so a cleared lot number propagates to Framer.
const lotShortIf = (v: unknown) => {
  const s = asString(v);
  if (s === undefined) return str(''); // mirror sIf: a cleared lot_number clears the short form too
  const digits = s.replace(/\D/g, '').replace(/^0+/, '');
  return str(digits || s);
};
// The QMI detail page's availability badge ("/new-homes/available/:slug/") is bound
// to the managed `move_in_date` field behind a static "AVAILABLE " prefix, so it was
// rendering the raw ISO date — "AVAILABLE 2026-11-23". The listing cards instead show
// a two-month window sourced from `availability_text` ("Available JUN/JUL 2026" /
// "Available Now"). To make the detail badge match the listing WITHOUT a Framer canvas
// rebind, push the de-prefixed availability_text as the move_in_date display value:
//   "Available JUN/JUL 2026" -> "JUN/JUL 2026"  (badge -> "AVAILABLE JUN/JUL 2026")
//   "Available Now"          -> "Now"           (badge -> "AVAILABLE NOW")
// availability_text is the single source of truth (admin/ingest-authored); fall back to
// the raw move_in_date only when it's absent. This managed field is consumed solely by
// that badge — the cards read `availability_text` from the API and the XML feed reads D1.
const availabilityBadgeValue = (availabilityText: unknown, moveInDate: unknown) => {
  const at = asString(availabilityText);
  if (at !== undefined) {
    const stripped = at.replace(/^available\s*/i, '').trim();
    return str(stripped); // mirror sIf: empty → str('') so a cleared badge propagates
  }
  return sIf(moveInDate);
};

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

// Displayed bath count = full baths + half baths (3 full + 1 half → 3.5). Snowflake
// carries BASE_HALFBATHROOMS through as half_bathroom_count, but it was previously
// dropped — only the full count reached Framer, so 3.5-bath homes rendered as "3".
const combineBath = (full: unknown, half: unknown): number | undefined => {
  const f = numField(full);
  if (f === undefined) return undefined;
  const h = numField(half) ?? 0;
  return f + 0.5 * h;
};

// Estimated monthly payment — PITI, parity with the legacy O'Neill listing calculator
// (verified to the cent on real homes). Inputs: list price + the COMPANY-WIDE PROMOTIONAL
// rate from site_settings.incentive_rate (marketing-editable in admin → /api/public/
// settings) — this is the prominent "estimated monthly" figure, so it uses the incentive
// rate, not the standard mortgage_rate. The projection injects it as `monthly_rate`, so
// one admin edit + a `qmi` backfill re-prices every listing, and the figure self-updates
// whenever a home's price changes.
// Constants mirror the legacy calculator: 3.5% down, 30-yr term, 2.08% property tax,
// 0.4% insurance, $180/yr HOA, 0.75% PMI. Returns undefined (→ stored value kept) when
// price or rate is missing/non-positive.
const MONTHLY_DOWN_PCT = 0.035;
const MONTHLY_TERM_MONTHS = 360;
const MONTHLY_TAX_RATE = 0.0208;
const MONTHLY_INS_RATE = 0.004;
const MONTHLY_HOA_MONTHLY = 180 / 12;
const MONTHLY_PMI_RATE = 0.0075;
function computeMonthlyPayment(price: unknown, rate: unknown): number | undefined {
  const p = numField(price);
  const r = numField(rate);
  if (p === undefined || p <= 0 || r === undefined || r <= 0) return undefined;
  const down = Math.round(p * MONTHLY_DOWN_PCT);
  const principal = p - down;
  const mr = r / 100 / 12;
  const pi = (principal * mr) / (1 - Math.pow(1 + mr, -MONTHLY_TERM_MONTHS));
  const taxes = (p * MONTHLY_TAX_RATE) / 12;
  const insurance = (p * MONTHLY_INS_RATE) / 12;
  const pmi = (principal * MONTHLY_PMI_RATE) / 12;
  return Math.round((pi + taxes + insurance + MONTHLY_HOA_MONTHLY + pmi) * 100) / 100;
}

const QMI_PROJECTION = `
  q.id AS id,
  (SELECT value FROM site_settings WHERE key = 'incentive_rate') AS monthly_rate,
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
  q.description, q.upgrades, q.incentive, q.virtual_tour_url,
  COALESCE(q.override_elevation_type, q.synced_elevation_type) AS elevation_type,
  q.mls_id, q.mls_number,
  COALESCE(q.override_lot_number, q.synced_lot_number) AS lot_number,
  q.year_built, q.lot_size_sqft,
  COALESCE(q.override_move_in_date, q.synced_move_in_date) AS move_in_date,
  q.hers_score, q.arm_rate, q.promo_text, q.availability_text, q.nter_now, q.cities,
  q.posted, q.publish_date, q.last_modified_time,
  q.custom_fields, -- Phase C: custom-field VALUES (emitted by emitCustomFields)
  -- FP:* lookups resolved from the linked floor plan (qmi.fp_* removed — D1
  -- 100-col limit; mirrors v_public_qmi's LEFT JOIN). Same output names so the
  -- mapper below is unchanged. fp_image / fp_additional_images carry attachment
  -- JSON and live on floor_plans.
  COALESCE(fp.override_bedroom_min, fp.synced_bedroom_min)   AS fp_bedrooms_min,
  COALESCE(fp.override_bedroom_max, fp.synced_bedroom_max)   AS fp_bedrooms_max,
  COALESCE(fp.override_bathroom_max, fp.synced_bathroom_max) AS fp_bathrooms_max,
  fp.car_garage_count       AS fp_garage,
  COALESCE(fp.override_living_square_footage, fp.synced_living_square_footage) AS fp_living_sqft,
  COALESCE(fp.override_total_square_footage,  fp.synced_total_square_footage)  AS fp_total_sqft,
  fp.description            AS fp_description,
  fp.fp_image               AS fp_image,
  fp.fp_additional_images   AS fp_additional_images,
  COALESCE(fp.override_starting_price, fp.synced_starting_price) AS fp_starting_price,
  fp.virtual_tour_url       AS fp_virtual_tour,
  fp.plan_viewer_url        AS fp_plan_viewer,
  fp.collection             AS fp_collection,
  fp.master_bed_location    AS fp_master_bed_location,
  fp.floor_plan_image       AS fp_floor_plan_image,
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
  selectByIdSql: `SELECT *,
    COALESCE(override_starting_price, synced_starting_price) AS starting_price,
    COALESCE(override_bedroom_min,  synced_bedroom_min)  AS bedroom_min,
    COALESCE(override_bedroom_max,  synced_bedroom_max)  AS bedroom_max,
    COALESCE(override_bathroom_min, synced_bathroom_min) AS bathroom_min,
    COALESCE(override_bathroom_max, synced_bathroom_max) AS bathroom_max,
    COALESCE(override_living_square_footage, synced_living_square_footage) AS living_square_footage,
    COALESCE(override_total_square_footage,  synced_total_square_footage)  AS total_square_footage
  FROM floor_plans WHERE id = ?`,
  selectAllSql: `SELECT *,
    COALESCE(override_starting_price, synced_starting_price) AS starting_price,
    COALESCE(override_bedroom_min,  synced_bedroom_min)  AS bedroom_min,
    COALESCE(override_bedroom_max,  synced_bedroom_max)  AS bedroom_max,
    COALESCE(override_bathroom_min, synced_bathroom_min) AS bathroom_min,
    COALESCE(override_bathroom_max, synced_bathroom_max) AS bathroom_max,
    COALESCE(override_living_square_footage, synced_living_square_footage) AS living_square_footage,
    COALESCE(override_total_square_footage,  synced_total_square_footage)  AS total_square_footage
  FROM floor_plans`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['name']) ? kebab(String(row['name'])) : id);
    const draft = !asBool(row['published']);
    const photo = galleryUrls(row['photo_gallery']);
    const elevGallery = galleryUrls(row['elevation_gallery']);
    const addl = galleryUrls(row['additional_images_gallery']);
    const interior = galleryUrls(row['interior_photos_json']);
    // brochure_pdf_url is the Link-typed Framer field operators bind to the "Download
    // Brochure" button. Prefer the designed InDesign brochure (R2, migrated off the retired
    // media.esperanzahomes.com host) so the link is the real brochure; fall back to the
    // dynamic generated PDF (/pdf/floorplan/<slug>) for plans with no designed brochure.
    const designedBrochure = asString(row['brochure_pdf']);
    const brochureLink =
      designedBrochure && designedBrochure.trim()
        ? designedBrochure
        : asString(row['brochure_pdf_url']);
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
      floor_plan_image: imgIf(row['floor_plan_image']),
      description: sIf(row['description']),
      plan_viewer_url: sIf(row['plan_viewer_url']),
      virtual_tour_url: sIf(row['virtual_tour_url']),
      master_bed_location: sIf(row['master_bed_location']),
      incentive: sIf(row['incentive']),
      coming_soon: bool(asBool(row['coming_soon'])), // live FP (Managed) has the field (added 2026-06)
      // brochure_pdf_url = the Link-typed brochure field (field_definitions pins its
      // framer_type to 'link' (MAPPER_FRAMER_TYPE), so applyTypeOverrides coerces the value
      // to a link before push; the live Framer field MUST stay Link type or addItems aborts).
      // Carries `brochureLink` = designed R2 brochure when present, else the dynamic PDF.
      brochure_pdf_url: sIf(brochureLink),
      // brochure_pdf = the same designed R2 brochure as a plain String (kept for reference /
      // admin; operators bind the Link-typed brochure_pdf_url above for the live button).
      brochure_pdf: sIf(row['brochure_pdf']),
      hers_score: nIf(row['hers_score']),
      energy_cost_esperanza_monthly: nIf(row['energy_cost_low']),
      energy_cost_preowned_monthly: nIf(row['energy_cost_high']),
      energy_cost_monthly_savings: nIf(row['energy_cost_avg']),
      communities: sIf(row['communities']),
      community_count: nIf(row['community_count']),
      community_ids: sIf(row['community_ids']),
      // The plan's OWN rec-ID as a string, mirroring communities.community_id. Framer's
      // filter value-picker binds CMS *fields* (not an item's internal id), so the Floor
      // Plan page needs this to bind as the needle in the Available-Locations Communities
      // filter: `Community.floor_plan_ids Contains {floor_plan_id}` (reciprocal of #42).
      floor_plan_id: str(id),
      photo_gallery: galIf(photo),
      elevation_renderings: sIf(row['elevation_renderings']),
      elevation_gallery: galIf(elevGallery),
      // Labeled elevations ([{url,type}] JSON) for the captioned grid on the plan page.
      elevations_json: sIf(elevationsJson(row['elevation_gallery'])),
      additional_images: sIf(row['additional_images']),
      additional_images_gallery: galIf(addl),
      // 0011: admin-owned interior room photos (interior_photos_json {url,alt} array).
      interior_photos: galIf(interior),
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
    // Canonical public slug (shared with the api sitesearch index so search links
    // never diverge from the live page URL). See @esperanza/db/slug.
    const slug = qmiPublicSlug(row);
    const draft = !asBool(row['published']);

    const fpImageUrl = fpScalarUrl(row['fp_image']);
    const fpAddl = galleryUrls(row['fp_additional_images']);
    const floorPlanSlug = asString(row['floor_plan'])
      ? kebab(String(row['floor_plan']))
      : undefined;
    // QMI photo gallery, computed once: the full array still feeds `photo_gallery`,
    // AND two entries are surfaced as standalone scalar image fields so the site can
    // bind them individually (CMS-linkable) without indexing into the gallery. Entry
    // [0] is the elevation RENDER, so the two photo fields use gallery entries [1]/[2].
    const qmiGallery = galleryUrls(row['photo_gallery_json']);

    const fieldData = compactFields({
      address: sIf(row['address']),
      slug: str(slug),
      city: sIf(row['city']),
      postal_code: sIf(row['postal_code']), // live field is type string ("ZIP") — emit string, not number
      latitude: nIf(row['latitude']),
      longitude: nIf(row['longitude']),
      community: sIf(row['community']),
      // Resolved community rec-ID (projection: COALESCE(override, synced) AS community_id).
      // Same key + string shape as floor_plans.community_ids so a community CMS page can
      // filter BOTH collections with `community_ids Contains {communityId}`. Auto-current:
      // re-emitted on every QMI push (Snowflake ingest + admin edits), honors the override.
      community_ids: sIf(row['community_id']),
      floor_plan: sIf(row['floor_plan']),
      floor_plan_slug: floorPlanSlug === undefined ? undefined : str(floorPlanSlug),
      collection: sIf(row['collection']),
      price: nIf(row['price']),
      // Computed PITI from list price + the company-wide mortgage_rate setting; falls
      // back to any stored value when price/rate are absent (see computeMonthlyPayment).
      estimated_monthly_price: nIf(
        computeMonthlyPayment(row['price'], row['monthly_rate']) ?? row['estimated_monthly_price']
      ),
      // Snowflake-first, FP-lookup fallback
      bedroom_count: nIf(row['bedroom_count'] ?? fpScalar(row['fp_bedrooms_max'])),
      // Full + half baths combined (half_bathroom_count was previously dropped).
      bathroom_count: nIf(
        combineBath(row['bathroom_count'], row['half_bathroom_count']) ??
          fpScalar(row['fp_bathrooms_max'])
      ),
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
      // Dynamic QMI brochure (/pdf/qmi/<slug>, auto-filled by ensurePdfRender). Emitted
      // as a string; field_definitions pins qmi.dynamic_pdf framer_type to 'link'
      // (MAPPER_FRAMER_TYPE) → applyTypeOverrides coerces to a link before push. The live
      // Framer field MUST be Link type to match.
      dynamic_pdf: sIf(row['dynamic_pdf']),
      featured_image: imgIf(row['featured_image']),
      image_2: imgIf(row['image_2']),
      image_3: imgIf(row['image_3']),
      image_4: imgIf(row['image_4']),
      image_5: imgIf(row['image_5']),
      floor_plan_image: imgIf(row['fp_floor_plan_image']),
      // Floor-plan-default → QMI-override content resolution (same COALESCE the
      // PDF renderer applies in packages/pdf/src/data/qmi.ts): the site binds this
      // ONE plain field; an editor sets qmi.description only to override the plan
      // copy. Empty-string counts as "unset" (asString('') → undefined → fallback).
      // The raw FP value keeps flowing separately as fp_description below.
      description: sIf(asString(row['description']) ?? fpScalar(row['fp_description'])),
      // QMI's OWN photo gallery (qmi.photo_gallery_json — column added by a
      // parallel migration; enrichRow() probes for it until the projection carries
      // it). Deliberately NO fallback to the floor plan's gallery: null/absent →
      // the field is dropped (pushed empty), per the content-resolution spec.
      photo_gallery: galIf(qmiGallery),
      // First two PHOTOS (gallery entries [1] and [2]) as standalone, individually-
      // bindable image fields — entry [0] is the elevation render, so it's skipped.
      // The gallery still carries the full set. Absent → dropped by compactFields.
      gallery_image_1: imgIf(qmiGallery[1]),
      gallery_image_2: imgIf(qmiGallery[2]),
      upgrades: sIf(row['upgrades']),
      incentive: sIf(row['incentive']),
      virtual_tour_url: sIf(row['virtual_tour_url']),
      // NterNow self-tour "Enter Now" link. Admin-owned; the view selects q.nter_now
      // (line ~342). Mirrors the community mapper — was previously absent from the QMI
      // mapper, so the field never reached Framer even when populated.
      nter_now: sIf(row['nter_now']),
      elevation_type: sIf(row['elevation_type'] ?? row['elevation']),
      housenumber: sIf(row['housenumber']),
      mls_id: sIf(row['mls_id']),
      lot_number: sIf(row['lot_number']),
      lot_number_short: lotShortIf(row['lot_number']), // RC169 → 169 (community prefix + leading zeros stripped)
      year_built: nIf(row['year_built']),
      lot_size_sqft: nIf(row['lot_size_sqft']),
      // Display value for the "AVAILABLE …" badge — de-prefixed availability_text
      // ("JUN/JUL 2026" / "Now"), falling back to the raw date. See helper above.
      move_in_date: availabilityBadgeValue(row['availability_text'], row['move_in_date']),
      estimated_monthly_payment: nIf(row['estimated_monthly_payment']),
      published: bool(asBool(row['published'])),
      coming_soon: bool(asBool(row['coming_soon'])), // live QMI (Managed) has the field (added 2026-06)
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

// The esperanza-pdf worker base. Per-community list PDFs are served at
// /pdf/list/community-<communitySlug>-{plans,qmis} (registered by seed-renders with the
// identical slug). We build the link in the mapper rather than store a column: the slug
// is deterministic and this matches how the brochure URLs are shaped, with no migration.
// Keep in sync with PDF_PUBLIC_BASE_URL (seed-renders) if the worker domain ever changes.
const PDF_LIST_BASE = 'https://esperanza-pdf.round-base-ed8c.workers.dev';

// =============================================================================
// 3. COMMUNITIES  (draft = !published — the `draft` column was DROPPED in
//    migration 0005; published is now the single gate, like every other entity)
// =============================================================================
const communities: CollectionDef = {
  key: 'communities',
  defaultCollectionName: 'Communities',
  collectionEnvVar: 'FRAMER_COLLECTION_COMMUNITIES',
  // floor_plan_ids: reciprocal of floor_plans.community_ids — the CSV of floor-plan
  // rec-IDs offered in this community, aggregated at query time. The membership test
  // mirrors CITY_COUNTS_SQL's plan match: normalize the plan's community_ids CSV
  // (strip spaces, comma-wrap) and look for the comma-delimited community id, so a
  // Floor Plan page can filter communities by `floor_plan_ids Contains {floorPlanId}`
  // (the Available Locations section) in the natural direction. All linked plans are
  // listed; the Floor Plans collection's own draft gate controls render visibility.
  selectByIdSql: `SELECT *,
    COALESCE(override_square_footage_range, synced_square_footage_range) AS square_footage_range,
    COALESCE(override_bed_count,  synced_bed_count)  AS bed_count,
    COALESCE(override_bath_count, synced_bath_count) AS bath_count,
    COALESCE(
      override_price_from,
      CASE WHEN close_out = 1 THEN COALESCE(
        (SELECT MIN(cep.sales_price)
         FROM community_elevation_prices cep
         JOIN floor_plans fpe ON fpe.id = cep.floor_plan_id
         WHERE cep.community_id = communities.id
           AND close_out_elevation IS NOT NULL
           AND cep.elevation_label = close_out_elevation
           AND cep.sales_price > 0
           AND fpe.published = 1),
        (SELECT MIN(COALESCE(fp3.override_starting_price, fp3.synced_starting_price))
         FROM floor_plans fp3
         WHERE fp3.published = 1
           AND COALESCE(fp3.override_starting_price, fp3.synced_starting_price) > 0
           AND ',' || REPLACE(IFNULL(fp3.community_ids, ''), ' ', '') || ',' LIKE '%,' || communities.id || ',%')
      ) END,
      synced_price_from
    ) AS price_from,
    (SELECT group_concat(fp.id) FROM floor_plans fp
      WHERE ',' || REPLACE(IFNULL(fp.community_ids, ''), ' ', '') || ','
            LIKE '%,' || communities.id || ',%') AS floor_plan_ids,
    (SELECT COUNT(*) FROM floor_plans fp2
      WHERE fp2.published = 1 AND ',' || REPLACE(IFNULL(fp2.community_ids, ''), ' ', '') || ','
            LIKE '%,' || communities.id || ',%') AS plan_count,
    (SELECT COUNT(*) FROM qmi q2
      WHERE q2.published = 1
        AND COALESCE(q2.override_community_id, q2.synced_community_id) = communities.id) AS home_count
  FROM communities WHERE id = ?`,
  selectAllSql: `SELECT *,
    COALESCE(override_square_footage_range, synced_square_footage_range) AS square_footage_range,
    COALESCE(override_bed_count,  synced_bed_count)  AS bed_count,
    COALESCE(override_bath_count, synced_bath_count) AS bath_count,
    COALESCE(
      override_price_from,
      CASE WHEN close_out = 1 THEN COALESCE(
        (SELECT MIN(cep.sales_price)
         FROM community_elevation_prices cep
         JOIN floor_plans fpe ON fpe.id = cep.floor_plan_id
         WHERE cep.community_id = communities.id
           AND close_out_elevation IS NOT NULL
           AND cep.elevation_label = close_out_elevation
           AND cep.sales_price > 0
           AND fpe.published = 1),
        (SELECT MIN(COALESCE(fp3.override_starting_price, fp3.synced_starting_price))
         FROM floor_plans fp3
         WHERE fp3.published = 1
           AND COALESCE(fp3.override_starting_price, fp3.synced_starting_price) > 0
           AND ',' || REPLACE(IFNULL(fp3.community_ids, ''), ' ', '') || ',' LIKE '%,' || communities.id || ',%')
      ) END,
      synced_price_from
    ) AS price_from,
    (SELECT group_concat(fp.id) FROM floor_plans fp
      WHERE ',' || REPLACE(IFNULL(fp.community_ids, ''), ' ', '') || ','
            LIKE '%,' || communities.id || ',%') AS floor_plan_ids,
    (SELECT COUNT(*) FROM floor_plans fp2
      WHERE fp2.published = 1 AND ',' || REPLACE(IFNULL(fp2.community_ids, ''), ' ', '') || ','
            LIKE '%,' || communities.id || ',%') AS plan_count,
    (SELECT COUNT(*) FROM qmi q2
      WHERE q2.published = 1
        AND COALESCE(q2.override_community_id, q2.synced_community_id) = communities.id) AS home_count
  FROM communities`,
  map(row) {
    const id = String(row['id']);
    const slug =
      asString(row['slug']) ?? (asString(row['name']) ? kebab(String(row['name'])) : id);
    // single gate: not published (the `draft` column was dropped in migration 0005)
    const draft = !asBool(row['published']);

    // Per-community list PDFs (the /pdf-list "Plan List" + "Sale List" columns). Built from
    // the community slug (the exact slug seed-renders registered) so no column/migration is
    // needed; only emitted when the community has a slug (slug-less communities have no
    // registered render). Emitted as LINK (linkIf) directly — no field_definitions pin.
    const communitySlug = asString(row['slug']);
    const planListUrl = communitySlug ? `${PDF_LIST_BASE}/pdf/list/community-${communitySlug}-plans` : undefined;
    const saleListUrl = communitySlug ? `${PDF_LIST_BASE}/pdf/list/community-${communitySlug}-qmis` : undefined;

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

    // lat_long: bare "lat,long" string the Framer map layer binds to. Build it from
    // the clean numeric lat/long columns (source of truth) rather than the legacy
    // lat_long/map_coordinates text — that text carried leading whitespace, a dropped
    // longitude sign (Cascada at Tres Lagos), and, where lat_long was null (Los
    // Arroyos), fell back to the full Google Maps URL. Fall back to the raw lat_long
    // text only when the numeric columns are absent.
    const latLong =
      latitude !== undefined && longitude !== undefined
        ? `${latitude},${longitude}`
        : asString(row['lat_long']);

    // photo_gallery_json is the authoritative multi-image gallery (JSON array of URLs).
    // Fall back to the single photo_gallery_image_url if the array column is empty/null.
    const galleryJson = galleryUrls(row['photo_gallery_json']);
    const photo = galleryJson.length
      ? galleryJson
      : galleryUrls(row['photo_gallery_image_url']);

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
      // [P2] floor_plan_plaintext (legacy Airtable aiText flattening) no longer emitted;
      // the real relationship is floor_plans.communities + community_count.
      town: sIf(row['town']),
      address: sIf(row['address']),
      // Get Directions = the Google Maps link. The dedicated `directions` column is
      // empty for every community, so fall back to map_coordinates (which holds the
      // maps.google.com URL) — that's the link the button is meant to surface.
      get_directions: linkIf(row['directions'] ?? row['map_coordinates']),
      lat_long: sIf(latLong),
      latitude: latitude === undefined ? undefined : num(latitude),
      longitude: longitude === undefined ? undefined : num(longitude),
      price_from: nIf(row['price_from']),
      bed_range: sIf(row['bed_count']),
      bath_range: sIf(row['bath_count']),
      sqft_range: sIf(row['square_footage_range']),
      description: ftIf(row['description']),
      amenities_rich: ftIf(row['amenities']),
      image_url: imgIf(row['featured_image_url']),
      featured_image_alt: sIf(row['featured_image_alt']),
      secondary_image: imgIf(row['secondary_image_url']),
      secondary_image_alt: sIf(row['secondary_image_alt']),
      photo_gallery_image: imgIf(row['photo_gallery_image_url']),
      photo_gallery: galIf(photo),
      photo_gallery_image_alt: sIf(row['photo_gallery_image_alt']),
      description_image: imgIf(row['description_image_url']),
      community_logo: imgIf(row['community_logo_url']),
      community_logo_alt: sIf(row['community_logo_alt']),
      master_planned: bool(asBool(row['master_planned'])),
      coming_soon: bool(asBool(row['coming_soon'])),
      published: bool(asBool(row['published'])),
      // CSV of floor-plan rec-IDs offered in this community (group_concat in the SQL
      // above) — same string/passthrough posture as the other *_ids fields (no
      // field_definitions row). Lets a Floor Plan page filter the communities list by
      // `floor_plan_ids Contains {floorPlanId}` (Available Locations) in the natural
      // direction (the multi-value CSV is the haystack, the page's id is the needle).
      floor_plan_ids: sIf(row['floor_plan_ids']),
      featured_video: sIf(row['featured_video']),
      office_phone: sIf(row['office_phone']),
      office_hours: sIf(row['office_hours']),
      schedule_visit: sIf(row['schedule_visit']),
      lending: sIf(row['lending']),
      directions: sIf(row['directions']),
      education_rich: ftIf(row['education_rich']),
      mine_link: linkIf(row['mine_link']),
      nter_now: sIf(row['nter_now']),
      community_map_embed: sIf(row['community_map_embed']),
      features_download: linkIf(row['features_download_url']),
      resources_download: linkIf(row['resources_download_url']),
      // Dynamic PDF (community brochure) — deterministic /pdf/community/<slug> URL
      // auto-filled into brochure_pdf_url by ensurePdfRender. Emitted as a string;
      // field_definitions pins communities.brochure_pdf_url framer_type to 'link'
      // (MAPPER_FRAMER_TYPE) → applyTypeOverrides coerces it to a link before push
      // (same proven pattern as floor_plans.brochure_pdf_url). The live Framer field
      // must be Link type to match.
      brochure_pdf_url: sIf(row['brochure_pdf_url']),
      // Per-community aggregate list PDFs (Link) + counts (Number) for the /pdf-list
      // LOCATIONS row: Plan List = all plans offered, Sale List = all homes for sale.
      // Emitted as link/number directly; created in Framer via POST /schema.
      plan_list_pdf_url: linkIf(planListUrl),
      sale_list_pdf_url: linkIf(saleListUrl),
      plan_count: nIf(row['plan_count']),
      home_count: nIf(row['home_count']),
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
      // Utilities block: live Communities (Managed) types Gas/Internet/Water/Electric
      // Details as formattedText (Security Details stays string). internet_details &
      // water_details were emitting sIf (string) → "Expected formattedText but got string".
      gas_details_rich: ftIf(row['gas_details_rich']),
      internet_details: ftIf(row['internet_details']),
      water_details: ftIf(row['water_details']),
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
      // Rich text: D1 stores Framer-subset HTML (re-scraped legacy + TipTap WYSIWYG).
      // formattedText so headings/links/inline images render. field_definitions pins
      // blogs.content → formattedText (was string).
      content: htmlFt(row['content']),
      // Real Framer date field (was string). field_definitions pins blogs.publish_date → date.
      publish_date: dateIf(row['publish_date']),
      featured_image: imgIf(row['featured_image']),
      // 0012: Vimeo URL string, same convention as communities.featured_video.
      video_url: sIf(row['video_url']),
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
      COALESCE(NULLIF(p.rate_override, ''),
        (SELECT value FROM site_settings WHERE key = 'incentive_rate')) AS effective_rate,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'community') AS community_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'floor_plan') AS floor_plan_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'qmi') AS qmi_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'city') AS city_ids
    FROM promotions p WHERE p.id = ?`,
  selectAllSql: `
    SELECT p.*,
      COALESCE(NULLIF(p.rate_override, ''),
        (SELECT value FROM site_settings WHERE key = 'incentive_rate')) AS effective_rate,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'community') AS community_ids,
      (SELECT group_concat(t.target_id) FROM promotion_targets t
         WHERE t.promotion_id = p.id AND t.target_type = 'floor_plan') AS floor_plan_ids,
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
      // [P2] applies_to (legacy descriptive label) no longer emitted; targeting is
      // driven by promotion_targets, not this field.
      sort_order: nIf(row['sort_order']),
      published: bool(asBool(row['published'])),
      expiration_date: sIf(row['end_date']),
      // image: consumer pre-resolves the fallback chain onto row['image_url'].
      image: imgIf(row['image_url']),
      pdf: linkIf(row['pdf_url']),
      rate: sIf(row['effective_rate']),
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

// Copy-block keys that EXIST on the live Cities (Managed) collection. The admin
// JSON is free-form, but emitting a key Framer doesn't know rejects the item, so
// we only push keys in this allow-list. Split by live field type: image vs string.
const CITY_COPY_IMG_KEYS = new Set<string>([
  'section_1_image',
  'section_1a_image',
  'section_2_image',
  'section_3_image',
  'image_0',
  'live_in_image',
]);
const CITY_COPY_STR_KEYS = new Set<string>([
  'section_1_title',
  'section_1_description',
  'section_2_title',
  'section_2_description',
  'section_3_title',
  'section_3_description',
  'pillar_1_title',
  'pillar_1_description',
  'pillar_2_title',
  'pillar_2_description',
  'pillar_3_title',
  'pillar_3_description',
  'pillar_4_title',
  'pillar_4_description',
  'homes_heading',
  'homes_description',
  'live_in_heading',
  'live_in_description',
  // hero_description & national_recognition also live in the JSON but are emitted
  // from dedicated row columns below; they're intentionally excluded here.
]);

// Live, city-scoped counts for the three stat fields on the Framer city page.
// The stored cities.{community_count,move_in_homes_count,floor_plans_count}
// columns are frozen legacy-Airtable snapshots that nothing recomputes, so they
// drift the moment inventory changes (e.g. McAllen showed 99 move-ins / 67 plans
// when reality was ~46 / 39). We derive them from live published data instead and
// emit under *_live aliases that map() prefers, leaving the stored columns intact.
//   • communities: published communities whose city_id = this city
//   • move-in homes: published QMIs whose effective city = this city
//       (override_city_id wins over synced_city_id, mirroring the QMI mapper)
//   • floor plans: published plans linked (community_ids CSV) to a PUBLISHED
//       community in this city — "plans available in this city". Plans with no
//       community linkage are intentionally excluded (not available anywhere).
const CITY_COUNTS_SQL = `
  (SELECT COUNT(*) FROM communities cm
     WHERE cm.city_id = c.id AND cm.published = 1) AS community_count_live,
  (SELECT COUNT(*) FROM qmi q
     WHERE COALESCE(q.override_city_id, q.synced_city_id) = c.id
       AND q.published = 1) AS move_in_homes_count_live,
  (SELECT COUNT(DISTINCT fp.id) FROM floor_plans fp
     WHERE fp.published = 1
       AND EXISTS (
         SELECT 1 FROM communities cm2
          WHERE cm2.city_id = c.id AND cm2.published = 1
            AND ',' || REPLACE(IFNULL(fp.community_ids, ''), ' ', '') || ','
                LIKE '%,' || cm2.id || ',%'
       )) AS floor_plans_count_live`;

const cities: CollectionDef = {
  key: 'cities',
  defaultCollectionName: 'Cities',
  collectionEnvVar: 'FRAMER_COLLECTION_CITIES',
  // community_ids: CSV of the community rec-IDs linked to this city (communities.city_id
  // = cities.id), aggregated at query time (same correlated-subquery shape as the
  // promotions target lists / CITY_COUNTS_SQL above). Emitted as a plain string so a
  // City page can filter communities by `community_ids Contains {cityId}` — IDs as the
  // stable key (no name-drift). All linked communities are listed; the Communities
  // collection's own publish gate (draft:!published) still controls render visibility.
  // NB: communities aliased `cm` here (the city is `c`, matching CITY_COUNTS_SQL).
  selectByIdSql: `SELECT c.*, ${CITY_COUNTS_SQL},
    (SELECT group_concat(cm.id) FROM communities cm WHERE cm.city_id = c.id) AS community_ids
    FROM cities c WHERE c.id = ?`,
  selectAllSql: `SELECT c.*, ${CITY_COUNTS_SQL},
    (SELECT group_concat(cm.id) FROM communities cm WHERE cm.city_id = c.id) AS community_ids
    FROM cities c`,
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

    // copy blocks: section/pillar/heading fields. Only emit keys that EXIST on the
    // live Cities (Managed) collection (an unknown key rejects the whole item), and
    // type each by the live schema (image set vs string set).
    const copyFields: Record<string, AnyFieldValue | undefined> = {};
    for (const [k, v] of Object.entries(copy)) {
      if (CITY_COPY_IMG_KEYS.has(k)) {
        copyFields[k] = imgIf(v);
      } else if (CITY_COPY_STR_KEYS.has(k)) {
        copyFields[k] = sIf(v);
      }
      // else: unknown copy key — drop it (Framer has no field to receive it).
    }

    const fieldData = compactFields({
      city_name: sIf(row['city_name']),
      slug: str(slug),
      state: sIf(row['state']),
      status: sIf(row['status']),
      map_latitude: nIf(row['map_latitude']),
      map_longitude: nIf(row['map_longitude']),
      hero_image: imgIf(row['hero_image_url']),
      where_we_build_image: imgIf(row['where_we_build_image_url']),
      hero_description: sIf(row['hero_description']),
      national_recognition: sIf(row['national_recognition']),
      // Prefer the live computed counts (CITY_COUNTS_SQL); fall back to the
      // stored snapshot columns only if a caller selects rows without them.
      community_count: nIf(row['community_count_live'] ?? row['community_count']),
      floor_plans_count: nIf(row['floor_plans_count_live'] ?? row['floor_plans_count']),
      move_in_homes_count: nIf(row['move_in_homes_count_live'] ?? row['move_in_homes_count']),
      incentive: sIf(row['incentive']),
      coming_soon: bool(asBool(row['coming_soon'])), // live Cities (Managed) has the field (added 2026-06)
      // CSV of community rec-IDs in this city (group_concat in the SQL above) — same
      // string/passthrough posture as floor_plans/qmi community_ids (no field_definitions
      // row). Lets a City page filter communities by `community_ids Contains {cityId}`.
      community_ids: sIf(row['community_ids']),
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
      // A testimonial belongs to ONE community (testimonials.community_id) → single
      // rec-ID under the SAME `community_ids` key/string shape as floor_plans/qmi, so a
      // community CMS page can filter testimonials with `community_ids Contains {communityId}`.
      community_ids: sIf(row['community_id']),
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
