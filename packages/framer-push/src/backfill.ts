// =============================================================================
// esperanza-cf framer-push — backfill driver. `npm run backfill [keys...]`.
//
// Run with: npm run backfill            (all 9 collections)
//           npm run backfill qmi        (just QMI)
//           npm run backfill qmi communities promotions
//
// The actual push logic lives server-side in the Worker's POST /backfill route
// (runBackfill in consumer.ts) — that's where the D1 + Framer bindings are. This
// driver just authenticates and invokes it, so node never needs Cloudflare creds
// or the framer-api WS transport locally (mirrors the legacy backfill.ts which
// POSTed batches to WORKER_URL).
//
// Env (.env, loaded via `tsx --env-file=.env`):
//   WORKER_URL     — deployed framer-push worker base url
//   WEBHOOK_TOKEN  — Bearer token (same as the worker's WEBHOOK_TOKEN secret)
// =============================================================================

const VALID_KEYS = [
  'floor_plans',
  'qmi',
  'communities',
  'collections',
  'images',
  'blogs',
  'promotions',
  'cities',
  'testimonials',
];

async function main(): Promise<void> {
  const workerUrl = process.env['WORKER_URL'];
  const token = process.env['WEBHOOK_TOKEN'];
  if (!workerUrl) throw new Error('WORKER_URL env var is required');
  if (!token) throw new Error('WEBHOOK_TOKEN env var is required');

  const keys = process.argv.slice(2);
  for (const k of keys) {
    if (!VALID_KEYS.includes(k)) {
      throw new Error(`unknown collection key "${k}". valid: ${VALID_KEYS.join(', ')}`);
    }
  }

  const url = new URL('/backfill', workerUrl);
  if (keys.length) url.searchParams.set('keys', keys.join(','));

  console.log(`backfilling ${keys.length ? keys.join(', ') : 'ALL collections'} via ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`backfill failed (${res.status}): ${body}`);
  console.log(body);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
