// =============================================================================
// packages/db — audit legacy O'Neill site (www.esperanzahomes.com) vs production D1.
//
// Crawls the legacy available-inventory listing, community pages, and floor-plan
// collection pages; compares against the esperanza-api public endpoints (D1 source
// of truth). Emits a JSON report with classified discrepancies.
//
// Usage (from repo root):
//   npx tsx packages/db/scripts/audit-oneill-site.ts
//   npx tsx packages/db/scripts/audit-oneill-site.ts --report /tmp/oneill-audit.json
//
// Optional env:
//   API_BASE_URL — defaults to https://esperanza-api.round-base-ed8c.workers.dev
//   LEGACY_BASE  — defaults to https://www.esperanzahomes.com
// =============================================================================

import { writeFileSync } from 'node:fs';

const API_BASE = process.env.API_BASE_URL ?? 'https://esperanza-api.round-base-ed8c.workers.dev';
const LEGACY_BASE = process.env.LEGACY_BASE ?? 'https://www.esperanzahomes.com';

/** Legacy URL slug → D1 slug (address formatting differs between O'Neill and MarkSystems). */
const LEGACY_QMI_SLUG_ALIASES: Record<string, string> = {
  '3626-peggy-dr': '3926-peggy-dr',
  '4417-pear-ave': '4417-n-pear-ave',
  '5315-moses-lp': '5315-moses-loop',
};

/** Legacy community path slug → D1 slug. */
const LEGACY_COMM_SLUG_ALIASES: Record<string, string> = {
  'retama-village-55-at-bentsen-palm': 'retama-village-(55-)-at-bentsen-palm',
};

const COLLECTIONS = [
  'harbor-collection',
  'haven-collection',
  'hearth-collection',
  'homestead-collection',
  'villas-collection',
  'retama-collection',
] as const;

interface LegacyQmi {
  slug: string;
  url: string;
  address?: string;
  price?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'EsperanzaAudit/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': 'EsperanzaAudit/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) links.push(m[1]!);
  return links;
}

function legacyQmiSlugFromHref(href: string): string | null {
  const m = href.match(/\/new-homes\/tx\/[^/]+\/[^/]+\/\d+\/([^/]+)\/\d+\/?$/);
  return m?.[1] ?? null;
}

function legacyCommSlugFromHref(href: string): string | null {
  const m = href.match(/\/new-homes\/tx\/[^/]+\/([^/]+)\/\d+\/?$/);
  return m?.[1] ?? null;
}

function d1SlugForLegacyQmi(slug: string): string {
  return LEGACY_QMI_SLUG_ALIASES[slug] ?? slug;
}

function parseLegacyQmiPage(html: string, url: string, slug: string): LegacyQmi {
  const ogDesc = html.match(/property="og:description"\s+content="([^"]+)"/)?.[1];
  const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1];
  const out: LegacyQmi = { slug, url };
  if (ogTitle) out.address = ogTitle.split(',')[0]?.trim();
  if (ogDesc) {
    const price = ogDesc.match(/\$([0-9,]+)/);
    const beds = ogDesc.match(/(\d+(?:\.\d+)?)\s*br/i);
    const baths = ogDesc.match(/(\d+(?:\.\d+)?)\s*ba/i);
    const sqft = ogDesc.match(/([\d,]+)\s*sqft/i);
    if (price) out.price = Number(price[1]!.replace(/,/g, ''));
    if (beds) out.beds = Number(beds[1]);
    if (baths) out.baths = Number(baths[1]);
    if (sqft) out.sqft = Number(sqft[1]!.replace(/,/g, ''));
  }
  return out;
}

async function crawlLegacyQmi(): Promise<{ slugs: Set<string>; details: Map<string, LegacyQmi> }> {
  const html = await fetchText(`${LEGACY_BASE}/new-homes/available/`);
  const slugs = new Set<string>();
  for (const href of extractLinks(html)) {
    const slug = legacyQmiSlugFromHref(href);
    if (slug) slugs.add(slug);
  }
  const details = new Map<string, LegacyQmi>();
  for (const slug of slugs) {
    const href = extractLinks(html).find((h) => h.includes(`/${slug}/`) && legacyQmiSlugFromHref(h));
    if (!href) continue;
    const url = href.startsWith('http') ? href : `${LEGACY_BASE}${href}`;
    const page = await fetchText(url);
    details.set(slug, parseLegacyQmiPage(page, url, slug));
  }
  return { slugs, details };
}

async function crawlLegacyCommunities(): Promise<Set<string>> {
  const html = await fetchText(`${LEGACY_BASE}/`);
  const slugs = new Set<string>();
  for (const href of extractLinks(html)) {
    const slug = legacyCommSlugFromHref(href);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

async function crawlLegacyFloorPlanNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const coll of COLLECTIONS) {
    const html = await fetchText(`${LEGACY_BASE}/floorplan-collections/${coll}/`);
    for (const m of html.matchAll(/>(Acuna II|Agave|Bahia|Birch|Brunello|Cypress|Encino|Iris|Juniper|Kestrel|Magnolia|Manzanita|Marigold|Marzano|Paloma|Presidio|San Lorenzo|San Luis|[A-Z][a-z]+(?: II)?)\s*</g)) {
      names.add(m[1]!.trim());
    }
  }
  return names;
}

