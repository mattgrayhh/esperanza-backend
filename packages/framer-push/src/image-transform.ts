// =============================================================================
// esperanza-cf framer-push — Cloudflare Images URL transformation.
//
// WHY: images are stored full-resolution in R2 (esperanza-cms →
// pub-<hash>.r2.dev) with NO compression on the path to the live site. Framer
// re-hosts image-field sources at sync time, so the lever to shrink page weight
// is to hand Framer (and any raw-URL consumer) an ALREADY-compressed source.
//
// HOW: rewrite each R2 image URL to a Cloudflare Images "transform via URL"
// request served from a delivery domain that fronts the same R2 bucket, e.g.
//   https://pub-<hash>.r2.dev/qmi/<id>/hero.jpg
//     -> https://img.hazardhouse.ai/cdn-cgi/image/format=auto,quality=80,width=1920/qmi/<id>/hero.jpg
// format=auto negotiates WebP/AVIF per browser; width caps the source so the
// original 5 MB JPEG never leaves R2 at full size. (Transformations must be
// enabled on the delivery zone; the bucket is exposed at the delivery host as a
// public R2 custom domain. PDFs/SVGs are NOT raster-transformable and pass
// through unchanged — and link() fields, which carry PDFs, are never wrapped.)
//
// CONFIG (per-Worker-invocation, set from env at the handler entry points):
//   IMAGES_TRANSFORM_BASE  delivery origin, e.g. "https://img.hazardhouse.ai".
//                          UNSET → passthrough (no-op). This is the kill switch:
//                          deploying without it changes nothing; setting it (then
//                          a backfill) activates compression.
//   IMAGES_TRANSFORM_OPTS  cdn-cgi option string. Default below.
// Module-singleton (not threaded through every mapper) so the pure value
// builders in framer-types.ts stay env-free and unit-testable. Tests get the
// default (passthrough) unless they call configureImageTransform().
// =============================================================================

const DEFAULT_OPTS = 'format=auto,quality=80,width=1920';

let base = '';
let opts = DEFAULT_OPTS;

/** Set from env at each Worker entry point. Empty/missing base → passthrough. */
export function configureImageTransform(b?: string | null, o?: string | null): void {
  base = (b ?? '').trim().replace(/\/+$/, '');
  opts = o && o.trim() ? o.trim() : DEFAULT_OPTS;
}

/** Reset to defaults — for tests. */
export function resetImageTransform(): void {
  base = '';
  opts = DEFAULT_OPTS;
}

/** Only our R2 public bucket hosts are rewritten; everything else is left alone. */
const R2_HOST = /(^|\.)r2\.dev$/i;

/**
 * Wrap an R2-hosted image URL in a Cloudflare Images transform served from the
 * configured delivery domain. Returns the input UNCHANGED when:
 *   - no delivery base is configured (default — safe no-op),
 *   - the value isn't a parseable absolute URL,
 *   - the host isn't *.r2.dev (don't touch external / framerusercontent / data URLs),
 *   - the asset is a PDF or SVG (not raster-transformable),
 *   - it's already a /cdn-cgi/image/ transform URL (idempotent).
 */
export function transformImageUrl(value: string): string {
  if (!base || !value) return value;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return value;
  }
  if (!R2_HOST.test(u.hostname)) return value;
  if (u.pathname.includes('/cdn-cgi/image/')) return value;
  if (/\.(pdf|svg)$/i.test(u.pathname)) return value;
  return `${base}/cdn-cgi/image/${opts}${u.pathname}`;
}
