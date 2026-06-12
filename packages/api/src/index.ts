// =============================================================================
// esperanza-api — public read API Worker (edge-served). Migration Plan v2, Phase 4.
//
// Serves the legacy public-JSON contract Framer already consumes, but sourced from
// the D1 v_public_* views instead of the old Airtable cache workers:
//
//   GET /api/public/qmi          -> { homes:        RawAirtableRecord[], ts }
//   GET /api/public/communities  -> { communities:  Community[],         ts }
//   GET /api/public/promotions   -> { promotions:   Promotion[],         ts }
//   GET /api/public/floorplans   -> { floorplans:   FloorPlan[],         ts }
//   GET /api/public/cities       -> { cities:       City[],              ts }
//   GET /api/public/collections  -> { collections:  Collection[],        ts }
//   GET /api/public/images       -> { images:       Image[],             ts }
//   GET /api/public/blogs        -> { blogs:        Blog[],              ts }
//   GET /api/public/testimonials -> { testimonials: Testimonial[],       ts }
//   GET /api/public/settings     -> { settings: {mortgage_rate,...},     ts }
//
// Three contract invariants the serializers reproduce byte-for-byte:
//   1. /qmi is a RAW Airtable passthrough: each item is { id, createdTime, fields }
//      where `fields` is SPARSE (absent fields omitted, not nulled), keys are the
//      original Airtable labels (spaces + mixed case, e.g. "viewer slug", "City (Link)"),
//      FP:* lookups are SINGLE-ELEMENT ARRAYS, and postal_code is NUMERIC.
//   2. /communities + /qmi carry the RESOLVED effective promotion (banner/badge/cta/
//      image), sourced from promotion_targets via resolveEffectivePromo() — NOT the
//      legacy "best-promo flatten over linked Promotions array".
//   3. /promotions is a dense passthrough with DERIVED communityNames/floorPlanNames
//      and an image fallback (own image -> first linked community -> first linked FP).
//
// === D1 READ REPLICATION (Sessions API) ===
// Public reads use `env.DB.withSession("first-unconstrained")`: the request may be
// served by ANY replica (eventually consistent), which is exactly right for a public
// CDN-cached read path. The ADMIN app MUST NOT use this constraint — admin read-your-
// writes has to route the first read to the primary (`withSession("first-primary")`)
// or replay a stored bookmark (`withSession(savedBookmark)`) so an editor sees their
// own just-committed edit. See docs/runbook below.
//
// === CACHE API + PURGE ===
// Each response body is stored in caches.default keyed by the request URL, with an
// edge Cache-Control (qmi 60s, communities 300s, others 300s). To match the legacy
// cache workers, that Cache-Control is set ONLY on the CACHED body and is NOT emitted
// on the client response. An admin edit purges via `?purge=1` (or the documented
// cache.delete hook the admin worker calls service-to-service).
// =============================================================================

import {
  resolveEffectivePromo,
  type PromoTargetType,
} from '@esperanza/db/promo';
import { buildSiteSearchPayload } from './sitesearch.js';

// -----------------------------------------------------------------------------
// Env
// -----------------------------------------------------------------------------
export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  /** Optional CSV CORS allowlist. Mirrors the legacy ALLOWED_ORIGINS behaviour. */
  ALLOWED_ORIGINS?: string;
}

// -----------------------------------------------------------------------------
// Public-contract types
// -----------------------------------------------------------------------------
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** /qmi item — verbatim Airtable record shape. `fields` is intentionally sparse. */
export interface RawAirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, Json>;
}

/** Resolved promotion object flattened onto qmi + community rows. */
export interface ResolvedPromo {
  promoBannerText: string;
  promoBadgeText: string;
  promoCtaLabel: string;
  promoCtaLink: string;
}

// -----------------------------------------------------------------------------
// Cache config per entity
// -----------------------------------------------------------------------------
const TTL: Record<string, number> = {
  qmi: 60,
  communities: 300,
  promotions: 300,
  floorplans: 300,
  cities: 300,
  collections: 300,
  images: 300,
  blogs: 300,
  testimonials: 300,
  sitesearch: 300,
  settings: 300,
};

const ENTITIES = Object.keys(TTL) as readonly string[];

// =============================================================================
// Small value coercers (D1 returns SQLite scalars; booleans arrive as 0/1)
// =============================================================================
const asStr = (v: unknown): string => (v == null ? '' : String(v));
const asStrOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const asBool = (v: unknown): boolean => v === 1 || v === true || v === '1';
const asNumOrNull = (v: unknown): number | null =>
  typeof v === 'number' ? v : v == null || v === '' ? null : Number.isNaN(Number(v)) ? null : Number(v);
