// =============================================================================
// packages/admin — server-side builder that turns one DB row + the entity field
// config into the plain-JSON view model EntityEditForm consumes. This is where the
// config-driven engine resolves widgets/buckets into render instructions.
//
// Responsibilities:
//   - For each config field, produce a FieldView (generic | image | syncedOverride).
//   - Resolve `select` / `syncedOverride(select)` option lists from the DB.
//   - Extract the publish-gate state (published | active | status).
//   - Assemble side widgets (hoaLinks | jsonBlocks | promoScopeTag) from their columns.
// =============================================================================

import { eq } from 'drizzle-orm';
import { getReadDb } from './db';
import { ENTITIES, type EntityKey, type EntityDef } from './entities';
import {
  publishGateColumn,
  CITY_COPY_BLOCK_KEYS,
  CITY_VENUE_BLOCK_KEYS,
  type FieldConfig,
  type SelectSource,
} from './field-config';
import { resolveFieldConfig } from './field-config-source';
import { loadOptionSets, loadPromoScopeOptions, type SelectOption } from './select-options';
import { promotionTargets } from '@esperanza/db';
import type {
  FieldView,
  PublishGateView,
  SideWidget,
} from '../components/EntityEditForm';

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return v == null ? '' : String(v);
}

function parseObj(v: unknown): Record<string, string> {
  if (typeof v !== 'string' || v.trim() === '') return {};
  try {
    const o = JSON.parse(v);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(o as Record<string, unknown>)) out[k] = s(val);
    return out;
  } catch {
    return {};
  }
}

/**
 * Parse the entity row's `custom_fields` JSON blob into a flat { key → string } map.
 * This column holds the VALUES of Field-Builder user-added fields (Phase B). Tolerant of
 * NULL/blank/malformed (→ {}), and stringifies scalar values so the generic FieldView
 * (which is string-valued) can render them uniformly.
 */
function parseCustomFields(v: unknown): Record<string, string> {
  return parseObj(v);
}

function parseLinks(v: unknown): Array<{ title: string; link: string }> {
  if (typeof v !== 'string' || v.trim() === '') return [];
  try {
    const a = JSON.parse(v);
    if (!Array.isArray(a)) return [];
    return a.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { title: s(o['title']), link: s(o['link']) };
    });
  } catch {
    return [];
  }
}

export interface EditView {
  def: EntityDef;
  id: string;
  /** Human record name for the detail H1 (e.g. a community's name, a blog's title). */
  displayName: string;
  fields: FieldView[];
  publishGate: PublishGateView | null;
  sideWidgets: SideWidget[];
}

// =============================================================================
// [13][14][15][43] Per-entity record DISPLAY NAME resolver. The generic detail H1
// must read the record's human name (not "Entitie recXXXX"). Row keys are physical
// snake_case columns (db.select().from(table)); we read the configured display
// column(s) per entity, with sane fallbacks, and finally to the id.
// =============================================================================
function firstNonEmpty(row: Row, cols: string[]): string {
  for (const c of cols) {
    const v = s(row[c]).trim();
    if (v !== '') return v;
  }
  return '';
}

export function resolveDisplayName(key: EntityKey, row: Row, id: string): string {
  let name = '';
  switch (key) {
    case 'communities':
    case 'floor_plans':
      name = firstNonEmpty(row, ['name']);
      break;
    case 'cities':
      name = firstNonEmpty(row, ['city_name', 'name']);
      break;
    case 'promotions':
    case 'collections':
    case 'blogs':
      name = firstNonEmpty(row, ['title']);
      break;
    case 'images':
      // images has no `name` column; the operator-facing identity is the plan/caption/slug.
      name = firstNonEmpty(row, ['plan_name', 'caption_clean', 'caption', 'slug']);
      break;
    case 'testimonials': {
      const person = firstNonEmpty(row, ['person_name']);
      const location = firstNonEmpty(row, ['town', 'community_name', 'city_name']);
      name = [person, location].filter((x) => x !== '').join(', ');
      break;
    }
    case 'qmi':
      // QMI has its own bespoke detail header; this is only a fallback.
      name = firstNonEmpty(row, ['override_address', 'synced_address', 'address']);
      break;
  }
  return name !== '' ? name : id;
}

