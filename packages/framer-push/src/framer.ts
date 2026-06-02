// =============================================================================
// esperanza-cf framer-push — Framer Managed CMS client abstraction.
//
// The upstream transport (ported from esperanza-sync's framer-api dependency) is
// an RPC-over-WebSocket "headless plugin" session — NOT a REST POST:
//   connect(FRAMER_PROJECT_URL, FRAMER_API_KEY) opens a WS to
//   wss://api.framer.com/channel/headless-plugin; AUTH on the Cloudflare-Worker
//   path is the HTTP header `Authorization: Token ${FRAMER_API_KEY}`.
// FRAMER_PROJECT_URL is the full project URL
//   (https://framer.com/projects/Esperanza-Homes--t47CBg6stJkC8hsPgamo-egL7H);
// FRAMER_API_KEY is a "Token" credential from Framer Site Settings > General.
//
// We hide that behind a narrow FramerClient interface so:
//   (a) the consumer/backfill are unit-testable with a mock (no live WS), and
//   (b) framer-api is imported LAZILY at runtime (literal `import('framer-api')`,
//       so esbuild bundles it into the Worker) — but only inside connectFramer, so
//       tsc/vitest/module-load never pull it in to type-check / run the logic.
//
// Upsert contract (framer-api d.ts:3180-3214): addItems performs an UPSERT keyed
// by item `id`; items with a matching id are updated, new ids inserted. CAVEAT
// (d.ts:3189-3194): today addItems MERGES provided fieldData into the existing
// item (omitted fields unchanged); v4.0.0 switches to full-replace — so we ALWAYS
// send the complete fieldData on update (the mappers build the full set).
// =============================================================================

import type { ManagedCollectionItemInput } from './framer-types.js';

/**
 * One existing Managed-collection field, as getFields() exposes it. The `id` is the
 * Framer field id (== our snake_case key by convention); `type` is the Framer CMS
 * field type ("string"|"number"|"boolean"|"image"|"link"|"formattedText"|"date"|
 * "enum"|"array"|"file"|"unsupported"|…). We re-type by rebuilding the input list.
 */
export interface ManagedField {
  id: string;
  name: string;
  type: string;
}

/**
 * A field input for setFields. Mirrors framer-api's ManagedCollectionFieldInput:
 * `{ id, type, name, userEditable? }`. We only ever emit the scalar CMS types our
 * push produces (string/number/boolean/image/link/formattedText/date/enum); other
 * existing fields are passed through verbatim by copying their id/type/name.
 */
export interface ManagedFieldInput {
  id: string;
  type: string;
  name: string;
  userEditable?: boolean;
}

/** A single managed collection handle (the subset of the framer-api surface we use). */
export interface FramerCollection {
  readonly name: string;
  /** Upsert by item.id (update on match, insert on new). */
  addItems(items: ManagedCollectionItemInput[]): Promise<void>;
  /** Hard-delete by record id. */
  removeItems(ids: string[]): Promise<void>;
  /** All existing item ids (for orphan reconciliation). */
  getItemIds(): Promise<string[]>;
  /** The collection's current field schema (id/name/type). */
  getFields(): Promise<ManagedField[]>;
  /** Replace the collection's field schema with `fields` (full set). */
  setFields(fields: ManagedFieldInput[]): Promise<void>;
}

/** A connected Framer project session. */
export interface FramerClient {
  /** Resolve a managed collection by its human NAME (e.g. "Quick Move-Ins"). */
  getCollectionByName(name: string): Promise<FramerCollection | null>;
  /** publish() then deploy(deployment.id) — required to go live. */
  publishAndDeploy(): Promise<{ deploymentId: string }>;
  /** Always called in a finally to close the WS session. */
  disconnect(): Promise<void>;
}

export interface FramerEnv {
  FRAMER_PROJECT_URL: string;
  FRAMER_API_KEY: string;
}

/**
 * A factory that returns a connected FramerClient. The Worker passes the real
 * factory (lazy framer-api); tests pass a mock factory. This is the single seam
 * the whole package is wired through.
 */
export type FramerConnect = (env: FramerEnv) => Promise<FramerClient>;

// =============================================================================
// Real implementation — lazy import of framer-api so the dependency is only
// touched at runtime in the deployed Worker (and never by tsc/vitest).
// =============================================================================

/**
 * The minimal slice of framer-api's runtime surface we rely on. Declared loosely
 * (the package ships its own d.ts; we don't import its types so the build never
 * requires it to be present).
 */
interface FramerApiField {
  id: string;
  name: string;
  type: string;
}
interface FramerApiCollection {
  name: string;
  addItems(items: ManagedCollectionItemInput[]): Promise<unknown>;
  removeItems(ids: string[]): Promise<unknown>;
  getItemIds(): Promise<string[]>;
  getFields(): Promise<FramerApiField[]>;
  setFields(fields: ManagedFieldInput[]): Promise<unknown>;
}
interface FramerApiSession {
  getManagedCollections(): Promise<FramerApiCollection[]>;
  publish(): Promise<{ deployment: { id: string } }>;
  deploy(deploymentId: string): Promise<unknown>;
  disconnect(): Promise<void>;
}
type FramerApiModule = {
  connect(projectUrlOrId: string, token?: string): Promise<FramerApiSession>;
};