const asIntOrNull = (v: unknown): number | null => {
  const n = asNumOrNull(v);
  return n == null ? null : Math.trunc(n);
};

/**
 * Parse a JSON column that holds (per schema) either a JSON-encoded scalar/value
 * or an already-wrapped single-element array, and return the UNWRAPPED inner value.
 * Idempotent: tolerates both `"2"` and `"[2]"`, `'[{...}]'` and `'[[{...}]]'`.
 */
function unwrapStored(raw: unknown): unknown {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // not JSON — treat the raw string as the scalar value
    return raw;
  }
  // A single-element wrapper array stores the value at [0]; unwrap one level.
  if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
  return parsed;
}

/**
 * Reproduce the FP:* contract: a lookup-from-linked-Floor-Plan is a SINGLE-ELEMENT
 * ARRAY wrapping a scalar (or, for FP: Image, a single attachment object). Absent
 * when no Floor Plan is linked. Returns undefined to signal "omit this field".
 */
function fpArray(raw: unknown): Json[] | undefined {
  const inner = unwrapStored(raw);
  if (inner === undefined || inner === null) return undefined;
  return [inner as Json];
}

// =============================================================================
// Row shapes read out of the views (snake_case columns the views expose)
// =============================================================================
type Row = Record<string, unknown>;

/**
 * A v_public_promotions row. Shaped to satisfy `PromoLike` (so resolveEffectivePromo
 * accepts it directly) while carrying the extra columns the /promotions serializer
 * reads. `published`/`sort_order`/dates are the fields the resolver inspects.
 * (`published` is the gate column, renamed from `active` in migration 0005; the PUBLIC
 * JSON output key stays `active` — see serializePromotionRow.)
 */
interface PromoRow {
  id: string;
  title: unknown;
  banner_text: unknown;
  badge_text: unknown;
  copy: unknown;
  cta_label: unknown;
  cta_url: unknown;
  image_url: unknown;
  sort_order: number | null;
  start_date: string | null;
  end_date: string | null;
  published: number | boolean;
  // [P2] applies_to removed (legacy label; promotion_targets drives targeting). The index
  // signature below still tolerates the column if a stray row carries it.
  [k: string]: unknown;
}

export interface TargetRow {
  promotion_id: string;
  target_type: PromoTargetType;
  target_id: string | null;
  [k: string]: unknown;
}

// =============================================================================
// QMI serializer — RAW passthrough. Maps a v_public_qmi row back to the original
// Airtable field labels, omitting absent fields and re-wrapping FP:* scalars.
// `resolvedPromo` (if any) is flattened onto the row's `fields`.
// =============================================================================

/** [snake_column, "Airtable Field Label", coercer]. Only emitted when non-null. */
type FieldSpec = [string, string, (v: unknown) => Json];

