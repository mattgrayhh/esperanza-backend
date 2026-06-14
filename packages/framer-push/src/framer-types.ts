// =============================================================================
// esperanza-cf framer-push — Framer Managed CMS field/item shapes.
//
// Ports the ItemInput contract from esperanza-sync (d.ts:2742
// ManagedCollectionItemInput + setup.ts:17 FieldType union). The mappers in
// collections.ts emit exactly this shape; the FramerClient (framer.ts) hands it
// to `collection.addItems(items)` (upsert by `id`).
//
//   item   = { id (required unique — the Airtable/D1 recXXXX), slug (required
//             unique), draft?, fieldData }
//   value  = { type, value }   type ∈ string|number|boolean|image|link
//             |formattedText|array
//   array  = items, each { fieldData: { image: { type:"image", value:url } } }
//             (Framer ArrayField currently supports a SINGLE nested image item
//              per entry — setup.ts:22 — so a gallery is N entries, not one
//              entry with N images).
// =============================================================================

import { transformImageUrl } from './image-transform.js';

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'image'
  | 'link'
  | 'formattedText'
  | 'date'
  | 'array';

/** One scalar field value: { type, value }. */
export interface FieldValue {
  type: Exclude<FieldType, 'array'>;
  value: string | number | boolean;
}

/** One array entry. The esperanza gallery shape: a single nested image. */
export interface ArrayEntry {
  fieldData: {
    image: { type: 'image'; value: string };
  };
}

/** An array field value. */
export interface ArrayFieldValue {
  type: 'array';
  value: ArrayEntry[];
}

export type AnyFieldValue = FieldValue | ArrayFieldValue;

/** fieldData is keyed by Framer field id; each value is { type, value }. */
export type FieldData = Record<string, AnyFieldValue>;

/**
 * ManagedCollectionItemInput. `id` is the UPSERT KEY (the D1/Airtable record id)
 * — "Using an ID instead of the slug helps avoid data loss." `slug` is required &
 * unique. `draft:true` hides the item from production after publish/deploy
 * WITHOUT removing the CMS item (soft-delete).
 */
export interface ManagedCollectionItemInput {
  id: string;
  slug: string;
  draft?: boolean;
  fieldData: FieldData;
}

// -- value constructors (keep type strings stable; setup.ts must match) --

export const str = (value: string): FieldValue => ({ type: 'string', value });
export const num = (value: number): FieldValue => ({ type: 'number', value });
export const bool = (value: boolean): FieldValue => ({ type: 'boolean', value });
// image() is the SINGLE choke point for every image-type value (mappers' imgIf,
// galleryArray below, and type-overrides' image case all route through here), so
// the Cloudflare Images transform is applied once, here. No-op until configured.
export const image = (value: string): FieldValue => ({ type: 'image', value: transformImageUrl(value) });
export const link = (value: string): FieldValue => ({ type: 'link', value });
export const formattedText = (value: string): FieldValue => ({
  type: 'formattedText',
  value,
});
// Framer's date field expects an ISO-8601 datetime string. D1 stores plain dates
// ("YYYY-MM-DD", e.g. blogs.publish_date) — normalise to midnight UTC here (the
// single choke point) so Framer parses them. Already-ISO values pass through; an
// unparseable value is carried verbatim (Framer drops it rather than us guessing).
export const toIsoDate = (value: string): string => {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? v : parsed.toISOString();
};
export const date = (value: string): FieldValue => ({ type: 'date', value: toIsoDate(value) });

/** Build an array field from a list of image urls (1 nested image per entry). */
export const galleryArray = (urls: string[]): ArrayFieldValue => ({
  type: 'array',
  value: urls.map((url) => ({
    fieldData: { image: { type: 'image', value: transformImageUrl(url) } },
  })),
});
