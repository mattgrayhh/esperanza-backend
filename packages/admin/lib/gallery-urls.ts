// =============================================================================
// packages/admin — gallery-URL parsing for the ImageGalleryEditor widget.
//
// A single column carries an ordered gallery. Two on-disk shapes exist and BOTH must
// be readable:
//   · JSON array of bare strings        — what the widget itself serializes on save.
//   · JSON array of { url, ... } objects — the legacy Airtable-synced galleries
//     (floor_plans.photo_gallery / elevation_gallery / additional_images_gallery,
//      qmi/community photo_gallery_json). Pull `.url` out of each object.
//
// If the parser dropped the object shape (its original behaviour), surfacing a synced
// gallery in the editor would render empty AND a save would write `[]` back — silently
// WIPING the column. This mirrors framer-push's galleryUrls() so the admin and the push
// pipeline agree on what a gallery contains.
// =============================================================================

/** Parse a stored gallery column into an ordered list of image URL strings. */
export function parseGalleryUrls(raw: string): string[] {
  if (!raw) return [];
  // Legacy newline-separated string (only when it isn't a JSON array).
  if (raw.indexOf('\n') !== -1 && raw.trim()[0] !== '[') {
    return raw
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON and not newline-separated → nothing usable.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      const s = item.trim();
      if (s) out.push(s);
    } else if (item && typeof item === 'object') {
      const u = (item as Record<string, unknown>)['url'];
      if (typeof u === 'string' && u.trim()) out.push(u.trim());
    }
  }
  return out;
}