/**
 * Connect to Framer via framer-api. Imported through an indirection so bundlers/
 * type-checkers treat it as a runtime-only module (matches esperanza-sync's
 * `import { connect } from "framer-api"` but deferred).
 */
export const connectFramer: FramerConnect = async (env) => {
  // Literal lazy import: a STRING-LITERAL `import('framer-api')` is statically
  // analyzable, so esbuild/wrangler bundles framer-api into the deployed Worker
  // (a variable-indirected import did NOT bundle → runtime "No such module").
  // It stays lazy (inside connectFramer) so module load / tsc / vitest never pull
  // it in; we cast through `unknown` so tsc doesn't need framer-api's own types.
  const mod = (await import('framer-api')) as unknown as FramerApiModule;
  const session = await mod.connect(env.FRAMER_PROJECT_URL, env.FRAMER_API_KEY);

  // Cache the collection list once per session (getManagedCollections is a round-trip).
  let collectionsCache: FramerApiCollection[] | null = null;
  const loadCollections = async (): Promise<FramerApiCollection[]> => {
    if (!collectionsCache) collectionsCache = await session.getManagedCollections();
    return collectionsCache;
  };

  return {
    async getCollectionByName(name: string): Promise<FramerCollection | null> {
      const collections = await loadCollections();
      // framer-api's headless plugin names managed collections "<Name> (Managed)"
      // (e.g. our "Cities" lives as "Cities (Managed)"). Match the exact name
      // first, then fall back to the "(Managed)" variant so the configured human
      // names ("Cities", "Quick Move-Ins", ...) resolve against a live project.
      const c =
        collections.find((x) => x.name === name) ??
        collections.find((x) => x.name === `${name} (Managed)`);
      if (!c) return null;
      return {
        name: c.name,
        addItems: (items) => c.addItems(items).then(() => undefined),
        removeItems: (ids) => c.removeItems(ids).then(() => undefined),
        getItemIds: () => c.getItemIds(),
        getFields: async () =>
          (await c.getFields()).map((f) => ({ id: f.id, name: f.name, type: f.type })),
        setFields: (fields) => c.setFields(fields).then(() => undefined),
      };
    },
    async publishAndDeploy(): Promise<{ deploymentId: string }> {
      const { deployment } = await session.publish();
      await session.deploy(deployment.id);
      return { deploymentId: deployment.id };
    },
    async disconnect(): Promise<void> {
      await session.disconnect();
    },
  };
};

// =============================================================================
// Test mock — an in-memory FramerClient that records calls and stores items.
// Exported from the package so tests (and a `--dry-run` backfill) can swap it in.
// =============================================================================

export interface MockCollectionState {
  name: string;
  items: Map<string, ManagedCollectionItemInput>;
  addItemsCalls: ManagedCollectionItemInput[][];
  removeItemsCalls: string[][];
  /** The collection's current field schema (mutated by setFields). */
  fields: ManagedField[];
  /** Every setFields call's argument (for assertions). */
  setFieldsCalls: ManagedFieldInput[][];
}

export interface MockFramer {
  connect: FramerConnect;
  /** Inspect what landed in a collection after the run. */
  collections: Map<string, MockCollectionState>;
  publishCount: number;
  deploymentIds: string[];
  disconnectCount: number;
}

/**
 * Build a mock FramerClient factory. `names` seeds which managed collections
 * exist (resolveCollection matches by NAME, so the mock must know them up front,
 * exactly like a live project whose collections were created by setup.ts).
 *
 * `seedFields` optionally seeds each collection's starting field schema (keyed by
 * collection name) so /schema re-type tests can assert against a known pre-state.
 */
export function createMockFramer(
  names: string[],
  seedFields: Record<string, ManagedField[]> = {}
): MockFramer {
  const collections = new Map<string, MockCollectionState>();
  for (const name of names) {
    collections.set(name, {
      name,
      items: new Map(),
      addItemsCalls: [],
      removeItemsCalls: [],
      fields: (seedFields[name] ?? []).map((f) => ({ ...f })),
      setFieldsCalls: [],
    });
  }
  const mock: MockFramer = {
    collections,
    publishCount: 0,
    deploymentIds: [],
    disconnectCount: 0,
    connect: async () => ({
      async getCollectionByName(name) {
        const state = collections.get(name);
        if (!state) return null;
        return {
          name: state.name,
          async addItems(items) {
            state.addItemsCalls.push(items);
            for (const it of items) state.items.set(it.id, it); // upsert by id
          },
          async removeItems(ids) {
            state.removeItemsCalls.push(ids);
            for (const id of ids) state.items.delete(id);
          },
          async getItemIds() {
            return [...state.items.keys()];
          },
          async getFields() {
            return state.fields.map((f) => ({ ...f }));
          },
          async setFields(fields) {
            state.setFieldsCalls.push(fields);
            // Apply the new schema (id/name/type) so a subsequent getFields reflects it.
            state.fields = fields.map((f) => ({ id: f.id, name: f.name, type: f.type }));
          },
        };
      },
      async publishAndDeploy() {
        mock.publishCount++;
        const id = `deploy_${mock.publishCount}`;
        mock.deploymentIds.push(id);
        return { deploymentId: id };
      },
      async disconnect() {
        mock.disconnectCount++;
      },
    }),
  };
  return mock;
}
