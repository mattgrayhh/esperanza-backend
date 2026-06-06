// =============================================================================
// packages/admin — server-side builder for the BESPOKE QMI detail page.
//
// The generic engine reads through v_public_qmi (published=1 only). The QMI admin
// detail must show BOTH published and DRAFT homes (published=0, often a freshly-
// arrived Snowflake draft with floor_plan_id = NULL). So this reads the BASE `qmi`
// table by id on the PRIMARY session (getReadDb → read-your-writes) and resolves the
// floor-plan / community / city by COALESCE(override_*_id, synced_*_id) exactly like
// v_public_qmi does — but WITHOUT the publish gate, so drafts are visible.
//
// Effective values mirror the view's COALESCE(override, synced) via effectiveValue().
// fp_* attributes (beds/baths/sqft/images/description/base-price) are pulled from the
// LINKED floor plan — this is the "80-90% auto-fill" the operator gets the moment a
// draft is assigned a floor plan.
//
// Output is plain JSON only (no Drizzle rows / Date objects), safe to hand from the
// RSC to the client QmiDetail shell. NO writes happen here — every mutation still
// routes through the existing server actions in lib/actions.ts.
// =============================================================================

import { eq, inArray } from 'drizzle-orm';
import { getReadDb } from './db';
import { qmi, floorPlans, communities, cities, promotions, promotionTargets } from '@esperanza/db';
import { effectiveValue } from '@esperanza/db/override';
import { loadOptions, type SelectOption } from './select-options';
import { deriveStatus } from './status';

type Row = Record<string, unknown>;

/**
 * Drizzle's bare `select()` keys rows by the schema PROPERTY name (camelCase, e.g.
 * `syncedFloorPlanId`, `fpImage`), but this builder reads PHYSICAL snake_case columns
 * (`synced_floor_plan_id`, `fp_image`). Without this, every snake_case read is undefined —
 * the detail treats assigned homes as unassigned and the gallery comes up empty
 * (feedback [15][16]). Add snake_case aliases alongside the camelCase keys.
 */
function snakeRow(row: Row): Row {
  const out: Row = { ...row };
  for (const [k, v] of Object.entries(row)) {
    const snake = k.replace(/[A-Z0-9]+/g, (m) => `_${m.toLowerCase()}`);
    if (snake !== k && !(snake in out)) out[snake] = v;
  }
  return out;
}

