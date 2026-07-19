// =============================================================================
// esperanza-api — public read API Worker (edge-served). Migration Plan v2, Phase 4.
//
// Serves the legacy public-JSON contract the frontend consumes, but sourced from
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
import { COMMUNITY_PLAN_PRICE_SQL } from '@esperanza/db/elevation-price';
import { buildSiteSearchPayload } from './sitesearch.js';
import * as Sentry from '@sentry/cloudflare';

// -----------------------------------------------------------------------------
// Env
// -----------------------------------------------------------------------------
export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  /** Optional CSV CORS allowlist. Mirrors the legacy ALLOWED_ORIGINS behaviour. */
  ALLOWED_ORIGINS?: string;
  /** Sentry DSN for backend error monitoring. Set via `wrangler secret put SENTRY_DSN`.
   *  Unset -> Sentry is disabled (no-op), so local/dev/test runs stay clean. */
  SENTRY_DSN?: string;
  /** Shared secret gating the /api/preview/qmi draft passthrough. Set (via
   *  `wrangler secret put PREVIEW_SECRET`) ONLY on this Worker and the staging frontend
   *  Worker. UNSET on any public/prod path -> the preview route 404s, so drafts can
   *  never leak. See docs/esperanza/03-module-admin.md (draft preview). */
  PREVIEW_SECRET?: string;
  /** Shared secret gating `?purge=1` cache-busting. Set (via `wrangler secret put
   *  PURGE_KEY`) on this Worker plus the admin + ingest Workers that issue purges.
   *  A purge request must carry a matching `X-Purge-Key` header; otherwise the purge
   *  param is IGNORED (served as a normal cached GET), so public callers cannot
   *  cache-bust their way into a D1 rebuild on every request. UNSET -> all purges
   *  ignored. */
  PURGE_KEY?: string;
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

/**
 * QMI photo gallery: v_public_qmi.photo_gallery_json is a JSON string array of
 * {url, alt} (tolerates bare URL strings too). Emitted at fields.photo_gallery;
 * omitted when empty so galleryless homes fall back to image_url. The plain
 * coercers can't carry a multi-element array, so emit here.
 */
function parseGallery(raw: unknown): Array<{ url: string; alt: string }> {
  if (raw == null || raw === '') return [];
  let arr: unknown;
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Array<{ url: string; alt: string }> = [];
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const url = asStr((item as Record<string, unknown>)['url']);
      if (url) out.push({ url, alt: asStr((item as Record<string, unknown>)['alt']) });
    } else if (typeof item === 'string' && item.trim()) {
      out.push({ url: item.trim(), alt: '' });
    }
  }
  return out;
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
  // postal_code MUST stay numeric (load-bearing — the public contract expects a number).
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

  // Self-tour signals. A home is self-tourable iff it carries an NterNow link
  // (qmi.nter_now); an explicit self_tour_available=1 flag also counts. Both columns
  // exist on v_public_qmi but were never emitted, so the QMI page's Self-Tour filter
  // and each card's "Request Your Time" CTA had nothing to bind to.
  const nterNow = asStr(row['nter_now']);
  if (nterNow !== '') fields['nter_now'] = nterNow;
  if (asBool(row['self_tour_available']) || nterNow !== '') {
    fields['self_tour_available'] = true;
  }

  // Per-home photo gallery (v_public_qmi.photo_gallery_json). Emit explicitly so the
  // detail page gets real model-home photos; galleryless homes fall back to image_url.
  const gallery = parseGallery(row['photo_gallery_json']);
  if (gallery.length) fields['photo_gallery'] = gallery;

  for (const [col, label] of QMI_FP) {
    const arr = fpArray(row[col]);
    if (arr !== undefined) fields[label] = arr;
  }

  // Floor-plan-default → QMI-override description resolution (the same COALESCE
  // the PDF renderer applies): when the home carries no Description
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
  // promoBannerText is already gated by the promo's show_card_badge toggle in
  // toResolved(), so a global-surface-only promo no longer stamps its banner
  // headline onto badge-less homes.
  if (resolved) {
    if (resolved.promoBannerText) fields['promo_text'] = resolved.promoBannerText;
  }

  // Card incentive banner = the home's own D1 `incentive` (the live-site source of
  // truth, e.g. "UNLOCK YOUR 15K FLEX DISCOUNT NOW!"). Emit it as card_badge_text so
  // the QMI card prints the real per-home incentive instead of synthesizing a
  // hardcoded rate. ponytail: raw column — the promotions engine doesn't populate
  // per-home badges. Fallback (only if a resolved promo badge didn't already set it).
  if (fields['card_badge_text'] === undefined) {
    const inc = asStr(row['incentive']);
    if (inc !== '') fields['card_badge_text'] = inc;
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
  officePhone: string;
  officeHours: string;
  scheduleVisit: string;
  promoBannerText: string;
  promoBadgeText: string;
  promoCtaLabel: string;
  promoCtaLink: string;
  /** HOA documents (CCRs, amendments) — {title, link} where link is an R2 PDF url.
   *  Parsed from communities.hoa_links_json; empty array when none. */
  hoaLinks: Array<{ title: string; link: string }>;
}

