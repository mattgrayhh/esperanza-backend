// =============================================================================
// Field Types Phase C — unit tests for the config-driven output-type layer:
//   * coerceToFramerType: every coercion pair + drop-on-incompatible/empty.
//   * applyTypeOverrides: no-op when framer_type == emitted type; re-types when it
//     differs; drops on incompatible coercion; leaves unmatched keys untouched.
//   * emitCustomFields: custom_fields[key] → { type: framer_type, value }; empties
//     dropped; only custom=1 defs emitted.
//   * buildItem end-to-end: override no-op against the REAL seeded field_definitions
//     (regression proof) + custom-field append.
//   * applySchema: re-type existing + create missing + abort on unsupported +
//     pure no-op; via the mock FramerClient.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, d1, insertRow } from './helpers.js';
import {
  coerceToFramerType,
  applyTypeOverrides,
  emitCustomFields,
  parseCustomFields,
  loadFieldDefs,
  type FieldDef,
} from '../src/type-overrides.js';
import { buildItem, applySchema } from '../src/consumer.js';
import type { ConsumerEnv } from '../src/consumer.js';
import { COLLECTION_DEFS } from '../src/collections.js';
import { createMockFramer, type ManagedField } from '../src/framer.js';
import { str, num, bool, image, link, formattedText, date, galleryArray } from '../src/framer-types.js';
import type { FieldData } from '../src/framer-types.js';

function consumerEnv(db: ReturnType<typeof freshDb>): ConsumerEnv {
  return {
    DB: d1(db),
    FRAMER_PROJECT_URL: 'https://framer.com/projects/Test--t47CBg6stJkC8hsPgamo-egL7H',
    FRAMER_API_KEY: 'test-token',
  };
}

/** Insert a field_definitions row (only the columns the push layer reads + NOT NULLs). */
function seedDef(
  db: ReturnType<typeof freshDb>,
  entity: string,
  key: string,
  framer_type: string | null,
  custom = 0
): void {
  insertRow(db, 'field_definitions', {
    id: `${entity}__${key}`,
    entity,
    key,
    label: key,
    type: 'text',
    framer_type,
    custom,
  });
}

