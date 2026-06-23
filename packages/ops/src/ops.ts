import type { Env } from './index';

// PdfType values the pdf consumer recognises (matches packages/pdf/src/env.ts)
type PdfType = 'community' | 'qmi' | 'floorplan' | 'list';

async function callFramer(env: Env, path: string): Promise<{ ok: boolean; detail: string }> {
  const res = await env.FRAMER_PUSH.fetch(`https://framer-push${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WEBHOOK_TOKEN}` },
  });
  const detail = await res.text();
  return { ok: res.ok, detail };
}

export function backfill(env: Env, keys: string[]): Promise<{ ok: boolean; detail: string }> {
  const csv = encodeURIComponent(keys.join(','));
  return callFramer(env, `/backfill?keys=${csv}`);
}

export async function pushSchema(env: Env, collection: string): Promise<{ ok: boolean; detail: string }> {
  const { results } = await env.DB
    .prepare(`SELECT key, framer_type, label FROM field_definitions WHERE entity = ? AND framer_type IS NOT NULL`)
    .bind(collection)
    .all<{ key: string; framer_type: string; label: string | null }>();
  const fields = results.map((r) => ({ key: r.key, framer_type: r.framer_type, label: r.label ?? undefined }));
  const res = await env.FRAMER_PUSH.fetch('https://framer-push/schema', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WEBHOOK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection, fields }),
  });
  return { ok: res.ok, detail: await res.text() };
}

export async function triggerIngest(env: Env): Promise<{ ok: boolean; detail: string }> {
  const res = await env.INGEST.fetch('https://ingest/run', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.INGEST_TRIGGER_TOKEN}` },
  });
  return { ok: res.ok, detail: await res.text() };
}

export async function rebuildPdf(env: Env, list: string): Promise<{ ok: boolean; detail: string }> {
  // RENDER_Q message shape from packages/pdf/src/env.ts: { type: PdfType; slug: string; reason: string }
  // 'list' type with slug = the list name (e.g. 'all-qmis', 'all-plans')
  await env.RENDER_Q.send({ type: 'list' as PdfType, slug: list, reason: 'ops-rebuild' });
  return { ok: true, detail: `queued render for list:${list}` };
}
