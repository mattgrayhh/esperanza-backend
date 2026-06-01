import type { Env, RenderJob, PdfType } from './env';
import { getRender, acquireLease, markError, putObject as realPut } from './store';
import { loadActiveTheme } from './theme';
import { rebuild, type ServeDeps } from './serve';
import { renderPdf as realRender } from './render';

/** Render one job under the single-flight lease. Returns 'rendered' | 'skipped' (lease lost). Throws on render failure (→ queue retry). */
export async function processJob(env: Env, job: RenderJob, deps: ServeDeps = {}): Promise<'rendered' | 'skipped'> {
  const row = await getRender(env.DB, job.type, job.slug);
  if (!row?.entity_id) return 'skipped';
  if (!(await acquireLease(env.DB, job.type, job.slug))) return 'skipped';
  const { theme, version: activeVersion } = await loadActiveTheme(env.DB);
  const version = deps.activeVersion ?? activeVersion;
  const render = deps.render ?? realRender;
  const putObject = deps.putObject ?? ((k: string, b: Uint8Array) => realPut(env, k, b));
  try {
    await rebuild(env, job.type, job.slug, row.entity_id, theme, version, render, putObject);
    return 'rendered';
  } catch (e) {
    await markError(env.DB, job.type, job.slug, String(e));
    throw e;
  }
}

/** Nightly: enqueue every list render that isn't currently live (warm + rebuild stale). */
export async function enqueueStaleLists(env: Env): Promise<number> {
  if (!env.RENDER_Q) return 0;
  const res = await env.DB.prepare(`SELECT type, slug FROM pdf_renders WHERE type='list' AND status<>'live'`).all<{ type: PdfType; slug: string }>();
  const rows = res.results ?? [];
  for (const r of rows) await env.RENDER_Q.send({ type: r.type, slug: r.slug, reason: 'nightly' });
  return rows.length;
}
