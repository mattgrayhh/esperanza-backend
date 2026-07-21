import { qmiPublicSlug } from '@esperanza/db/slug';
import type { EntityKey } from './entities';

export const LIVE_SITE_ORIGIN = 'https://esperanzahomes.hazardhouse.ai';

/** Staging Worker (workers.dev only — can never touch prod). Its /api proxy adds the
 *  preview secret, so the QMI detail island there renders DRAFT homes. Used to offer a
 *  shareable "Preview draft" link for unpublished QMI homes. */
export const STAGING_ORIGIN = 'https://esperanzahomes-staging.round-base-ed8c.workers.dev';
/** Runtime QMI detail shell — fetches live API data by ?slug= (dash slug). Used for drafts
 *  that do not yet have a baked static page. */
const QMI_PREVIEW_SHELL = '/new-homes/available/home/';

/** Canonical public QMI paths on esperanza-frontend: /new-homes/tx/{city}/{community}/{slug}/.
 *  The legacy /new-homes/available/{underscore_slug} pattern 404s on the live site. */
const QMI_TX_PREFIX = '/new-homes/tx';

/** Path prefixes — mirrors packages/api/src/sitesearch.ts DEFAULT_BASE_URLS. */
export const LIVE_SITE_PATHS = {
  community: '/new-homes',
  floorPlan: '/floorplans',
  qmi: '/new-homes/available',
  blog: '/blog',
  city: '/new-homes',
  promotion: '/incentives',
} as const;

export interface PlacementSection {
  id: string;
  label: string;
}