/** Parse the hoa_links_json column (JSON array of {title, link}) into a typed list,
 *  dropping any entry without a link. */
function parseHoaLinks(raw: unknown): Array<{ title: string; link: string }> {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({ title: asStr((x as Record<string, unknown>)?.title), link: asStr((x as Record<string, unknown>)?.link) }))
      .filter((x) => x.link !== '');
  } catch {
    return [];
  }
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
    officePhone: asStr(row['office_phone']),
    officeHours: asStr(row['office_hours']),
    scheduleVisit: asStr(row['schedule_visit']),
    promoBannerText: resolved?.promoBannerText ?? '',
    promoBadgeText: resolved?.promoBadgeText ?? '',
    promoCtaLabel: resolved?.promoCtaLabel ?? '',
    promoCtaLink: resolved?.promoCtaLink ?? '',
    hoaLinks: parseHoaLinks(row['hoa_links_json']),
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
  pdf: string;
  rate: string;
  // Per-surface visibility toggles (migration 0021); compose with location targeting.
  showSiteBanner: boolean;
  showIncentivePage: boolean;
  showBannerButton: boolean;
  showCardCta: boolean;
  showCardBadge: boolean;
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
    pdf: asStr(promo.pdf_url),
    rate: asStr((promo as Record<string, unknown>).effective_rate),
    showSiteBanner: asBool(promo.show_site_banner),
    showIncentivePage: asBool(promo.show_incentive_page),
    showBannerButton: asBool(promo.show_banner_button),
    showCardCta: asBool(promo.show_card_cta),
    showCardBadge: asBool(promo.show_card_badge),
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
export function serializeFloorPlanRow(
  row: Row,
  resolved: ResolvedPromo | null = null,
  communityPrices?: Record<string, number>
): Record<string, Json> {
  return {
    id: String(row['id']),
    name: asStr(row['name']),
    slug: asStr(row['slug']),
    comingSoon: asBool(row['coming_soon']),
    collection: asStr(row['collection']),
    // Dev-wide "from" = cheapest across communities the plan can still be BUILT in.
    // communityPrices already excludes close-outs (COMMUNITY_PLAN_PRICE_SQL), so its MIN
    // is that number; the stored starting_price (Snowflake dev-wide MIN) can't see the
    // D1 close_out flag and is only the fallback when no elevation rows exist.
    startingPrice:
      communityPrices && Object.keys(communityPrices).length > 0
        ? Math.min(...Object.values(communityPrices))
        : asNumOrNull(row['starting_price']),
    // Per-community lowest price, keyed by community NAME to match the `communities`
    // CSV / Community filter. A plan is offered in many communities at different prices;
    // startingPrice above is the buildable dev-wide cheapest, so the Floor Plans browse
    // shows that community's own price once a community is selected.
    communityPrices: communityPrices ?? {},
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
    communities: asStr(row['communities']), // CSV of community NAMES → Community filter

    image: asStr(row['image_url']) || asStr(row['synced_image_url']),
    description: asStr(row['description']),
    planViewerUrl: asStr(row['plan_viewer_url']),
    virtualTourUrl: asStr(row['virtual_tour_url']),
    brochurePdfUrl: asStr(row['brochure_pdf_url']),
    // Resolved effective promo (floor-plan / global scope) — same shape QMI &
    // community cards already carry. Badge/banner gated by show_card_badge; CTA by
    // show_card_cta (both in toResolved).
    promoBannerText: resolved?.promoBannerText ?? '',
    promoBadgeText: resolved?.promoBadgeText ?? '',
    promoCtaLabel: resolved?.promoCtaLabel ?? '',
    promoCtaLink: resolved?.promoCtaLink ?? '',
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

export function toResolved(p: PromoRow | null): ResolvedPromo | null {
  if (!p) return null;
  // Card surfaces are EXPLICIT toggles (migration 0021 + 0024):
  //   show_card_badge — corner badge (badge_text) AND the card incentive line
  //     (banner_text → promo_text / promoBannerText). Previously implicit ("badge
  //     shows whenever set; banner always flows"), which flattened the GLOBAL
  //     banner headline onto badge-less homes the live site shows bare.
  //   show_card_cta   — the CTA button on cards ("two options" per card).
  const showCardBadge = asBool(p.show_card_badge);
  const showCardCta = asBool(p.show_card_cta);
  return {
    promoBannerText: showCardBadge ? asStr(p.banner_text) : '',
    promoBadgeText: showCardBadge ? asStr(p.badge_text) : '',
    promoCtaLabel: showCardCta ? asStr(p.cta_label) : '',
    promoCtaLink: showCardCta ? asStr(p.cta_url) : '',
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
  session: D1DatabaseSession,
  opts: { preview?: boolean } = {}
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
      //
      // preview: read the ungated v_preview_qmi (published + drafts) instead of the
      // publish-gated v_public_qmi. Reachable ONLY via the secret-gated /api/preview/qmi
      // route below — the public path always passes opts.preview=false. Both views have
      // identical columns, so serializeQmiRow is unchanged.
      const qmiView = opts.preview ? 'v_preview_qmi' : 'v_public_qmi';
      const res = await session
        .prepare(
          `SELECT v.*, q.created_at AS created_time
             FROM ${qmiView} v JOIN qmi q ON q.id = v.id`
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
      const ctx = await loadPromoContext(session);
      const res = await session.prepare('SELECT * FROM v_public_floor_plans').all();
      const rows = (res.results ?? []) as unknown as Row[];
      // Per-community price per plan, from community_elevation_prices (Snowflake-derived,
      // per community × plan × elevation): the community's pinned elevation >
      // Traditional / Brick where offered > cheapest offered (migration 0025 — shared
      // SQL in @esperanza/db/elevation-price). Keyed by floor_plan_id → { communityName: price }.
      const cepRes = await session.prepare(COMMUNITY_PLAN_PRICE_SQL).all();
      const cepByPlan = new Map<string, Record<string, number>>();
      for (const r of (cepRes.results ?? []) as unknown as Row[]) {
        const fpId = asStr(r['fp_id']);
        const community = asStr(r['community']);
        const price = asNumOrNull(r['price']);
        if (!fpId || !community || price == null) continue;
        const map = cepByPlan.get(fpId) ?? {};
        map[community] = price;
        cepByPlan.set(fpId, map);
      }
      const floorplans = rows.map((row) => {
        // floor-plan page context: only floor_plan-targeted (or global) promos match.
        const resolved = resolveFor(ctx, 'city', { floorPlanId: String(row['id']) }, now);
        return serializeFloorPlanRow(row, resolved, cepByPlan.get(String(row['id'])));
      });
      return { floorplans, ts };
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
      // which the mortgage calculators fetch so a single admin edit updates
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
/** Constant-time string compare for the preview secret — avoids leaking the secret
 *  via response-timing on a `===` short-circuit. (Length is not secret.) */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The draft-preview route is authorized ONLY when a secret is configured on this Worker
 *  AND the caller's header matches it (constant-time). An UNSET secret (i.e. prod, where
 *  PREVIEW_SECRET is never provisioned) or any mismatch/absent header → false → 404, so
 *  drafts can never leak on a public deployment. Pure, so the gate is unit-tested. */
export function previewAuthorized(secret: string | undefined, provided: string | null): boolean {
  return Boolean(secret) && Boolean(provided) && safeEqual(provided as string, secret as string);
}

// -----------------------------------------------------------------------------
// Miss coalescing — one D1 build per cache key per isolate. `caches.default` is
// per-colo, so on TTL expiry every concurrent request in a colo would otherwise
// run its own full buildPayload (thundering herd straight into D1). The map is
// module-level: all requests sharing this isolate await the same build promise.
// ponytail: per-isolate only (a colo runs a handful of isolates) — good enough;
// upgrade path is a Durable Object lock if D1 miss load ever matters again.
const inflight = new Map<string, Promise<string>>();

/** Long-lived last-good copy, used to serve stale instead of a 502 when a rebuild
 *  fails (D1 blip). Distinct cache key so its 24h TTL can't leak into the normal
 *  short-TTL entry. */
function backupKeyFor(cacheKeyUrl: URL): Request {
  const u = new URL(cacheKeyUrl);
  u.searchParams.set('__backup', '1');
  return new Request(u.toString(), { method: 'GET' });
}

// Worker entry — routes /api/public/<entity>, Cache API wrap, D1 read session.
// =============================================================================
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Draft-preview passthrough (staging only) ──────────────────────────────
    // The ONLY route that bypasses the publish gate: returns published AND drafted
    // homes from v_preview_qmi. Gated by a secret header that ONLY the staging Worker
    // attaches; env.PREVIEW_SECRET is UNSET on prod, so an unset secret (or any
    // mismatch) 404s and drafts can never leak publicly. Never cached (no-store) so a
    // just-edited draft previews immediately.
    if (request.method === 'GET' && url.pathname === '/api/preview/qmi') {
      if (!previewAuthorized(env.PREVIEW_SECRET, request.headers.get('X-Esperanza-Preview'))) {
        return new Response('Not found', { status: 404, headers: cors });
      }
      try {
        const session = env.DB.withSession('first-unconstrained');
        const payload = await buildPayload('qmi', session, { preview: true });
        const out = new Response(JSON.stringify(payload), { status: 200 });
        out.headers.set('Content-Type', 'application/json');
        out.headers.set('Cache-Control', 'no-store');
        for (const [k, v] of cors) out.headers.set(k, v);
        return out;
      } catch (err) {
        Sentry.captureException(err);
        const detail = err instanceof Error ? err.message : String(err);
        const out = new Response(JSON.stringify({ error: 'upstream_failure', detail }), { status: 502 });
        out.headers.set('Content-Type', 'application/json');
        for (const [k, v] of cors) out.headers.set(k, v);
        return out;
      }
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

    // Purge is authenticated: only the admin/ingest Workers (which send X-Purge-Key
    // matching our PURGE_KEY secret) may cache-bust. An unauthenticated ?purge=1 is
    // IGNORED — the caller gets the normal cached response — so bots can't turn every
    // request into a D1 rebuild. Same constant-time gate as the preview route.
    const purgeAuthorized =
      wantsPurge && previewAuthorized(env.PURGE_KEY, request.headers.get('X-Purge-Key'));

    if (purgeAuthorized) {
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

    const inflightKey = cacheKeyUrl.toString();
    try {
      // Coalesce concurrent misses: the first request per isolate runs the build;
      // the rest await the same promise instead of piling onto D1.
      let build = inflight.get(inflightKey);
      if (!build) {
        build = (async () => {
          // Public read path: any replica is fine (eventually consistent). The admin
          // path MUST NOT use this — it uses first-primary / a stored bookmark.
          const session = env.DB.withSession('first-unconstrained');
          const payload = await buildPayload(entity, session);
          return JSON.stringify(payload);
        })();
        inflight.set(inflightKey, build);
        build.finally(() => inflight.delete(inflightKey)).catch(() => {});
      }
      const body = await build;

      // Store in cache WITH the edge Cache-Control (this header lives on the cached
      // copy only). max-age == s-maxage == ttl, matching the legacy workers.
      const cacheControl = `public, max-age=${ttl}, s-maxage=${ttl}`;
      const toCache = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
      });
      ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
      // Also refresh the 24h last-good backup used to serve stale on build failure.
      const toBackup = new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400, s-maxage=86400' },
      });
      ctx.waitUntil(cache.put(backupKeyFor(cacheKeyUrl), toBackup));

      // Client response: NO Cache-Control, X-Cache: MISS, CORS reflected.
      const out = new Response(body, { status: 200 });
      out.headers.set('Content-Type', 'application/json');
      out.headers.set('X-Cache', 'MISS');
      for (const [k, v] of cors) out.headers.set(k, v);
      return out;
    } catch (err) {
      // The handler swallows upstream/D1 failures into a 502, so Sentry's automatic
      // uncaught-error capture never sees them — report explicitly. No-op if disabled.
      Sentry.captureException(err);

      // Serve the last-good copy (≤24h old) rather than failing the page: a stale
      // listing beats a 502 + browser retry storm while D1 is already struggling.
      try {
        const stale = await cache.match(backupKeyFor(cacheKeyUrl));
        if (stale) {
          const out = new Response(stale.body, stale);
          out.headers.delete('Cache-Control');
          for (const [k, v] of cors) out.headers.set(k, v);
          out.headers.set('X-Cache', 'STALE');
          return out;
        }
      } catch {
        // fall through to 502
      }

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

// Wrap the handler so unhandled errors (and 502 upstream failures thrown below) are
// reported to Sentry. `enabled: false` when SENTRY_DSN is unset -> a clean no-op for
// local/dev/test. Errors-only for now (no tracing); flip tracesSampleRate up later for
// performance/latency visibility on the public read path.
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    tracesSampleRate: 0,
    sendDefaultPii: false,
  }),
  apiHandler,
);