/** Plain (non-FP, non-link) columns: emitted only when the column value is non-null. */
const QMI_PLAIN: FieldSpec[] = [
  ['published', 'Published', (v) => asBool(v)],
  ['coming_soon', 'Coming Soon', (v) => asBool(v)],
  ['housenumber', 'housenumber', (v) => asStr(v)],
  ['posted', 'Posted', (v) => asStr(v)],
  ['community', 'Community', (v) => asStr(v)],
  ['publish_date', 'Publish Date', (v) => asStr(v)],
  ['city', 'City', (v) => asStr(v)],
  ['bathroom_count', 'bathroom_count', (v) => asNumOrNull(v) as Json],
  ['slug', 'slug', (v) => asStr(v)],
  ['price', 'Price', (v) => asNumOrNull(v) as Json],
  ['half_bathroom_count', 'half_bathroom_count', (v) => asNumOrNull(v) as Json],
  ['seo_slug', 'seo_slug', (v) => asStr(v)],
  ['total_square_footage', 'total_square_footage', (v) => asNumOrNull(v) as Json],
  ['elevation', 'elevation', (v) => asStr(v)],
  ['address', 'address', (v) => asStr(v)],
  ['eci_key', 'eci_key', (v) => asStr(v)],
  ['living_square_footage', 'living_square_footage', (v) => asNumOrNull(v) as Json],
  ['bedroom_count', 'bedroom_count', (v) => asNumOrNull(v) as Json],
  ['estimated_monthly_price', 'estimated_monthly_price', (v) => asNumOrNull(v) as Json],
  ['construction_stage', 'construction_stage', (v) => asStr(v)],
  ['dynamic_pdf', 'Dynamic PDF', (v) => asStr(v)],
  ['mark_job_number', 'mark_job_number', (v) => asStr(v)],
  // postal_code MUST stay numeric (load-bearing — Framer expects a number).
  ['postal_code', 'postal_code', (v) => asNumOrNull(v) as Json],
  ['viewer_slug', 'viewer slug', (v) => asStr(v)], // NOTE the SPACE in the label
  ['last_synced_price', 'last_synced_price', (v) => asNumOrNull(v) as Json],
  ['last_modified_time', 'Last Modified Time', (v) => asStr(v)],
  ['floor_plan', 'Floor Plan', (v) => asStr(v)],
  // partial/optional (present subset of records)
  ['og_image_url', 'og_image_url', (v) => asStr(v)],
  ['geo_latitude', 'geo_latitude', (v) => asNumOrNull(v) as Json],
  ['geo_longitude', 'geo_longitude', (v) => asNumOrNull(v) as Json],
  ['hers_score', 'hers_score', (v) => asNumOrNull(v) as Json],
  ['monthly_energy_cost', 'monthly_energy_cost', (v) => asNumOrNull(v) as Json],
  ['stories', 'stories', (v) => asNumOrNull(v) as Json],
  ['availability_text', 'availability_text', (v) => asStr(v)],
  ['page_url', 'page_url', (v) => asStr(v)],
  ['promo_text', 'promo_text', (v) => asStr(v)],
  ['available_now', 'Available Now', (v) => asBool(v)],
  // drift / one-off legacy manual fields (rare-optional — emitted only when present)
  ['rich_slug', 'rich_slug', (v) => asStr(v)],
  ['stories_count', 'stories_count', (v) => asNumOrNull(v) as Json],
  ['include_in_xml_feed', 'Include in XML Feed?', (v) => asBool(v)],
  ['lot_size_sqft', 'Lot Size (sqft)', (v) => asNumOrNull(v) as Json],
  ['car_garage_count', 'car_garage_count', (v) => asNumOrNull(v) as Json],
  ['virtual_tour_url', 'Virtual Tour URL', (v) => asStr(v)],
  ['collection', 'Collection', (v) => asStr(v)],
  ['description', 'Description', (v) => asStr(v)],
  ['image_url', 'image_url', (v) => asStr(v)],
  ['move_in_date', 'Move-In Date', (v) => asStr(v)],
  ['longitude', 'longitude', (v) => asNumOrNull(v) as Json],
  ['latitude', 'latitude', (v) => asNumOrNull(v) as Json],
  ['year_built', 'Year Built', (v) => asNumOrNull(v) as Json],
];

/** FP:* lookup columns -> single-element-array Airtable labels. */
const QMI_FP: Array<[string, string]> = [
  ['fp_master_bed_location', 'FP: Master Bed Location'],
  ['fp_garage', 'FP: Garage'],
  ['fp_starting_price', 'FP: Starting Price'],
  ['fp_living_sqft', 'FP: Living SqFt'],
  ['fp_image', 'FP: Image'],
  ['fp_plan_viewer', 'FP: Plan Viewer'],
  ['fp_bedrooms_max', 'FP: Bedrooms (Max)'],
  ['fp_bathrooms_max', 'FP: Bathrooms (Max)'],
  ['fp_bedrooms_min', 'FP: Bedrooms (Min)'],
  ['fp_description', 'FP: Description'],
  ['fp_total_sqft', 'FP: Total SqFt'],
  ['fp_collection', 'FP: Collection'],
  ['fp_virtual_tour', 'FP: Virtual Tour'],
  ['fp_additional_images', 'FP: Additional Images'],
];

/** Link columns -> single-element string-array labels (the Airtable link shape). */
const QMI_LINKS: Array<[string, string]> = [
  ['community_id', 'Community (Link)'],
  ['city_id', 'City (Link)'],
  ['floor_plan_id', 'Floor Plan (Link)'],
];

/** Drift attachment column -> single-element attachment-array label. */
const QMI_DRIFT_ATTACH: Array<[string, string]> = [
  ['featured_image', 'Featured Image'],
];

/**
 * Build one raw QMI record. `createdTime` comes from a created_at column if the
 * view exposes one; the view in this repo does not select it, so we fall back to
 * the row's created_at if present, else "" (the field is always present in goldens
 * because the importer carries Airtable's createdTime — kept here as a column).
 */
