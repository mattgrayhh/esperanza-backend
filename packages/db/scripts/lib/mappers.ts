// =============================================================================
// esperanza-cf — Airtable raw record -> bucketed D1 column row mappers.
//
// One mapper per entity. Each returns a flat { <d1_column>: value } object whose
// keys are PHYSICAL column names (snake_case) ready for buildUpsert(). Buckets:
//
//   QMI Snowflake write-set  -> synced_<col>  (override_<col> stays NULL at import
//                               by design, EXCEPT override_price which is seeded
//                               ONLY where Price != last_synced_price).
//   communities.square_footage_range -> the one synced community field.
//   cities counts            -> synced (recomputed live; imported as-is).
//   floor_plans.synced_image_url -> external-synced (Exterior Renderings attach).
//   everything else          -> plain admin-owned columns.
//
// Links (QMI->FP/Community/City, Testimonial->FP/Community, Community->City)
// resolve via Airtable LINKED-RECORD ID fields: firstLinkId(fields['... (Link)']).
// Unresolved (the linked id is absent from the imported set) is logged by the
// caller — the mapper just records the raw linked id (or null).
//
// Image fields hold RAW attachment arrays / urls at this stage. migrate-images.ts
// rewrites attachment / signed urls to stable R2 urls BEFORE the row is persisted;
// the importer also runs a hard guard so no airtableusercontent url is ever
// written. Permanent url-typed fields (image_url, og_image_url, page_url) pass
// through unchanged.
// =============================================================================

import type { AirtableRecord } from './airtable.js';
import {
  num,
  int,
  boolInt,
  str,
  firstLinkId,
  linkCsv,
  jsonArray,
  firstAttachmentUrl,
  attachments,
} from './coerce.js';

type Row = Record<string, unknown>;
const f = (r: AirtableRecord) => r.fields;

// ── QMI ──────────────────────────────────────────────────────────────────────
// Returns the row PLUS the raw linked ids so the caller can validate resolution.
export interface QmiMapResult {
  row: Row;
  links: { city: string | null; community: string | null; floorPlan: string | null };
  /** raw Price / last_synced_price for the override seeding rule. */
  price: number | null;
  lastSyncedPrice: number | null;
}

