// =============================================================================
// esperanza-cf framer-push — config-driven Framer output type (Field Types Phase C).
//
// Two responsibilities, both driven by the field_definitions registry in D1:
//
//   1. applyTypeOverrides(entity, fieldData, defs) — run AFTER def.map(row). For
//      each emitted Framer field id whose configured field_definitions.framer_type
//      DIFFERS from the type the mapper emitted, re-wrap the value as the configured
//      type via coerceToFramerType. UNCHANGED fields are touched by NOTHING — the
//      seed was reconciled (pre-work audit, zero drift) so this pass is a guaranteed
//      no-op for every field whose Framer field id == a field_definitions.key and
//      whose framer_type already equals the mapper's output.
//
//   2. emitCustomFields(entity, customFieldsRaw, defs) — for each CUSTOM
//      field_definitions entry (custom=1), emit { [key]: coerce(custom_fields[key],
//      framer_type) }. Framer field id == key (created by POST /schema). Empty /
//      undefined custom values are dropped (no "0"/blank leak to the live site).
//
// coerceToFramerType is the shared coercion primitive: string ↔ link ↔ formattedText
// ↔ number ↔ boolean, image/array pass-through; incompatible or empty → undefined
// (drop). It never throws — a bad value is dropped, never aborts the item.
// =============================================================================

import {
  type AnyFieldValue,
  type FieldData,
  type FieldType,
  str,
  num,
  bool,
  image,
  link,
  formattedText,
  date,
} from './framer-types.js';
import type { CollectionKey, D1Like } from './types.js';

/**
 * The subset of field_definitions a push needs. framer_type is the Framer output
 * type the field SHOULD be emitted as; key == the Framer field id (by convention).
 */
export interface FieldDef {
  key: string;
  framer_type: string | null;
  custom: number; // 1 = value lives in custom_fields JSON
}

// The Framer CMS field types framer-push knows how to BUILD a value for. The
// registry may also hold `date`/`enum` (admin-side types), which have no scalar
// value constructor here — coerceToFramerType treats them as a string carrier
// (date → string ISO/label; enum → string label), matching how the mappers already
// push those columns (sIf → string). `array` (gallery) is pass-through only.
const SCALAR_TYPES = new Set<FieldType>([
  'string',
  'number',
  'boolean',
  'image',
  'link',
  'formattedText',
  'date',
]);

/** Unwrap a stored field value: a FieldValue/{value} → its inner value, else raw. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && 'type' in (value as object) && 'value' in (value as object)) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/** A non-empty trimmed string, or undefined. */
function nonEmptyStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** A valid absolute http(s) URL string, else undefined (image/link guard). */
function urlString(v: unknown): string | undefined {
  const s = nonEmptyStr(v);
  if (s === undefined) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Coerce an arbitrary value into the requested Framer type, returning an
 * AnyFieldValue ({type,value}) or undefined to DROP (incompatible / empty).
 *
 * `value` may be a raw JS value (custom_fields[key]) OR an already-wrapped
 * FieldValue (from the mapper's fieldData) — both are accepted: a wrapped value is
 * unwrapped to its inner scalar first. NEVER throws.
 *
 * Compatibility:
 *   string         ← any non-empty scalar (stringified)
 *   formattedText  ← any non-empty scalar (treated as the HTML/markdown carrier)
 *   number         ← finite numeric (string or number); NaN/empty → drop
 *   boolean        ← true/false, 1/0, "true"/"false"/"1"/"0"/"yes"/"no"; else drop
 *   link / image   ← a valid absolute http(s) URL string; else drop
 *   date / enum    ← string carrier (matches the mappers' sIf output)
 *   array          ← pass through only if already a {type:'array'} value; else drop
 */
export function coerceToFramerType(value: unknown, type: string): AnyFieldValue | undefined {
  // array is a structured gallery value — never synthesised from a scalar.
  if (type === 'array') {
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'array') {
      return value as AnyFieldValue;
    }
    return undefined;
  }

  const inner = unwrap(value);

  switch (type) {
    case 'date': {
      // Real Framer date field — normalise to ISO via date(). Empty → drop.
      const s = nonEmptyStr(inner);
      return s === undefined ? undefined : date(s);
    }
    case 'string':
    case 'enum': {
      // enum has no dedicated value constructor; carry as string.
      const s = nonEmptyStr(inner);
      return s === undefined ? undefined : str(s);
    }
    case 'formattedText': {
      const s = nonEmptyStr(inner);
      return s === undefined ? undefined : formattedText(s);
    }
    case 'number': {
      if (inner == null || inner === '') return undefined;
      const n = typeof inner === 'number' ? inner : Number(inner);
      return Number.isFinite(n) ? num(n) : undefined;
    }
    case 'boolean': {
      const b = toBool(inner);
      return b === undefined ? undefined : bool(b);
    }
    case 'link': {
      const u = urlString(inner);
      return u === undefined ? undefined : link(u);
    }
    case 'image': {
      const u = urlString(inner);
      return u === undefined ? undefined : image(u);
    }
    default:
      // Unknown / unsupported target type → drop (never abort the item).
      return undefined;
  }
}

/** Strict-ish boolean parse; undefined when the value isn't boolean-ish. */
function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
    return undefined;
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return s === '' ? undefined : false;
    return undefined;
  }
  return undefined;
}

