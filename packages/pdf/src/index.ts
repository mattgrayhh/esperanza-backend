import type { Env, PdfType } from './env';
import { renderPdf } from './render';
import { serve } from './serve';
import { preview } from './preview';
import { verifyPreviewToken } from './token';

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
      return serve(env, pdfMatch[1] as PdfType, decodeURIComponent(pdfMatch[2]!), {}, ctx);
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
    return new Response('Not found', { status: 404 });
  },
};
