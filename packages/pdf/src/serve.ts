import type { Env, PdfType } from './env';
import { getRender, acquireLease, markLive, markError, getObject as realGet, putObject as realPut } from './store';
import { decideFreshness } from './freshness';
import { loadActiveTheme } from './theme';
import { renderTemplate } from './templates';
import { stableHash } from './hash';
import { r2KeyFor } from './slug';
import { loadCommunityData } from './data/community';
import { loadQmiData } from './data/qmi';
import { loadFloorPlanData } from './data/floorplan';
import { renderPdf as realRender } from './render';

export interface ServeDeps {
  render?: (env: Env, html: string, margins?: any) => Promise<Uint8Array>;
  putObject?: (key: string, pdf: Uint8Array) => Promise<void>;
  getObject?: (key: string) => Promise<{ body: ReadableStream | Uint8Array; httpMetadata?: { contentType?: string } } | null>;
  activeVersion?: number;
}

async function loadData(env: Env, type: PdfType, entityId: string, theme: Awaited<ReturnType<typeof loadActiveTheme>>['theme']) {
  switch (type) {
    case 'community': return loadCommunityData(env.DB, entityId, theme.copy.collectionIntros);
    case 'qmi': return loadQmiData(env.DB, entityId, { appendFloorPlanPages: theme.qmi.appendFloorPlanPages });
    case 'floorplan': return loadFloorPlanData(env.DB, entityId);
    default: throw new Error(`loadData not implemented for ${type}`);
  }
}

export async function serve(env: Env, type: PdfType, slug: string, deps: ServeDeps = {}, ctx?: ExecutionContext): Promise<Response> {
  const render = deps.render ?? realRender;
  const putObject = deps.putObject ?? ((k: string, b: Uint8Array) => realPut(env, k, b));
  const getObject = deps.getObject ?? (async (k: string) => { const o = await realGet(env, k); return o ? { body: o.body, httpMetadata: o.httpMetadata } : null; });

  const row = await getRender(env.DB, type, slug);
  if (!row) return new Response('Not found', { status: 404 });

  const loaded = await loadActiveTheme(env.DB);
  const theme = loaded.theme;
  const version = deps.activeVersion != null ? deps.activeVersion : loaded.version;

  const state = decideFreshness(row as any, version);
  const stream = async (): Promise<Response | null> => {
    const key = r2KeyFor(type, row.entity_id!);
    const o = await getObject(key);
    if (!o) return null;
    return new Response(o.body as any, { headers: { 'content-type': 'application/pdf', 'x-cache': 'HIT' } });
  };

  if (state === 'fresh') { const r = await stream(); if (r) return r; }

  if (state === 'stale-present') {
    const r = await stream();
    const bg = (async () => {
      if (await acquireLease(env.DB, type, slug)) {
        try { await rebuild(env, type, slug, row.entity_id!, theme, version, render, putObject); }
        catch (e) { await markError(env.DB, type, slug, String(e)); }
      }
    })();
    if (ctx) ctx.waitUntil(bg); else await bg;
    if (r) return r;
  }

  if (!(await acquireLease(env.DB, type, slug))) {
    const r = await stream(); if (r) return r;
    return new Response('Building…', { status: 202, headers: { 'retry-after': '3' } });
  }
  try {
    await rebuild(env, type, slug, row.entity_id!, theme, version, render, putObject);
    const r = await stream();
    return r ?? new Response('Render produced no object', { status: 500 });
  } catch (e) {
    await markError(env.DB, type, slug, String(e));
    const r = await stream(); if (r) return r;
    return new Response('Render failed', { status: 502 });
  }
}

// EXPORTED so the Phase-4 queue consumer reuses the identical render path.
export async function rebuild(
  env: Env, type: PdfType, slug: string, entityId: string,
  theme: any, version: number,
  render: NonNullable<ServeDeps['render']>, putObject: NonNullable<ServeDeps['putObject']>,
): Promise<void> {
  const data = await loadData(env, type, entityId, theme);
  if (!data) throw new Error('no data');
  const html = renderTemplate(type, theme, data);
  const dataHash = await stableHash(data);
  const pdf = await render(env, html, theme.page.marginsMm);
  const key = r2KeyFor(type, entityId);
  await putObject(key, pdf);
  await markLive(env.DB, type, slug, { dataHash, themeVersion: version, bytes: pdf.byteLength, r2Key: key });
  await env.DB.prepare(
    `INSERT INTO pdf_render_log (type, slug, action, status, bytes, theme_version) VALUES (?,?,?,?,?,?)`
  ).bind(type, slug, 'render', 'live', pdf.byteLength, version).run();
}