interface ApiQmi {
  id: string;
  fields: Record<string, unknown>;
}

interface ApiCommunity {
  slug: string;
  name: string;
  priceFrom?: number;
  bedCount?: string;
  bathCount?: string;
  squareFootageRange?: string;
  published?: boolean;
}

interface ApiFloorPlan {
  name: string;
  slug: string;
  published: number | boolean;
  startingPrice?: number;
}

async function main(): Promise<void> {
  const reportPath = process.argv.includes('--report')
    ? process.argv[process.argv.indexOf('--report') + 1]
    : '/tmp/oneill-audit.json';

  console.log('Crawling legacy O\'Neill site…');
  const [{ slugs: legacyQmiSlugs, details: legacyQmiDetails }, legacyCommSlugs, legacyFpNames] =
    await Promise.all([crawlLegacyQmi(), crawlLegacyCommunities(), crawlLegacyFloorPlanNames()]);

  console.log('Fetching production API…');
  const [apiQmi, apiComm, apiFp] = await Promise.all([
    fetchJson<{ homes: ApiQmi[] }>(`${API_BASE}/api/public/qmi?purge=1`),
    fetchJson<{ communities: ApiCommunity[] }>(`${API_BASE}/api/public/communities`),
    fetchJson<{ floorplans: ApiFloorPlan[] }>(`${API_BASE}/api/public/floorplans`),
  ]);

  const d1BySlug = new Map(
    apiQmi.homes.map((h) => [String(h.fields.slug ?? ''), h])
  );
  const allPublishedSlugs = new Set(apiQmi.homes.map((h) => String(h.fields.slug ?? '')));

  const needPublish: Array<{ legacySlug: string; d1Slug: string; reason: string }> = [];
  const needIngest: string[] = [];
  const slugOnlyOnLegacy: string[] = [];
  const slugOnlyOnD1: string[] = [];
  const priceMismatch: Array<{ slug: string; legacy: number; d1: number; eci_key?: string }> = [];

  const legacyD1Slugs = new Set<string>();
  for (const legacySlug of legacyQmiSlugs) {
    const d1Slug = d1SlugForLegacyQmi(legacySlug);
    legacyD1Slugs.add(d1Slug);
    const row = d1BySlug.get(d1Slug);
    if (!row) {
      if (legacySlug === d1Slug) needIngest.push(legacySlug);
      else slugOnlyOnLegacy.push(`${legacySlug} → expected D1 ${d1Slug}`);
      continue;
    }
    if (!row.fields.Published) {
      needPublish.push({ legacySlug, d1Slug, reason: 'in D1 as draft' });
    }
    const lq = legacyQmiDetails.get(legacySlug);
    const d1Price = Number(row.fields.Price);
    if (lq?.price && d1Price && lq.price !== d1Price) {
      priceMismatch.push({
        slug: d1Slug,
        legacy: lq.price,
        d1: d1Price,
        eci_key: String(row.fields.eci_key ?? ''),
      });
    }
  }

  for (const slug of allPublishedSlugs) {
    if (!legacyD1Slugs.has(slug)) {
      const rev = Object.entries(LEGACY_QMI_SLUG_ALIASES).find(([, v]) => v === slug)?.[0];
      if (!rev || !legacyQmiSlugs.has(rev)) {
        slugOnlyOnD1.push(slug);
      }
    }
  }

  const d1CommBySlug = new Map(apiComm.communities.map((c) => [c.slug, c]));
  const commMissingD1: string[] = [];
  for (const legacySlug of legacyCommSlugs) {
    const d1Slug = LEGACY_COMM_SLUG_ALIASES[legacySlug] ?? legacySlug;
    if (!d1CommBySlug.has(d1Slug)) commMissingD1.push(legacySlug);
  }

  const d1FpByName = new Map(apiFp.floorplans.map((f) => [f.name.toLowerCase(), f]));
  const fpMissingD1 = [...legacyFpNames].filter((n) => !d1FpByName.has(n.toLowerCase()));

  const report = {
    auditedAt: new Date().toISOString(),
    summary: {
      legacyQmi: legacyQmiSlugs.size,
      apiPublishedQmi: apiQmi.homes.length,
      legacyCommunities: legacyCommSlugs.size,
      apiCommunities: apiComm.communities.length,
      legacyCollectionPlans: legacyFpNames.size,
      apiFloorPlans: apiFp.floorplans.length,
      needPublish: needPublish.length,
      needIngest: needIngest.length,
      priceMismatch: priceMismatch.length,
      commMissingD1: commMissingD1.length,
      fpMissingD1: fpMissingD1.length,
    },
    needPublish,
    needIngest,
    slugOnlyOnLegacy,
    slugOnlyOnD1,
    priceMismatch,
    commMissingD1,
    fpMissingD1,
    slugAliases: LEGACY_QMI_SLUG_ALIASES,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport → ${reportPath}`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (needPublish.length) console.log('\nNeed publish:', needPublish);
  if (needIngest.length) console.log('\nNeed ingest:', needIngest);
  if (priceMismatch.length) console.log('\nPrice mismatches (legacy vs D1/Snowflake):', priceMismatch);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
