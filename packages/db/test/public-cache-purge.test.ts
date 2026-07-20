import { describe, expect, it, vi } from 'vitest';
import { publicCacheEntitiesFor, purgePublicCache } from '../lib/public-cache-purge';

describe('publicCacheEntitiesFor', () => {
  it('includes promo-coupled dependents and sitesearch', () => {
    expect(publicCacheEntitiesFor('promotions')).toEqual([
      'promotions',
      'communities',
      'cities',
      'qmi',
      'sitesearch',
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
});