export function serializeQmiRow(row: Row, resolved: ResolvedPromo | null): RawAirtableRecord {
  const fields: Record<string, Json> = {};

  for (const [col, label, coerce] of QMI_PLAIN) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    const out = coerce(v);
    if (out === null || out === undefined) continue;
    fields[label] = out;
  }

  for (const [col, label] of QMI_FP) {
    const arr = fpArray(row[col]);
    if (arr !== undefined) fields[label] = arr;
  }

  // Floor-plan-default → QMI-override description resolution (the same COALESCE
  // the PDF renderer and framer-push apply): when the home carries no Description
  // of its own (NULL or ''), serve the linked floor plan's copy so consumers bind
  // ONE plain field with zero conditional logic. 'FP: Description' above keeps
  // carrying the raw FP lookup, so existing component-side fallbacks still work.
  if (fields['Description'] === undefined || fields['Description'] === '') {
    const fp = unwrapStored(row['fp_description']);
    if (fp != null && String(fp) !== '') fields['Description'] = String(fp);
  }

  for (const [col, label] of QMI_LINKS) {
    const v = row[col];
    if (v == null || v === '') continue;
    fields[label] = [String(v)];
  }

  for (const [col, label] of QMI_DRIFT_ATTACH) {
    const arr = fpArray(row[col]);
    if (arr !== undefined) fields[label] = arr;
  }

  // Flatten the resolved effective promo (replacing the legacy best-promo flatten).
  if (resolved) {
    if (resolved.promoBannerText) fields['promo_text'] = resolved.promoBannerText;
  }

  return {
    id: String(row['id']),
    createdTime: asStr(row['created_time'] ?? row['createdTime'] ?? row['created_at']),
    fields,
  };
}

// =============================================================================
// Community serializer — MAPPED, DENSE (every key always present).
// =============================================================================

/** Normalize lat/lng-ish input into a bare "lat,lng" (strips Google-Maps @ / URL). */
export function normalizeLatLng(raw: unknown): string {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Google-Maps "@lat,lng,zoom" or full URL forms: grab the first "num,num".
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return '';
  return `${m[1]},${m[2]}`;
}

export interface CommunityPublic {
  id: string;
  name: string;
  slug: string;
  town: string;
  coordinates: string;
  active: boolean;
  address: string;
  image: string;
  secondaryImage: string;
  priceFrom: number | null;
  sqft: string;
  beds: string;
  baths: string;
  description: string;
  amenities: string;
  comingSoon: boolean;
  promoBannerText: string;
  promoBadgeText: string;
  promoCtaLabel: string;
  promoCtaLink: string;
}

export function serializeCommunityRow(row: Row, resolved: ResolvedPromo | null): CommunityPublic {
  // image: prefer the stable featured_image_url; coordinates: map_coordinates ->
  // lat_long -> latitude/longitude pair.
  const coords =
    normalizeLatLng(row['map_coordinates']) ||
    normalizeLatLng(row['lat_long']) ||
    (row['latitude'] != null && row['longitude'] != null
      ? normalizeLatLng(`${row['latitude']},${row['longitude']}`)
      : '');

  return {
    id: String(row['id']),
    name: asStr(row['name']),
    slug: asStr(row['slug']),
    town: asStr(row['town']),
    coordinates: coords,
    // `draft` column dropped in migration 0005; the view now gates published, so the
    // public `active` flag is simply `published` (every served community is live).
    active: asBool(row['published']),
    address: asStr(row['address']),
    image: asStr(row['featured_image_url']),
    secondaryImage: asStr(row['secondary_image_url']),
    priceFrom: asNumOrNull(row['price_from']),
    sqft: asStr(row['square_footage_range']),
    beds: asStr(row['bed_count']),
    baths: asStr(row['bath_count']),
    description: asStr(row['description']),
    amenities: asStr(row['amenities']),
    comingSoon: asBool(row['coming_soon']),
    promoBannerText: resolved?.promoBannerText ?? '',
    promoBadgeText: resolved?.promoBadgeText ?? '',
    promoCtaLabel: resolved?.promoCtaLabel ?? '',
    promoCtaLink: resolved?.promoCtaLink ?? '',
  };
}

// =============================================================================
// Promotion serializer — MAPPED, DENSE, with DERIVED names + image fallback.
// =============================================================================
export interface PromotionPublic {
  id: string;
  title: string;
  bannerText: string;
  cardBadgeText: string;
  ctaLabel: string;
  ctaLink: string;
  active: boolean;
  sortOrder: number;
  image: string;
  expirationDate: string;
  communityIds: string[];
  floorPlanIds: string[];
  collectionIds: string[];
  communityNames: string[];
  floorPlanNames: string[];
}

