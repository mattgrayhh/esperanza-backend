// =============================================================================
// packages/admin — Framer Field Types (Phase C) READ model.
//
// Loads every entity's field_definitions into the per-entity sections the Settings →
// Framer Field Types tab renders. For each field we surface:
//   - key / label / admin type (the field-builder type)
//   - the APPLIED framer_type (field_definitions.framer_type) and framer_field_id
//   - the RECOMMENDED Framer target for its admin type (the default + the warning basis)
//   - custom (user-added, custom_fields-backed) vs system/column flags
//
// Read via getReadDb() (primary session, read-your-writes) so the tab reflects a just-
// applied change. When an entity has ZERO registry rows we synthesize from the SAME
// static-config fallback the Field Builder uses (build-field-builder.fromStaticConfig),
// then resolve each field's framer_type from FIELD_TYPE_META — so the tab is never empty
// before the seed has run for that entity.
// =============================================================================

import { asc, eq } from 'drizzle-orm';
import { fieldDefinitions, type FieldDefinition } from '@esperanza/db';
import { getReadDb } from './db';
import { ENTITY_LIST, type EntityKey } from './entities';
import { buildFieldBuilderModel, type BuilderField } from './build-field-builder';
import { FIELD_TYPE_META, type FieldType } from './field-builder';
import { defaultFramerType } from './framer-types';

export interface FramerTypeField {
  /** field_definitions.id (the row to update on apply); synthetic for static-fallback rows. */
  id: string;
  key: string;
  label: string;
  /** field-builder admin type (text/long/rich/number/currency/bool/date/url/image/select). */
  adminType: string;
  /** the framer_type currently persisted in field_definitions (or null if unseeded). */
  framerType: string | null;
  /** the live Framer field id (== key by convention); null until /schema applies it. */
  framerFieldId: string | null;
  /** the recommended Framer target for this admin type (the default for an added field). */
  recommended: string;
  /** value lives in custom_fields (user-added) vs a real column / system field. */
  custom: boolean;
  system: boolean;
}

export interface FramerTypeSection {
  entity: EntityKey;
  label: string;
  segment: string;
  fields: FramerTypeField[];
}

/** Resolve a builder field's APPLIED framer_type, falling back to the type meta default. */
function appliedFramerType(adminType: string, dbFramerType: string | null): string | null {
  if (dbFramerType) return dbFramerType;
  const meta = FIELD_TYPE_META[adminType as FieldType];
  return meta ? meta.framerType : null;
}

function rowToField(r: FieldDefinition, custom: boolean): FramerTypeField {
  return {
    id: r.id,
    key: r.key,
    label: r.label ?? r.key,
    adminType: r.type,
    framerType: appliedFramerType(r.type, r.framerType),
    framerFieldId: r.framerFieldId ?? null,
    recommended: defaultFramerType(r.type),
    custom,
    system: r.system,
  };
}

function builderFieldToField(b: BuilderField): FramerTypeField {
  return {
    id: b.id,
    key: b.key,
    label: b.label,
    adminType: b.type,
    framerType: appliedFramerType(b.type, null),
    framerFieldId: null,
    recommended: defaultFramerType(b.type),
    custom: b.custom,
    system: b.system,
  };
}

/** Build one entity's Framer-types section (DB rows, else the static-config fallback). */
export async function buildFramerTypesSection(entity: EntityKey): Promise<FramerTypeSection> {
  const def = ENTITY_LIST.find((e) => e.key === entity)!;
  const db = getReadDb();

  let rows: FieldDefinition[] = [];
  try {
    rows = (await db
      .select()
      .from(fieldDefinitions)
      .where(eq(fieldDefinitions.entity, entity))
      .orderBy(asc(fieldDefinitions.sort))) as FieldDefinition[];
  } catch {
    rows = [];
  }

  let fields: FramerTypeField[];
  if (rows.length > 0) {
    // Reuse the Field Builder's custom-field classification so `custom` is consistent
    // across both Settings tabs (it joins the same column/override/gate rules).
    const builder = await buildFieldBuilderModel(entity);
    const customByKey = new Map(builder.fields.map((b) => [b.key, b.custom]));
    fields = rows.map((r) => rowToField(r, customByKey.get(r.key) ?? false));
  } else {
    const builder = await buildFieldBuilderModel(entity); // static-config fallback
    fields = builder.fields.map(builderFieldToField);
  }

  return { entity: def.key, label: def.label, segment: def.segment, fields };
}

/** Build the Framer-types sections for ALL 9 entities (one per section, ordered). */
export async function buildFramerTypesModel(): Promise<FramerTypeSection[]> {
  const out: FramerTypeSection[] = [];
  for (const e of ENTITY_LIST) {
    out.push(await buildFramerTypesSection(e.key));
  }
  return out;
}
