// =============================================================================
// packages/admin — Framer Field Types (Phase C) action + add-a-field flow.
//
// Covers (per task):
//   • PURE helpers (lib/framer-types.ts): settable types, recommended/compatible subset,
//     risky-conversion classification (number → image is risky; enum is not settable).
//   • applyFramerTypes action against the REAL schema (better-sqlite3 + the full additive
//     migration chain), with lib/db / lib/auth / next/cache / @opennextjs/cloudflare and
//     lib/framer-push-client (the ONE network hop) mocked:
//       (a) an ADDED field INSERTs a field_definitions row (custom=1, visible_in_form=1),
//           calls framer-push POST /schema with that field, and ADVANCES framer_type +
//           framer_field_id on the accepted /schema result.
//       (b) FULL ADD-A-FIELD FLOW: after applyFramerTypes adds the field, buildEditView
//           RENDERS it as an editable input on the entity edit page, and saveEntity
//           PERSISTS its value to custom_fields[key].
//       (c) a RETYPE of an existing field updates framer_type to the applied value.
//       (d) RBAC: a non-admin (role !== 'admin') is denied.
//
// Harness mirrors test/field-builder.test.ts (mutable ROLE for the Full-Admin gate).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { schema } from '@esperanza/db';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const INIT_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');
const VIEWS_SQL = readFileSync(join(__dirname, '..', '..', 'db', 'views.sql'), 'utf8');

interface Harness {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  queue: Array<{ collection: string; action: string; id: string }>;
}
let H: Harness;
const ACTOR = 'matt@hazard.house';
let ROLE = 'admin';

// Captured /schema calls + the canned response postSchema returns.
interface SchemaCall {
  collection: string;
  fields: Array<{ key: string; framer_type: string; label?: string }>;
}
let SCHEMA_CALLS: SchemaCall[] = [];
let SCHEMA_IMPL: ((c: SchemaCall) => unknown) | null = null;

function freshHarness(): Harness {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(INIT_SQL);
  sqlite.exec(VIEWS_SQL);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, queue: [] };
}

vi.mock('../lib/db', () => ({
  getDb: () => ({ db: H.db, session: {} }),
  getReadDb: () => H.db,
  idColumn: (table: unknown) => (table as { id: unknown }).id,
}));
vi.mock('../lib/auth', () => ({
  getCurrentUser: async () => ACTOR,
  isAdmin: async () => ROLE === 'admin',
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: {
      FRAMER_QUEUE: {
        send: async (msg: { collection: string; action: string; id: string }) => {
          H.queue.push(msg);
        },
      },
      // framer-push reach: the action reads these; postSchema itself is mocked below.
      FRAMER_PUSH_URL: 'https://framer-push.test',
      WEBHOOK_TOKEN: 'tok',
    },
  }),
}));
// Mock the ONE network hop. Capture the call; return the canned (or default) response.
vi.mock('../lib/framer-push-client', () => ({
  postSchema: async (_env: unknown, collection: string, fields: SchemaCall['fields']) => {
    const call: SchemaCall = { collection, fields };
    SCHEMA_CALLS.push(call);
    if (SCHEMA_IMPL) return SCHEMA_IMPL(call);
    // default: everything created/retyped successfully.
    return {
      ok: true,
      collection,
      collectionName: collection,
      deploymentId: 'dep_test',
      fields: fields.map((f) => ({ key: f.key, action: 'created', detail: 'ok' })),
    };
  },
}));

// Import AFTER mocks (hoisted).
import { applyFramerTypes, saveEntity } from '../lib/actions';
import { buildEditView } from '../lib/build-edit-view';
import {
  isSettableFramerType,
  recommendedFramerTypes,
  compatibleFramerTypes,
  classifyConversion,
  defaultFramerType,
} from '../lib/framer-types';

beforeEach(() => {
  H = freshHarness();
  ROLE = 'admin';
  SCHEMA_CALLS = [];
  SCHEMA_IMPL = null;
});
afterEach(() => {
  H.sqlite.close();
});

// helpers ---------------------------------------------------------------------
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}
const fieldDefRow = (entity: string, key: string) =>
  H.sqlite
    .prepare('SELECT * FROM field_definitions WHERE entity = ? AND key = ?')
    .get(entity, key) as Record<string, unknown> | undefined;