function s(v: unknown): string {
  return v == null ? '' : String(v);
}
function n(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export interface GalleryImage {
  url: string;
  alt: string;
}

/** Parse an attachment-JSON column (array of {url,...}) or a bare url string. */
function parseImages(raw: unknown, alt: string): GalleryImage[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const txt = raw.trim();
  // bare url (not JSON)
  if (!txt.startsWith('[') && !txt.startsWith('{')) {
    return txt.startsWith('http') ? [{ url: txt, alt }] : [];
  }
  try {
    const parsed = JSON.parse(txt);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const out: GalleryImage[] = [];
    for (const item of arr) {
      if (typeof item === 'string') {
        if (item.startsWith('http')) out.push({ url: item, alt });
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const url = s(o.url || o.URL || o.src);
        if (url) out.push({ url, alt: s(o.alt) || alt });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface QmiDetailView {
  id: string;
  /** publish gate state. */
  published: boolean;
  /** coming-soon flag (migration 0005). published + coming_soon → "Coming Soon" on site. */
  comingSoon: boolean;
  /** derived tri-state publish status: 'Draft' | 'Coming Soon' | 'Live' (lib/status). */
  status: string;
  availableNow: boolean;

  /** ecommerce-SKU technical ids (copyable). */
  housenumber: string;
  eciKey: string;
  markJobNumber: string;

  /** effective (COALESCE override/synced) display values. */
  address: string;
  price: number | null;
  /** base (plan from-price) — the floor-plan starting_price. */
  fpStartingPrice: number | null;
  bedroomCount: number | null;
  bathroomCount: number | null;
  totalSquareFootage: number | null;
  livingSquareFootage: number | null;
  elevation: string;

  /** per-field override indicators (true ⇒ admin has pinned a value). */
  hasPriceOverride: boolean;

  /** resolved human names (joined). */
  communityName: string;
  cityName: string;
  floorPlanName: string;

  /** the assigned floor-plan id (effective) — NULL/'' ⇒ UNASSIGNED DRAFT. */
  floorPlanId: string;
  /** true ⇒ no floor plan assigned yet (lead with the Assign select). */
  isUnassigned: boolean;

  /** description: home-specific (admin) text falls back to the floor-plan copy. */
  description: string;
  descriptionFromFloorPlan: boolean;

  slug: string;
  moveInDate: string;

  gallery: GalleryImage[];

  /** synced/override field view models (Snowflake-fed, edited via SyncedOverrideField). */
  syncedOverride: {
    price: SyncedOverrideView;
    address: SyncedOverrideView;
    bedroomCount: SyncedOverrideView;
    bathroomCount: SyncedOverrideView;
    totalSquareFootage: SyncedOverrideView;
    elevation: SyncedOverrideView;
    // 0007 Snowflake sync expansion
    lotNumber: SyncedOverrideView;
    elevationType: SyncedOverrideView;
    materialType: SyncedOverrideView;
    isModelHome: SyncedOverrideView;
  };

  /** relationship override selects (floor plan / community / city) — synced display is
   *  the human NAME; saving routes the *_id through buildOverrideWrite. */
  relations: {
    floorPlan: SyncedOverrideView;
    community: SyncedOverrideView;
    city: SyncedOverrideView;
  };

  /** home-specific marketing fields (admin, edited directly). */
  admin: {
    incentive: string;
    promoText: string;
    availabilityText: string;
    virtualTourUrl: string;
    moveInDate: string;
    selfTourAvailable: boolean;
    availableNow: boolean;
  };

  options: {
    floorPlans: SelectOption[];
    communities: SelectOption[];
    cities: SelectOption[];
  };

  /**
   * Promotions currently targeting this QMI (read-only). Targeting is OWNED by the
   * promotion (savePromotionTargets writes promotion_targets keyed by promotionId, NOT
   * qmiId), so the QMI page can only DISPLAY membership and link out to each promo's
   * editor (where PromoScopeTagPicker lives). This avoids inventing a non-existent
   * "save QMI promotions" action — every write stays on the documented path.
   */
  promotions: Array<{ id: string; title: string; global: boolean }>;
}

/** One synced/override field's render inputs (mirrors build-edit-view's syncedOverride). */
export interface SyncedOverrideView {
  /** logical override field name === FormData name routed through buildOverrideWrite. */
  field: string;
  label: string;
  variant: 'text' | 'number' | 'select';
  step?: 'any' | '1';
  /** synced value as a display string (the "Snowflake: X" helper). For selects this is
   *  the human NAME (displayColumn), not the id. */
  syncedDisplay: string;
  /** current override value ('' ⇒ follows synced). */
  overrideValue: string;
  /** select options when variant === 'select'. */
  options?: SelectOption[];
  help?: string;
}

/**
 * Build the full QMI detail view model for one id. Reads the BASE qmi row (drafts
 * included) on the primary session, resolves the linked floor plan / community / city,
 * and loads the option lists for the assignment / override selects. Returns null if the
 * row doesn't exist.
 */
export async function buildQmiDetailView(id: string): Promise<QmiDetailView | null> {
  const db = getReadDb();

  const rows = (await db.select().from(qmi).where(eq(qmi.id, id)).limit(1)) as Row[];
  if (rows.length === 0) return null;
  const r = snakeRow(rows[0]!);

  // Effective (COALESCE override/synced) ids for the joins — exactly like v_public_qmi.
  const effFloorPlanId = s(effectiveValue(r.synced_floor_plan_id, r.override_floor_plan_id));
  const effCommunityId = s(effectiveValue(r.synced_community_id, r.override_community_id));
  const effCityId = s(effectiveValue(r.synced_city_id, r.override_city_id));

  // Resolve the linked floor plan (for fp_* auto-fill + base price + images).
  let fp: Row | null = null;
  if (effFloorPlanId) {
    const fpRows = (await db
      .select()
      .from(floorPlans)
      .where(eq(floorPlans.id, effFloorPlanId))
      .limit(1)) as Row[];
    fp = fpRows[0] ? snakeRow(fpRows[0]) : null;
  }

  // Resolve community / city NAMES — prefer the joined table, fall back to the synced
  // name mirror columns on qmi (synced_community_name / synced_floor_plan_name).
  let communityName = s(r.synced_community_name);
  if (effCommunityId) {
    const cRows = (await db
      .select({ name: communities.name })
      .from(communities)
      .where(eq(communities.id, effCommunityId))
      .limit(1)) as Array<{ name: string | null }>;
    if (cRows[0]?.name) communityName = cRows[0].name;
  }
  let cityName = s(r.synced_city_name);
  if (effCityId) {
    const cityRows = (await db
      .select({ name: cities.cityName })
      .from(cities)
      .where(eq(cities.id, effCityId))
      .limit(1)) as Array<{ name: string | null }>;
    if (cityRows[0]?.name) cityName = cityRows[0].name;
  }
  const floorPlanName = fp?.name != null && s(fp.name) !== '' ? s(fp.name) : s(r.synced_floor_plan_name);

  // Effective scalar attributes (COALESCE override/synced), then fall back to the
  // floor-plan source when the QMI has none (the auto-fill).
  const effBeds = effectiveValue(r.synced_bedroom_count, r.override_bedroom_count);
  const effBaths = effectiveValue(r.synced_bathroom_count, r.override_bathroom_count);
  const effTotalSqft = effectiveValue(r.synced_total_square_footage, r.override_total_square_footage);
  const effLivingSqft = effectiveValue(r.synced_living_square_footage, r.override_living_square_footage);
  const effElevation = effectiveValue(r.synced_elevation, r.override_elevation);
  const effPrice = effectiveValue(r.synced_price, r.override_price);
  const effAddress = effectiveValue(r.synced_address, r.override_address);

  const bedroomCount = n(effBeds) ?? n(fp?.bedroom_max) ?? n(fp?.bedroom_min);
  const bathroomCount = n(effBaths) ?? n(fp?.bathroom_max) ?? n(fp?.bathroom_min);
  const totalSquareFootage = n(effTotalSqft) ?? n(fp?.total_square_footage);
  const livingSquareFootage = n(effLivingSqft) ?? n(fp?.living_square_footage);
  const fpStartingPrice = n(fp?.starting_price);

  // Description: home-specific copy wins; else the floor-plan description.
  const homeDescription = s(r.description);
  const fpDescription = s(fp?.description);
  const description = homeDescription !== '' ? homeDescription : fpDescription;
  const descriptionFromFloorPlan = homeDescription === '' && fpDescription !== '';

  // Gallery: floor-plan primary + additional images, then any home-level urls.
  const alt = effAddress ? s(effAddress) : 'QMI photo';
  const gallery: GalleryImage[] = [
    ...parseImages(fp?.fp_image, alt),
    ...parseImages(fp?.fp_additional_images, alt),
    ...parseImages(r.image_url, alt),
    ...parseImages(r.featured_image, alt),
    ...parseImages(r.image_2, alt),
    ...parseImages(r.image_3, alt),
    ...parseImages(r.image_4, alt),
    ...parseImages(r.image_5, alt),
  ];
  // De-dupe by url (fp_image may repeat in additional images).
  const seen = new Set<string>();
  const dedupedGallery = gallery.filter((g) => (seen.has(g.url) ? false : (seen.add(g.url), true)));

  // Option lists for the assignment + override selects.
  const [fpOptions, communityOptions, cityOptions] = await Promise.all([
    loadOptions('floor_plans'),
    loadOptions('communities'),
    loadOptions('cities'),
  ]);

  // Promotions targeting this QMI (read-only membership). A promo applies to this home
  // when it has a global target OR a qmi/community/city target matching this row. We
  // surface the direct qmi-targeted promos + global promos for the operator to jump to
  // the promotion editor (where PromoScopeTagPicker actually writes). Targeting writes
  // are owned by the promotion, never the QMI — so this is display-only.
  const targetRows = (await db
    .select({ promotionId: promotionTargets.promotionId, targetType: promotionTargets.targetType })
    .from(promotionTargets)) as Array<{ promotionId: string; targetType: string }>;
  const qmiPromoIds = new Set(
    targetRows
      .filter((t) => t.targetType === 'global')
      .map((t) => t.promotionId)
  );
  // Direct qmi targets for this id.
  const directRows = (await db
    .select({ promotionId: promotionTargets.promotionId })
    .from(promotionTargets)
    .where(eq(promotionTargets.targetId, id))) as Array<{ promotionId: string }>;
  for (const d of directRows) qmiPromoIds.add(d.promotionId);

  const globalIds = new Set(
    targetRows.filter((t) => t.targetType === 'global').map((t) => t.promotionId)
  );

  let promotionsList: Array<{ id: string; title: string; global: boolean }> = [];
  if (qmiPromoIds.size > 0) {
    const promoRows = (await db
      .select({ id: promotions.id, title: promotions.title })
      .from(promotions)
      .where(inArray(promotions.id, [...qmiPromoIds]))) as Array<{ id: string; title: string | null }>;
    promotionsList = promoRows.map((p) => ({
      id: p.id,
      title: p.title?.trim() || p.id,
      global: globalIds.has(p.id),
    }));
  }

  const buildSO = (
    field: string,
    label: string,
    variant: 'text' | 'number',
    syncedCol: string,
    overrideCol: string,
    step?: 'any' | '1',
    help?: string
  ): SyncedOverrideView => ({
    field,
    label,
    variant,
    step,
    syncedDisplay: s(r[syncedCol]),
    overrideValue: s(r[overrideCol]),
    help,
  });

  const published = Boolean(r.published);
  const comingSoon = Boolean(r.coming_soon);

  return {
    id,
    published,
    comingSoon,
    // Tri-state status from the same publish columns the rest of the engine uses
    // (lib/status: !published → Draft; published+coming_soon → Coming Soon; else Live).
    status: deriveStatus('location', { published, comingSoon }),
    availableNow: Boolean(r.available_now),

    housenumber: s(r.housenumber),
    eciKey: s(r.eci_key),
    markJobNumber: s(r.mark_job_number),

    address: s(effAddress),
    price: n(effPrice),
    fpStartingPrice,
    bedroomCount,
    bathroomCount,
    totalSquareFootage,
    livingSquareFootage,
    elevation: s(effElevation),

    hasPriceOverride: s(r.override_price) !== '',

    communityName,
    cityName,
    floorPlanName,

    floorPlanId: effFloorPlanId,
    isUnassigned: effFloorPlanId === '',

    description,
    descriptionFromFloorPlan,

    slug: s(r.slug),
    moveInDate: s(effectiveValue(r.synced_move_in_date, r.override_move_in_date)),

    gallery: dedupedGallery,

    syncedOverride: {
      price: buildSO('price', 'Price', 'number', 'synced_price', 'override_price', 'any', 'Blank = follow Snowflake.'),
      address: buildSO('address', 'Address', 'text', 'synced_address', 'override_address'),
      bedroomCount: buildSO('bedroom_count', 'Bedrooms', 'number', 'synced_bedroom_count', 'override_bedroom_count', '1'),
      bathroomCount: buildSO('bathroom_count', 'Bathrooms', 'number', 'synced_bathroom_count', 'override_bathroom_count', 'any'),
      totalSquareFootage: buildSO('total_square_footage', 'Total SqFt', 'number', 'synced_total_square_footage', 'override_total_square_footage', '1'),
      elevation: buildSO('elevation', 'Elevation', 'text', 'synced_elevation', 'override_elevation'),
      // 0007 Snowflake sync expansion
      lotNumber: buildSO('lot_number', 'Lot Number', 'text', 'synced_lot_number', 'override_lot_number'),
      elevationType: buildSO('elevation_type', 'Elevation Type', 'text', 'synced_elevation_type', 'override_elevation_type'),
      materialType: buildSO('material_type', 'Material Type', 'text', 'synced_material_type', 'override_material_type'),
      isModelHome: buildSO('is_model_home', 'Model Home (1/0)', 'number', 'synced_is_model_home', 'override_is_model_home', '1'),
    },

    relations: {
      floorPlan: {
        field: 'floor_plan_id',
        label: 'Floor Plan',
        variant: 'select',
        // synced NAME for the helper (not the id), matching build-edit-view's displayColumn.
        syncedDisplay: s(r.synced_floor_plan_name),
        overrideValue: s(r.override_floor_plan_id),
        options: fpOptions,
        help: 'Changing this re-pulls beds/baths/sqft/images/base price from the plan. Blank = follow Snowflake.',
      },
      community: {
        field: 'community_id',
        label: 'Community',
        variant: 'select',
        syncedDisplay: s(r.synced_community_name),
        overrideValue: s(r.override_community_id),
        options: communityOptions,
        help: 'Blank = follow Snowflake.',
      },
      city: {
        field: 'city_id',
        label: 'City',
        variant: 'select',
        syncedDisplay: s(r.synced_city_name),
        overrideValue: s(r.override_city_id),
        options: cityOptions,
        help: 'Blank = follow Snowflake.',
      },
    },

    admin: {
      incentive: s(r.incentive),
      promoText: s(r.promo_text),
      availabilityText: s(r.availability_text),
      virtualTourUrl: s(r.virtual_tour_url),
      moveInDate: s(effectiveValue(r.synced_move_in_date, r.override_move_in_date)),
      selfTourAvailable: Boolean(r.self_tour_available),
      availableNow: Boolean(r.available_now),
    },

    options: {
      floorPlans: fpOptions,
      communities: communityOptions,
      cities: cityOptions,
    },

    promotions: promotionsList,
  };
}
