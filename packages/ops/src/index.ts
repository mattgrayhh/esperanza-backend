export interface Env {
  DB: D1Database;
  FRAMER_PUSH: Fetcher;
  INGEST: Fetcher;
  PDF: Fetcher;
  RENDER_Q: Queue;
  WEBHOOK_TOKEN: string;
  INGEST_TRIGGER_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  },
};
