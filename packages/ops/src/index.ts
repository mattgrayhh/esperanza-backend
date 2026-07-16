import { authenticate } from './auth';
import { handleRest } from './rest';
import { OpsMcpAgent, type OpsProps } from './mcp';

export interface Env {
  DB: D1Database;
  INGEST: Fetcher;
  PDF: Fetcher;
  RENDER_Q: Queue;
  INGEST_TRIGGER_TOKEN: string;
  MCP_AGENT: DurableObjectNamespace<OpsMcpAgent>;
}

// The Durable Object class backing the MCP agent (binding MCP_AGENT in wrangler.toml).
export { OpsMcpAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });

    const token = await authenticate(request, env.DB);
    if (!token) return new Response('Unauthorized', { status: 401 });

    if (url.pathname.startsWith('/api/data/')) return handleRest(request, env, token);

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      // Inject the authenticated identity as the agent's per-connection props.
      // McpAgent.serve() reads ctx.props and forwards it to the DO (-> this.props).
      (ctx as ExecutionContext & { props?: OpsProps }).props = {
        tokenId: token.id,
        tier: token.tier,
      };
      return OpsMcpAgent.serve('/mcp', { binding: 'MCP_AGENT' }).fetch(request, env, ctx);
    }

    if (url.pathname === '/sse' || url.pathname.startsWith('/sse/')) {
      (ctx as ExecutionContext & { props?: OpsProps }).props = {
        tokenId: token.id,
        tier: token.tier,
      };
      return OpsMcpAgent.serveSSE('/sse', { binding: 'MCP_AGENT' }).fetch(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
};
