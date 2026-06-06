// =============================================================================
// packages/admin — the CONFIG that drives the entire list/edit engine.
//
// One declarative table per entity describes:
//   - listColumns: which columns the generic list page renders (read from the base
//     table; the engine COALESCEs synced/override for QMI display).
//   - fields: the edit-form fields, each tagged with a `widget` (how to render) and a
//     `bucket` (how to WRITE — see the engine summary in the brief).
//
// Buckets (write behavior, enforced in lib/actions.ts):
//   synced   → render read-only; never in the UPDATE set.
//   override → syncedOverride widget; save via buildOverrideWrite/buildOverrideAudit
//              (QMI only; field === a QMI_OVERRIDABLE_FIELDS name).
//   admin    → plain column UPDATE + single audit_log {action:'update'}.
//   publish  → boolean/select gate; togglePublished is the only published=1 path.
//   target   → promoScopeTag; replace promotion_targets rows.
//   system   → read-only id/timestamps (not rendered as editable).
//
// Widgets map to a component in components/fields/*. `text|textarea|number|boolean|
// richtext|image|select` are generic; `syncedOverride|jsonBlocks|hoaLinks|
// promoScopeTag` are the custom widgets.
//
// This file is intentionally hand-curated (NOT derived from the schema) because the
// admin field design assigns labels, widgets, and buckets per the operator spec — the
// schema only knows columns/types. lib/fields.ts still validates writes against the
// real schema, so a typo here can't write a non-existent column.
// =============================================================================

import { QMI_OVERRIDABLE_FIELDS, type QmiOverridableField } from '@esperanza/db/override';
import type { EntityKey } from './entities';

export type Widget =
  | 'text'
  | 'textarea'
  | 'number'
  | 'currency'
  | 'boolean'
  | 'richtext'
  | 'image'
  | 'date'
  | 'select'
  | 'syncedOverride'
  | 'jsonBlocks'
  | 'hoaLinks'
  | 'promoScopeTag';

export type Bucket = 'synced' | 'override' | 'admin' | 'publish' | 'target' | 'system';

/** Which dynamic option set a `select` / `syncedOverride(select)` field draws from. */
export type SelectSource = 'floor_plans' | 'communities' | 'cities';

/** A {value,label} option for a builder-defined `select` field (field_definitions.options_json). */
export interface SelectOptionItem {
  value: string;
  label: string;
}

export interface FieldConfig {
  /** form field name === physical D1 column name (snake_case) for admin/synced/publish.
   *  For `override` it's the QmiOverridableField logical name (also the column root).
   *  For `target`/`jsonBlocks`/`hoaLinks` it's a synthetic key (handled by its widget). */
  field: string;
  label: string;
  widget: Widget;
  bucket: Bucket;
  /** number sub-type allows decimals (e.g. bathroom_count). */
  step?: 'any' | '1';
  /** select / syncedOverride(select): which entity to enumerate by id. */
  selectSource?: SelectSource;
  /** select(static): fixed option list (testimonials.status). */
  options?: string[];
  /** select(builder): {value,label} option list from field_definitions.options_json
   *  for a user-added select field. Distinct from `options` (legacy string[]) so the
   *  Phase-A parity contract for testimonials.status is unchanged. */
  optionItems?: SelectOptionItem[];
  /** Phase B: true when this field is NOT a physical column on the entity — its value
   *  lives in the row's `custom_fields` JSON blob (user-added via the Field Builder).
   *  Drives both the read (build-edit-view) and the write (saveEntity) custom-field path. */
  custom?: boolean;
  /** muted helper text under the input. */
  help?: string;
  /** [32] render at half width (one column of a two-up grid) — for short/number fields
   *  (bedrooms, baths, garage, stories, sqft, year, …) so the form is shorter. Full-width
   *  fields (textarea/richtext/long text) omit this and span both columns. */
  halfWidth?: boolean;
  /** the synced_<col> to display beside an override input (defaults to synced_<field>). */
  syncedColumn?: string;
  /** a related *_name column to show as the human label of a synced/override id. */
  displayColumn?: string;
  /** [21][5][6] Section grouping (from field_definitions.group_label): fields sharing a
   *  group render together in one section Card; ungrouped fields fall under "Details". */
  group?: string;
  /** Field Builder visibility: false hides the field from the edit FORM (field_definitions
   *  .visible_in_form). Defaults true. Lets operators remove fields (feedback [7]-[11]). */
  visibleInForm?: boolean;
}