export function mapQmi(r: AirtableRecord): QmiMapResult {
  const x = f(r);
  const price = num(x['Price']);
  const lastSyncedPrice = num(x['last_synced_price']);
  // Override-price seeding: the human edited Price iff it diverges from the
  // last value the data-sync wrote. Seed override_price ONLY in that case.
  const diverged =
    price !== null && lastSyncedPrice !== null && Math.abs(price - lastSyncedPrice) >= 0.01;

  const cityId = firstLinkId(x['City (Link)']);
  const communityId = firstLinkId(x['Community (Link)']);
  const floorPlanId = firstLinkId(x['Floor Plan (Link)']);

  const row: Row = {
    id: r.id,

    // ── Snowflake write-set -> synced_* (override_* NULL by design) ──────────
    synced_address: str(x['address']),
    synced_postal_code: int(x['postal_code']),
    synced_bedroom_count: int(x['bedroom_count']),
    synced_bathroom_count: num(x['bathroom_count']),
    synced_half_bathroom_count: int(x['half_bathroom_count']),
    synced_living_square_footage: int(x['living_square_footage']),
    synced_total_square_footage: int(x['total_square_footage']),
    synced_elevation: str(x['elevation']),
    synced_construction_stage: str(x['construction_stage']),
    synced_city_id: cityId,
    synced_city_name: str(x['City']),
    synced_community_id: communityId,
    synced_community_name: str(x['Community']),
    synced_floor_plan_id: floorPlanId,
    synced_floor_plan_name: str(x['Floor Plan']),

    // price: synced + last_synced anchor; override_price seeded ONLY when diverged.
    // Attribution for the seeded override lives in audit_log (no per-col *_at/_by).
    synced_price: price, // current Price column = the synced source-of-truth at import
    last_synced_price: lastSyncedPrice,
    override_price: diverged ? price : null,

    // ── ingest identity / join keys ──────────────────────────────────────────
    eci_key: str(x['eci_key']),
    mark_job_number: str(x['mark_job_number']),
    housenumber: str(x['housenumber']),

    // ── publish gate (checkbox 1/0) ───────────────────────────────────────────
    published: boolInt(x['Published']),

    // ── slugs / SEO ────────────────────────────────────────────────────────────
    slug: str(x['slug']),
    seo_slug: str(x['seo_slug']),
    rich_slug: str(x['rich_slug']),
    viewer_slug: str(x['viewer slug']), // KEY has a space

    // ── geo ──────────────────────────────────────────────────────────────────
    latitude: num(x['latitude']),
    longitude: num(x['longitude']),
    geo_latitude: num(x['geo_latitude']),
    geo_longitude: num(x['geo_longitude']),

    // ── marketing collection / pricing display ─────────────────────────────────
    collection: str(x['Collection']),
    estimated_monthly_price: num(x['estimated_monthly_price']),
    estimated_monthly_payment: num(x['Estimated Monthly Payment']),
    monthly_energy_cost: num(x['monthly_energy_cost']),

    // ── attribute fallbacks ─────────────────────────────────────────────────────
    car_garage_count: int(x['car_garage_count']),
    stories_count: int(x['stories_count']),
    stories: int(x['stories']),

    // ── checkbox booleans ──────────────────────────────────────────────────────
    available_now: boolInt(x['Available Now']),
    self_tour_available: boolInt(x['Self Tour Available?']),
    include_in_xml_feed: boolInt(x['Include in XML Feed?']),

    // ── STABLE url-typed fields (permanent — pass through) ─────────────────────
    image_url: str(x['image_url']),
    og_image_url: str(x['og_image_url']),
    page_url: str(x['page_url']),
    dynamic_pdf: str(x['Dynamic PDF']),

    // ── attachment galleries — {url,filename}-only arrays (migrate-images rewrites
    //    item.url to R2). NEVER store the full attachment object: its nested
    //    thumbnails.{small,large,full}.url are signed airtableusercontent urls the
    //    migrator does NOT rewrite, so the guard would null the whole column. ──
    featured_image: jsonArray(
      attachments(x['Featured Image']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    image_2: jsonArray(attachments(x['Image 2']).map((a) => ({ url: a.url, filename: a.filename }))),
    image_3: jsonArray(attachments(x['Image 3']).map((a) => ({ url: a.url, filename: a.filename }))),
    image_4: jsonArray(attachments(x['Image 4']).map((a) => ({ url: a.url, filename: a.filename }))),
    image_5: jsonArray(attachments(x['Image 5']).map((a) => ({ url: a.url, filename: a.filename }))),

    // ── copy / misc ────────────────────────────────────────────────────────────
    description: str(x['Description']),
    upgrades: str(x['Upgrades']),
    incentive: str(x['Incentive']),
    virtual_tour_url: str(x['Virtual Tour URL']),
    synced_elevation_type: str(x['Elevation Type']),
    mls_id: str(x['MLS ID']),
    mls_number: str(x['mls_number']),
    synced_lot_number: str(x['Lot Number']),
    year_built: int(x['Year Built']),
    lot_size_sqft: int(x['Lot Size (sqft)']),
    synced_move_in_date: str(x['Move-In Date']),
    hers_score: int(x['hers_score']),
    arm_rate: str(x['ARM Rate']),
    promo_text: str(x['promo_text']),
    availability_text: str(x['availability_text']),
    nter_now: str(x['Nter Now']),
    cities: str(x['Cities']),

    // ── formula mirrors ─────────────────────────────────────────────────────────
    posted: str(x['Posted']),
    publish_date: str(x['Publish Date']),
    last_modified_time: str(x['Last Modified Time']),

    // ── FP:* lookups NO LONGER stored on qmi (D1 100-col limit) ─────────────────
    // They are resolved at read time in v_public_qmi via a LEFT JOIN to the linked
    // floor plan (floor_plans source columns + floor_plans.fp_image /
    // fp_additional_images). The floor plan link itself is carried in
    // synced_floor_plan_id above; mapFloorPlan() imports the source fields.
  };

  return {
    row,
    links: { city: cityId, community: communityId, floorPlan: floorPlanId },
    price,
    lastSyncedPrice,
  };
}

// ── COMMUNITIES ──────────────────────────────────────────────────────────────
function townCoalesce(x: Record<string, unknown>): string | null {
  return str(x['Town (TXT)']) ?? str(x['Town']) ?? null;
}

function hoaLinksJson(x: Record<string, unknown>): string | null {
  const pairs: { title: string | null; link: string | null }[] = [];
  for (let i = 1; i <= 7; i++) {
    const title = str(x[`HOA Link Title ${i}`]);
    const link = str(x[`HOA Link ${i}`]);
    if (title || link) pairs.push({ title, link });
  }
  return pairs.length ? JSON.stringify(pairs) : null;
}

export function mapCommunity(r: AirtableRecord): { row: Row; cityId: string | null } {
  const x = f(r);
  const coords = str(x['Get Directions (Map Coordinates)']);
  let lat: number | null = null;
  let lng: number | null = null;
  if (coords) {
    const m = coords.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      lat = num(m[1]);
      lng = num(m[2]);
    }
  }
  const cityId = firstLinkId(x['City']);

  const row: Row = {
    id: r.id,
    // the ONLY synced community field
    synced_square_footage_range: str(x['Square Footage']),

    name: str(x['Name']),
    slug: str(x['Slug']),
    town: townCoalesce(x),
    published: boolInt(x['Published']),
    draft: boolInt(x['Draft']),
    address: str(x['Address']),
    map_coordinates: coords,
    latitude: lat,
    longitude: lng,
    lat_long: str(x['Lat,Long']),
    master_planned: boolInt(x['Master Planned Community?']),
    coming_soon: boolInt(x['Coming Soon']),

    synced_price_from: num(x['Price Rng']),
    synced_bed_count: str(x['Bed Count']),
    synced_bath_count: str(x['Bath Count']),

    description: str(x['Copy Content']),
    amenities: str(x['Amenities']),
    education_rich: str(x['Education']),
    design_copy_rich: str(x['Design - Copy']),
    exterior_construction_copy_rich: str(x['Exterior Construction - Copy']),
    interior_construction_copy_rich: str(x['Interior Construction - Copy']),
    conservation_landscape_copy_rich: str(x['Conservation Landscape - Copy']),
    energy_package_copy_rich: str(x['Energy Package - Copy']),
    kitchen_features_copy_rich: str(x['Kitchen Features - Copy']),
    bath_features_copy_rich: str(x['Bath Features - Copy']),
    esperanza_difference_copy_rich: str(x['Esperanza Difference - Copy']),
    gas_details_rich: str(x['Gas Details']),
    internet_details: str(x['Internet Details']),
    water_details: str(x['Water Details']),
    electric_details_rich: str(x['Electric Details']),
    security_details: str(x['Security Details']),
    directions: str(x['Directions']),

    // image urls — attachment-first then text fallback (migrate-images rewrites attach urls)
    featured_image_url: firstAttachmentUrl(x['Featured Image (Attachment)']) ?? str(x['Featured Image']),
    featured_image_alt: str(x['Featured Image:alt']),
    secondary_image_url: firstAttachmentUrl(x['Secondary Image (Attachment)']) ?? str(x['Secondary Image']),
    secondary_image_alt: str(x['Secondary Image:alt']),
    photo_gallery_image_url:
      firstAttachmentUrl(x['Photo Gallery Image (Attachment)']) ?? str(x['Photo Gallery Image']),
    photo_gallery_image_alt: str(x['Photo Gallery Image:alt']),
    description_image_url: firstAttachmentUrl(x['Description Image']) ?? str(x['Description Image']),
    community_logo_url: firstAttachmentUrl(x['Community Logo (Attachment)']) ?? str(x['Community Logo']),
    community_logo_alt: str(x['Community Logo:alt']),
    features_download_url:
      firstAttachmentUrl(x['Features Download (Attachment)']) ?? str(x['Features Download']),
    resources_download_url:
      firstAttachmentUrl(x['Resources Download (Attachment)']) ?? str(x['Resources Download']),
    featured_video: str(x['Featured Video']),

    office_phone: str(x['Office Phone Number']),
    office_hours: str(x['Office Hours']),
    schedule_visit: str(x['Schedule Visit']),
    lending: str(x['Lending']),
    mine_link: str(x['Mine Link']),
    community_map_embed: str(x['Community Map Embed']),
    incentive: str(x['Incentive']),
    floor_plan_plaintext: str(x['Floor Plan Plaintext']),

    hoa_links_json: hoaLinksJson(x),
    city_id: cityId,
  };
  return { row, cityId };
}

// ── CITIES ─────────────────────────────────────────────────────────────────────
function cityCopyBlocksJson(x: Record<string, unknown>): string | null {
  const blocks: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== null && v !== undefined && v !== '') blocks[k] = v;
  };
  set('homes_heading', str(x['Homes Heading']));
  set('homes_description', str(x['Homes Description']));
  set('live_in_heading', str(x['Live In Heading']));
  set('live_in_description', str(x['Live In Description']));
  set('live_in_image', firstAttachmentUrl(x['Live In Image (Attachment)']) ?? str(x['Live In Image']));
  set('image_0', firstAttachmentUrl(x['Image 0 (Attachment)']) ?? str(x['Image 0']));
  for (const s of ['1', '1a', '2', '3']) {
    set(`section_${s}_title`, str(x[`Section ${s} Title`]));
    set(`section_${s}_description`, str(x[`Section ${s} Description`]));
    set(
      `section_${s}_image`,
      firstAttachmentUrl(x[`Section ${s} Image (Attachment)`]) ?? str(x[`Section ${s} Image`])
    );
  }
  for (const p of ['1', '2', '3', '4']) {
    set(`pillar_${p}_title`, str(x[`Pillar ${p} Title`]));
    set(`pillar_${p}_description`, str(x[`Pillar ${p} Description`]));
  }
  return Object.keys(blocks).length ? JSON.stringify(blocks) : null;
}

