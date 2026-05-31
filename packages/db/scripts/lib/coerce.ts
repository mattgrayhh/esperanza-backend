// =============================================================================
// esperanza-cf — value coercion helpers (Phase 2 import).
//
// Reproduces Airtable's native value encodings into the D1 column types per the
// raw-record contract in the manifests:
//   * numbers stay numbers (postal_code, price, beds, sqft, ...).
//   * checkboxes: true when checked, OMITTED when unchecked (so undefined => 0).
//   * multipleRecordLinks: ARRAY of recXXXX ids — we keep the ARRAY (link
//     resolution decides whether to take [0] or join all).
//   * multipleAttachments: ARRAY of {id,url,filename,size,type,thumbnails} — the
//     url is an EXPIRING v5.airtableusercontent.com signed URL. migrate-images.ts
//     rewrites these to stable R2 urls; the importer stores the RAW attachment
//     objects only transiently (never persisted with a signed url — see guard).
//   * FP:* multipleLookupValues: single-element arrays ([x]) / double-wrapped
//     ([[{url}]]) — preserved as JSON so the api Worker reproduces the shape.
// =============================================================================

export const FORBIDDEN_IMAGE_HOST = 'airtableusercontent.com';

/** An Airtable attachment object (as returned under fields[<attachmentField>]). */
export interface AirtableAttachment {
  id?: string;
  url: string;
  filename?: string;
  size?: number;
  type?: string;
  thumbnails?: unknown;
}

export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** Airtable number cell -> JS number | null (never a string). */
export function num(v: unknown): number | null {
  if (isBlank(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Airtable integer cell -> rounded int | null. */
export function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

/** Airtable checkbox: true when checked, OMITTED (=> false) when not. */
export function bool(v: unknown): boolean {
  return v === true;
}
/** Boolean -> 0/1 for INTEGER columns. */
export function boolInt(v: unknown): number {
  return v === true ? 1 : 0;
}

/** Plain string | null. Flattens single-element arrays + {value} wrapper objects. */
export function str(v: unknown): string | null {
  if (isBlank(v)) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const joined = v
      .map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x)))
      .filter((s) => s !== '')
      .join(', ');
    return joined === '' ? null : joined;
  }
  if (typeof v === 'object') {
    // Town (TXT) can arrive as {value} / {state,value,isStale}
    const obj = v as Record<string, unknown>;
    if ('value' in obj) return str(obj.value);
  }
  return null;
}

/** A multipleRecordLinks cell -> array of recXXXX ids (or []). */
export function linkIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.startsWith('rec'));
}

/** First linked record id, or null. */
export function firstLinkId(v: unknown): string | null {
  return linkIds(v)[0] ?? null;
}

/** CSV of linked record ids (Floor Plan quick_move_in_ids / promotion_ids shape). */
export function linkCsv(v: unknown): string | null {
  const ids = linkIds(v);
  return ids.length ? ids.join(',') : null;
}

/** A multipleAttachments cell -> array of attachment objects (or []). */
export function attachments(v: unknown): AirtableAttachment[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is AirtableAttachment => !!x && typeof x === 'object' && typeof (x as any).url === 'string'
  );
}

/** First attachment url, or null (RAW — may be a signed url; caller migrates it). */
export function firstAttachmentUrl(v: unknown): string | null {
  return attachments(v)[0]?.url ?? null;
}

/**
 * FP:* single-element-array lookup, preserved verbatim as JSON ("[3]" / "[\"Up\"]").
 * Returns null when the cell is absent so the column stays NULL (consumer treats
 * missing as unset). Pure structural passthrough — number-typed lookups keep
 * numbers, singleSelect lookups keep strings.
 */
export function jsonArray(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v) && v.length === 0) return null;
  return JSON.stringify(v);
}

/** Recursively find the first airtableusercontent.com URL in a value (guard). */
export function findAirtableUrl(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = findAirtableUrl(parsed);
        if (nested) return nested;
        return null;
      } catch {
        /* not JSON — fall through */
      }
    }
    return value.includes(FORBIDDEN_IMAGE_HOST) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findAirtableUrl(v);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const hit = findAirtableUrl(v);
      if (hit) return hit;
    }
  }
  return null;
}