export interface ListColumn {
  /** column key to read off the row (post-COALESCE alias for QMI effective fields). */
  field: string;
  label: string;
  /** render hint. 'publish' shows the published/active/status pill.
   *  [8] 'currency' formats as USD $000,000 (no decimals). */
  kind?: 'text' | 'number' | 'boolean' | 'publish' | 'currency';
}

export interface EntityFieldConfig {
  listColumns: ListColumn[];
  fields: FieldConfig[];
}

// QMI override fields are the single source of truth in override.ts; assert ours align.
const OF = new Set<QmiOverridableField>(QMI_OVERRIDABLE_FIELDS);
function of(field: QmiOverridableField): QmiOverridableField {
  if (!OF.has(field)) throw new Error(`Not a QMI override field: ${field}`);
  return field;
}

// =============================================================================
// 1. QMI
// =============================================================================
const qmi: EntityFieldConfig = {
  listColumns: [
    { field: 'address', label: 'Address' }, // effective COALESCE(override,synced)
    { field: 'synced_community_name', label: 'Community' },
    { field: 'synced_floor_plan_name', label: 'Floor Plan' },
    { field: 'price', label: 'Price', kind: 'currency' }, // effective
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'available_now', label: 'Available', kind: 'boolean' },
    { field: 'last_modified_time', label: 'Modified' },
  ],
  fields: [
    // ── publish ──
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    // coming-soon flag (migration 0005 wiring): on-site-but-not-yet-live state.
    { field: 'coming_soon', label: 'Coming Soon', widget: 'boolean', bucket: 'admin', halfWidth: true, visibleInForm: false }, // [P1] hidden from form — header Status control owns it

    // ── override (synced_/override_ pairs) ──
    {
      field: of('price'),
      label: 'Price',
      widget: 'syncedOverride',
      bucket: 'override',
      step: 'any',
      help: 'Falls back to synced_price. Blank = follow Snowflake.',
    },
    { field: of('address'), label: 'Address', widget: 'syncedOverride', bucket: 'override' },
    {
      field: of('postal_code'),
      label: 'Postal Code',
      widget: 'syncedOverride',
      bucket: 'override',
      step: '1',
      halfWidth: true,
    },
    {
      field: of('bedroom_count'),
      label: 'Bedrooms',
      widget: 'syncedOverride',
      bucket: 'override',
      step: '1',
      halfWidth: true,
    },
    {
      field: of('bathroom_count'),
      label: 'Bathrooms',
      widget: 'syncedOverride',
      bucket: 'override',
      step: 'any',
      halfWidth: true,
    },
    {
      field: of('half_bathroom_count'),
      label: 'Half Baths',
      widget: 'syncedOverride',
      bucket: 'override',
      step: '1',
      halfWidth: true,
    },
    {
      field: of('living_square_footage'),
      label: 'Living SqFt',
      widget: 'syncedOverride',
      bucket: 'override',
      step: '1',
      halfWidth: true,
    },
    {
      field: of('total_square_footage'),
      label: 'Total SqFt',
      widget: 'syncedOverride',
      bucket: 'override',
      step: '1',
      halfWidth: true,
    },
    { field: of('elevation'), label: 'Elevation', widget: 'syncedOverride', bucket: 'override', halfWidth: true },
    {
      field: of('construction_stage'),
      label: 'Construction Stage',
      widget: 'syncedOverride',
      bucket: 'override',
      help: 'Overridable per override.ts (QMI_OVERRIDABLE_FIELDS has 13 entries — confirm with operator).',
    },
    {
      field: of('floor_plan_id'),
      label: 'Floor Plan',
      widget: 'syncedOverride',
      bucket: 'override',
      selectSource: 'floor_plans',
      displayColumn: 'synced_floor_plan_name',
    },
    {
      field: of('community_id'),
      label: 'Community',
      widget: 'syncedOverride',
      bucket: 'override',
      selectSource: 'communities',
      displayColumn: 'synced_community_name',
    },
    {
      field: of('city_id'),
      label: 'City',
      widget: 'syncedOverride',
      bucket: 'override',
      selectSource: 'cities',
      displayColumn: 'synced_city_name',
    },

    // ── admin ──
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin' },
    { field: 'seo_slug', label: 'SEO Slug', widget: 'text', bucket: 'admin' },
    { field: 'rich_slug', label: 'Rich Slug', widget: 'text', bucket: 'admin' },
    { field: 'viewer_slug', label: 'Viewer Slug', widget: 'text', bucket: 'admin' },
    { field: 'collection', label: 'Collection', widget: 'text', bucket: 'admin' },
    { field: 'estimated_monthly_price', label: 'Est. Monthly Price', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'estimated_monthly_payment', label: 'Est. Monthly Payment', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'monthly_energy_cost', label: 'Monthly Energy Cost', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'car_garage_count', label: 'Car Garage', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'stories_count', label: 'Stories Count', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'stories', label: 'Stories', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'available_now', label: 'Available Now', widget: 'boolean', bucket: 'admin' },
    { field: 'self_tour_available', label: 'Self Tour Available', widget: 'boolean', bucket: 'admin' },
    { field: 'include_in_xml_feed', label: 'Include in XML Feed', widget: 'boolean', bucket: 'admin' },
    { field: 'image_url', label: 'Main Image', widget: 'image', bucket: 'admin' },
    { field: 'og_image_url', label: 'OG Image', widget: 'image', bucket: 'admin' },
    { field: 'page_url', label: 'Page URL', widget: 'text', bucket: 'admin' },
    { field: 'dynamic_pdf', label: 'Dynamic PDF', widget: 'text', bucket: 'admin' },
    { field: 'description', label: 'Description', widget: 'textarea', bucket: 'admin' },
    { field: 'upgrades', label: 'Upgrades', widget: 'textarea', bucket: 'admin' },
    { field: 'incentive', label: 'Incentive', widget: 'textarea', bucket: 'admin' },
    { field: 'virtual_tour_url', label: 'Virtual Tour URL', widget: 'text', bucket: 'admin' },
    { field: 'elevation_type', label: 'Elevation Type', widget: 'text', bucket: 'admin' },
    { field: 'mls_id', label: 'MLS ID', widget: 'text', bucket: 'admin' },
    { field: 'mls_number', label: 'MLS Number', widget: 'text', bucket: 'admin' },
    { field: 'lot_number', label: 'Lot Number', widget: 'text', bucket: 'admin' },
    { field: 'year_built', label: 'Year Built', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'lot_size_sqft', label: 'Lot Size SqFt', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'move_in_date', label: 'Move-In Date', widget: 'date', bucket: 'admin', halfWidth: true },
    { field: 'hers_score', label: 'HERS Score', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'arm_rate', label: 'ARM Rate', widget: 'text', bucket: 'admin' },
    { field: 'promo_text', label: 'Promo Text', widget: 'text', bucket: 'admin' },
    { field: 'availability_text', label: 'Availability Text', widget: 'text', bucket: 'admin' },
    { field: 'nter_now', label: 'Enter Now', widget: 'text', bucket: 'admin' },
    { field: 'cities', label: 'Cities', widget: 'text', bucket: 'admin' },
    { field: 'latitude', label: 'Latitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'geo_latitude', label: 'Geo Latitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'longitude', label: 'Longitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'geo_longitude', label: 'Geo Longitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
  ],
};