export interface PromoResolveMaps {
  /** id -> community { name, image } */
  communities: Map<string, { name: string; image: string }>;
  /** id -> floor plan { name, image } */
  floorPlans: Map<string, { name: string; image: string }>;
}

export function serializePromotionRow(
  promo: PromoRow,
  targets: TargetRow[],
  maps: PromoResolveMaps
): PromotionPublic {
  const communityIds: string[] = [];
  const floorPlanIds: string[] = [];
  const collectionIds: string[] = [];
  for (const t of targets) {
    if (t.target_id == null) continue;
    if (t.target_type === 'community') communityIds.push(t.target_id);
    else if (t.target_type === 'qmi') {
      /* qmi targets don't surface in the legacy promotions name lists */
    }
    // 'city' / 'global' don't map to community/floorplan/collection lists here.
  }
  // collectionIds carried raw if the schema ever stores them as a target_type;
  // current model has no 'collection' target_type, so this stays [].

  const communityNames: string[] = [];
  for (const cid of communityIds) {
    const c = maps.communities.get(cid);
    if (c) communityNames.push(c.name);
  }
  const floorPlanNames: string[] = [];
  for (const fid of floorPlanIds) {
    const f = maps.floorPlans.get(fid);
    if (f) floorPlanNames.push(f.name);
  }

  // image fallback: own image -> first linked community image -> first linked FP image.
  let image = asStr(promo.image_url);
  if (!image) {
    for (const cid of communityIds) {
      const c = maps.communities.get(cid);
      if (c?.image) {
        image = c.image;
        break;
      }
    }
  }
  if (!image) {
    for (const fid of floorPlanIds) {
      const f = maps.floorPlans.get(fid);
      if (f?.image) {
        image = f.image;
        break;
      }
    }
  }

  return {
    id: String(promo.id),
    title: asStr(promo.title),
    bannerText: asStr(promo.banner_text),
    cardBadgeText: asStr(promo.badge_text),
    ctaLabel: asStr(promo.cta_label),
    ctaLink: asStr(promo.cta_url),
    // PUBLIC contract output key stays `active`; read it from the renamed gate column.
    active: asBool(promo.published),
    sortOrder: asIntOrNull(promo.sort_order) ?? 0,
    image,
    expirationDate: asStr(promo.end_date),
    communityIds,
    floorPlanIds,
    collectionIds,
    communityNames,
    floorPlanNames,
  };
}

// =============================================================================
// Generic passthrough serializers for the simpler admin-owned entities.
// =============================================================================
export function serializeFloorPlanRow(row: Row): Record<string, Json> {
  return {
    id: String(row['id']),
    name: asStr(row['name']),
    slug: asStr(row['slug']),
    comingSoon: asBool(row['coming_soon']),
    collection: asStr(row['collection']),
    startingPrice: asNumOrNull(row['starting_price']),
    bedroomMin: asIntOrNull(row['bedroom_min']),
    bedroomMax: asIntOrNull(row['bedroom_max']),
    bathroomMin: asNumOrNull(row['bathroom_min']),
    bathroomMax: asNumOrNull(row['bathroom_max']),
    carGarageCount: asIntOrNull(row['car_garage_count']),
    storiesCount: asIntOrNull(row['stories_count']),
    livingSquareFootage: asIntOrNull(row['living_square_footage']),
    totalSquareFootage: asIntOrNull(row['total_square_footage']),
    masterBedLocation: asStr(row['master_bed_location']),
    hersScore: asIntOrNull(row['hers_score']),
    image: asStr(row['image_url']) || asStr(row['synced_image_url']),
    description: asStr(row['description']),
    planViewerUrl: asStr(row['plan_viewer_url']),
    virtualTourUrl: asStr(row['virtual_tour_url']),
    brochurePdfUrl: asStr(row['brochure_pdf_url']),
  };
}

export function serializeCityRow(row: Row): Record<string, Json> {
  return {
    id: String(row['id']),
    name: asStr(row['city_name']),
    slug: asStr(row['slug']),
    state: asStr(row['state']),
    status: asStr(row['status']),
    comingSoon: asBool(row['coming_soon']),
    coordinates:
      row['map_latitude'] != null && row['map_longitude'] != null
        ? normalizeLatLng(`${row['map_latitude']},${row['map_longitude']}`)
        : '',
    communityCount: asIntOrNull(row['community_count']),
    moveInHomesCount: asIntOrNull(row['move_in_homes_count']),
    floorPlansCount: asIntOrNull(row['floor_plans_count']),
    heroImage: asStr(row['hero_image_url']),
    heroDescription: asStr(row['hero_description']),
    nationalRecognition: asStr(row['national_recognition']),
  };
}

