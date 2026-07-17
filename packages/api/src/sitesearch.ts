// =============================================================================
// /api/public/sitesearch — the unified header-search index.
//
// Clone of the legacy O'Neil Interactive `/sitesearch.json` feed: a single flat
// array fetched once by the client and filtered in-browser (no per-keystroke
// network). Each record is { label, type, href }. The frontend's SiteSearch
// component does case-insensitive substring matching over `label` and navigates
// to `href` on select.
//
// Source = the existing v_public_* views (which already enforce `published = 1`),
// so this index only ever contains live pages. A QMI emits TWO records — one
// keyed by street address ("quick move in"), one by lot number ("lot number") —
// both pointing at the same QMI page, exactly like the legacy widget.
//
// This module is intentionally self-contained (no imports from index.ts) so it
// can evolve independently of the main serializer file. index.ts wires it in
// with a single `case 'sitesearch'` (see docs/sitesearch-clone-design.md).
//
// QMI hrefs MUST use the same public slug the frontend renders (dashes
// normalized to underscores, with the viewer/seo/rich/slug precedence), so the
// QMI slug is derived via the shared `qmiPublicSlug` rather than the raw `slug`
// column — otherwise every QMI/lot-number result 404s.
// =============================================================================

import { qmiPublicSlug } from '@esperanza/db/slug';

export type SiteSearchType =
  | 'community'
  | 'floor plan'
  | 'quick move in'
  | 'lot number'
  | 'blog';

export interface SiteSearchRecord {
  label: string;
  type: SiteSearchType;
  href: string;
}

/** Public path prefixes on the frontend (corrected 2026-06-03). */
export interface BaseUrls {
  community: string;
  floorPlan: string;
  qmi: string;
  blog: string;
}

export const DEFAULT_BASE_URLS: BaseUrls = {
  community: '/new-homes',
  floorPlan: '/floorplans',
  qmi: '/new-homes/available',
  blog: '/blog',
};

/**
 * SQL run against the public views. The views already filter `published = 1`,
 * so no gate is repeated here — we just select the label + slug columns.
 */
export const SITESEARCH_SQL = {
  communities: 'SELECT name, slug FROM v_public_communities',
  floorPlans: 'SELECT name, slug FROM v_public_floor_plans',
  // id + all slug-source columns so the QMI href matches the live page
  // slug exactly (see qmiPublicSlug). The raw `slug` alone is dash-cased and 404s.
  qmis: 'SELECT id, address, community, lot_number, slug, seo_slug, rich_slug, viewer_slug FROM v_public_qmi',
  blogs: 'SELECT title, slug FROM v_public_blogs',
} as const;

interface RawRows {
  communities: ReadonlyArray<{ name?: unknown; slug?: unknown }>;
  floorPlans: ReadonlyArray<{ name?: unknown; slug?: unknown }>;
  qmis: ReadonlyArray<{
    id?: unknown;
    address?: unknown;
    community?: unknown;
    lot_number?: unknown;
    slug?: unknown;
    seo_slug?: unknown;
    rich_slug?: unknown;
    viewer_slug?: unknown;
  }>;
  blogs: ReadonlyArray<{ title?: unknown; slug?: unknown }>;
}

// -- helpers ------------------------------------------------------------------
const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const joinUrl = (base: string, slug: string): string => `${base.replace(/\/+$/, '')}/${slug}`;

// -----------------------------------------------------------------------------
// buildIndex — pure serializer. Given rows shaped like the view output, returns
// the flat search index. Rows missing a slug or a usable label are dropped.
// -----------------------------------------------------------------------------
export function buildIndex(rows: RawRows, base: BaseUrls = DEFAULT_BASE_URLS): SiteSearchRecord[] {
  const out: SiteSearchRecord[] = [];

  for (const c of rows.communities) {
    const label = str(c.name);
    const slug = str(c.slug);
    if (label && slug) out.push({ label, type: 'community', href: joinUrl(base.community, slug) });
  }

  for (const f of rows.floorPlans) {
    const label = str(f.name);
    const slug = str(f.slug);
    if (label && slug) out.push({ label, type: 'floor plan', href: joinUrl(base.floorPlan, slug) });
  }

  for (const q of rows.qmis) {
    const slug = qmiPublicSlug(q);
    if (!slug) continue;
    const href = joinUrl(base.qmi, slug);
    const community = str(q.community);
    const address = str(q.address);
    const lot = str(q.lot_number);

    if (address) {
      const label = community ? `${address} at ${community}` : address;
      out.push({ label, type: 'quick move in', href });
    }
    if (lot) {
      const label = community ? `Lot ${lot} — ${community}` : `Lot ${lot}`;
      out.push({ label, type: 'lot number', href });
    }
  }

  for (const b of rows.blogs) {
    const label = str(b.title);
    const slug = str(b.slug);
    if (label && slug) out.push({ label, type: 'blog', href: joinUrl(base.blog, slug) });
  }

  return out;
}

/** Minimal shape of the D1 session this module needs (matches D1DatabaseSession). */
interface Preparable {
  prepare(sql: string): { all(): Promise<{ results?: unknown[] }> };
}

/**
 * Query the four public views and assemble the index. Used by index.ts inside
 * the standard Cache-API wrap. Returns the response payload `{ results, ts }`.
 */
export async function buildSiteSearchPayload(
  session: Preparable,
  base: BaseUrls = DEFAULT_BASE_URLS,
): Promise<{ results: SiteSearchRecord[]; ts: number }> {
  const [c, f, q, b] = await Promise.all([
    session.prepare(SITESEARCH_SQL.communities).all(),
    session.prepare(SITESEARCH_SQL.floorPlans).all(),
    session.prepare(SITESEARCH_SQL.qmis).all(),
    session.prepare(SITESEARCH_SQL.blogs).all(),
  ]);
  const results = buildIndex(
    {
      communities: (c.results ?? []) as RawRows['communities'],
      floorPlans: (f.results ?? []) as RawRows['floorPlans'],
      qmis: (q.results ?? []) as RawRows['qmis'],
      blogs: (b.results ?? []) as RawRows['blogs'],
    },
    base,
  );
  return { results, ts: Date.now() };
}
