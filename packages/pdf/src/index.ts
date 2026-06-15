import puppeteer from '@cloudflare/puppeteer';
import type { Env, PdfType, RenderJob } from './env';
import { renderPdf } from './render';
import { serve, loadData } from './serve';
import { preview } from './preview';
import { verifyPreviewToken } from './token';
import { processJob, enqueueStaleLists, enqueueAllStale } from './queue';
import { renderTemplate } from './templates';
import { loadActiveTheme } from './theme';
import { loadFilteredListData, type FilteredKind, type ListFilters } from './data/list';
import { stableHash } from './hash';
import { getObject, putObject } from './store';

function parseListFilters(sp: URLSearchParams): ListFilters {
  const n = (k: string): number | undefined => {
    const v = sp.get(k);
    if (v == null || v === '') return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const s = (k: string): string | undefined => sp.get(k) || undefined;
  return {
    city: s('city'),
    community: s('community'),
    collection: s('collection'),
    minBeds: n('minBeds'),
    minBaths: n('minBaths'),
    minPrice: n('minPrice'),
    maxPrice: n('maxPrice'),
    minSqft: n('minSqft'),
    maxSqft: n('maxSqft'),
    stories: n('stories'),
    garage: n('garage'),
    availableNow: sp.get('status') === 'available' || sp.get('availableNow') === 'true',
  };
}

export { BrowserRenderer } from './renderer-do';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    if (request.method === 'GET' && url.pathname === '/debug/limits') {
      // Non-destructive probe: reads account limits + live sessions WITHOUT launching a
      // browser (consumes zero browser-time). Used to diagnose 429s and confirm plan tier.
      const [limits, sessions] = await Promise.all([
        puppeteer.limits(env.BROWSER).catch((e) => ({ error: (e as Error).message })),
        puppeteer.sessions(env.BROWSER).catch((e) => ({ error: (e as Error).message })),
      ]);
      return Response.json({ limits, sessions });
    }
    if (request.method === 'GET' && url.pathname === '/debug/launch') {
      // Attempt a single guarded launch and surface the EXACT error (vs the generic 1101).
      try {
        const b = await puppeteer.launch(env.BROWSER, { keep_alive: 60_000 });
        const ok = b.isConnected();
        const sid = b.sessionId?.();
        await b.close().catch(() => {});
        return Response.json({ ok, sessionId: sid });
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message, name: (e as Error).name }, { status: 200 });
      }
    }
    if (request.method === 'GET' && url.pathname === '/debug/render') {
      const html = url.searchParams.get('html') ?? '<h1>hi</h1>';
      const pdf = await renderPdf(env, `<!DOCTYPE html><html><body>${html}</body></html>`);
      return new Response(pdf as unknown as BodyInit, { headers: { 'content-type': 'application/pdf' } });
    }
    if (request.method === 'GET' && url.pathname === '/img') {
      // Image proxy: resize via Cloudflare Image Resizing so the PDF embeds small images
      // (Chrome re-encodes embedded images at high quality, so source pixel size is the lever).
      // Degrades gracefully to the source if Image Resizing isn't enabled.
      const u = url.searchParams.get('u');
      if (!u) return new Response('missing u', { status: 400 });
      const w = Math.min(2000, Math.max(40, Number(url.searchParams.get('w') || '300')));
      const fetchImg = (src: string) => fetch(src, {
        cf: { image: { width: w, quality: 72, fit: 'scale-down', format: 'auto' }, cacheTtl: 86400, cacheEverything: true },
      } as any);
      let upstream = await fetchImg(u);
      // Renditions (…-w600.jpg) are incomplete — some plans only have the original. When the
      // requested rendition 404s, retry the original (suffix stripped) so the image still loads.
      if (!upstream.ok) {
        const original = u.replace(/-(w600|w1200|w2000)(\.[a-z0-9]+)?($|\?)/i, '$2$3');
        if (original !== u) upstream = await fetchImg(original);
      }
      if (!upstream.ok) return new Response('img fetch failed', { status: 502 });
      const h = new Headers();
      h.set('content-type', upstream.headers.get('content-type') || 'image/jpeg');
      h.set('cache-control', 'public, max-age=86400');
      return new Response(upstream.body, { status: 200, headers: h });
    }
    if (request.method === 'GET' && url.pathname === '/debug/pdf') {
      // Render a real template on demand from type+entityId — bypasses R2/cache/queue.
      // Fast iteration loop for template work. e.g. /debug/pdf?type=list&id=list:all:qmis
      const type = (url.searchParams.get('type') || '') as PdfType;
      const id = url.searchParams.get('id') || '';
      const { theme } = await loadActiveTheme(env.DB);
      const data = await loadData(env, type, id, theme);
      if (!data) return new Response(`no data for ${type} ${id}`, { status: 404 });
      const html = renderTemplate(type, theme, data);
      const pdf = await renderPdf(env, html, theme.page.marginsMm);
      return new Response(pdf as unknown as BodyInit, { headers: { 'content-type': 'application/pdf' } });
    }
    // On-demand FILTERED list PDFs — the "download current filter selection" button on the
    // Quick Move-Ins / Floor Plans filter pages. Filter combos are unbounded, so we render on
    // demand and cache in R2 keyed by a hash of (kind + filters + dataHash); the dataHash makes
    // the cache self-invalidate when the matching inventory changes.
    const filteredMatch = url.pathname.match(/^\/pdf\/filtered\/(qmis|plans)$/);
    if (request.method === 'GET' && filteredMatch) {
      const cache = (caches as any).default;
      const cached = await cache.match(request);
      if (cached) return cached;
      const kind = filteredMatch[1] as FilteredKind;
      const filters = parseListFilters(url.searchParams);
      const { theme } = await loadActiveTheme(env.DB);
      const data = await loadFilteredListData(env.DB, kind, filters, env.PDF_PUBLIC_BASE_URL);
      const items = kind === 'qmis' ? data.qmis : data.cards;
      const dataHash = await stableHash(items.map((i: any) => [i.id, i.price ?? null, i.availability ?? null]));
      const key = `pdf/filtered/${kind}/${await stableHash({ filters, dataHash })}.pdf`;
      let pdf: Uint8Array;
      const obj = await getObject(env, key);
      if (obj) {
        pdf = new Uint8Array(await obj.arrayBuffer());
      } else {
        const html = renderTemplate('list', theme, data);
        pdf = await renderPdf(env, html, theme.page.marginsMm);
        ctx.waitUntil(putObject(env, key, pdf));
      }
      const res = new Response(pdf as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          'cache-control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
        },
      });
      ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    }
    const pdfMatch = url.pathname.match(/^\/pdf\/(community|qmi|floorplan|list)\/(.+)$/);
    if (request.method === 'GET' && pdfMatch) {
      // Edge Cache API: serve repeat reads without hitting the worker at all.
      // Only 200 PDF responses are cached; 302 "building" redirects are not.
      const cache = (caches as any).default;
      const cached = await cache.match(request);
      if (cached) return cached;
      const res = await serve(env, pdfMatch[1] as PdfType, decodeURIComponent(pdfMatch[2]!), {}, ctx);
      if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    }
    const pvMatch = url.pathname.match(/^\/preview\/(community|qmi|floorplan|list)\/(.+)$/);
    if (request.method === 'GET' && pvMatch) {
      const which = url.searchParams.get('theme') === 'draft' ? 'draft' : 'active';
      // Guard draft preview with a signed token when PDF_PREVIEW_SECRET is configured.
      // If the secret is not set (local dev / CI), draft is allowed without a token as a
      // convenience — this can never fire in production since the secret is always set there.
      if (which === 'draft' && env.PDF_PREVIEW_SECRET) {
        const token = url.searchParams.get('token') ?? '';
        if (!(await verifyPreviewToken(env.PDF_PREVIEW_SECRET, pvMatch[1]!, decodeURIComponent(pvMatch[2]!), token))) {
          return new Response('Forbidden', { status: 403 });
        }
      }
      return preview(env, pvMatch[1] as PdfType, decodeURIComponent(pvMatch[2]!), which);
    }
    const pollMatch = url.pathname.match(/^\/poll\/(community|qmi|floorplan|list)\/(.+)$/);
    if (request.method === 'GET' && pollMatch) {
      const [, type, rawSlug] = pollMatch;
      const slug = decodeURIComponent(rawSlug!);
      const row = await env.DB.prepare(`SELECT status FROM pdf_renders WHERE type=? AND slug=?`).bind(type, slug).first<{ status: string }>();
      if (row?.status === 'live') {
        return Response.redirect(`${new URL(request.url).origin}/pdf/${type}/${encodeURIComponent(slug)}`, 302);
      }
      const body = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Building…</title></head><body style="font-family:system-ui;text-align:center;padding:3rem"><p>Building your PDF…</p><p style="color:#888;font-size:.9rem">This page refreshes automatically.</p></body></html>`;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },

  async queue(batch: MessageBatch<RenderJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try { await processJob(env, msg.body); msg.ack(); }
      catch { msg.retry(); }
    }
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await enqueueAllStale(env);
  },
};
