import type { Env, PdfType, RenderJob } from './env';
import { renderPdf } from './render';
import { serve } from './serve';
import { preview } from './preview';
import { verifyPreviewToken } from './token';
import { processJob, enqueueStaleLists, enqueueAllStale } from './queue';

export { BrowserRenderer } from './renderer-do';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }
    if (request.method === 'GET' && url.pathname === '/debug/render') {
      const html = url.searchParams.get('html') ?? '<h1>hi</h1>';
      const pdf = await renderPdf(env, `<!DOCTYPE html><html><body>${html}</body></html>`);
      return new Response(pdf as unknown as BodyInit, { headers: { 'content-type': 'application/pdf' } });
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
