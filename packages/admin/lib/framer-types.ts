// =============================================================================
// packages/admin — Framer Field Types (Phase C) PURE helpers.
//
// No 'use server' / no DB here — the Framer CMS type registry, the per-admin-type
// recommended subset, and the risky-conversion classifier the Settings → Framer Field
// Types tab + the applyFramerTypes action both consume. Kept separate (like
// lib/field-builder.ts) so it's unit-testable in plain Node without the CF/Next boundary.
//
// CONTRACT ALIGNMENT with framer-push:
//   • The Framer CMS field types the `POST /schema` endpoint can BUILD/RE-TYPE are the
//     framer-push SETTABLE_TYPES: string · number · boolean · image · link ·
//     formattedText · date · array · file. `enum` is intentionally NOT settable there
//     (it needs `cases`), so we do NOT offer it as a target (a field already seeded as
//     `enum` is shown as-is/locked — see FRAMER_TYPES.settable).
//   • Each admin field-builder type (text/long/rich/number/currency/bool/date/url/image/
//     select) has a RECOMMENDED Framer target (its natural mapping) plus a COMPATIBLE
//     set (safe alternates). Anything outside compatible is a RISKY conversion → inline
//     warning in the UI (e.g. number → image).
// =============================================================================

import type { FieldType as AdminFieldType } from './field-builder';

/** A Framer CMS field type. `value` is the wire type sent to framer-push /schema. */
export interface FramerTypeMeta {
  value: string;
  label: string;
  /** false → seed-only display type (e.g. enum); never offered as a /schema target. */
  settable: boolean;
}

// The Framer CMS field types the admin surfaces. `settable` ones are valid /schema
// targets (mirrors framer-push SETTABLE_TYPES); `enum` is display-only (not settable).
export const FRAMER_TYPES: FramerTypeMeta[] = [
  { value: 'string', label: 'Plain text (string)', settable: true },
  { value: 'formattedText', label: 'Rich / formatted text', settable: true },
  { value: 'number', label: 'Number', settable: true },
  { value: 'boolean', label: 'Boolean (toggle)', settable: true },
  { value: 'date', label: 'Date', settable: true },
  { value: 'link', label: 'Link (URL)', settable: true },
  { value: 'image', label: 'Image', settable: true },
  { value: 'file', label: 'File', settable: true },
  { value: 'array', label: 'Gallery (array)', settable: true },
  // Display-only: a field seeded as enum keeps its type; /schema can't (re)create enum.
  { value: 'enum', label: 'Option (enum)', settable: false },
];

const SETTABLE = new Set(FRAMER_TYPES.filter((t) => t.settable).map((t) => t.value));
const ALL_FRAMER = new Set(FRAMER_TYPES.map((t) => t.value));

/** Is `t` a Framer type framer-push /schema can re-type/create? */
export function isSettableFramerType(t: string): boolean {
  return SETTABLE.has(t);
}

/** Is `t` any known Framer CMS type (settable or display-only)? */
export function isKnownFramerType(t: string): boolean {
  return ALL_FRAMER.has(t);
}

export function framerTypeLabel(t: string): string {
  return FRAMER_TYPES.find((x) => x.value === t)?.label ?? t;
}

// =============================================================================
// admin field type → recommended + compatible Framer targets.
//   recommended[0] is the natural mapping (matches FIELD_TYPE_META.framerType in
//   lib/field-builder.ts). compatible is the safe set; a choice outside it is risky.
// =============================================================================
interface TypeRec {
  /** ordered preferred targets — recommended[0] is the default for an ADDED field. */
  recommended: string[];
  /** safe targets (superset of recommended). Outside this set → risky conversion. */
  compatible: string[];
}

const ADMIN_TYPE_RECS: Record<AdminFieldType, TypeRec> = {
  // Short text → string; safe to push as link/formattedText.
  text: { recommended: ['string'], compatible: ['string', 'link', 'formattedText', 'date'] },
  // Long/rich → formattedText; string is a safe (flattened) alternate.
  long: { recommended: ['formattedText'], compatible: ['formattedText', 'string'] },
  rich: { recommended: ['formattedText'], compatible: ['formattedText', 'string'] },
  number: { recommended: ['number'], compatible: ['number', 'string'] },
  currency: { recommended: ['number'], compatible: ['number', 'string'] },
  bool: { recommended: ['boolean'], compatible: ['boolean', 'string'] },
  date: { recommended: ['date'], compatible: ['date', 'string'] },
  url: { recommended: ['link'], compatible: ['link', 'image', 'string', 'file'] },
  image: { recommended: ['image'], compatible: ['image', 'link', 'string', 'file'] },
  // select → enum (display-only); string is the safe SETTABLE alternate the mappers use.
  select: { recommended: ['string'], compatible: ['string', 'enum'] },
};

/** The recommended Framer targets for an admin field type (recommended[0] = default). */
export function recommendedFramerTypes(adminType: string): string[] {
  return ADMIN_TYPE_RECS[adminType as AdminFieldType]?.recommended ?? ['string'];
}

/** The compatible (non-risky) Framer targets for an admin field type. */
export function compatibleFramerTypes(adminType: string): string[] {
  return ADMIN_TYPE_RECS[adminType as AdminFieldType]?.compatible ?? ['string'];
}

/** The default Framer target for a freshly-added field of `adminType`. */
export function defaultFramerType(adminType: string): string {
  return recommendedFramerTypes(adminType)[0] ?? 'string';
}

/**
 * Classify a chosen Framer target for an admin field type:
 *   'ok'      — recommended/compatible (no warning).
 *   'risky'   — a settable type outside the compatible set (e.g. number → image): the
 *               value will almost certainly be dropped by coerceToFramerType on push.
 *   'invalid' — not a settable Framer target (can't be applied via /schema, e.g. enum).
 */
export function classifyConversion(
  adminType: string,
  framerTarget: string
): 'ok' | 'risky' | 'invalid' {
  if (!isSettableFramerType(framerTarget)) return 'invalid';
  return compatibleFramerTypes(adminType).includes(framerTarget) ? 'ok' : 'risky';
}

/** A human warning string for a risky/invalid conversion, or null when ok. */
export function conversionWarning(adminType: string, framerTarget: string): string | null {
  const c = classifyConversion(adminType, framerTarget);
  if (c === 'ok') return null;
  if (c === 'invalid') {
    return `“${framerTypeLabel(framerTarget)}” can’t be applied to Framer automatically — pick a settable type.`;
  }
  return `Converting a ${adminType} field to “${framerTypeLabel(
    framerTarget
  )}” is risky: incompatible values are dropped on the next push.`;
}