// =============================================================================
// coerceToFramerType — all pairs
// =============================================================================
describe('coerceToFramerType', () => {
  it('string ← scalars; drops empty', () => {
    expect(coerceToFramerType('hello', 'string')).toEqual(str('hello'));
    expect(coerceToFramerType(42, 'string')).toEqual(str('42'));
    expect(coerceToFramerType(true, 'string')).toEqual(str('true'));
    expect(coerceToFramerType('', 'string')).toBeUndefined();
    expect(coerceToFramerType(null, 'string')).toBeUndefined();
    expect(coerceToFramerType('  ', 'string')).toBeUndefined();
  });

  it('formattedText ← scalars; drops empty', () => {
    expect(coerceToFramerType('# hi', 'formattedText')).toEqual(formattedText('# hi'));
    expect(coerceToFramerType('', 'formattedText')).toBeUndefined();
  });

  it('number ← numeric string/number; drops NaN/empty', () => {
    expect(coerceToFramerType('425000', 'number')).toEqual(num(425000));
    expect(coerceToFramerType(3.5, 'number')).toEqual(num(3.5));
    expect(coerceToFramerType('not-a-number', 'number')).toBeUndefined();
    expect(coerceToFramerType('', 'number')).toBeUndefined();
    expect(coerceToFramerType(null, 'number')).toBeUndefined();
  });

  it('boolean ← bool/1/0/true/false/yes/no; drops ambiguous', () => {
    expect(coerceToFramerType(true, 'boolean')).toEqual(bool(true));
    expect(coerceToFramerType(false, 'boolean')).toEqual(bool(false));
    expect(coerceToFramerType(1, 'boolean')).toEqual(bool(true));
    expect(coerceToFramerType(0, 'boolean')).toEqual(bool(false));
    expect(coerceToFramerType('true', 'boolean')).toEqual(bool(true));
    expect(coerceToFramerType('No', 'boolean')).toEqual(bool(false));
    expect(coerceToFramerType('maybe', 'boolean')).toBeUndefined();
    expect(coerceToFramerType(2, 'boolean')).toBeUndefined();
    expect(coerceToFramerType('', 'boolean')).toBeUndefined();
  });

  it('link ← valid http(s) URL only; drops non-URL', () => {
    expect(coerceToFramerType('https://x.com/a', 'link')).toEqual(link('https://x.com/a'));
    expect(coerceToFramerType('http://y.com', 'link')).toEqual(link('http://y.com'));
    expect(coerceToFramerType('not a url', 'link')).toBeUndefined();
    expect(coerceToFramerType('ftp://z.com', 'link')).toBeUndefined();
    expect(coerceToFramerType('', 'link')).toBeUndefined();
  });

  it('image ← valid http(s) URL only; drops non-URL', () => {
    expect(coerceToFramerType('https://m.com/a.jpg', 'image')).toEqual(image('https://m.com/a.jpg'));
    expect(coerceToFramerType('relative/path.jpg', 'image')).toBeUndefined();
  });

  it('date → real Framer date (ISO); enum carries as string', () => {
    expect(coerceToFramerType('2026-06-02', 'date')).toEqual(date('2026-06-02'));
    expect(date('2026-06-02')).toEqual({ type: 'date', value: '2026-06-02T00:00:00.000Z' });
    expect(coerceToFramerType('Live', 'enum')).toEqual(str('Live'));
    expect(coerceToFramerType('', 'date')).toBeUndefined();
  });

  it('array passes through only a real array value; drops scalars', () => {
    const gal = galleryArray(['https://m.com/a.jpg']);
    expect(coerceToFramerType(gal, 'array')).toBe(gal);
    expect(coerceToFramerType('https://m.com/a.jpg', 'array')).toBeUndefined();
  });

  it('cross-type: unwraps a wrapped FieldValue then re-coerces', () => {
    // a wrapped string → number
    expect(coerceToFramerType(str('99'), 'number')).toEqual(num(99));
    // a wrapped number → string
    expect(coerceToFramerType(num(7), 'string')).toEqual(str('7'));
    // a wrapped string url → link
    expect(coerceToFramerType(str('https://x.com'), 'link')).toEqual(link('https://x.com'));
    // string → formattedText
    expect(coerceToFramerType(str('body'), 'formattedText')).toEqual(formattedText('body'));
    // formattedText → string
    expect(coerceToFramerType(formattedText('<p>hi</p>'), 'string')).toEqual(str('<p>hi</p>'));
  });

  it('unknown target type → drop', () => {
    expect(coerceToFramerType('x', 'collectionReference')).toBeUndefined();
  });
});

