// =============================================================================
// Shared elevation → hero-image matching (importable by admin AND the api worker).
//
// A floor plan's `elevation_gallery` is JSON `[{ url, type }]` where `type` is the
// "<Style> <Material>" label (e.g. "Tuscan Brick", "Farmhouse"). A QMI carries its
// own elevation as style + material (override_/synced_ elevation_type + material_type,
// already COALESCE'd in v_public_qmi). composeElevation() joins them into the same
// label; pickElevationImage() returns the gallery url whose `type` matches, else null
// so callers fall back to fp_image — no match = today's behavior exactly.
//
// The admin's packages/admin/lib/elevation-types.ts owns type DERIVATION from
// filenames (the backfill/editor concern). This shared copy only MATCHES an explicit
// label against the already-typed gallery, so the api worker can import it via
// @esperanza/db/elevation-image without pulling in admin-only code.
// =============================================================================

/** Whitespace-collapsed, lower-cased key for case-insensitive label matching. */
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Compose "<Style> <Material>" from a QMI's elevation type + material (either may be blank). */
export function composeElevation(type: string | null | undefined, material: string | null | undefined): string {
  return `${(type ?? '').trim()} ${(material ?? '').trim()}`.trim().replace(/\s+/g, ' ');
}

/**
 * The gallery url whose `type` matches `elevationType` (case-insensitive, whitespace-
 * normalized), or null. `galleryJson` is the stored `[{url,type}]` JSON string (a parsed
 * array is also accepted). Returns null on empty/blank/unparseable input or no match.
 */
export function pickElevationImage(
  galleryJson: unknown,
  elevationType: string | null | undefined
): string | null {
  const want = norm(elevationType ?? '');
  if (!want) return null;
  let arr: unknown = galleryJson;
  if (typeof galleryJson === 'string') {
    if (galleryJson.trim() === '') return null;
    try {
      arr = JSON.parse(galleryJson);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const url = typeof rec['url'] === 'string' ? rec['url'].trim() : '';
      const type = typeof rec['type'] === 'string' ? rec['type'] : '';
      if (url && norm(type) === want) return url;
    }
  }
  return null;
}