export function serializeCollectionRow(row: Row): Record<string, Json> {
  return {
    id: String(row['id']),
    title: asStr(row['title']),
    slug: asStr(row['slug']),
    content: asStr(row['content']),
    headerImage: asStr(row['header_image']),
    headerImageAlt: asStr(row['header_image_alt']),
    startingAt: asNumOrNull(row['starting_at']),
    endingAt: asNumOrNull(row['ending_at']),
  };
}

export function serializeImageRow(row: Row): Record<string, Json> {
  return {
    id: String(row['id']),
    slug: asStr(row['slug']),
    planName: asStr(row['plan_name']),
    caption: asStr(row['caption']),
    captionClean: asStr(row['caption_clean']),
    elevationStyle: asStr(row['elevation_style']),
    elevationMaterial: asStr(row['elevation_material']),
    fileUrl: asStr(row['file_url']),
  };
}

export function serializeBlogRow(row: Row): Record<string, Json> {
  return {
    id: String(row['id']),
    title: asStr(row['title']),
    slug: asStr(row['slug']),
    category: asStr(row['category']),
    excerpt: asStr(row['excerpt']),
    content: asStr(row['content']),
    publishDate: asStr(row['publish_date']),
    featuredImage: asStr(row['featured_image']),
    seoDescription: asStr(row['seo_description']),
    communityName: asStr(row['community_name']),
  };
}

export function serializeTestimonialRow(row: Row): Record<string, Json> {
  return {
    id: String(row['id']),
    personName: asStr(row['person_name']),
    slug: asStr(row['slug']),
    datePosted: asStr(row['date_posted']),
    testimonialText: asStr(row['testimonial_text']),
    moveInYear: asStr(row['move_in_year']),
    image: asStr(row['image_url']),
    floorPlanId: asStrOrNull(row['floor_plan_id']),
    floorPlanName: asStr(row['floor_plan_name']),
    floorPlanImage: asStr(row['floor_plan_image']),
    communityId: asStrOrNull(row['community_id']),
    communityName: asStr(row['community_name']),
    town: asStr(row['town']),
  };
}

// =============================================================================
// Promo resolution glue — fetch active promos + targets ONCE, build the maps the
// /promotions serializer needs, and a per-entity resolver that flattens the
// effective promo (banner/badge/cta) for qmi + community rows.
// =============================================================================
interface PromoContext {
  promos: PromoRow[];
  targets: TargetRow[];
  maps: PromoResolveMaps;
}

function toResolved(p: PromoRow | null): ResolvedPromo | null {
  if (!p) return null;
  return {
    promoBannerText: asStr(p.banner_text),
    promoBadgeText: asStr(p.badge_text),
    promoCtaLabel: asStr(p.cta_label),
    promoCtaLink: asStr(p.cta_url),
  };
}

function resolveFor(
  ctx: PromoContext,
  entity: 'qmi' | 'community' | 'city',
  ids: {
    qmiId?: string | null;
    communityId?: string | null;
    floorPlanId?: string | null;
    cityId?: string | null;
  },
  now: string
): ResolvedPromo | null {
  const winner = resolveEffectivePromo(entity, ids, ctx.promos, ctx.targets, now);
  return toResolved(winner);
}

// =============================================================================
// D1 query helpers — all reads go through a `first-unconstrained` session.
// =============================================================================
async function loadPromoContext(session: D1DatabaseSession): Promise<PromoContext> {
  const batch = await session.batch<Row>([
    session.prepare('SELECT * FROM v_public_promotions ORDER BY sort_order ASC, id ASC'),
    session.prepare('SELECT promotion_id, target_type, target_id FROM promotion_targets'),
    session.prepare('SELECT id, name, featured_image_url FROM communities'),
    session.prepare('SELECT id, name, image_url, synced_image_url FROM floor_plans'),
  ]);
  const [promosRes, targetsRes, commRes, fpRes] = batch;

  const promos = (promosRes?.results ?? []) as unknown as PromoRow[];
  const targets = (targetsRes?.results ?? []) as unknown as TargetRow[];

  const communities = new Map<string, { name: string; image: string }>();
  for (const c of (commRes?.results ?? []) as unknown as Row[]) {
    communities.set(String(c['id']), {
      name: asStr(c['name']),
      image: asStr(c['featured_image_url']),
    });
  }
  const floorPlans = new Map<string, { name: string; image: string }>();
  for (const f of (fpRes?.results ?? []) as unknown as Row[]) {
    floorPlans.set(String(f['id']), {
      name: asStr(f['name']),
      image: asStr(f['image_url']) || asStr(f['synced_image_url']),
    });
  }

  return { promos, targets, maps: { communities, floorPlans } };
}