function seedExistingDef(over: Partial<Record<string, unknown>>): void {
  const base = {
    id: `qmi__${over.key}`,
    entity: 'qmi',
    key: 'x',
    label: 'X',
    help: null,
    group_label: null,
    sort: 0,
    type: 'text',
    options_json: null,
    required: 0,
    system: 0,
    visible_in_form: 1,
    visible_in_list: 0,
    half_width: 0,
    framer_field_id: null,
    framer_type: 'string',
    custom: 0,
    ...over,
  };
  H.sqlite
    .prepare(
      `INSERT INTO field_definitions
        (id, entity, key, label, help, group_label, sort, type, options_json, required,
         system, visible_in_form, visible_in_list, half_width, framer_field_id, framer_type, custom)
       VALUES (@id,@entity,@key,@label,@help,@group_label,@sort,@type,@options_json,@required,
         @system,@visible_in_form,@visible_in_list,@half_width,@framer_field_id,@framer_type,@custom)`
    )
    .run(base);
}

// =============================================================================
// PURE helpers
// =============================================================================
describe('framer-types pure helpers', () => {
  it('settable types exclude enum; include string/link/formattedText/date/image', () => {
    expect(isSettableFramerType('string')).toBe(true);
    expect(isSettableFramerType('link')).toBe(true);
    expect(isSettableFramerType('formattedText')).toBe(true);
    expect(isSettableFramerType('date')).toBe(true);
    expect(isSettableFramerType('image')).toBe(true);
    expect(isSettableFramerType('enum')).toBe(false); // needs cases — not /schema-settable
  });

  it('recommended/default targets match the natural mapping', () => {
    expect(defaultFramerType('text')).toBe('string');
    expect(defaultFramerType('rich')).toBe('formattedText');
    expect(defaultFramerType('url')).toBe('link');
    expect(defaultFramerType('image')).toBe('image');
    expect(recommendedFramerTypes('number')).toEqual(['number']);
  });

  it('classifyConversion flags risky + invalid conversions', () => {
    expect(classifyConversion('text', 'string')).toBe('ok');
    expect(classifyConversion('text', 'link')).toBe('ok'); // text→link is compatible
    expect(classifyConversion('number', 'image')).toBe('risky'); // the documented risky case
    expect(classifyConversion('text', 'enum')).toBe('invalid'); // not settable
    expect(compatibleFramerTypes('number')).toContain('number');
  });
});

// =============================================================================
// applyFramerTypes — ADDED field
// =============================================================================
describe('applyFramerTypes — adds a custom field', () => {
  it('(a) inserts field_definitions (custom=1) FIRST, calls /schema, advances framer_type', async () => {
    const res = await applyFramerTypes({
      qmi: [
        {
          key: 'plan_viewer_link',
          framerType: 'link',
          add: { adminType: 'url', label: 'Plan Viewer Link' },
        },
      ],
    });
    expect(res.ok).toBe(true);

    // The registry row exists, custom=1, visible_in_form=1, the given admin type.
    const row = fieldDefRow('qmi', 'plan_viewer_link')!;
    expect(row).toBeDefined();
    expect(row.custom).toBe(1);
    expect(row.visible_in_form).toBe(1);
    expect(row.type).toBe('url');
    // framer_type ADVANCED to the applied value; framer_field_id stamped to the key.
    expect(row.framer_type).toBe('link');
    expect(row.framer_field_id).toBe('plan_viewer_link');

    // framer-push /schema was called once for qmi with the added field.
    expect(SCHEMA_CALLS).toHaveLength(1);
    expect(SCHEMA_CALLS[0]!.collection).toBe('qmi');
    expect(SCHEMA_CALLS[0]!.fields).toEqual([
      { key: 'plan_viewer_link', framer_type: 'link', label: 'Plan Viewer Link' },
    ]);

    // per-field result surfaced.
    if (res.ok) {
      const fr = res.results[0]!.fields.find((f) => f.key === 'plan_viewer_link')!;
      expect(fr.status).toBe('created');
      expect(fr.framerAction).toBe('created');
      expect(res.results[0]!.deploymentId).toBe('dep_test');
    }

    // an audit row for the create + the framer_type set.
    const audits = H.sqlite
      .prepare("SELECT action FROM audit_log WHERE entity = 'field_definitions:qmi' ORDER BY id")
      .all() as Array<{ action: string }>;
    expect(audits.map((a) => a.action)).toContain('field_create');
    expect(audits.map((a) => a.action)).toContain('framer_type_set');
  });

  it('(b) FULL FLOW: the added field renders on the entity edit page AND persists to custom_fields', async () => {
    // Seed a QMI record so buildEditView has a row.
    H.sqlite.prepare(`INSERT INTO qmi (id) VALUES ('q1')`).run();

    await applyFramerTypes({
      qmi: [
        {
          key: 'plan_viewer_link',
          framerType: 'link',
          add: { adminType: 'url', label: 'Plan Viewer Link' },
        },
      ],
    });

    // RENDER: the new field appears as an editable generic input on the QMI edit page.
    const view = await buildEditView('qmi', 'q1');
    expect(view).not.toBeNull();
    const field = view!.fields.find((f) => f.field === 'plan_viewer_link');
    expect(field).toBeDefined();
    expect(field!.kind).toBe('generic'); // an editable input, not read-only
    if (field!.kind === 'generic') {
      expect(field!.widget).not.toBe('synced'); // editable
      expect(field!.value).toBe(''); // empty until set
    }

    // PERSIST: editing it writes into custom_fields[plan_viewer_link] (not a column).
    const save = await saveEntity(
      'qmi',
      'q1',
      form({ plan_viewer_link: 'https://viewer.example.com/abc' })
    );
    expect(save).toEqual({ ok: true });
    const stored = H.sqlite
      .prepare('SELECT custom_fields FROM qmi WHERE id = ?')
      .get('q1') as { custom_fields: string | null };
    expect(JSON.parse(stored.custom_fields!)).toEqual({
      plan_viewer_link: 'https://viewer.example.com/abc',
    });

    // READ-BACK: buildEditView now shows the saved value.
    const view2 = await buildEditView('qmi', 'q1');
    const field2 = view2!.fields.find((f) => f.field === 'plan_viewer_link')!;
    if (field2.kind === 'generic') {
      expect(field2.value).toBe('https://viewer.example.com/abc');
    }
  });
});

