// =============================================================================
// packages/admin — entity registry + QMI field classification.
//
// The 9 managed collections (== framer-push CollectionKey set). For each we record:
//   - the Drizzle table
//   - the human label + url segment
//   - whether it has a publish toggle (admin-owns-1)
//
// QMI is special: a subset of its columns are the Snowflake synced write-set carrying
// synced_/override_ pairs. Edits to those MUST route through @esperanza/db/override
// (buildOverrideWrite/buildOverrideAudit). EVERYTHING ELSE on QMI is a plain
// admin-owned column edited directly. Communities expose square_footage_range as a
// single synced field (read-only display; no override pair) — the rest admin-owned.
// =============================================================================

import {
  qmi,
  communities,
  cities,
  floorPlans,
  promotions,
  collections,
  images,
  blogs,
  testimonials,
} from '@esperanza/db';
import { QMI_OVERRIDABLE_FIELDS, type QmiOverridableField } from '@esperanza/db/override';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

/** The 9 admin entity keys — identical to framer-push CollectionKey. */
export type EntityKey =
  | 'qmi'
  | 'communities'
  | 'cities'
  | 'floor_plans'
  | 'promotions'
  | 'collections'
  | 'images'
  | 'blogs'
  | 'testimonials';

export interface EntityDef {
  key: EntityKey;
  label: string;
  /** url segment under /admin (and the framer queue `collection`). */
  segment: string;
  table: SQLiteTable;
  /** has an admin-owned publish gate (toggle path). */
  publishable: boolean;
}

export const ENTITIES: Record<EntityKey, EntityDef> = {
  qmi: { key: 'qmi', label: 'Quick Move-Ins', segment: 'qmi', table: qmi, publishable: true },
  communities: {
    key: 'communities',
    label: 'Communities',
    segment: 'communities',
    table: communities,
    publishable: true,
  },
  cities: { key: 'cities', label: 'Cities', segment: 'cities', table: cities, publishable: false },
  floor_plans: {
    key: 'floor_plans',
    label: 'Floor Plans',
    segment: 'floor-plans',
    table: floorPlans,
    publishable: true,
  },
  promotions: {
    key: 'promotions',
    label: 'Promotions',
    segment: 'promotions',
    table: promotions,
    publishable: false,
  },
  collections: {
    key: 'collections',
    label: 'Collections',
    segment: 'collections',
    table: collections,
    publishable: false,
  },
  images: { key: 'images', label: 'Images', segment: 'images', table: images, publishable: false },
  blogs: { key: 'blogs', label: 'Blogs', segment: 'blogs', table: blogs, publishable: true },
  testimonials: {
    key: 'testimonials',
    label: 'Testimonials',
    segment: 'testimonials',
    table: testimonials,
    publishable: false,
  },
};

/** Ordered list for the nav. */
export const ENTITY_LIST: EntityDef[] = [
  ENTITIES.qmi,
  ENTITIES.communities,
  ENTITIES.cities,
  ENTITIES.floor_plans,
  ENTITIES.promotions,
  ENTITIES.collections,
  ENTITIES.images,
  ENTITIES.blogs,
  ENTITIES.testimonials,
];

export function getEntity(key: string): EntityDef | undefined {
  return (ENTITIES as Record<string, EntityDef>)[key];
}

/** Singularize a plural entity label for "New X" / breadcrumb context. Handles the
 *  -ies → -y case (Communities→Community, Cities→City) and the plain trailing -s,
 *  while leaving already-singular labels untouched. Fixes the old `replace(/s$/,'')`
 *  bug that produced "Communitie"/"Citie". */
export function singularizeLabel(label: string): string {
  if (/ies$/i.test(label)) return label.replace(/ies$/i, 'y');
  if (/ss$/i.test(label)) return label; // e.g. a hypothetical "Address"
  if (/s$/i.test(label)) return label.replace(/s$/i, '');
  return label;
}

// =============================================================================
// QMI override-field set. Re-exported from the db contract so the admin and the
// override helper agree on EXACTLY which fields carry a synced_/override_ pair.
//
// NOTE: the task brief lists `city_id, community_id, floor_plan_id, price, address,
// bedroom_count, bathroom_count, half_bathroom_count, living_square_footage,
// total_square_footage, postal_code, elevation`. The canonical source is
// QMI_OVERRIDABLE_FIELDS in @esperanza/db/override, which additionally includes
// `construction_stage` (it too has the pair in the schema). We use the db constant as
// the single source of truth; a QMI field is "override-routed" iff it's in this set.
// =============================================================================
export const QMI_OVERRIDE_FIELDS: ReadonlySet<QmiOverridableField> = new Set(QMI_OVERRIDABLE_FIELDS);

export function isQmiOverrideField(field: string): field is QmiOverridableField {
  return QMI_OVERRIDE_FIELDS.has(field as QmiOverridableField);
}