// =============================================================================
// applyTypeOverrides
// =============================================================================
describe('applyTypeOverrides', () => {
  it('is a NO-OP when framer_type equals the emitted type', () => {
    const fd: FieldData = { title: str('Hello'), price: num(100), published: bool(true) };
    const before = JSON.parse(JSON.stringify(fd));
    const defs: FieldDef[] = [
      { key: 'title', framer_type: 'string', custom: 0 },
      { key: 'price', framer_type: 'number', custom: 0 },
      { key: 'published', framer_type: 'boolean', custom: 0 },
    ];
    applyTypeOverrides('qmi', fd, defs);
    expect(JSON.parse(JSON.stringify(fd))).toEqual(before);
    // identity preserved (same value objects, not re-wrapped)
  });

  it('re-types a field whose configured framer_type differs (string → link)', () => {
    const fd: FieldData = { cta: str('https://x.com/promo') };
    applyTypeOverrides('promotions', fd, [{ key: 'cta', framer_type: 'link', custom: 0 }]);
    expect(fd['cta']).toEqual(link('https://x.com/promo'));
  });

  it('re-types string → number and string → formattedText', () => {
    const fd: FieldData = { zip: str('77384'), copy: str('# Big sale') };
    applyTypeOverrides('qmi', fd, [
      { key: 'zip', framer_type: 'number', custom: 0 },
      { key: 'copy', framer_type: 'formattedText', custom: 0 },
    ]);
    expect(fd['zip']).toEqual(num(77384));
    expect(fd['copy']).toEqual(formattedText('# Big sale'));
  });

  it('DROPS a field when the re-type coercion is incompatible', () => {
    const fd: FieldData = { ref: str('not a url') };
    applyTypeOverrides('communities', fd, [{ key: 'ref', framer_type: 'link', custom: 0 }]);
    expect(fd['ref']).toBeUndefined();
    expect('ref' in fd).toBe(false);
  });

  it('leaves keys with NO matching def untouched', () => {
    const fd: FieldData = { orphan: str('keep me') };
    applyTypeOverrides('qmi', fd, [{ key: 'something_else', framer_type: 'number', custom: 0 }]);
    expect(fd['orphan']).toEqual(str('keep me'));
  });

  it('ignores custom=1 defs (those are emitted separately, not re-typed here)', () => {
    const fd: FieldData = { plan_viewer_link: str('https://x.com') };
    applyTypeOverrides('qmi', fd, [{ key: 'plan_viewer_link', framer_type: 'link', custom: 1 }]);
    // custom def is skipped → the (coincidentally pre-present) value is untouched
    expect(fd['plan_viewer_link']).toEqual(str('https://x.com'));
  });
});

// =============================================================================
// emitCustomFields
// =============================================================================
describe('emitCustomFields', () => {
  const defs: FieldDef[] = [
    { key: 'plan_viewer_link', framer_type: 'link', custom: 1 },
    { key: 'priority', framer_type: 'number', custom: 1 },
    { key: 'title', framer_type: 'string', custom: 0 }, // NOT custom → ignored
  ];

  it('emits each custom value coerced to its framer_type', () => {
    const out = emitCustomFields(
      JSON.stringify({ plan_viewer_link: 'https://x.com/plan', priority: '5', title: 'should-be-ignored' }),
      defs
    );
    expect(out['plan_viewer_link']).toEqual(link('https://x.com/plan'));
    expect(out['priority']).toEqual(num(5));
    expect(out['title']).toBeUndefined(); // custom=0 def is not emitted
  });

  it('drops empty/absent/invalid custom values', () => {
    const out = emitCustomFields(JSON.stringify({ plan_viewer_link: '', priority: 'nope' }), defs);
    expect(out['plan_viewer_link']).toBeUndefined(); // empty string dropped
    expect(out['priority']).toBeUndefined(); // NaN dropped
  });

  it('accepts an object (not just a JSON string) and tolerates garbage', () => {
    expect(emitCustomFields({ priority: 9 }, defs)['priority']).toEqual(num(9));
    expect(emitCustomFields('not json', defs)).toEqual({});
    expect(emitCustomFields(null, defs)).toEqual({});
  });

  it('parseCustomFields returns {} on null/empty/array/garbage', () => {
    expect(parseCustomFields(null)).toEqual({});
    expect(parseCustomFields('')).toEqual({});
    expect(parseCustomFields('[1,2]')).toEqual({});
    expect(parseCustomFields('{bad')).toEqual({});
    expect(parseCustomFields('{"a":1}')).toEqual({ a: 1 });
  });
});