/** Load the row + build the full edit view model for an entity record. Returns null if not found. */
export async function buildEditView(key: EntityKey, id: string): Promise<EditView | null> {
  const def = ENTITIES[key];
  // ENGINE SWAP: derive the field set from field_definitions (D1), with a SAFE FALLBACK
  // to the static lib/field-config.ts when the entity has zero rows. The resolved shape
  // is identical, so the rest of this builder (and EntityEditForm) is unchanged.
  const cfg = await resolveFieldConfig(key);
  const db = getReadDb();

  const rows = (await db
    .select()
    .from(def.table)
    .where(eq((def.table as unknown as { id: never }).id, id as never))
    .limit(1)) as Row[];
  if (rows.length === 0) return null;
  const row = rows[0]!;

  // Resolve every dynamic select source referenced (admin selects + override selects).
  const sources = new Set<SelectSource>();
  for (const f of cfg.fields) if (f.selectSource) sources.add(f.selectSource);
  const optionSets = await loadOptionSets(sources);

  const gateCol = publishGateColumn(key);
  // Field-Builder custom-field VALUES live in the row's `custom_fields` JSON blob (a field
  // whose key is NOT a real column resolves its value from here). Parse it once. Drizzle's
  // bare select() keys rows by the JS PROPERTY name (camelCase `customFields`), so read
  // that first and fall back to the physical snake_case key for safety.
  const customValues = parseCustomFields(row['customFields'] ?? row['custom_fields']);
  const fields: FieldView[] = [];
  const sideWidgets: SideWidget[] = [];

  for (const f of cfg.fields) {
    // The publish-gate field is the header toggle, not a form input.
    if (f.bucket === 'publish') continue;

    // Custom side widgets (own actions, rendered below the form).
    if (f.widget === 'hoaLinks') {
      sideWidgets.push({ kind: 'hoaLinks', initial: parseLinks(row['hoa_links_json']) });
      continue;
    }
    if (f.widget === 'promoScopeTag') {
      // handled after the loop (needs a separate query); placeholder push below.
      continue;
    }
    if (f.widget === 'jsonBlocks') {
      // Two jsonBlocks config entries (copy + venue) collapse to ONE editor instance.
      // Only add it once (when we hit the copy-blocks column).
      if (f.field === 'city_copy_blocks_json') {
        const copy = mergeKeys(CITY_COPY_BLOCK_KEYS, parseObj(row['city_copy_blocks_json']));
        const venue = mergeKeys(CITY_VENUE_BLOCK_KEYS, parseObj(row['city_venue_blocks_json']));
        sideWidgets.push({ kind: 'jsonBlocks', copy, venue });
      }
      continue;
    }

    fields.push(buildFieldView(key, f, row, optionSets, customValues));
  }

  // Promotion targeting scope (needs the promotion_targets rows + full option lists).
  if (cfg.fields.some((f) => f.widget === 'promoScopeTag')) {
    const targets = (await db
      .select()
      .from(promotionTargets)
      .where(eq(promotionTargets.promotionId, id))) as Row[];
    const global = targets.some((t) => t['target_type'] === 'global');
    const pick = (type: string) =>
      targets.filter((t) => t['target_type'] === type).map((t) => s(t['target_id']));
    const options = await loadPromoScopeOptions();
    sideWidgets.push({
      kind: 'promoScope',
      global,
      selected: { cities: pick('city'), communities: pick('community'), qmis: pick('qmi') },
      options,
    });
  }

  // Publish gate view model.
  let publishGate: PublishGateView | null = null;
  if (gateCol === 'published' || gateCol === 'active') {
    publishGate = { gate: gateCol, published: Boolean(row[gateCol]) };
  } else if (gateCol === 'status') {
    const statusCfg = cfg.fields.find((f) => f.field === 'status');
    publishGate = {
      gate: 'status',
      status: s(row['status']),
      statusOptions: statusCfg?.options ?? ['', 'Live', 'Draft'],
    };
  }

  const displayName = resolveDisplayName(key, row, id);

  return { def, id, displayName, fields, publishGate, sideWidgets };
}

/** Resolve a single config field into a FieldView, reading the row + option sets.
 *  For a Field-Builder CUSTOM field (f.custom — no real column), the value is read from
 *  `customValues` (the row's parsed custom_fields blob) instead of the row column. */
function buildFieldView(
  key: EntityKey,
  f: FieldConfig,
  row: Row,
  optionSets: Partial<Record<SelectSource, SelectOption[]>>,
  customValues: Record<string, string>
): FieldView {
  // Resolve the value: a custom field reads from custom_fields[key]; everything else
  // reads its real column off the row.
  const fieldValue = f.custom ? s(customValues[f.field]) : s(row[f.field]);

  // synced (read-only display) — never submitted. Rendered via the read-only 'synced'
  // GenericField variant regardless of the configured widget (text/number/image).
  if (f.bucket === 'synced') {
    return {
      kind: 'generic',
      field: f.field,
      label: f.label,
      widget: 'synced',
      value: s(row[f.field]),
      help: f.help,
      group: f.group,
    };
  }

  // override (QMI synced_/override_ pairs).
  if (f.bucket === 'override') {
    const syncedCol = f.syncedColumn ?? `synced_${f.field}`;
    const overrideCol = `override_${f.field}`;
    const variant: 'text' | 'number' | 'select' =
      f.widget === 'syncedOverride' && f.selectSource
        ? 'select'
        : f.step
          ? 'number'
          : 'text';
    // For selects, show the synced human NAME (displayColumn) as the helper, not the id.
    const syncedDisplay =
      variant === 'select' && f.displayColumn ? s(row[f.displayColumn]) : s(row[syncedCol]);
    return {
      kind: 'syncedOverride',
      field: f.field,
      label: f.label,
      variant,
      syncedDisplay,
      overrideValue: s(row[overrideCol]),
      step: f.step,
      options: f.selectSource ? optionSets[f.selectSource] : undefined,
      help: f.help,
      halfWidth: f.halfWidth,
      group: f.group,
    };
  }

  // admin: image widget → ImageUploader; else GenericField. (fieldValue resolves the
  // custom_fields value for a builder-added image field, the column otherwise.)
  if (f.widget === 'image') {
    return { kind: 'image', field: f.field, label: f.label, value: fieldValue, help: f.help, group: f.group };
  }

  const genericWidget =
    f.widget === 'textarea' ||
    f.widget === 'number' ||
    f.widget === 'currency' ||
    f.widget === 'boolean' ||
    f.widget === 'richtext' ||
    f.widget === 'date' ||
    f.widget === 'select'
      ? f.widget
      : 'text';

  return {
    kind: 'generic',
    field: f.field,
    label: f.label,
    widget: genericWidget,
    value: fieldValue,
    step: f.step,
    options: f.selectSource ? optionSets[f.selectSource] : undefined,
    staticOptions: f.options,
    optionItems: f.optionItems,
    help: f.help,
    halfWidth: f.halfWidth,
    group: f.group,
  };
}

/** Known keys first (in order), then any extra keys already present in the stored object. */
function mergeKeys(known: readonly string[], existing: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of known) out[k] = existing[k] ?? '';
  for (const [k, v] of Object.entries(existing)) if (!(k in out)) out[k] = v;
  return out;
}
