// =============================================================================
// Purge esperanza-api (and frontend proxy) edge cache after remote D1 scripts.
//
// Admin saves do this automatically via postWrite(); bulk backfills that write
// directly to D1 must call this or operators see "random" stale card heroes until
// the TTL expires (~60s per PoP for /api/public/qmi, up to 24h stale backup on errors).
//
// Requires env (same secrets as esperanza-admin):
//   PURGE_KEY          — must match esperanza-api
//   API_PUBLIC_URL     — e.g. https://esperanza-api….workers.dev
//   FRONTEND_PUBLIC_URL — optional second purge target
// =============================================================================

import {
  publicCacheEntitiesFor,
  purgePublicCacheEntities,
  type PublicCachePurgeEnv,
} from '../../lib/public-cache-purge.js';

export function purgeEnvFromProcess(): PublicCachePurgeEnv | null {
  const PURGE_KEY = (process.env.PURGE_KEY ?? '').trim();
  const API_PUBLIC_URL = (process.env.API_PUBLIC_URL ?? '').trim();
  const FRONTEND_PUBLIC_URL = (process.env.FRONTEND_PUBLIC_URL ?? '').trim();
  if (!PURGE_KEY || !API_PUBLIC_URL) return null;
  return {
    PURGE_KEY,
    API_PUBLIC_URL,
    ...(FRONTEND_PUBLIC_URL ? { FRONTEND_PUBLIC_URL } : {}),
  };
}

/** Best-effort purge after a script changed D1. Logs and returns false when skipped. */
export async function purgeAfterRemoteD1Write(
  collection: string,
  opts?: { reason?: string }
): Promise<boolean> {
  const env = purgeEnvFromProcess();
  if (!env) {
    console.warn(
      `[purge] skipped${opts?.reason ? ` (${opts.reason})` : ''} — set PURGE_KEY and API_PUBLIC_URL, or run:\n` +
        '  npx tsx scripts/purge-public-cache.ts --entity=qmi',
    );
    return false;
  }
  const entities = publicCacheEntitiesFor(collection);
  console.log(`[purge] busting edge cache: ${entities.join(', ')}`);
  await purgePublicCacheEntities(env, entities);
  return true;
}