function cityVenueBlocksJson(x: Record<string, unknown>): string | null {
  const blocks: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => {
    if (v !== null && v !== undefined && v !== '') blocks[k] = v;
  };
  for (const v of ['Eat', 'Shop', 'Play', 'Relax', 'Stay']) {
    const key = v.toLowerCase();
    set(`${key}_venues`, str(x[`${v} Venues`]));
    set(`${key}_image`, firstAttachmentUrl(x[`${v} Image (Attachment)`]) ?? str(x[`${v} Image`]));
  }
  return Object.keys(blocks).length ? JSON.stringify(blocks) : null;
}

export function mapCity(r: AirtableRecord): Row {
  const x = f(r);
  return {
    id: r.id,
    // synced pricing/availability counts (recomputed live; imported as-is)
    community_count: int(x['Community Count']),
    move_in_homes_count: int(x['Move-In Homes Count']),
    floor_plans_count: int(x['Floor Plans Count']),

    city_name: str(x['City Name']),
    slug: str(x['Slug']),
    state: str(x['State']),
    status: str(x['Status']),
    map_latitude: num(x['Map Latitude']),
    map_longitude: num(x['Map Longitude']),

    hero_image_url: firstAttachmentUrl(x['Hero Image (Attachment)']) ?? str(x['Hero Image']),
    hero_description: str(x['Hero Description']),
    national_recognition: str(x['National Recognition']),
    incentive: str(x['Incentive']),

    city_copy_blocks_json: cityCopyBlocksJson(x),
    city_venue_blocks_json: cityVenueBlocksJson(x),
  };
}