export interface LiveSitePlacement {
  pageLabel: string;
  path: string | null;
  fullUrl: string | null;
  visitorStatus: string;
  /** True only when the public page actually exists (record is published/active). Drafts
      resolve a slug but 404 on the public site — the UI must not offer a broken "preview". */
  isLive: boolean;
  /** Shareable staging preview URL (QMI only). Renders the home — including DRAFTS — on
      the staging Worker without touching production. Null for non-QMI or when no slug. */
  previewUrl: string | null;
  sections: PlacementSection[];
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function col(row: Record<string, unknown>, key: string): unknown {
  const v = row[key];
  if (v !== undefined) return v;
  const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return row[camel];
}

function joinPath(base: string, slug: string): string {
  return `${base.replace(/\/+$/, '')}/${slug.replace(/^\/+/, '')}`;
}

function fullUrl(path: string | null): string | null {
  if (!path) return null;
  return `${LIVE_SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Dash slug from qmi.slug — the segment the frontend hierarchical URL and API use. */
export function qmiDashSlug(row: Record<string, unknown>): string {
  return str(col(row, 'slug'));
}

/**
 * Build the live-site QMI detail path. Prefer the baked hierarchical route the frontend
 * ships (/new-homes/tx/{city}/{community}/{dash-slug}/), which qmi-links.json indexes.
 * Falls back to page_url when it already points at a short tx path, then the legacy
 * /new-homes/available/{underscore_slug} pattern (may 404 until a frontend rebuild).
 *
 * Optional row keys: city_slug, community_slug (from joined cities/communities).
 */
export function qmiDetailPath(row: Record<string, unknown>): string | null {
  const dashSlug = qmiDashSlug(row);
  const citySlug = str(col(row, 'city_slug'));
  const communitySlug = str(col(row, 'community_slug'));
  if (dashSlug && citySlug && communitySlug) {
    return `${QMI_TX_PREFIX}/${citySlug}/${communitySlug}/${dashSlug}/`;
  }

  const pageUrl = str(col(row, 'page_url'));
  if (pageUrl) {
    try {
      const pathname = pageUrl.startsWith('http')
        ? new URL(pageUrl).pathname
        : pageUrl.startsWith('/')
          ? pageUrl
          : `/${pageUrl}`;
      const short = pathname.match(/^(\/new-homes\/tx\/[^/]+\/[^/]+\/[^/]+)\/?$/);
      if (short) return short[1]!.endsWith('/') ? short[1]! : `${short[1]}/`;
    } catch {
      /* ignore malformed page_url */
    }
  }

  const legacy = resolveSlug('qmi', row);
  return legacy ? joinPath(LIVE_SITE_PATHS.qmi, legacy) : null;
}

export function resolveSlug(entity: EntityKey, row: Record<string, unknown>): string {
  switch (entity) {
    case 'qmi':
      return qmiPublicSlug({
        id: col(row, 'id'),
        viewer_slug: col(row, 'viewer_slug'),
        seo_slug: col(row, 'seo_slug'),
        rich_slug: col(row, 'rich_slug'),
        slug: col(row, 'slug'),
        address: col(row, 'override_address') ?? col(row, 'synced_address') ?? col(row, 'address'),
      });
    case 'communities':
    case 'floor_plans':
    case 'cities':
    case 'blogs':
    case 'promotions':
    case 'collections':
      return str(col(row, 'slug'));
    case 'images':
      return str(col(row, 'slug')) || str(col(row, 'plan_name'));
    case 'testimonials':
      return str(col(row, 'slug'));
    default:
      return '';
  }
}

export function liveSitePath(entity: EntityKey, row: Record<string, unknown>): string | null {
  if (entity === 'qmi') return qmiDetailPath(row);
  const slug = resolveSlug(entity, row);
  if (!slug) return null;
  switch (entity) {
    case 'communities':
      return joinPath(LIVE_SITE_PATHS.community, slug);
    case 'floor_plans':
      return joinPath(LIVE_SITE_PATHS.floorPlan, slug);
    case 'blogs':
      return joinPath(LIVE_SITE_PATHS.blog, slug);
    case 'cities':
      return joinPath(LIVE_SITE_PATHS.city, slug);
    case 'promotions':
      return LIVE_SITE_PATHS.promotion;
    default:
      return null;
  }
}

const SECTIONS: Partial<Record<EntityKey, PlacementSection[]>> = {
  qmi: [
    { id: 'hero', label: 'Hero photo & address' },
    { id: 'price', label: 'Price strip' },
    { id: 'specs', label: 'Beds, baths, sqft' },
    { id: 'description', label: 'Description' },
    { id: 'gallery', label: 'Photo gallery' },
  ],
  communities: [
    { id: 'hero', label: 'Hero banner' },
    { id: 'stats', label: 'Starting price & stats' },
    { id: 'description', label: 'Description' },
    { id: 'amenities', label: 'Amenities & copy blocks' },
    { id: 'map', label: 'Map & directions' },
    { id: 'gallery', label: 'Photo gallery' },
  ],
  blogs: [
    { id: 'hero', label: 'Featured image' },
    { id: 'title', label: 'Title & excerpt' },
    { id: 'body', label: 'Article body' },
  ],
  floor_plans: [
    { id: 'hero', label: 'Main image' },
    { id: 'layout', label: 'Floor plan drawing' },
    { id: 'specs', label: 'Beds, baths, sqft, price' },
    { id: 'copy', label: 'Description & features' },
  ],
  cities: [
    { id: 'hero', label: 'City hero' },
    { id: 'communities', label: 'Communities list' },
    { id: 'copy', label: 'Venue & lifestyle copy' },
  ],
  promotions: [
    { id: 'banner', label: 'Site-wide banner' },
    { id: 'cards', label: 'Cards on targeted pages' },
    { id: 'incentives', label: 'Incentives page card' },
  ],
};

const PAGE_LABELS: Record<EntityKey, string> = {
  qmi: 'Quick Move-In home page',
  communities: 'Community page',
  cities: 'City page',
  floor_plans: 'Floor plan page',
  promotions: 'Promotion surfaces',
  collections: 'Collection (internal group)',
  images: 'Image library (CDN asset)',
  blogs: 'Blog post',
  testimonials: 'Testimonial (embedded on site)',
};

export function visitorStatusLabel(
  entity: EntityKey,
  opts: { published?: boolean; status?: string; active?: boolean },
): string {
  if (entity === 'promotions') {
    const active = opts.active ?? opts.published;
    return active ? 'Active' : 'Inactive';
  }
  if (entity === 'collections' || entity === 'images') {
    return 'Always on';
  }
  if (entity === 'testimonials') {
    return 'Live when referenced';
  }
  const status = str(opts.status);
  if (status) return status;
  return opts.published ? 'Published' : 'Draft';
}

export function buildLiveSitePlacement(
  entity: EntityKey,
  row: Record<string, unknown>,
  gate?: { published?: boolean; status?: string; active?: boolean },
): LiveSitePlacement {
  const path = liveSitePath(entity, row);
  // The public site only renders published/active records; a draft resolves a slug but
  // 404s. Coming-soon counts as live (the page renders). Fall back to `active` for
  // entities gated on that instead of `published`.
  const isLive = Boolean(path) && Boolean(gate?.published ?? gate?.active ?? false);
  // QMI staging preview: published homes with a hierarchical path open the baked page on
  // staging (same static assets as prod). Drafts / homes without city+community use the
  // runtime shell — MUST pass the dash slug (qmi.slug); the API matches on dashes, not
  // viewer_slug underscores, or the island shows "This home is no longer available".
  let previewUrl: string | null = null;
  if (entity === 'qmi') {
    const dashSlug = qmiDashSlug(row);
    const txPath = qmiDetailPath(row);
    const txLooksCanonical =
      txPath?.startsWith(`${QMI_TX_PREFIX}/`) && txPath.split('/').filter(Boolean).length >= 5;
    if (isLive && txLooksCanonical && txPath) {
      previewUrl = `${STAGING_ORIGIN}${txPath}`;
    } else if (dashSlug) {
      previewUrl = `${STAGING_ORIGIN}${QMI_PREVIEW_SHELL}?slug=${encodeURIComponent(dashSlug)}&preview=1`;
    }
  }
  return {
    pageLabel: PAGE_LABELS[entity],
    path,
    fullUrl: fullUrl(path),
    visitorStatus: visitorStatusLabel(entity, gate ?? {}),
    isLive,
    previewUrl,
    sections: SECTIONS[entity] ?? [{ id: 'content', label: 'Page content' }],
  };
}
