import { describe, expect, it, vi } from 'vitest';
import { publicCacheEntitiesFor, purgePublicCache } from '../lib/public-cache-purge';
import { triggerFrontendRebuild } from '../lib/site-rebuild';

describe('publicCacheEntitiesFor', () => {
  it('includes promo-coupled dependents and sitesearch', () => {
    expect(publicCacheEntitiesFor('promotions')).toEqual([
      'promotions',
      'communities',
      'cities',
      'qmi',
      'sitesearch',
      'sitesearch.json',
    ]);
  });

  it('maps floor_plans to the api floorplans path', () => {
    expect(publicCacheEntitiesFor('floor_plans')).toContain('floorplans');
    expect(publicCacheEntitiesFor('floor_plans')).toContain('sitesearch');
  });
});

describe('purgePublicCache', () => {
  it('warns and skips when PURGE_KEY is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await purgePublicCache({ API_PUBLIC_URL: 'https://api.example' }, 'qmi');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sends X-Purge-Key and checks X-Purge-Applied', async () => {
    const fetch = vi.fn(async () => new Response('{}', { headers: { 'X-Purge-Applied': '1' } }));
    await purgePublicCache(
      { API_PUBLIC_URL: 'https://api.example', PURGE_KEY: 'secret', API: { fetch } },
      'qmi'
    );
    expect(fetch).toHaveBeenCalled();
    const req = fetch.mock.calls[0]![0] as Request;
    expect(req.url).toContain('/api/public/qmi?purge=1');
    expect(req.headers.get('X-Purge-Key')).toBe('secret');
  });

  it('also purges the frontend proxy when FRONTEND_PUBLIC_URL is set', async () => {
    const globalFetch = vi.fn(async () => new Response('{}', { headers: { 'X-Purge-Applied': '1' } }));
    vi.stubGlobal('fetch', globalFetch);
    const apiFetch = vi.fn(async () => new Response('{}', { headers: { 'X-Purge-Applied': '1' } }));
    await purgePublicCache(
      {
        API_PUBLIC_URL: 'https://api.example',
        FRONTEND_PUBLIC_URL: 'https://frontend.example',
        FRONTEND_STAGING_PUBLIC_URL: 'https://staging.example',
        PURGE_KEY: 'secret',
        API: { fetch: apiFetch },
      },
      'qmi'
    );
    expect(apiFetch).toHaveBeenCalledTimes(3); // qmi + sitesearch + sitesearch.json
    expect(globalFetch).toHaveBeenCalledTimes(6); // 3 entities × 2 frontend origins
    const frontendUrls = globalFetch.mock.calls.map((c) => String(c[0]));
    expect(frontendUrls).toContain('https://frontend.example/api/public/qmi?purge=1');
    expect(frontendUrls).toContain('https://staging.example/api/public/qmi?purge=1');
    vi.unstubAllGlobals();
  });
});

describe('triggerFrontendRebuild', () => {
  it('warns and skips when FRONTEND_DEPLOY_HOOK_URL is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await triggerFrontendRebuild({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('POSTs to the deploy hook', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await triggerFrontendRebuild({ FRONTEND_DEPLOY_HOOK_URL: 'https://hooks.example/deploy' });
    expect(fetch).toHaveBeenCalledWith('https://hooks.example/deploy', { method: 'POST' });
    vi.unstubAllGlobals();
  });
});