// =============================================================================
// Response builders per entity (the serializers above, wired to D1).
// =============================================================================
async function buildPayload(
  entity: string,
  session: D1DatabaseSession
): Promise<Record<string, unknown>> {
  const now = new Date().toISOString().slice(0, 10);
  const ts = Date.now();

  switch (entity) {
    case 'qmi': {
      const ctx = await loadPromoContext(session);
      // The view is the contract surface for FIELD values; createdTime is the only
      // record-envelope datum the view doesn't carry, so we read q.created_at from
      // the base table (aliased created_time) alongside it. (The legacy /qmi worker
      // emitted Airtable's createdTime verbatim; the importer persists it here.)
      const res = await session
        .prepare(
          `SELECT v.*, q.created_at AS created_time
             FROM v_public_qmi v JOIN qmi q ON q.id = v.id`
        )
        .all();
      const rows = (res.results ?? []) as unknown as Row[];
      const homes = rows.map((row) => {
        const resolved = resolveFor(
          ctx,
          'qmi',
          {
            qmiId: String(row['id']),
            communityId: asStrOrNull(row['community_id']),
            // Cascade: a plan-targeted promo applies to every QMI built on it
            // (unless a more specific community/qmi promo wins). v_public_qmi
            // exposes floor_plan_id as COALESCE(override, synced).
            floorPlanId: asStrOrNull(row['floor_plan_id']),
            cityId: asStrOrNull(row['city_id']),
          },
          now
        );
        return serializeQmiRow(row, resolved);
      });
      return { homes, ts };
    }

    case 'communities': {
      const ctx = await loadPromoContext(session);
      const res = await session.prepare('SELECT * FROM v_public_communities').all();
      const rows = (res.results ?? []) as unknown as Row[];
      // The view already gates published (draft column dropped in 0005) — map directly.
      const communities = rows
        .map((row) => {
          const resolved = resolveFor(
            ctx,
            'community',
            { communityId: String(row['id']), cityId: asStrOrNull(row['city_id']) },
            now
          );
          return serializeCommunityRow(row, resolved);
        });
      return { communities, ts };
    }

    case 'promotions': {
      const ctx = await loadPromoContext(session);
      // group targets by promotion
      const byPromo = new Map<string, TargetRow[]>();
      for (const t of ctx.targets) {
        const arr = byPromo.get(t.promotion_id);
        if (arr) arr.push(t);
        else byPromo.set(t.promotion_id, [t]);
      }
      const promotions = ctx.promos
        .filter((p) => asBool(p.published))
        .map((p) => serializePromotionRow(p, byPromo.get(p.id) ?? [], ctx.maps))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      return { promotions, ts };
    }

    case 'floorplans': {
      const res = await session.prepare('SELECT * FROM v_public_floor_plans').all();
      const rows = (res.results ?? []) as unknown as Row[];
      return { floorplans: rows.map(serializeFloorPlanRow), ts };
    }

    case 'cities': {
      const res = await session.prepare('SELECT * FROM v_public_cities').all();
      const rows = (res.results ?? []) as unknown as Row[];
      return { cities: rows.map(serializeCityRow), ts };
    }

    case 'collections': {
      const res = await session.prepare('SELECT * FROM v_public_collections').all();
      const rows = (res.results ?? []) as unknown as Row[];
      return { collections: rows.map(serializeCollectionRow), ts };
    }

    case 'images': {
      const res = await session.prepare('SELECT * FROM v_public_images').all();
      const rows = (res.results ?? []) as unknown as Row[];
      return { images: rows.map(serializeImageRow), ts };
    }

    case 'blogs': {
      const res = await session.prepare('SELECT * FROM v_public_blogs').all();
      const rows = (res.results ?? []) as unknown as Row[];
      return { blogs: rows.map(serializeBlogRow), ts };
    }

    case 'testimonials': {
      const res = await session.prepare('SELECT * FROM v_public_testimonials').all();
      const rows = (res.results ?? []) as unknown as Row[];
      return { testimonials: rows.map(serializeTestimonialRow), ts };
    }

    case 'sitesearch': {
      // Unified header-search index — clone of the legacy /sitesearch.json feed.
      // See sitesearch.ts + docs/sitesearch-clone-design.md.
      return await buildSiteSearchPayload(session);
    }

    case 'settings': {
      // Company-wide settings (site_settings, migration 0013) — e.g. mortgage_rate,
      // which the Framer mortgage calculators fetch so a single admin edit updates
      // every payment calculator site-wide. Numeric-looking values are coerced so
      // calculators can use them directly.
      const res = await session.prepare('SELECT key, value FROM site_settings').all();
      const rows = (res.results ?? []) as unknown as Row[];
      const settings: Record<string, string | number | null> = {};
      for (const r of rows) {
        const v = r['value'];
        const n = asNumOrNull(v);
        settings[asStr(r['key'])] = n != null ? n : asStrOrNull(v);
      }
      return { settings, ts };
    }

    default:
      throw new Error(`unknown entity: ${entity}`);
  }
}