// ── FLOOR PLANS ─────────────────────────────────────────────────────────────────
export function mapFloorPlan(r: AirtableRecord): Row {
  const x = f(r);
  // Published is a formula NOT({Inactive?}) returning 1/0 — treat truthy as published.
  const publishedFormula = x['Published'];
  const published =
    publishedFormula === 1 || publishedFormula === true || publishedFormula === '1' ? 1 : 0;

  return {
    id: r.id,
    // external-synced: Exterior Renderings attachment array (migrate-images rewrites)
    synced_image_url: jsonArray(
      attachments(x['Exterior Renderings']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    force_replace_renderings: boolInt(x['Force Replace Renderings']),

    name: str(x['name']),
    slug: str(x['slug']),
    published,
    collection: str(x['collection'] ?? x['Collection']),
    synced_starting_price: num(x['starting_price']),
    // Live Airtable uses bedroom_count_minimum/maximum + bathroom_count_minimum/maximum
    // (the bedroom_min / 'Bedrooms (Min)' variants don't exist on this base). Keep the
    // legacy names first so a future schema rename still resolves.
    synced_bedroom_min: int(x['bedroom_min'] ?? x['bedroom_count_minimum'] ?? x['Bedrooms (Min)']),
    synced_bedroom_max: int(x['bedroom_max'] ?? x['bedroom_count_maximum'] ?? x['Bedrooms (Max)']),
    synced_bathroom_min: num(x['bathroom_min'] ?? x['bathroom_count_minimum'] ?? x['Bathrooms (Min)']),
    synced_bathroom_max: num(x['bathroom_max'] ?? x['bathroom_count_maximum'] ?? x['Bathrooms (Max)']),
    car_garage_count: int(x['car_garage_count'] ?? x['Garage']),
    stories_count: int(x['stories_count'] ?? x['Stories']),
    synced_living_square_footage: int(x['living_square_footage'] ?? x['Living SqFt']),
    synced_total_square_footage: int(x['total_square_footage'] ?? x['Total SqFt']),
    master_bed_location: str(x['master_bed_location'] ?? x['Master Bed Location']),
    hers_score: int(x['hers_score'] ?? x['HERS Score']),

    image_url: firstAttachmentUrl(x['image_url (Attachment)']) ?? str(x['image_url']),
    hero_image_2: firstAttachmentUrl(x['Hero Image 2']) ?? firstAttachmentUrl(x['hero_image_2 (Attachment)']) ?? str(x['hero_image_2']),
    hero_image_3: firstAttachmentUrl(x['Hero Image 3']) ?? firstAttachmentUrl(x['hero_image_3 (Attachment)']) ?? str(x['hero_image_3']),
    // FP:* image lookups: store the floor plan's own image attachment as a JSON
    // array of {url,filename}-ONLY elements so v_public_qmi can expose it as the
    // `FP: Image` [{...}] contract shape (migrate-images rewrites item.url to R2).
    // fp_image MUST stay a SINGLE-element array (slice(0,1)) to preserve the
    // [{...}] contract shape; fp_additional_images keeps the multi-element shape.
    //
    // CRITICAL: do NOT store the full Airtable attachment object here. Its nested
    // thumbnails.{small,large,full}.url are signed airtableusercontent urls that
    // resolveRowImages does NOT rewrite (it only touches item.url), so they would
    // survive migration and stripUnmigratedImages / the guard would null the whole
    // column — exactly the fp_image-NULL bug. {url,filename}-only mirrors every
    // sibling array column (synced_image_url, elevation_renderings, photo_gallery,
    // additional_images, …) which is why those never get flagged.
    fp_image: jsonArray(
      attachments(x['image_url (Attachment)'])
        .slice(0, 1)
        .map((a) => ({ url: a.url, filename: a.filename }))
    ),
    fp_additional_images: jsonArray(
      attachments(x['Additional Images (Attachment)']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    elevation_renderings: jsonArray(
      attachments(x['Elevation Renderings']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    elevation_gallery: jsonArray(
      attachments(x['Elevation Renderings']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    photo_gallery_urls: jsonArray(
      attachments(x['Photo Gallery (Attachment)']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    photo_gallery: jsonArray(
      attachments(x['Photo Gallery (Attachment)']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    additional_images: jsonArray(
      attachments(x['Additional Images (Attachment)']).map((a) => ({ url: a.url, filename: a.filename }))
    ),
    additional_images_gallery: jsonArray(
      attachments(x['Additional Images (Attachment)']).map((a) => ({ url: a.url, filename: a.filename }))
    ),

    description: str(x['description'] ?? x['Description']),
    plan_viewer_url: str(x['plan_viewer_url'] ?? x['Plan Viewer URL'] ?? x['Plan Viewer']),
    virtual_tour_url: str(x['virtual_tour_url'] ?? x['Virtual Tour URL'] ?? x['Virtual Tour']),
    incentive: str(x['incentive'] ?? x['Incentive']),
    brochure_pdf_url: firstAttachmentUrl(x['Brochure PDF (Attachment)']) ?? str(x['brochure_pdf_url'] ?? x['Brochure PDF URL']),
    brochure_pdf: firstAttachmentUrl(x['Brochure PDF (Attachment)']) ?? str(x['brochure_pdf'] ?? x['Brochure PDF URL']),

    // Live names are 'Energy Cost - Esperanza Monthly' (low) / 'Energy Cost - Pre-Owned
    // Monthly' (high) / 'Energy Cost Monthly Savings' (avg-slot). The framer-push contract
    // maps low→esperanza_monthly, high→preowned_monthly, avg→monthly_savings.
    energy_cost_low: num(x['energy_cost_low'] ?? x['Energy Cost - Esperanza Monthly']),
    energy_cost_high: num(x['energy_cost_high'] ?? x['Energy Cost - Pre-Owned Monthly']),
    energy_cost_avg: num(x['energy_cost_avg'] ?? x['Energy Cost Monthly Savings']),

    communities: str(x['Community Names']),
    community_count: int(x['Community Count']),
    quick_move_in_ids: linkCsv(x['Quick Move-Ins']),
    promotion_ids: linkCsv(x['Promotions']),
  };
}

// ── PROMOTIONS ──────────────────────────────────────────────────────────────────
export interface PromoMapResult {
  row: Row;
  /** raw linked-record id arrays — translated into promotion_targets by the caller. */
  communityIds: string[];
  floorPlanIds: string[];
  collectionIds: string[];
  appliesTo: string | null;
}

export function mapPromotion(r: AirtableRecord): PromoMapResult {
  const x = f(r);
  const row: Row = {
    id: r.id,
    title: str(x['Title']),
    banner_text: str(x['Banner Text']),
    badge_text: str(x['Card Badge Text']),
    copy: str(x['Copy']),
    cta_label: str(x['CTA Label']),
    cta_url: str(x['CTA Link']),
    image_url: firstAttachmentUrl(x['Image']), // RAW — migrate-images rewrites
    sort_order: int(x['Sort Order']) ?? 0,
    start_date: str(x['Start Date']) ?? null,
    end_date: str(x['Expiration Date']) ?? null,
    // `Active` field does not exist live; the only real gate is Published checkbox.
    active: boolInt(x['Published']),
    applies_to: str(x['Applies To']),
  };
  // collect raw linked ids for target translation
  const communityIds = (Array.isArray(x['Community']) ? x['Community'] : []).filter(
    (v): v is string => typeof v === 'string' && v.startsWith('rec')
  );
  const floorPlanIds = (Array.isArray(x['Floor Plan']) ? x['Floor Plan'] : []).filter(
    (v): v is string => typeof v === 'string' && v.startsWith('rec')
  );
  const collectionIds = (Array.isArray(x['Collection']) ? x['Collection'] : []).filter(
    (v): v is string => typeof v === 'string' && v.startsWith('rec')
  );
  return { row, communityIds, floorPlanIds, collectionIds, appliesTo: str(x['Applies To']) };
}

// ── COLLECTIONS ──────────────────────────────────────────────────────────────────
export function mapCollection(r: AirtableRecord): Row {
  const x = f(r);
  return {
    id: r.id,
    title: str(x['Title']),
    slug: str(x['Slug']),
    content: str(x['Content']),
    // live column is plain 'Header Image' (multipleAttachments) — resolve the url.
    header_image: firstAttachmentUrl(x['Header Image']) ?? str(x['Header Image']),
    header_image_alt: str(x['Header Image:alt']),
    starting_at: num(x['Starting At']),
    ending_at: num(x['Ending At']),
    incentive: str(x['Incentive']),
  };
}

// ── IMAGES ─────────────────────────────────────────────────────────────────────
export function mapImage(r: AirtableRecord): Row {
  const x = f(r);
  // live: 'File' is a url field; attachment column is 'Attachments'.
  const fileUrl = str(x['File']) ?? firstAttachmentUrl(x['Attachments']);
  return {
    id: r.id,
    slug: str(x['Slug']),
    plan_name: str(x['Plan_Name']),
    caption: str(x['Caption']),
    caption_clean: str(x['Caption (Clean)']),
    elevation_style: str(x['Elevation_Style']),
    elevation_material: str(x['Elevation_Material']),
    elevation_parsed: str(x['Elevation_Parsed']),
    file_url: fileUrl,
  };
}

// ── BLOGS ──────────────────────────────────────────────────────────────────────
export function mapBlog(r: AirtableRecord): Row {
  const x = f(r);
  return {
    id: r.id,
    title: str(x['Title']),
    slug: str(x['slug']),
    category: str(x['Category']),
    excerpt: str(x['Excerpt']),
    content: str(x['Content']),
    publish_date: str(x['publish_date']),
    featured_image: firstAttachmentUrl(x['Featured Image (Attachment)']) ?? str(x['Featured Image']),
    seo_description: str(x['SEO Description']),
    community_name: str(x['Communities']),
    // D1-owned gate; no dead 'Inactive?' field. Default published=1 (live mapper never hid).
    published: 1,
  };
}

// ── TESTIMONIALS ─────────────────────────────────────────────────────────────────
export function mapTestimonial(r: AirtableRecord): { row: Row; floorPlanId: string | null; communityId: string | null } {
  const x = f(r);
  const floorPlanId = firstLinkId(x['Floor Plan']);
  const communityId = firstLinkId(x['Community']);
  const row: Row = {
    id: r.id,
    person_name: str(x['Person Name']),
    slug: str(x['Slug']),
    date_posted: str(x['Date Posted']),
    testimonial_text: str(x['Testimonial Text']),
    move_in_year: str(x['Move In Year']),
    status: str(x['Status']),
    image_url: firstAttachmentUrl(x['Image']), // RAW — migrate-images rewrites
    floor_plan_id: floorPlanId,
    floor_plan_name: str(x['Floor Plan Name']),
    floor_plan_image: null, // resolved from linked FP image at read time (kept NULL at import)
    community_id: communityId,
    community_name: str(x['Community Name']),
    town: str(x['Town (from Community)']),
  };
  return { row, floorPlanId, communityId };
}
