// =============================================================================
// @esperanza/db — static frontend rebuild hook.
//
// The public site (esperanza-frontend) bakes most page HTML at build time from
// esperanza-api snapshots. Purging the api edge cache updates live JS islands
// (maps, settings, QMI card reconciliation) but NOT baked copy, galleries, or
// list grids — those need a frontend redeploy. Admin postWrite() calls this
// best-effort after purging the api cache, so a publish re-bakes the site.
//
// Two transports, tried in order:
//   1. FRONTEND_DEPLOY_HOOK_URL — a plain unauthenticated POST hook (e.g. a
//      Cloudflare Workers Build / Pages deploy hook). Simplest when it exists.
//   2. GITHUB_DISPATCH_TOKEN (+ FRONTEND_REPO) — the frontend deploys via GitHub
//      Actions (deploy.yml, workflow_dispatch enabled), so we trigger that workflow
//      on each ref in FRONTEND_DEPLOY_REFS. This is the active path today.
// Dormant (warns, no-ops) if neither is configured. A failed trigger NEVER fails
// the admin save.
// =============================================================================

export interface SiteRebuildEnv {
  /** Plain POST deploy hook (Cloudflare Workers Build / Pages) for esperanza-frontend. */
  FRONTEND_DEPLOY_HOOK_URL?: string;
  /** Fine-grained GitHub PAT with Actions: read+write on the frontend repo. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** "owner/repo" of the frontend (default Hazard-House/esperanza-frontend). */
  FRONTEND_REPO?: string;
  /** Workflow file to dispatch (default deploy.yml). */
  FRONTEND_DEPLOY_WORKFLOW?: string;
  /** Comma-separated branches to rebuild (default "main"). */
  FRONTEND_DEPLOY_REFS?: string;
}

/** Best-effort: a failed hook must never fail the admin save. */
export async function triggerFrontendRebuild(env: SiteRebuildEnv): Promise<void> {
  // Transport 1: plain deploy-hook URL (self-authenticating).
  const hookUrl = (env.FRONTEND_DEPLOY_HOOK_URL ?? '').trim();
  if (hookUrl) {
    try {
      const res = await fetch(hookUrl, { method: 'POST' });
      if (!res.ok) console.error(`[site-rebuild] deploy hook failed (HTTP ${res.status})`);
    } catch (err) {
      console.error('[site-rebuild]', err);
    }
    return;
  }

  // Transport 2: GitHub Actions workflow_dispatch.
  const token = (env.GITHUB_DISPATCH_TOKEN ?? '').trim();
  if (!token) {
    console.warn('[site-rebuild] no FRONTEND_DEPLOY_HOOK_URL or GITHUB_DISPATCH_TOKEN — static pages not rebuilt');
    return;
  }
  const repo = (env.FRONTEND_REPO ?? 'Hazard-House/esperanza-frontend').trim();
  const workflow = (env.FRONTEND_DEPLOY_WORKFLOW ?? 'deploy.yml').trim();
  const refs = (env.FRONTEND_DEPLOY_REFS ?? 'main')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  await Promise.all(
    refs.map(async (ref) => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'esperanza-admin',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref }),
          }
        );
        // 204 No Content = accepted.
        if (!res.ok) {
          console.error(`[site-rebuild] dispatch ${ref} failed (HTTP ${res.status}) ${await res.text().catch(() => '')}`);
        }
      } catch (err) {
        console.error(`[site-rebuild] dispatch ${ref}`, err);
      }
    })
  );
}
