// =============================================================================
// packages/admin — typed Cloudflare bindings for getCloudflareContext().env.
//
// Hand-maintained mirror of wrangler.toml. (`npm run cf-typegen` can regenerate a
// fuller version, but this keeps the contract explicit and reviewable in source.)
// @opennextjs/cloudflare reads the GLOBAL `CloudflareEnv` interface to type
// getCloudflareContext().env, so we augment it here.
// =============================================================================

import type { D1Database, R2Bucket, Queue, Fetcher } from '@cloudflare/workers-types';

/** Message enqueued onto esperanza-framer-queue (matches framer-push types.ts). */
export interface FramerSyncMessage {
  collection:
    | 'floor_plans'
    | 'qmi'
    | 'communities'
    | 'collections'
    | 'images'
    | 'blogs'
    | 'promotions'
    | 'cities'
    | 'testimonials';
  action: 'upsert' | 'delete';
  id: string;
}

declare global {
  interface CloudflareEnv {
    /** D1 — the shared `esperanza` database. Admin uses withSession("first-primary"). */
    DB: D1Database;
    /** R2 — image uploads. Key = <entity>/<id>/<filename>. */
    IMAGES: R2Bucket;
    /** Producer for esperanza-framer-queue. */
    FRAMER_QUEUE: Queue<FramerSyncMessage>;
    /** OpenNext static assets. */
    ASSETS: Fetcher;

    // --- vars ---
    IMAGES_PUBLIC_BASE_URL: string;

    // --- secrets (wrangler secret put) ---
    /** Auth.js v5 JWT signing secret. REQUIRED in production. */
    AUTH_SECRET?: string;

    // --- local-only (.dev.vars) ---
    /** Local dev login bypass — attributes writes to this email under `next dev`.
     *  NEVER set in wrangler.toml [vars]; inert when NODE_ENV === 'production'. */
    ADMIN_DEV_EMAIL?: string;
  }
}

export {};