// =============================================================================
// 2. COMMUNITIES
// =============================================================================
const communities: EntityFieldConfig = {
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'town', label: 'Town' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'coming_soon', label: 'Coming Soon', kind: 'boolean' },
    { field: 'price_from', label: 'Price From', kind: 'currency' },
    { field: 'city_id', label: 'City' },
  ],
  fields: [
    { field: 'square_footage_range', label: 'Sq Ft Range (synced)', widget: 'text', bucket: 'synced', help: 'Read-only synced value.' },
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    // `draft` column removed in migration 0005 (published is the single gate).
    { field: 'name', label: 'Name', widget: 'text', bucket: 'admin' },
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin' },
    { field: 'town', label: 'Town', widget: 'text', bucket: 'admin' },
    { field: 'address', label: 'Address', widget: 'text', bucket: 'admin' },
    { field: 'city_id', label: 'City', widget: 'select', bucket: 'admin', selectSource: 'cities' },
    // [17] map_coordinates + [18] lat_long removed from the admin form (latitude/longitude
    // below remain the editable geo source; D1 columns + sync unchanged).
    { field: 'latitude', label: 'Latitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'longitude', label: 'Longitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'master_planned', label: 'Master Planned', widget: 'boolean', bucket: 'admin', halfWidth: true },
    { field: 'coming_soon', label: 'Coming Soon', widget: 'boolean', bucket: 'admin', halfWidth: true, visibleInForm: false }, // [P1] hidden from form — header Status control owns it
    { field: 'price_from', label: 'Price From', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'bed_count', label: 'Bed Count', widget: 'text', bucket: 'admin', halfWidth: true },
    { field: 'bath_count', label: 'Bath Count', widget: 'text', bucket: 'admin', halfWidth: true },
    { field: 'description', label: 'Description', widget: 'textarea', bucket: 'admin' },
    // richtext (markdown)
    { field: 'amenities', label: 'Amenities (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'education_rich', label: 'Education (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'design_copy_rich', label: 'Design Copy (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'exterior_construction_copy_rich', label: 'Exterior Construction (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'interior_construction_copy_rich', label: 'Interior Construction (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'conservation_landscape_copy_rich', label: 'Conservation/Landscape (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'energy_package_copy_rich', label: 'Energy Package (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'kitchen_features_copy_rich', label: 'Kitchen Features (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'bath_features_copy_rich', label: 'Bath Features (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'esperanza_difference_copy_rich', label: 'Esperanza Difference (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'gas_details_rich', label: 'Gas Details (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'electric_details_rich', label: 'Electric Details (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'internet_details', label: 'Internet Details', widget: 'textarea', bucket: 'admin' },
    { field: 'water_details', label: 'Water Details', widget: 'textarea', bucket: 'admin' },
    { field: 'security_details', label: 'Security Details', widget: 'textarea', bucket: 'admin' },
    { field: 'directions', label: 'Directions', widget: 'textarea', bucket: 'admin' },
    // images (R2)
    { field: 'featured_image_url', label: 'Featured Image', widget: 'image', bucket: 'admin' },
    { field: 'secondary_image_url', label: 'Secondary Image', widget: 'image', bucket: 'admin' },
    { field: 'photo_gallery_image_url', label: 'Photo Gallery Image', widget: 'image', bucket: 'admin' },
    { field: 'description_image_url', label: 'Description Image', widget: 'image', bucket: 'admin' },
    { field: 'community_logo_url', label: 'Community Logo', widget: 'image', bucket: 'admin' },
    { field: 'featured_image_alt', label: 'Featured Image Alt', widget: 'text', bucket: 'admin' },
    { field: 'secondary_image_alt', label: 'Secondary Image Alt', widget: 'text', bucket: 'admin' },
    { field: 'photo_gallery_image_alt', label: 'Photo Gallery Alt', widget: 'text', bucket: 'admin' },
    { field: 'community_logo_alt', label: 'Community Logo Alt', widget: 'text', bucket: 'admin' },
    { field: 'featured_video', label: 'Featured Video', widget: 'text', bucket: 'admin' },
    { field: 'community_map_embed', label: 'Map Embed', widget: 'textarea', bucket: 'admin' },
    { field: 'mine_link', label: 'Mine Link', widget: 'text', bucket: 'admin' },
    { field: 'features_download_url', label: 'Features Download (PDF)', widget: 'image', bucket: 'admin' },
    { field: 'resources_download_url', label: 'Resources Download (PDF)', widget: 'image', bucket: 'admin' },
    { field: 'office_phone', label: 'Office Phone', widget: 'text', bucket: 'admin' },
    { field: 'office_hours', label: 'Office Hours', widget: 'text', bucket: 'admin' },
    { field: 'schedule_visit', label: 'Schedule Visit', widget: 'text', bucket: 'admin' },
    { field: 'lending', label: 'Lending', widget: 'text', bucket: 'admin' },
    // [22] floor_plan_plaintext + [23] incentive removed from the admin form
    // (D1 columns + sync unchanged).
    // custom widget
    { field: 'hoa_links_json', label: 'HOA Links', widget: 'hoaLinks', bucket: 'admin', help: 'Array of {title, link}; framer pushes the first 7.' },
  ],
};

// =============================================================================
// 3. CITIES
// =============================================================================
const cities: EntityFieldConfig = {
  listColumns: [
    { field: 'city_name', label: 'City' },
    { field: 'state', label: 'State' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'coming_soon', label: 'Coming Soon', kind: 'boolean' },
    { field: 'community_count', label: 'Communities', kind: 'number' },
    { field: 'move_in_homes_count', label: 'Move-In Homes', kind: 'number' },
  ],
  fields: [
    // publish gate + coming-soon flag added in migration 0005 (gate-all standardization).
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    { field: 'coming_soon', label: 'Coming Soon', widget: 'boolean', bucket: 'admin', halfWidth: true, visibleInForm: false }, // [P1] hidden from form — header Status control owns it
    { field: 'community_count', label: 'Community Count (synced)', widget: 'number', bucket: 'synced', halfWidth: true },
    { field: 'move_in_homes_count', label: 'Move-In Homes (synced)', widget: 'number', bucket: 'synced', halfWidth: true },
    { field: 'floor_plans_count', label: 'Floor Plans Count (synced)', widget: 'number', bucket: 'synced', halfWidth: true },
    { field: 'city_name', label: 'City Name', widget: 'text', bucket: 'admin', halfWidth: true },
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin', halfWidth: true },
    { field: 'state', label: 'State', widget: 'text', bucket: 'admin', halfWidth: true },
    // `status` demoted to informational in migration 0005 (no longer a gate).
    { field: 'status', label: 'Status (informational)', widget: 'text', bucket: 'admin', halfWidth: true, visibleInForm: false }, // [P1] hidden from form — `published` is the gate
    { field: 'map_latitude', label: 'Map Latitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'map_longitude', label: 'Map Longitude', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'hero_image_url', label: 'Hero Image', widget: 'image', bucket: 'admin' },
    { field: 'hero_description', label: 'Hero Description', widget: 'textarea', bucket: 'admin' },
    { field: 'national_recognition', label: 'National Recognition', widget: 'text', bucket: 'admin' },
    { field: 'incentive', label: 'Incentive', widget: 'textarea', bucket: 'admin' },
    // custom widget (handled out-of-band via saveCityBlocks); both JSON blobs are one widget instance each.
    { field: 'city_copy_blocks_json', label: 'Copy Blocks', widget: 'jsonBlocks', bucket: 'admin' },
    { field: 'city_venue_blocks_json', label: 'Venue Blocks', widget: 'jsonBlocks', bucket: 'admin' },
  ],
};

// Known keys per framer-push cities mapper. Keys ending `_image` (or image_0 /
// live_in_image) are IMAGE-valued; everything else is STRING-valued.
export const CITY_COPY_BLOCK_KEYS = [
  'hero_description',
  'national_recognition',
  'homes_heading',
  'homes_description',
  'live_in_heading',
  'live_in_description',
  'live_in_image',
  'section_1_title',
  'section_1_description',
  'section_1_image',
  'section_1a_image',
  'image_0',
  'section_2_title',
  'section_2_description',
  'section_2_image',
  'section_3_title',
  'section_3_description',
  'section_3_image',
  'pillar_1_title',
  'pillar_2_title',
  'pillar_3_title',
  'pillar_4_title',
  'pillar_1_description',
  'pillar_2_description',
  'pillar_3_description',
  'pillar_4_description',
] as const;

/** FIXED 10 venue keys: 5 markdown + 5 image. */
export const CITY_VENUE_BLOCK_KEYS = [
  'eat_venues',
  'shop_venues',
  'play_venues',
  'relax_venues',
  'stay_venues',
  'eat_image',
  'shop_image',
  'play_image',
  'relax_image',
  'stay_image',
] as const;

/** True for copy/venue keys whose VALUE is an R2 image URL (vs a string). */
export function isImageBlockKey(key: string): boolean {
  return /_image$/.test(key) || key === 'image_0' || key === 'live_in_image';
}

// =============================================================================
// 4. FLOOR PLANS
// =============================================================================
const floor_plans: EntityFieldConfig = {
  listColumns: [
    { field: 'name', label: 'Name' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'collection', label: 'Collection' },
    { field: 'starting_price', label: 'Starting Price', kind: 'currency' },
    { field: 'bedroom_min', label: 'Bed Min', kind: 'number' },
    { field: 'bedroom_max', label: 'Bed Max', kind: 'number' },
  ],
  fields: [
    // [30] synced_image_url removed from the admin form — the DAM image_url is the
    // source of truth. (D1 column + sync unchanged; just hidden here.)
    { field: 'force_replace_renderings', label: 'Force Replace Renderings', widget: 'boolean', bucket: 'admin' },
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    // coming-soon flag (migration 0005 wiring): on-site-but-not-yet-live state.
    { field: 'coming_soon', label: 'Coming Soon', widget: 'boolean', bucket: 'admin', halfWidth: true, visibleInForm: false }, // [P1] hidden from form — header Status control owns it
    { field: 'name', label: 'Name', widget: 'text', bucket: 'admin' },
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin' },
    { field: 'collection', label: 'Collection', widget: 'text', bucket: 'admin' },
    { field: 'starting_price', label: 'Starting Price', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'bedroom_min', label: 'Bedroom Min', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'bedroom_max', label: 'Bedroom Max', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'bathroom_min', label: 'Bathroom Min', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'bathroom_max', label: 'Bathroom Max', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'car_garage_count', label: 'Car Garage', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'stories_count', label: 'Stories Count', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'living_square_footage', label: 'Living SqFt', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'total_square_footage', label: 'Total SqFt', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'hers_score', label: 'HERS Score', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'master_bed_location', label: 'Master Bed Location', widget: 'text', bucket: 'admin', halfWidth: true },
    { field: 'image_url', label: 'Main Image', widget: 'image', bucket: 'admin' },
    { field: 'hero_image_2', label: 'Hero Image 2', widget: 'image', bucket: 'admin' },
    { field: 'hero_image_3', label: 'Hero Image 3', widget: 'image', bucket: 'admin' },
    { field: 'description', label: 'Description (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'plan_viewer_url', label: 'Plan Viewer URL', widget: 'text', bucket: 'admin' },
    { field: 'virtual_tour_url', label: 'Virtual Tour URL', widget: 'text', bucket: 'admin' },
    { field: 'brochure_pdf_url', label: 'Brochure PDF', widget: 'text', bucket: 'admin' },
    { field: 'brochure_pdf', label: 'Brochure PDF (legacy)', widget: 'text', bucket: 'admin', visibleInForm: false }, // [P2] retired dup of brochure_pdf_url — hidden; column kept
    // [34] incentive removed from the admin form (D1 column + sync unchanged).
    { field: 'energy_cost_low', label: 'Energy Cost Low', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'energy_cost_high', label: 'Energy Cost High', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'energy_cost_avg', label: 'Energy Cost Avg', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
  ],
};

// =============================================================================
// 5. PROMOTIONS
// =============================================================================
const promotions: EntityFieldConfig = {
  listColumns: [
    { field: 'title', label: 'Title' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'sort_order', label: 'Sort', kind: 'number' },
    { field: 'start_date', label: 'Start' },
    { field: 'end_date', label: 'End' },
  ],
  fields: [
    // gate column renamed from `active` to `published` in migration 0005.
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish', help: 'The single gate; published=false → framer draft:true.' },
    { field: 'title', label: 'Title', widget: 'text', bucket: 'admin' },
    { field: 'banner_text', label: 'Banner Text', widget: 'text', bucket: 'admin' },
    { field: 'badge_text', label: 'Badge Text', widget: 'text', bucket: 'admin' },
    { field: 'cta_label', label: 'CTA Label', widget: 'text', bucket: 'admin' },
    { field: 'cta_url', label: 'CTA URL', widget: 'text', bucket: 'admin' },
    { field: 'copy', label: 'Copy', widget: 'textarea', bucket: 'admin' },
    { field: 'image_url', label: 'Image', widget: 'image', bucket: 'admin' },
    { field: 'sort_order', label: 'Sort Order', widget: 'number', bucket: 'admin', step: '1', halfWidth: true },
    { field: 'start_date', label: 'Start Date', widget: 'date', bucket: 'admin', halfWidth: true },
    { field: 'end_date', label: 'End Date', widget: 'date', bucket: 'admin', halfWidth: true },
    { field: 'applies_to', label: 'Applies-To Label (legacy)', widget: 'text', bucket: 'admin', help: 'Informational only; does NOT drive targeting.', visibleInForm: false }, // [P2] retired — targeting via Targeting Scope; hidden; column kept
    { field: 'promotion_targets', label: 'Targeting Scope', widget: 'promoScopeTag', bucket: 'target' },
  ],
};

// =============================================================================
// 6. COLLECTIONS
// =============================================================================
const collections: EntityFieldConfig = {
  listColumns: [
    { field: 'title', label: 'Title' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'slug', label: 'Slug' },
    { field: 'starting_at', label: 'Starting At', kind: 'currency' },
    { field: 'ending_at', label: 'Ending At', kind: 'currency' },
  ],
  fields: [
    // publish gate added in migration 0005 (gate-all standardization; backfilled =1).
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    { field: 'title', label: 'Title', widget: 'text', bucket: 'admin' },
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin' },
    { field: 'content', label: 'Content (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'header_image', label: 'Header Image', widget: 'image', bucket: 'admin' },
    { field: 'header_image_alt', label: 'Header Image Alt', widget: 'text', bucket: 'admin' },
    { field: 'starting_at', label: 'Starting At', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'ending_at', label: 'Ending At', widget: 'number', bucket: 'admin', step: 'any', halfWidth: true },
    { field: 'incentive', label: 'Incentive', widget: 'textarea', bucket: 'admin' },
  ],
};

// =============================================================================
// 7. IMAGES
// =============================================================================
const images: EntityFieldConfig = {
  listColumns: [
    { field: 'slug', label: 'Slug' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'plan_name', label: 'Plan' },
    { field: 'caption_clean', label: 'Caption' },
    { field: 'elevation_style', label: 'Elevation' },
  ],
  fields: [
    // publish gate added in migration 0005 (gate-all standardization; backfilled =1).
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin' },
    { field: 'plan_name', label: 'Plan Name', widget: 'text', bucket: 'admin' },
    { field: 'caption', label: 'Caption', widget: 'textarea', bucket: 'admin' },
    { field: 'caption_clean', label: 'Caption (clean)', widget: 'textarea', bucket: 'admin' },
    { field: 'elevation_style', label: 'Elevation Style', widget: 'text', bucket: 'admin' },
    { field: 'elevation_material', label: 'Elevation Material', widget: 'text', bucket: 'admin' },
    { field: 'elevation_parsed', label: 'Elevation Parsed', widget: 'text', bucket: 'admin' },
    { field: 'file_url', label: 'Image File', widget: 'image', bucket: 'admin' },
  ],
};

// =============================================================================
// 8. BLOGS
// =============================================================================
const blogs: EntityFieldConfig = {
  listColumns: [
    { field: 'title', label: 'Title' },
    { field: 'category', label: 'Category' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'publish_date', label: 'Publish Date' },
    { field: 'community_name', label: 'Community' },
  ],
  fields: [
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    { field: 'title', label: 'Title', widget: 'text', bucket: 'admin' },
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin' },
    { field: 'category', label: 'Category', widget: 'text', bucket: 'admin', halfWidth: true },
    { field: 'excerpt', label: 'Excerpt', widget: 'textarea', bucket: 'admin' },
    { field: 'content', label: 'Content (md)', widget: 'richtext', bucket: 'admin' },
    { field: 'publish_date', label: 'Publish Date', widget: 'date', bucket: 'admin', halfWidth: true },
    { field: 'featured_image', label: 'Featured Image', widget: 'image', bucket: 'admin' },
    { field: 'seo_description', label: 'SEO Description', widget: 'textarea', bucket: 'admin' },
    { field: 'community_name', label: 'Community Name', widget: 'text', bucket: 'admin' },
  ],
};

// =============================================================================
// 9. TESTIMONIALS
// =============================================================================
const testimonials: EntityFieldConfig = {
  listColumns: [
    { field: 'person_name', label: 'Person' },
    { field: 'published', label: 'Published', kind: 'publish' },
    { field: 'move_in_year', label: 'Move-In Year' },
    { field: 'community_name', label: 'Community' },
    { field: 'floor_plan_name', label: 'Floor Plan' },
  ],
  fields: [
    // publish gate added in migration 0005 (default 1; backfilled =0 where status='Draft').
    { field: 'published', label: 'Published', widget: 'boolean', bucket: 'publish' },
    // `status` demoted to informational in migration 0005 (no longer the gate); kept as a
    // free-pick label so legacy 'Live'/'Draft' values remain visible/editable.
    { field: 'status', label: 'Status (informational)', widget: 'select', bucket: 'admin', options: ['', 'Live', 'Draft'], help: 'Informational label only; `published` is the gate.', visibleInForm: false }, // [P1] hidden from form — `published` is the gate
    { field: 'person_name', label: 'Person Name', widget: 'text', bucket: 'admin' },
    { field: 'slug', label: 'Slug', widget: 'text', bucket: 'admin' },
    { field: 'date_posted', label: 'Date Posted', widget: 'date', bucket: 'admin', halfWidth: true },
    { field: 'move_in_year', label: 'Move-In Year', widget: 'text', bucket: 'admin', halfWidth: true },
    { field: 'testimonial_text', label: 'Testimonial', widget: 'textarea', bucket: 'admin' },
    { field: 'image_url', label: 'Photo', widget: 'image', bucket: 'admin' },
    { field: 'floor_plan_id', label: 'Floor Plan', widget: 'select', bucket: 'admin', selectSource: 'floor_plans' },
    { field: 'floor_plan_name', label: 'Floor Plan Name', widget: 'text', bucket: 'admin' },
    { field: 'community_id', label: 'Community', widget: 'select', bucket: 'admin', selectSource: 'communities' },
    { field: 'community_name', label: 'Community Name', widget: 'text', bucket: 'admin' },
    { field: 'town', label: 'Town', widget: 'text', bucket: 'admin' },
  ],
};

// =============================================================================
// Registry
// =============================================================================
export const FIELD_CONFIG: Record<EntityKey, EntityFieldConfig> = {
  qmi,
  communities,
  cities,
  floor_plans,
  promotions,
  collections,
  images,
  blogs,
  testimonials,
};

export function fieldConfigFor(key: EntityKey): EntityFieldConfig {
  return FIELD_CONFIG[key];
}

/** The publish-gate column for an entity (drives the publish indicator + toggle).
 *  Migration 0005 standardized EVERY public entity onto a single `published` gate
 *  (promotions.active was renamed; cities/collections/images gained `published`;
 *  testimonials.status was demoted to informational with a new `published` gate). */
export function publishGateColumn(key: EntityKey): string | null {
  switch (key) {
    case 'qmi':
    case 'communities':
    case 'floor_plans':
    case 'blogs':
    case 'promotions':
    case 'testimonials':
    case 'cities':
    case 'collections':
    case 'images':
      return 'published';
    default:
      return null;
  }
}
