/**
 * One-off (Phase 2): REMOVE three legacy/duplicate fields from the live Framer
 * Managed collections. The esperanza-cf framer-push mappers stopped emitting them
 * (Phase 2A); this strips the now-orphaned fields from the CMS schema.
 *
 *   Communities  (aFxxkciqK) → floor_plan_plaintext   (legacy Airtable aiText flattening;
 *                                                       the floor_plans.communities relationship
 *                                                       is the real source)
 *   Floor Plans  (czFXxWqH9) → brochure_pdf            (legacy attachment dup of brochure_pdf_url,
 *                                                       which stays)
 *   Promotions   (by name)   → applies_to              (legacy descriptive label; promotion_targets
 *                                                       drives targeting)
 *
 * Mechanism (mirrors remove-photo-gallery-urls.ts / retype-plan-viewer.ts): ManagedCollection
 * only exposes setFields, and fields OMITTED from the array are removed. So per collection we
 * getFields(), strip the readonly `userEditable` key (the one key setFields rejects on
 * round-trip), drop the target field id, preserve everything else verbatim (incl. array nested
 * `fields`), and setFields(without).
 *
 * SAFETY — verify BEFORE running (binding-safety pre-flight, same as photo_gallery_urls):
 * a native page element / CMS code component bound to one of these fields would break if
 * removed. Confirm clear on the live project:
 *   • Communities detail: no element bound to `floor_plan_plaintext` (no $control__… / var(--…)).
 *   • Floor Plans detail: brochure download element binds `brochure_pdf_url` (NOT `brochure_pdf`).
 *   • Promotions consumers (CMS-sync + the /promotions API embed path): no component reads
 *     `applies_to` / `appliesTo` — targeting is communityIds/floorPlanIds from promotion_targets.
 * If any binding exists, re-point it (to the kept field) BEFORE running this.
 *
 * Idempotent: a field already absent is skipped (no-op round-trip).
 *
 * Creds (FRAMER_API_KEY + FRAMER_PROJECT_URL) live in the operator's esperanza-sync/.env.
 * Run from a checkout that has framer-api installed:
 *   npx tsx --env-file="../esperanza-sync/.env" \
 *     packages/framer-push/scripts/remove-legacy-fields-p2.ts
 *
 * Framer's API intermittently throws "Internal server error" under throttling; this retries
 * connect + each step with backoff.
 */

import { connect, isRetryableError } from "framer-api";

const projectUrl = process.env.FRAMER_PROJECT_URL;
const apiKey = process.env.FRAMER_API_KEY;

// One legacy field to remove, per collection. Collections are resolved by NAME (robust to
// unknown ids — Promotions' id isn't hardcoded); known ids are noted for reference.
const REMOVALS: Array<{ collection: string; knownId?: string; field: string }> = [
  { collection: "Communities", knownId: "aFxxkciqK", field: "floor_plan_plaintext" },
  { collection: "Floor Plans", knownId: "czFXxWqH9", field: "brochure_pdf" },
  { collection: "Promotions", field: "applies_to" },
];

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

    for (const { collection, knownId, field } of REMOVALS) {
      const col =
        cols.find((c: { id: string; name?: string }) => c.name === collection) ??
        (knownId ? cols.find((c: { id: string }) => c.id === knownId) : undefined);
      if (!col) {
        console.error(`Collection "${collection}" not found — skipping ${field}.`);
        continue;
      }

      const before = await withRetry(`${collection}.getFields(before)`, () => col.getFields());
      const hadTarget = before.some((f: { id: string }) => f.id === field);
      console.log(`${collection} (${col.id}): ${before.length} fields; ${field} present=${hadTarget}`);
      if (!hadTarget) {
        console.log(`${collection}: ${field} already absent — nothing to remove.`);
        continue;
      }

      // Dedupe by id (last wins), sanitize, drop the target.
      const byId = new Map<string, Record<string, unknown>>();
      for (const f of before) byId.set((f as { id: string }).id, sanitize(f as unknown as Record<string, unknown>));
      byId.delete(field);
      const without = Array.from(byId.values());

      console.log(`${collection}: setFields without ${field} (${without.length} fields)…`);
      await withRetry(`${collection}.setFields`, () => col.setFields(without as never));

      const after = await withRetry(`${collection}.getFields(after)`, () => col.getFields());
      const gone = !after.some((f: { id: string }) => f.id === field);
      console.log(`${collection}: now ${after.length} fields; ${field} removed=${gone}`);
      if (!gone) throw new Error(`${collection}: ${field} still present after setFields!`);
    }

    console.log("Done. Phase 2 legacy fields removed from all target collections.");
  } finally {
    await framer.disconnect().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
