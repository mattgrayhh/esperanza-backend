import { qmiPublicSlug } from '@esperanza/db/slug';
import type { EntityKey } from './entities';

export const LIVE_SITE_ORIGIN = 'https://www.esperanzahomes.com';

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
  const slug = resolveSlug(entity, row);
  if (!slug) return null;
  switch (entity) {
    case 'qmi':
      return joinPath(LIVE_SITE_PATHS.qmi, slug);
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
  return {
    pageLabel: PAGE_LABELS[entity],
    path,
    fullUrl: fullUrl(path),
    visitorStatus: visitorStatusLabel(entity, gate ?? {}),
    sections: SECTIONS[entity] ?? [{ id: 'content', label: 'Page content' }],
  };
}