// =============================================================================
// CORS — mirrors the legacy allowlist behaviour (reflect matched Origin; exact /
// "*" / "https://*.host" subdomain wildcard; fall back to allowlist[0]).
// =============================================================================
const DEFAULT_ALLOWED = [
  'https://www.esperanzahomes.com',
  'https://esperanzahomes.com',
  'https://*.framer.app',
  'https://*.framer.website',
];

function originAllowed(origin: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === origin) return true;
  if (pattern.startsWith('https://*.')) {
    const host = pattern.slice('https://*.'.length);
    try {
      const o = new URL(origin);
      return o.protocol === 'https:' && (o.host === host || o.host.endsWith('.' + host));
    } catch {
      return false;
    }
  }
  return false;
}

function corsHeaders(env: Env, requestOrigin: string | null): Headers {
  const allowlist = (env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ??
    DEFAULT_ALLOWED) as string[];
  let allowOrigin = allowlist[0] ?? '*';
  if (requestOrigin) {
    for (const pattern of allowlist) {
      if (originAllowed(requestOrigin, pattern)) {
        allowOrigin = requestOrigin;
        break;
      }
    }
  }
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', allowOrigin);
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return h;
}

// =============================================================================
// Worker entry — routes /api/public/<entity>, Cache API wrap, D1 read session.
// =============================================================================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const match = url.pathname.match(/^\/api\/public\/([a-z]+)\/?$/);
    if (request.method !== 'GET' || !match || !ENTITIES.includes(match[1]!)) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    const entity = match[1]!;
    const ttl = TTL[entity]!;

    // ── Cache API: key on the URL (sans purge param). Purge hook for admin edits. ──
    const cache = caches.default;
    const cacheKeyUrl = new URL(url);
    const wantsPurge = cacheKeyUrl.searchParams.get('purge') === '1';
    cacheKeyUrl.searchParams.delete('purge');
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: 'GET' });

    if (wantsPurge) {
      // Admin cache-busting hook: DELETE the cached body so the next read repopulates.
      // (The admin Worker calls this service-to-service after a write; see runbook.)
      ctx.waitUntil(cache.delete(cacheKey));
    } else {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const out = new Response(hit.body, hit);
        // Strip any stored Cache-Control before returning to the client (contract:
        // edge Cache-Control is on the cached copy only, never on the client response).
        out.headers.delete('Cache-Control');
        for (const [k, v] of cors) out.headers.set(k, v);
        out.headers.set('X-Cache', 'HIT');
        return out;
      }
    }

    try {
      // Public read path: any replica is fine (eventually consistent). The admin
      // path MUST NOT use this — it uses first-primary / a stored bookmark.
      const session = env.DB.withSession('first-unconstrained');
      const payload = await buildPayload(entity, session);
      const body = JSON.stringify(payload);

      // Store in cache WITH the edge Cache-Control (this header lives on the cached
      // copy only). max-age == s-maxage == ttl, matching the legacy workers.
      const cacheControl = `public, max-age=${ttl}, s-maxage=${ttl}`;
      const toCache = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
      });
      ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

      // Client response: NO Cache-Control, X-Cache: MISS, CORS reflected.
      const out = new Response(body, { status: 200 });
      out.headers.set('Content-Type', 'application/json');
      out.headers.set('X-Cache', 'MISS');
      for (const [k, v] of cors) out.headers.set(k, v);
      return out;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const out = new Response(JSON.stringify({ error: 'upstream_failure', detail }), {
        status: 502,
      });
      out.headers.set('Content-Type', 'application/json');
      for (const [k, v] of cors) out.headers.set(k, v);
      return out;
    }
  },
};
