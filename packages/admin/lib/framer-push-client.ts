// =============================================================================
// packages/admin — framer-push POST /schema client (Framer Field Types Phase C).
//
// The applyFramerTypes action calls framer-push's POST /schema to re-type/create the
// Framer CMS fields for a collection, then framer-push re-pushes that collection so
// values repopulate in the new type. This module owns the ONE network hop, abstracting
// HOW we reach the worker:
//
//   • PREFERRED: the FRAMER_PUSH service binding (env.FRAMER_PUSH.fetch). The request
//     never leaves Cloudflare's network. framer-push STILL enforces Bearer auth on
//     /schema, so we always send Authorization: Bearer WEBHOOK_TOKEN.
//   • FALLBACK: env.FRAMER_PUSH_URL + WEBHOOK_TOKEN over the public internet (used when
//     the binding is absent, e.g. a partial/standalone deploy).
//
// Contract (matches packages/framer-push/src/index.ts handleSchema):
//   POST /schema   Authorization: Bearer <WEBHOOK_TOKEN>
//   body  { collection, fields: [{ key, framer_type, label }] }
//   200   { ok, collection, collectionName, fields:[{key, action, detail}], deploymentId }
//   400/401 on bad collection / missing auth.
// =============================================================================

/** One field re-type/create request sent to /schema. */
export interface SchemaFieldRequest {
  key: string;
  framer_type: string;
  label?: string;
}

/** One per-field outcome from /schema. */
export interface SchemaFieldResult {
  key: string;
  action: 'retyped' | 'created' | 'unchanged' | 'error';
  detail?: string;
}

/** The /schema response shape (subset we consume). */
export interface SchemaResponse {
  ok: boolean;
  collection?: string;
  collectionName?: string;
  fields?: SchemaFieldResult[];
  deploymentId?: string | null;
  error?: string;
  noop?: boolean;
}

/** The bindings the client reads off getCloudflareContext().env. */
export interface FramerPushEnv {
  FRAMER_PUSH?: { fetch: (req: Request) => Promise<Response> };
  FRAMER_PUSH_URL?: string;
  WEBHOOK_TOKEN?: string;
}

/**
 * POST a schema change to framer-push for ONE collection. `collection` is the
 * framer-push CollectionKey (or a human name — framer-push resolves both). Prefers the
 * service binding; falls back to the public URL. Throws on transport/HTTP error so the
 * caller can mark the affected fields errored (and NOT advance their framer_type).
 */
export async function postSchema(
  env: FramerPushEnv,
  collection: string,
  fields: SchemaFieldRequest[]
): Promise<SchemaResponse> {
  const token = env.WEBHOOK_TOKEN ?? '';
  const body = JSON.stringify({ collection, fields });
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  let res: Response;
  if (env.FRAMER_PUSH && typeof env.FRAMER_PUSH.fetch === 'function') {
    // Service binding: the URL host is irrelevant (routed to the bound worker); use a
    // canonical https origin so the worker sees a well-formed /schema request.
    res = await env.FRAMER_PUSH.fetch(
      new Request('https://framer-push/schema', { method: 'POST', headers, body })
    );
  } else {
    const base = (env.FRAMER_PUSH_URL ?? '').replace(/\/+$/, '');
    if (!base) {
      throw new Error('framer-push is unreachable: no FRAMER_PUSH binding and no FRAMER_PUSH_URL');
    }
    res = await fetch(`${base}/schema`, { method: 'POST', headers, body });
  }

  let parsed: SchemaResponse;
  try {
    parsed = (await res.json()) as SchemaResponse;
  } catch {
    throw new Error(`framer-push /schema returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(parsed?.error ?? `framer-push /schema HTTP ${res.status}`);
  }
  return parsed;
}