/** Is `t` one of the scalar Framer types this package can build a value for? */
function isKnownScalar(t: string | null | undefined): t is FieldType {
  return t != null && SCALAR_TYPES.has(t as FieldType);
}

// =============================================================================
// field_definitions loader (cache by entity per consumer invocation)
// =============================================================================

const DEFS_SQL =
  'SELECT key, framer_type, custom FROM field_definitions WHERE entity = ? AND framer_type IS NOT NULL';

/**
 * Load the field_definitions rows for one entity. Cache is keyed by entity on the
 * passed Map so a single consumer invocation reads each entity's defs at most once.
 * (Pass a fresh Map per batch/run to scope the cache to that invocation.)
 */
export async function loadFieldDefs(
  db: D1Like,
  entity: CollectionKey,
  cache: Map<string, FieldDef[]>
): Promise<FieldDef[]> {
  const hit = cache.get(entity);
  if (hit) return hit;
  const { results } = await db.prepare(DEFS_SQL).bind(entity).all<FieldDef>();
  const defs = results ?? [];
  cache.set(entity, defs);
  return defs;
}

// =============================================================================
// applyTypeOverrides — re-type emitted fields whose configured framer_type differs
// =============================================================================

/**
 * Re-wrap each emitted field whose configured framer_type (field_definitions, keyed
 * by Framer field id == key) DIFFERS from the type the mapper emitted. Mutates &
 * returns the same FieldData. Rules:
 *   - def has no entry for an emitted key  → leave the emitted value untouched.
 *   - def.framer_type === emitted.type     → no-op (the reconciled steady state).
 *   - def.framer_type !== emitted.type     → coerce the emitted value to the new
 *     type; on incompatible/empty coercion the field is DROPPED (per spec).
 *   - def.framer_type is not a known target type → leave untouched (defensive).
 * CUSTOM defs are NOT applied here (they have no mapper-emitted field to re-type;
 * emitCustomFields owns them).
 */
export function applyTypeOverrides(
  _entity: CollectionKey,
  fieldData: FieldData,
  defs: FieldDef[]
): FieldData {
  const byKey = new Map<string, FieldDef>();
  for (const d of defs) {
    if (d.custom) continue; // custom fields are emitted separately
    byKey.set(d.key, d);
  }

  for (const [key, current] of Object.entries(fieldData)) {
    const def = byKey.get(key);
    if (!def || def.framer_type == null) continue;
    const target = def.framer_type;
    if (target === current.type) continue; // already the configured type → untouched
    // For array (gallery) targets there is no scalar re-type; only string-family,
    // number, boolean, link, image are coercible. Unknown target → leave as-is.
    if (target !== 'array' && !isKnownScalar(target) && target !== 'date' && target !== 'enum') {
      continue;
    }
    const recoerced = coerceToFramerType(current, target);
    if (recoerced === undefined) {
      delete fieldData[key]; // incompatible/empty → drop (no stale wrong-typed value)
    } else {
      fieldData[key] = recoerced;
    }
  }
  return fieldData;
}

// =============================================================================
// emitCustomFields — push custom_fields JSON values as their configured type
// =============================================================================

/** Parse the entity row's custom_fields JSON column → flat object ({} on absent). */
export function parseCustomFields(raw: unknown): Record<string, unknown> {
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
 * Build the custom-field portion of fieldData from the row's custom_fields JSON.
 * For each CUSTOM (custom=1) field_definitions entry, emit { [key]: coerce(
 * custom_fields[key], framer_type) }. Empty/undefined custom values are dropped.
 * Returns a plain FieldData fragment the caller merges over the mapped fieldData.
 */
export function emitCustomFields(
  customFieldsRaw: unknown,
  defs: FieldDef[]
): FieldData {
  const values = parseCustomFields(customFieldsRaw);
  const out: FieldData = {};
  for (const d of defs) {
    if (!d.custom || d.framer_type == null) continue;
    const raw = values[d.key];
    if (raw === undefined || raw === null || raw === '') continue; // drop empties
    const v = coerceToFramerType(raw, d.framer_type);
    if (v !== undefined) out[d.key] = v;
  }
  return out;
}
