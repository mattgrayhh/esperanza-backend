import { describe, it, expect } from 'vitest';
import { backfill, pushSchema, triggerIngest, rebuildPdf } from '../src/ops';

function fakeEnv() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const FRAMER_PUSH = {
    async fetch(input: RequestInfo, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request).url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
  return { env: { FRAMER_PUSH, WEBHOOK_TOKEN: 'tok' } as never, calls };
}

function fakeEnvWithDb() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const FRAMER_PUSH = {
    async fetch(input: RequestInfo, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request).url;
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    },
  };
  const DB = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  return { env: { FRAMER_PUSH, WEBHOOK_TOKEN: 'tok', DB } as never, calls };
}

describe('tier-2 ops', () => {
  it('backfill calls framer-push /backfill with the keys and bearer', async () => {
    const { env, calls } = fakeEnv();
    const r = await backfill(env, ['qmi', 'communities']);
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toContain('/backfill');
    expect(calls[0]!.url).toContain('keys=qmi%2Ccommunities');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('pushSchema calls framer-push /schema via POST with collection in body', async () => {
    const { env, calls } = fakeEnvWithDb();
    const r = await pushSchema(env, 'communities');
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toContain('/schema');
    expect(calls[0]!.init!.method).toBe('POST');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.collection).toBe('communities');
  });
});