// =============================================================================
// loadFieldDefs cache
// =============================================================================
describe('loadFieldDefs', () => {
  it('reads defs for an entity and caches by entity (one query per entity)', async () => {
    const db = freshDb();
    seedDef(db, 'qmi', 'title', 'string');
    seedDef(db, 'qmi', 'price', 'number');
    seedDef(db, 'communities', 'name', 'string');
    const env = consumerEnv(db);
    const cache = new Map<string, FieldDef[]>();
    const a = await loadFieldDefs(env.DB, 'qmi', cache);
    expect(a.map((d) => d.key).sort()).toEqual(['price', 'title']);
    const b = await loadFieldDefs(env.DB, 'qmi', cache); // cache hit
    expect(b).toBe(a); // same array reference → no re-query
    const c = await loadFieldDefs(env.DB, 'communities', cache);
    expect(c.map((d) => d.key)).toEqual(['name']);
  });
});

// =============================================================================
// buildItem — override no-op against REAL seeded defs + custom append
// =============================================================================
describe('buildItem (mapper + overrides + custom)', () => {
  it('override is a NO-OP for a published QMI when defs match the mapper (regression)', async () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMINOOP00001',
      published: 1,
      synced_address: '10 Steady Ln',
      synced_price: 500000,
      description: 'A nice home', // mapper emits sIf → string
      viewer_slug: 'steady-10',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    // Seed the reconciled defs: postal_code=string, description=string, price=number,
    // address=string (matching the live mapper output — the audited steady state).
    seedDef(db, 'qmi', 'address', 'string');
    seedDef(db, 'qmi', 'price', 'number');
    seedDef(db, 'qmi', 'description', 'string'); // RECONCILED (was formattedText)
    seedDef(db, 'qmi', 'postal_code', 'string'); // RECONCILED (was number)

    const env = consumerEnv(db);
    const def = COLLECTION_DEFS.qmi;
    const row = await env.DB.prepare(def.selectByIdSql).bind('recQMINOOP00001').first<Record<string, unknown>>();
    const baseline = def.map(row!); // mapper-only output
    const built = await buildItem(env, def, row!, new Map());

    // every mapper-emitted field is byte-identical after the override pass
    expect(built.fieldData).toEqual(baseline.fieldData);
    expect(built.fieldData['description']?.type).toBe('string');
    expect(built.fieldData['price']?.type).toBe('number');
  });

  it('appends a CUSTOM field value coerced to its framer_type', async () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMICUSTOM001',
      published: 1,
      synced_address: '12 Custom Ct',
      custom_fields: JSON.stringify({ plan_viewer_link: 'https://viewer.example.com/plan/42' }),
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    seedDef(db, 'qmi', 'plan_viewer_link', 'link', 1); // custom=1
    const env = consumerEnv(db);
    const def = COLLECTION_DEFS.qmi;
    const row = await env.DB.prepare(def.selectByIdSql).bind('recQMICUSTOM001').first<Record<string, unknown>>();
    const built = await buildItem(env, def, row!, new Map());
    expect(built.fieldData['plan_viewer_link']).toEqual(link('https://viewer.example.com/plan/42'));
  });

  it('does not emit a custom field whose value is empty', async () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMICUSTOM002',
      published: 1,
      synced_address: '13 Empty Ct',
      custom_fields: JSON.stringify({ plan_viewer_link: '' }),
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    seedDef(db, 'qmi', 'plan_viewer_link', 'link', 1);
    const env = consumerEnv(db);
    const def = COLLECTION_DEFS.qmi;
    const row = await env.DB.prepare(def.selectByIdSql).bind('recQMICUSTOM002').first<Record<string, unknown>>();
    const built = await buildItem(env, def, row!, new Map());
    expect(built.fieldData['plan_viewer_link']).toBeUndefined();
  });
});

