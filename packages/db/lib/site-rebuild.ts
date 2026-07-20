// =============================================================================
// @esperanza/db — static frontend rebuild hook.
//
// The public site (esperanza-frontend) bakes most page HTML at build time from
// esperanza-api snapshots. Purging the api edge cache updates live JS islands
// (maps, settings, QMI card reconciliation) but NOT baked copy, galleries, or
// list grids — those need a frontend redeploy. Admin postWrite() calls this
// best-effort after purging the api cache.
// =============================================================================

export interface SiteRebuildEnv {
  /** Cloudflare Pages/Workers deploy hook or CI dispatch URL for esperanza-frontend. */
  FRONTEND_DEPLOY_HOOK_URL?: string;
}

/** Best-effort: a failed hook must never fail the admin save. */
export async function triggerFrontendRebuild(env: SiteRebuildEnv): Promise<void> {
  const url = (env.FRONTEND_DEPLOY_HOOK_URL ?? '').trim();
  if (!url) {
    console.warn('[site-rebuild] FRONTEND_DEPLOY_HOOK_URL unset — static pages not rebuilt');
    return;
  }
  try {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      console.error(`[site-rebuild] deploy hook failed (HTTP ${res.status})`);
    }
  } catch (err) {
    console.error('[site-rebuild]', err);
  }
}
