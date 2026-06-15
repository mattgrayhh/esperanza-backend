// =============================================================================
// Canonical public-URL slug derivation.
//
// SINGLE SOURCE OF TRUTH for the slug that appears in a live Framer page path.
// Both sides MUST agree or links break:
//   * framer-push (the WRITER) pushes `qmiPublicSlug(row)` as the Framer item slug,
//     so the QMI detail page lives at `/new-homes/available/<qmiPublicSlug>`.
//   * the api sitesearch index (the READER) builds its QMI href from the SAME
//     function, so the header search always points at the URL that exists.
//
// Before this was shared, the search worker emitted the raw (dash) `slug` column
// while framer-push normalized dashes→underscores — so every QMI/lot-number
// search result 404'd. Keep the derivation here; do not re-implement it.
// =============================================================================

/** Public slugs for QMI & Testimonials normalize dashes→underscores. */
export function toUnderscore(s: string): string {
  return s.replace(/-/g, '_');
}

/** kebab-case a name for slug derivation. */
export function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Record suffix used when deriving a slug from an address fallback: chars 3..11
 * of a `recXXXXXXXX…` id (or the id minus a leading `rec`). NOT lowercased —
 * mirrors framer-push's inline qmi-mapper suffix exactly.
 */
export function recSuffix(id: string): string {
  return id.length >= 11 ? id.slice(3, 11) : id.replace(/^rec/, '');
}

/** Join arrays to a string; pass scalars through; null/undefined/'' → undefined. */
function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) {
    const joined = v.filter((x) => x != null).join(', ');
    return joined === '' ? undefined : joined;
  }
  const s = String(v);
  return s === '' ? undefined : s;
}

/** The slug-source columns a QMI row must carry for slug derivation. */
export interface QmiSlugRow {
  id?: unknown;
  viewer_slug?: unknown;
  seo_slug?: unknown;
  rich_slug?: unknown;
  slug?: unknown;
  address?: unknown;
}

/**
 * The public QMI slug exactly as framer-push pushes it to Framer: the first
 * non-empty of viewer_slug → seo_slug → rich_slug → slug → kebab(address)-recSuffix
 * (→ id), normalized dashes→underscores.
 *
 * Note: framer-push additionally de-dupes slugs that collide across the whole
 * batch (a second home at the same address gets a `_<recSuffix>` suffix). That
 * is order-dependent and currently never fires (0 collisions in live data), so
 * the reader cannot reproduce it deterministically and does not try; the base
 * slug below matches the Framer page for every non-colliding home.
 */
export function qmiPublicSlug(row: QmiSlugRow): string {
  const id = String(row.id ?? '');
  const baseSlug =
    asString(row.viewer_slug) ??
    asString(row.seo_slug) ??
    asString(row.rich_slug) ??
    asString(row.slug) ??
    (asString(row.address) ? `${kebab(String(row.address))}-${recSuffix(id)}` : id);
  return toUnderscore(baseSlug);
}
