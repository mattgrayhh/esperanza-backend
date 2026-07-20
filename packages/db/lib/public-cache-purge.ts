// =============================================================================
// @esperanza/db — public API edge-cache purge helpers.
//
// Admin and ingest call esperanza-api after writes so the static frontend sees
// edits within moments instead of waiting for the cache TTL (≤5 min).
// =============================================================================

/** Admin entity key → api `/api/public/<entity>` paths to bust. */
export const PUBLIC_CACHE_DEPS: Record<string, readonly string[]> = {
  promotions: ['promotions', 'communities', 'cities', 'qmi'],
  communities: ['communities', 'cities', 'qmi'],
  floor_plans: ['floorplans', 'qmi'],
  qmi: ['qmi'],
  cities: ['cities'],
  collections: ['collections'],
  images: ['images'],
  blogs: ['blogs'],
  testimonials: ['testimonials'],
  settings: ['settings'],
};

/** Purged on every write — the header search index spans all live collections. */
export const PUBLIC_CACHE_ALWAYS = ['sitesearch'] as const;

export function publicCacheEntitiesFor(collection: string): string[] {
  const deps = PUBLIC_CACHE_DEPS[collection];
  const base = deps ? [...deps] : collection ? [collection] : [];
  return [...new Set([...base, ...PUBLIC_CACHE_ALWAYS])];
}

export interface PublicCachePurgeEnv {
  API_PUBLIC_URL?: string;
  PURGE_KEY?: string;
  /** Cloudflare service binding to esperanza-api (preferred over the public URL). */
  API?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

/** Best-effort: a purge failure must never fail the save (the TTL is the backstop). */
export async function purgePublicCacheEntities(
  env: PublicCachePurgeEnv,
  entities: Iterable<string>
): Promise<void> {
  const list = [...new Set(entities)];
  if (list.length === 0) return;
  if (!env.PURGE_KEY) {
    console.warn('[purge] PURGE_KEY unset — public cache not purged for', list.join(', '));
    return;
  }
  const base = (env.API_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (!env.API && !base) {
    console.warn('[purge] no API binding or API_PUBLIC_URL — public cache not purged for', list.join(', '));
    return;
  }

  const headers = { 'X-Purge-Key': env.PURGE_KEY };
  await Promise.all(
    list.map(async (entity) => {
      try {
        const path = `/api/public/${entity}?purge=1`;
        const res = env.API
          ? await env.API.fetch(new Request(`https://esperanza-api.internal${path}`, { method: 'GET', headers }))
          : await fetch(`${base}${path}`, { method: 'GET', headers });
        if (res.headers.get('X-Purge-Applied') !== '1') {
          console.error(
            `[purge] ${entity}: purge not applied (HTTP ${res.status}, X-Cache=${res.headers.get('X-Cache') ?? '—'})`
          );
        }
      } catch (err) {
        console.error('[purge]', entity, err);
      }
    })
  );
}

export async function purgePublicCache(env: PublicCachePurgeEnv, collection: string): Promise<void> {
  await purgePublicCacheEntities(env, publicCacheEntitiesFor(collection));
}