// =============================================================================
// applyFramerTypes — RETYPE existing
// =============================================================================
describe('applyFramerTypes — re-types an existing field', () => {
  it('(c) updates field_definitions.framer_type to the applied value', async () => {
    seedExistingDef({ key: 'description', label: 'Description', type: 'long', framer_type: 'string' });
    SCHEMA_IMPL = (c) => ({
      ok: true,
      collection: c.collection,
      collectionName: c.collection,
      deploymentId: 'dep_retype',
      fields: c.fields.map((f) => ({ key: f.key, action: 'retyped', detail: 'string → formattedText' })),
    });

    const res = await applyFramerTypes({
      qmi: [{ key: 'description', framerType: 'formattedText' }],
    });
    expect(res.ok).toBe(true);

    const row = fieldDefRow('qmi', 'description')!;
    expect(row.framer_type).toBe('formattedText');
    expect(row.framer_field_id).toBe('description');

    expect(SCHEMA_CALLS[0]!.fields).toEqual([
      { key: 'description', framer_type: 'formattedText', label: 'Description' },
    ]);
    if (res.ok) {
      const fr = res.results[0]!.fields.find((f) => f.key === 'description')!;
      expect(fr.framerAction).toBe('retyped');
      expect(fr.status).toBe('applied');
    }
  });

  it('a /schema field error does NOT advance framer_type', async () => {
    seedExistingDef({ key: 'description', label: 'Description', type: 'long', framer_type: 'string' });
    SCHEMA_IMPL = (c) => ({
      ok: false,
      collection: c.collection,
      collectionName: c.collection,
      deploymentId: null,
      fields: c.fields.map((f) => ({ key: f.key, action: 'error', detail: 'setFields failed' })),
    });

    const res = await applyFramerTypes({
      qmi: [{ key: 'description', framerType: 'formattedText' }],
    });
    expect(res.ok).toBe(true);
    // framer_type stayed at the original — the error short-circuited the update.
    expect(fieldDefRow('qmi', 'description')!.framer_type).toBe('string');
    if (res.ok) {
      const fr = res.results[0]!.fields.find((f) => f.key === 'description')!;
      expect(fr.status).toBe('error');
    }
  });
});

// =============================================================================
// RBAC
// =============================================================================
describe('applyFramerTypes — RBAC', () => {
  it('(d) denies a non-admin (role !== admin) and writes NOTHING', async () => {
    ROLE = 'editor';
    const res = await applyFramerTypes({
      qmi: [
        { key: 'plan_viewer_link', framerType: 'link', add: { adminType: 'url', label: 'X' } },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Full Admin/i);
    // no registry row, no /schema call.
    expect(fieldDefRow('qmi', 'plan_viewer_link')).toBeUndefined();
    expect(SCHEMA_CALLS).toHaveLength(0);
  });
});