// =============================================================================
// applySchema — re-type + create + abort-on-unsupported + no-op
// =============================================================================
describe('applySchema (/schema core)', () => {
  function envWithRow(): ConsumerEnv {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMISCHEMA001',
      published: 1,
      synced_address: '1 Schema Way',
      viewer_slug: 'schema-1',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    return consumerEnv(db);
  }

  const baseFields: ManagedField[] = [
    { id: 'address', name: 'Address', type: 'string' },
    { id: 'postal_code', name: 'ZIP', type: 'number' },
    { id: 'slug', name: 'Slug', type: 'string' },
  ];

  it('re-types an existing field and creates a missing one, then re-pushes', async () => {
    const env = envWithRow();
    const mock = createMockFramer(['Quick Move-Ins'], { 'Quick Move-Ins': baseFields });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [
      { key: 'postal_code', framer_type: 'string', label: 'ZIP' }, // retype number→string
      { key: 'plan_viewer_link', framer_type: 'link', label: 'Plan Viewer Link' }, // create
      { key: 'address', framer_type: 'string' }, // unchanged
    ]);

    const byKey = Object.fromEntries(result.fields.map((f) => [f.key, f.action]));
    expect(byKey['postal_code']).toBe('retyped');
    expect(byKey['plan_viewer_link']).toBe('created');
    expect(byKey['address']).toBe('unchanged');
    expect(result.error).toBeUndefined();

    // setFields was called once with the FULL preserved set (3 existing + 1 new)
    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.setFieldsCalls.length).toBe(1);
    const set = state.setFieldsCalls[0]!;
    const setById = Object.fromEntries(set.map((f) => [f.id, f.type]));
    expect(setById['postal_code']).toBe('string'); // re-typed
    expect(setById['plan_viewer_link']).toBe('link'); // created
    expect(setById['address']).toBe('string'); // preserved
    expect(setById['slug']).toBe('string'); // preserved (not in request)
    expect(set.length).toBe(4);

    // re-push happened → addItems called + a deployment id returned
    expect(state.addItemsCalls.length).toBeGreaterThan(0);
    expect(result.deploymentId).toBeTruthy();
  });

  it('preserves a non-scalar field’s sub-schema (array `fields`) through the setFields rebuild', async () => {
    // Regression: a collection with a gallery (array) field could not have ANY field
    // re-typed — rebuilding the field set dropped the array's nested item schema, so
    // Framer's setFields validator rejected the whole call ("invalid type on …fields,
    // expect to be [ManagedArrayItemFieldInput]"). The array field is NOT in the request;
    // it must be passed through verbatim, sub-schema and all.
    const env = envWithRow();
    const itemSchema = [{ fieldData: { image: { type: 'image' } } }];
    const mock = createMockFramer(['Quick Move-Ins'], {
      'Quick Move-Ins': [
        ...baseFields,
        { id: 'photo_gallery', name: 'Photo Gallery', type: 'array', fields: itemSchema },
      ],
    });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [
      { key: 'postal_code', framer_type: 'string', label: 'ZIP' }, // retype a scalar only
    ]);

    expect(result.error).toBeUndefined();
    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.setFieldsCalls.length).toBe(1);
    const gallery = state.setFieldsCalls[0]!.find((f) => f.id === 'photo_gallery');
    expect(gallery).toBeDefined();
    expect(gallery!.type).toBe('array');
    // The array field MUST carry its nested item schema or Framer rejects the rebuild.
    expect(gallery!.fields).toEqual(itemSchema);
  });

  it('CREATES a missing gallery (array) field with a valid nested item sub-schema', async () => {
    // Creating an array field needs a nested `fields` ([ManagedArrayItemFieldInput]) or
    // Framer rejects the rebuild. Reuse an existing gallery's sub-schema on the same
    // collection (here photo_gallery) so the new field's item shape is guaranteed valid.
    const env = envWithRow();
    const itemSchema = [{ fieldData: { image: { type: 'image' } } }];
    const mock = createMockFramer(['Quick Move-Ins'], {
      'Quick Move-Ins': [
        ...baseFields,
        { id: 'photo_gallery', name: 'Photo Gallery', type: 'array', fields: itemSchema },
      ],
    });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [
      { key: 'interior_photos', framer_type: 'array', label: 'Interior Photos' },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.fields.find((f) => f.key === 'interior_photos')?.action).toBe('created');
    const set = mock.collections.get('Quick Move-Ins')!.setFieldsCalls[0]!;
    const created = set.find((f) => f.id === 'interior_photos');
    expect(created!.type).toBe('array');
    // Must carry a nested item sub-schema (reused from photo_gallery) — not bare.
    expect(created!.fields).toEqual(itemSchema);
  });

  it('CREATES a gallery field with a fallback image item when the collection has no existing gallery', async () => {
    const env = envWithRow();
    const mock = createMockFramer(['Quick Move-Ins'], { 'Quick Move-Ins': baseFields });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [
      { key: 'interior_photos', framer_type: 'array', label: 'Interior Photos' },
    ]);
    expect(result.error).toBeUndefined();
    const created = mock.collections
      .get('Quick Move-Ins')!
      .setFieldsCalls[0]!.find((f) => f.id === 'interior_photos');
    expect(created!.fields).toEqual([{ id: 'image', type: 'image', name: 'Image' }]);
  });

  it('is a pure no-op (no setFields) when every requested field already matches', async () => {
    const env = envWithRow();
    const mock = createMockFramer(['Quick Move-Ins'], { 'Quick Move-Ins': baseFields });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [
      { key: 'address', framer_type: 'string' },
      { key: 'postal_code', framer_type: 'number' },
    ]);
    expect(result.fields.every((f) => f.action === 'unchanged')).toBe(true);
    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.setFieldsCalls.length).toBe(0); // schema untouched
    expect(result.deploymentId).toBeNull(); // no re-push
  });

  it('drops a field: removes it from the set, no re-push', async () => {
    // Drop is the escape hatch for type changes Framer won't apply in place (e.g.
    // string → date): drop the field, then re-create it as the new type in a later call.
    const env = envWithRow();
    const mock = createMockFramer(['Quick Move-Ins'], { 'Quick Move-Ins': baseFields });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [], { drop: ['postal_code'] });

    const byKey = Object.fromEntries(result.fields.map((f) => [f.key, f.action]));
    expect(byKey['postal_code']).toBe('dropped');
    expect(result.error).toBeUndefined();

    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.setFieldsCalls.length).toBe(1);
    const set = state.setFieldsCalls[0]!;
    expect(set.find((f) => f.id === 'postal_code')).toBeUndefined(); // gone
    expect(set.find((f) => f.id === 'address')).toBeDefined(); // others preserved
    expect(state.addItemsCalls.length).toBe(0); // pure drop → no re-push
    expect(result.deploymentId).toBeNull();
  });

  it('drop of a non-existent field is a no-op for that key', async () => {
    const env = envWithRow();
    const mock = createMockFramer(['Quick Move-Ins'], { 'Quick Move-Ins': baseFields });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [], { drop: ['nope'] });
    expect(result.fields[0]).toMatchObject({ key: 'nope', action: 'unchanged' });
    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.setFieldsCalls.length).toBe(0); // nothing changed
  });

  it('ABORTS (no setFields) when an existing field is type "unsupported"', async () => {
    const env = envWithRow();
    const mock = createMockFramer(['Quick Move-Ins'], {
      'Quick Move-Ins': [...baseFields, { id: 'weird', name: 'Weird', type: 'unsupported' }],
    });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [
      { key: 'postal_code', framer_type: 'string' },
    ]);
    expect(result.error).toMatch(/unsupported/);
    expect(result.fields.every((f) => f.action === 'error')).toBe(true);
    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.setFieldsCalls.length).toBe(0);
  });

  it('errors a field whose requested target type is not settable', async () => {
    const env = envWithRow();
    const mock = createMockFramer(['Quick Move-Ins'], { 'Quick Move-Ins': baseFields });
    const framer = await mock.connect(env);
    const result = await applySchema(env, framer, 'qmi', [
      { key: 'postal_code', framer_type: 'collectionReference' },
    ]);
    expect(result.fields[0]!.action).toBe('error');
    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.setFieldsCalls.length).toBe(0); // nothing changed → no setFields
  });
});
