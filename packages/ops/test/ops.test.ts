import { describe, it, expect } from 'vitest';
import { triggerIngest, rebuildPdf } from '../src/ops';

function fakeIngestEnv() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const INGEST = {
    async fetch(input: RequestInfo, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request).url;
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    },
  };
  return { env: { INGEST, INGEST_TRIGGER_TOKEN: 'tok' } as never, calls };
}

function fakeRenderEnv() {
  const sent: unknown[] = [];
  const RENDER_Q = { async send(msg: unknown) { sent.push(msg); } };
  return { env: { RENDER_Q } as never, sent };
}

describe('tier-2 ops', () => {
  it('triggerIngest calls ingest /run via POST with the bearer', async () => {
    const { env, calls } = fakeIngestEnv();
    const r = await triggerIngest(env);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toContain('/run');
    expect(calls[0]!.init!.method).toBe('POST');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('rebuildPdf enqueues a list render on RENDER_Q', async () => {
    const { env, sent } = fakeRenderEnv();
    const r = await rebuildPdf(env, 'all-plans');
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ type: 'list', slug: 'all-plans', reason: 'ops-rebuild' }]);
  });
});
