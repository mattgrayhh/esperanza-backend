import type { Env } from './env';

export async function renderPdf(env: Env, html: string, marginsMm = { top: 12, right: 12, bottom: 12, left: 12 }): Promise<Uint8Array> {
  const id = env.RENDERER.idFromName('renderer');     // single shared instance → serializes through one warm browser
  const stub = env.RENDERER.get(id);
  const res = await stub.fetch('https://renderer.internal/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html, marginsMm }),
  });
  if (!res.ok) throw new Error(`renderer DO returned ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
