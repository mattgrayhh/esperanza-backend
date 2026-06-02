/**
 * One-off: REMOVE the legacy `photo_gallery_urls` field from the two live
 * Framer Managed collections:
 *   - Communities  (id aFxxkciqK)
 *   - Floor Plans  (id czFXxWqH9)
 *
 * The mapper (esperanza-cf packages/framer-push) no longer emits
 * photo_gallery_urls (commit bfedc77). The real gallery now lives in
 * `photo_gallery` (array of {image}) plus `photo_gallery_image` (image).
 *
 * Mechanism: ManagedCollection only exposes setFields. Fields OMITTED from the
 * array are removed (per Framer docs). So we getFields(), strip the readonly
 * `userEditable` key (the one key setFields rejects on round-trip), drop the
 * target id, preserve everything else verbatim (incl. array nested `fields`),
 * and setFields(without). This mirrors the proven retype-plan-viewer.ts dance.
 *
 * SAFETY: A native page element bound to the CMS field would break if removed.
 * Verified clear before running (2026-06-02): the CMSGalleryViewer
 * `$control__galleryURLS` control is empty ("") on the Communities detail page
 * and absent on the Floor Plans detail page; no var(--variable-) binding to the
 * field on either CMS template page; component code already cleared. If you
 * re-bound a page element to photo_gallery_urls since then, re-bind it to
 * photo_gallery (array) BEFORE running this.
 *
 * Idempotent: if photo_gallery_urls is already gone, this is a no-op round-trip.
 *
 * Creds (FRAMER_API_KEY + FRAMER_PROJECT_URL) live in the operator's
 * esperanza-sync/.env (same file packages/db/scripts + esperanza-sync use). Run
 * from a checkout that has framer-api installed, pointing --env-file at it, e.g.:
 *   npx tsx --env-file="../esperanza-sync/.env" \
 *     packages/framer-push/scripts/remove-photo-gallery-urls.ts
 * A byte-identical runnable copy also lives at
 *   esperanza-sync/src/remove-photo-gallery-urls.ts  (run with `--env-file=.env`).
 *
 * NOTE (2026-06-02): already executed against the live project — both
 * collections now report photo_gallery_urls removed (Communities 68->67,
 * Floor Plans 37->36). Kept for reproducibility / future runs.
 *
 * Framer's API has been intermittently throwing "Internal server error" when
 * throttled; this script retries connect + each step with backoff.
 */

import { connect, isRetryableError } from "framer-api";

const projectUrl = process.env.FRAMER_PROJECT_URL;
const apiKey = process.env.FRAMER_API_KEY;

const TARGET = "photo_gallery_urls";
const TARGETS: Record<string, string> = {
  Communities: "aFxxkciqK",
  "Floor Plans": "czFXxWqH9",
};

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 18_000;

if (!projectUrl || !apiKey) {
  console.error("Missing FRAMER_PROJECT_URL or FRAMER_API_KEY (load from .env).");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryable(err: unknown): boolean {
  try {
    if (isRetryableError?.(err)) return true;
  } catch {
    /* isRetryableError may be unavailable in older framer-api */
  }
  const msg = String((err as { message?: string } | undefined)?.message ?? err);
  return /internal server error|failed to get connection|timeout|ECONNRESET|socket hang up/i.test(msg);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = String((err as { message?: string } | undefined)?.message ?? err);
      if (!retryable(err) || i === MAX_ATTEMPTS) {
        console.error(`${label}: failed on attempt ${i}/${MAX_ATTEMPTS}: ${msg}`);
        throw err;
      }
      console.warn(`${label}: attempt ${i}/${MAX_ATTEMPTS} hit retryable error (${msg}); waiting ${BACKOFF_MS / 1000}s…`);
      await sleep(BACKOFF_MS);
    }
  }
  throw last;
}

function sanitize(field: Record<string, unknown>): Record<string, unknown> {
  // Strip the one readonly key setFields rejects; keep everything else verbatim
  // (id, name, type, required, basedOn, and array `fields`).
  const { userEditable, ...rest } = field;
  return rest;
}

async function main() {
  const framer = await withRetry("connect", () => connect(projectUrl!, apiKey!));
  try {
    const cols = await withRetry("getManagedCollections", () => framer.getManagedCollections());

    for (const [name, id] of Object.entries(TARGETS)) {
      const col = cols.find((c: { id: string }) => c.id === id);
      if (!col) {
        console.error(`Collection "${name}" (${id}) not found — skipping.`);
        continue;
      }

      const before = await withRetry(`${name}.getFields(before)`, () => col.getFields());
      const hadTarget = before.some((f: { id: string }) => f.id === TARGET);
      console.log(`${name} (${id}): ${before.length} fields; ${TARGET} present=${hadTarget}`);

      if (!hadTarget) {
        console.log(`${name}: ${TARGET} already absent — nothing to remove.`);
        continue;
      }

      // Dedupe by id (last wins), sanitize, drop the target.
      const byId = new Map<string, Record<string, unknown>>();
      for (const f of before) byId.set((f as { id: string }).id, sanitize(f as unknown as Record<string, unknown>));
      byId.delete(TARGET);
      const without = Array.from(byId.values());

      console.log(`${name}: setFields without ${TARGET} (${without.length} fields)…`);
      await withRetry(`${name}.setFields`, () => col.setFields(without as never));

      const after = await withRetry(`${name}.getFields(after)`, () => col.getFields());
      const gone = !after.some((f: { id: string }) => f.id === TARGET);
      const pg = after.find((f: { id: string }) => f.id === "photo_gallery") as
        | { type?: string; fields?: Array<{ id: string }> }
        | undefined;
      const pgOk = pg?.type === "array" && !!pg.fields?.some((nf) => nf.id === "image");
      console.log(
        `${name}: now ${after.length} fields; ${TARGET} removed=${gone}; ` +
          `photo_gallery(array+image)=${pgOk}; photo_gallery_image=${after.some((f: { id: string }) => f.id === "photo_gallery_image")}`
      );
      if (!gone) throw new Error(`${name}: ${TARGET} still present after setFields!`);
    }

    console.log("Done. photo_gallery_urls removed from all target collections.");
  } finally {
    await framer.disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
