// =============================================================================
// packages/admin/lib/pdf-tree — pure helpers for the PDFs drill-down section.
//
// NO 'use server' — these are plain pure functions with zero Cloudflare / Next.js
// boundary imports so they are testable in Node/vitest without any mocking.
// The server action (pdf-actions.ts) imports computeRegenerateUpdate; the RSC page
// (app/pdfs/page.tsx) imports buildPdfTree.
// =============================================================================

export interface PdfRenderRowLite {
  type: string;
  slug: string;
  city_slug: string | null;
  community_id: string | null;
  status: string;
  entity_id: string | null;
}

export interface PdfLeaf {
  slug: string;
  status: string;
  entityId: string | null;
  type: string;
}

export interface PdfCommunityNode {
  communityId: string;
  plans: PdfLeaf[];
  specs: PdfLeaf[];
  self: PdfLeaf | null;
}

export interface PdfCityNode {
  citySlug: string;
  lists: PdfLeaf[];
  communities: PdfCommunityNode[];
}

/**
 * Group flat pdf_renders rows into a City → Community → {plans, specs} tree.
 * City-level "list" renders go into city.lists. "community" renders populate
 * community.self. "floorplan" renders → community.plans, "qmi" renders → community.specs.
 * Cities are returned sorted alphabetically by citySlug.
 */
export function buildPdfTree(rows: PdfRenderRowLite[]): PdfCityNode[] {
  const cities = new Map<string, PdfCityNode>();
  const city = (s: string) =>
    cities.get(s) ?? cities.set(s, { citySlug: s, lists: [], communities: [] }).get(s)!;
  const comm = (c: PdfCityNode, id: string) =>
    c.communities.find((x) => x.communityId === id) ??
    (c.communities.push({ communityId: id, plans: [], specs: [], self: null }),
    c.communities[c.communities.length - 1]!);

  for (const r of rows) {
    const leaf: PdfLeaf = { slug: r.slug, status: r.status, entityId: r.entity_id, type: r.type };
    const cs = r.city_slug ?? '—';
    if (r.type === 'list') {
      city(cs).lists.push(leaf);
      continue;
    }
    const cn = comm(city(cs), r.community_id ?? '—');
    if (r.type === 'community') cn.self = leaf;
    else if (r.type === 'floorplan') cn.plans.push(leaf);
    else if (r.type === 'qmi') cn.specs.push(leaf);
  }
  return [...cities.values()].sort((a, b) => a.citySlug.localeCompare(b.citySlug));
}

/**
 * Compute the SQL + binds to mark a single render stale → forces re-render on next
 * request. Pure (no side effects) — called from the server action which executes it.
 * Skips rows already in 'rendering' state (the worker has a lease on them).
 */
export function computeRegenerateUpdate(
  type: string,
  slug: string,
): { sql: string; binds: unknown[] } {
  return {
    sql: `UPDATE pdf_renders SET status='stale' WHERE type=? AND slug=? AND status<>'rendering'`,
    binds: [type, slug],
  };
}
