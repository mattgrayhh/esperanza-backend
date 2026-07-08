// =============================================================================
// QMI mapper test (most complex collection). Asserts the full field set maps,
// COALESCE(override, synced) wins, FP:* fallback chain, slug underscore
// normalization, numField drops empties (no "0" leak), draft soft-delete gate,
// and end-to-end upsert-by-id through the mock Framer client.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, d1, insertRow } from './helpers.js';
import { COLLECTION_DEFS, dedupeSlugs } from '../src/collections.js';
import type { ManagedCollectionItemInput } from '../src/framer-types.js';
import { pushMessage, handleQueueBatch, loadRowById } from '../src/consumer.js';
import type { ConsumerEnv } from '../src/consumer.js';
import { createMockFramer } from '../src/framer.js';
import type { FieldValue, ArrayFieldValue } from '../src/framer-types.js';
import type { Env } from '../src/index.js';

function consumerEnv(db: ReturnType<typeof freshDb>): ConsumerEnv {
  return {
    DB: d1(db),
    FRAMER_PROJECT_URL: 'https://framer.com/projects/Test--t47CBg6stJkC8hsPgamo-egL7H',
    FRAMER_API_KEY: 'test-token',
  };
}

const sval = (v: FieldValue | ArrayFieldValue | undefined) =>
  v && v.type !== 'array' ? (v as FieldValue).value : undefined;

const qmiDef = COLLECTION_DEFS.qmi;

describe('QMI mapper — field set, COALESCE, FP fallback, slug, numField', () => {
  it('maps the full field set with override winning over synced', async () => {
    const db = freshDb();
    // FP:* lookups are resolved via the floor-plan JOIN (qmi.fp_* removed for the
    // D1 100-col limit). Seed the linked floor plan with the lookup source values;
    // the QMI just carries the link (synced_floor_plan_id).
    insertRow(db, 'floor_plans', {
      id: 'recFPkestrel0001',
      name: 'Kestrel',
      slug: 'kestrel',
      published: 1,
      synced_total_square_footage: 2450, // → FP: Total SqFt fallback
      synced_starting_price: 389000, // → FP: Starting Price
      fp_image: '[{"url":"https://media.esperanzahomes.com/fp/kestrel.jpg"}]',
      floor_plan_image:
        'https://img.hazardhouse.ai/floor_plans/recFPkestrel0001/floor-plan.png', // → fp_floor_plan_image (top-down layout)
    });
    insertRow(db, 'qmi', {
      id: 'recQMI0001ABCDEF',
      published: 1,
      synced_address: '100 Synced St',
      override_address: '200 Override Ave', // override wins
      synced_bedroom_count: 3,
      override_bedroom_count: 4, // override wins
      synced_bathroom_count: 2.5,
      synced_price: 400000,
      override_price: 425000, // override wins
      synced_city_name: 'Conroe',
      synced_community_name: 'Tres Lagos',
      synced_floor_plan_name: 'Kestrel',
      synced_floor_plan_id: 'recFPkestrel0001', // link → FP:* resolved via JOIN
      synced_postal_code: 77384, // base column; view aliases COALESCE(override,synced) → postal_code
      latitude: 30.1,
      longitude: -95.4,
      collection: 'Haven',
      self_tour_available: 1,
      available_now: 1,
      image_url: 'https://media.esperanzahomes.com/qmi/recQMI0001/og.jpg',
      viewer_slug: 'tres-lagos-200-override-ave',
      nter_now: 'https://www.webflow.nternow.com/EsperanzaHomes/property/55009',
      updated_at: '2026-05-30T12:00:00.000Z',
    });

    const env = consumerEnv(db);
    const row = await loadRowById(env, qmiDef, 'recQMI0001ABCDEF');
    expect(row).not.toBeNull();
    const item = qmiDef.map(row!);

    // upsert key = record id
    expect(item.id).toBe('recQMI0001ABCDEF');
    // slug normalized dashes→underscores
    expect(item.slug).toBe('tres_lagos_200_override_ave');
    // published row → not draft
    expect(item.draft).toBe(false);

    const f = item.fieldData;
    expect(sval(f['address'])).toBe('200 Override Ave'); // override
    expect(sval(f['bedroom_count'])).toBe(4); // override
    expect(sval(f['price'])).toBe(425000); // override
    expect(sval(f['bathroom_count'])).toBe(2.5); // synced (no override)
    expect(sval(f['city'])).toBe('Conroe');
    // NterNow "Enter Now" self-tour link must be emitted (regression: previously
    // absent from the QMI mapper, so populated values never reached Framer).
    expect(sval(f['nter_now'])).toBe(
      'https://www.webflow.nternow.com/EsperanzaHomes/property/55009',
    );
    expect(sval(f['community'])).toBe('Tres Lagos');
    expect(sval(f['postal_code'])).toBe('77384');
    expect(f['postal_code']?.type).toBe('string'); // live Framer field "ZIP" is type string
    expect(sval(f['collection'])).toBe('Haven');
    expect(sval(f['self_tour_available'])).toBe(true);
    expect(sval(f['available_now'])).toBe(true);
    expect(sval(f['image_url'])).toBe('https://media.esperanzahomes.com/qmi/recQMI0001/og.jpg');
    expect(f['image_url']?.type).toBe('image');

    // FP fallback: total_square_footage absent on QMI → falls back to FP: Total SqFt
    expect(sval(f['total_square_footage'])).toBe(2450);
    // fp_image unwrapped from [{url}] → image field
    expect(sval(f['fp_image'])).toBe('https://media.esperanzahomes.com/fp/kestrel.jpg');
    expect(sval(f['fp_starting_price'])).toBe(389000);

    // floor_plan_image: top-down layout resolved from the linked floor plan via JOIN
    expect(sval(f['floor_plan_image'])).toBe(
      'https://img.hazardhouse.ai/floor_plans/recFPkestrel0001/floor-plan.png'
    );
    expect(f['floor_plan_image']?.type).toBe('image');

    // floor_plan_slug derived from FP name, underscored
    expect(sval(f['floor_plan_slug'])).toBe('kestrel');
  });

  it('prefers a home-specific floor_plan_image override over the linked plan default', () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFPkestrel0001',
      name: 'Kestrel',
      slug: 'kestrel',
      published: 1,
      floor_plan_image: 'https://media.esperanzahomes.com/floor_plans/recFPkestrel0001/floor-plan.png',
    });
    insertRow(db, 'qmi', {
      id: 'recQMI0001ABCDEF',
      published: 1,
      synced_address: '1 Main',
      synced_floor_plan_id: 'recFPkestrel0001',
      floor_plan_image: 'https://media.esperanzahomes.com/qmi/recQMI0001/custom-layout.png',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMI0001ABCDEF') as Record<string, unknown>;
    const f = qmiDef.map(row).fieldData;
    expect(sval(f['floor_plan_image'])).toBe(
      'https://media.esperanzahomes.com/qmi/recQMI0001/custom-layout.png'
    );
  });

  it('emits lot_number_short = digits-only lot number (RC169 → 169), keeping raw lot_number', () => {
    const cases: Array<[string | null, unknown, unknown]> = [
      // [synced_lot_number, expected lot_number, expected lot_number_short]
      ['RC169', 'RC169', '169'], // strip 2-letter community prefix
      ['RC069', 'RC069', '69'], // drop leading zeros too
      ['169', '169', '169'], // already numeric → unchanged
      ['MODEL', 'MODEL', 'MODEL'], // no digits → fall back to raw
      [null, '', ''], // absent → both emit str('') so a cleared lot number propagates to Framer
    ];
    let n = 0;
    for (const [lot, expRaw, expShort] of cases) {
      const db = freshDb();
      const id = `recQMILOT${String(n++).padStart(7, '0')}`;
      insertRow(db, 'qmi', {
        id,
        published: 1,
        synced_address: '1 Lot St',
        ...(lot === null ? {} : { synced_lot_number: lot }),
        updated_at: '2026-05-30T12:00:00.000Z',
      });
      const row = db.prepare(qmiDef.selectByIdSql).get(id) as Record<string, unknown>;
      const f = qmiDef.map(row).fieldData;
      expect(sval(f['lot_number'])).toBe(expRaw);
      expect(sval(f['lot_number_short'])).toBe(expShort);
    }
  });

  it('lot_number_short follows the override → synced COALESCE like lot_number', () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMILOTOVR0001',
      published: 1,
      synced_address: '2 Lot St',
      synced_lot_number: 'RC169',
      override_lot_number: 'RC200', // override wins for both
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMILOTOVR0001') as Record<string, unknown>;
    const f = qmiDef.map(row).fieldData;
    expect(sval(f['lot_number'])).toBe('RC200');
    expect(sval(f['lot_number_short'])).toBe('200');
  });

  it('drops empty numbers (no "0" leak) and absent strings', () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMI0002ABCDEF',
      published: 1,
      synced_address: '1 Main',
      // no price, no sqft, no year_built, no FP fallbacks
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMI0002ABCDEF') as Record<string, unknown>;
    const item = qmiDef.map(row);
    const f = item.fieldData;
    // empty numerics must be ABSENT (undefined-dropped), never 0
    expect(f['price']).toBeUndefined();
    expect(f['year_built']).toBeUndefined();
    expect(f['total_square_footage']).toBeUndefined();
    expect(f['estimated_monthly_price']).toBeUndefined();
    // no linked floor plan → floor_plan_image dropped (never an empty image field)
    expect(f['floor_plan_image']).toBeUndefined();
    // booleans we deliberately always emit
    expect(sval(f['self_tour_available'])).toBe(false);
    expect(sval(f['available_now'])).toBe(false);
  });

  it('dedupes colliding slugs across a batch (first keeps slug, rest get rec-suffix)', () => {
    // Two homes at the same address share a precomputed slug → Framer "Duplicate slug".
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recDUPE0001AAAA',
      published: 1,
      synced_address: '2004 S Lake Texoma St',
      viewer_slug: '2004-s-lake-texoma-st',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    insertRow(db, 'qmi', {
      id: 'recDUPE0002BBBB',
      published: 1,
      synced_address: '2004 S Lake Texoma St',
      viewer_slug: '2004-s-lake-texoma-st', // same precomputed slug
      updated_at: '2026-05-30T12:00:00.000Z',
    });

    const rows = db.prepare(qmiDef.selectAllSql).all() as Record<string, unknown>[];
    const items = dedupeSlugs(rows.map((r) => qmiDef.map(r)));
    const slugs = items.map((i) => i.slug);

    // both base-map to the same slug, but after dedup they are unique
    expect(new Set(slugs).size).toBe(slugs.length);
    // first to claim it keeps the clean slug (no URL churn)
    expect(slugs).toContain('2004_s_lake_texoma_st');
    // the collider is disambiguated with its record suffix
    const collider = items.find((i) => i.slug !== '2004_s_lake_texoma_st')!;
    expect(collider.slug.startsWith('2004_s_lake_texoma_st_')).toBe(true);
  });

  it('dedupeSlugs leaves an already-unique batch untouched', () => {
    const items: ManagedCollectionItemInput[] = [
      { id: 'recA', slug: 'alpha', fieldData: {} },
      { id: 'recB', slug: 'beta', fieldData: {} },
    ];
    dedupeSlugs(items);
    expect(items.map((i) => i.slug)).toEqual(['alpha', 'beta']);
  });

  it('soft-deletes via draft:true when unpublished (item kept, hidden)', async () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMI0003ABCDEF',
      published: 0, // unpublished → draft:true
      synced_address: '9 Hidden Ct',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const env = consumerEnv(db);
    const mock = createMockFramer(['Quick Move-Ins']);
    const res = await pushMessage(env, await mock.connect(env), {
      collection: 'qmi',
      action: 'upsert',
      id: 'recQMI0003ABCDEF',
    });
    expect(res).toEqual({ upserted: 1, deleted: 0 });
    const state = mock.collections.get('Quick Move-Ins')!;
    const item = state.items.get('recQMI0003ABCDEF')!;
    expect(item.draft).toBe(true); // hidden but PRESENT (not removed)
    expect(state.items.size).toBe(1);
  });

  it('move_in_date carries the de-prefixed availability_text for the detail-page badge', async () => {
    const db = freshDb();
    // window case → badge "AVAILABLE JUN/JUL 2026" (static prefix + this value)
    insertRow(db, 'qmi', {
      id: 'recQMIwindow001',
      published: 1,
      synced_address: '1 Window Way',
      availability_text: 'Available JUN/JUL 2026',
      synced_move_in_date: '2026-07-15',
    });
    // available-now case → badge "AVAILABLE NOW"
    insertRow(db, 'qmi', {
      id: 'recQMInow0000001',
      published: 1,
      synced_address: '2 Now Now',
      availability_text: 'Available Now',
      synced_move_in_date: '2026-01-21',
    });
    // fallback: no availability_text → raw move_in_date
    insertRow(db, 'qmi', {
      id: 'recQMIfallback01',
      published: 1,
      synced_address: '3 Fallback Ln',
      synced_move_in_date: '2026-11-23',
    });
    const env = consumerEnv(db) as unknown as Env;

    const win = qmiDef.map((await loadRowById(env, qmiDef, 'recQMIwindow001'))!);
    expect(sval(win.fieldData['move_in_date'])).toBe('JUN/JUL 2026');

    const now = qmiDef.map((await loadRowById(env, qmiDef, 'recQMInow0000001'))!);
    expect(sval(now.fieldData['move_in_date'])).toBe('Now');

    const fb = qmiDef.map((await loadRowById(env, qmiDef, 'recQMIfallback01'))!);
    expect(sval(fb.fieldData['move_in_date'])).toBe('2026-11-23');
  });

  it('description defaults to the linked floor plan copy, overridden per-home', async () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFPdesc0000001',
      name: 'Verbena',
      slug: 'verbena',
      published: 1,
      description: 'The Verbena, part of our Haven Collection, blends light and space.',
    });
    // no own description → falls back to the plan copy
    insertRow(db, 'qmi', {
      id: 'recQMIdescFB0001',
      published: 1,
      synced_address: '10 Default Dr',
      synced_floor_plan_id: 'recFPdesc0000001',
      synced_floor_plan_name: 'Verbena',
    });
    // own description set → override wins
    insertRow(db, 'qmi', {
      id: 'recQMIdescOV0001',
      published: 1,
      synced_address: '11 Override Ct',
      synced_floor_plan_id: 'recFPdesc0000001',
      synced_floor_plan_name: 'Verbena',
      description: 'This specific home features a custom outdoor kitchen.',
    });
    const env = consumerEnv(db);

    // description is rich text now (ftIf → formattedText): plain copy is wrapped in <p>.
    const fb = qmiDef.map((await loadRowById(env, qmiDef, 'recQMIdescFB0001'))!);
    expect(fb.fieldData['description']?.type).toBe('formattedText');
    expect(String(sval(fb.fieldData['description']))).toContain(
      '<p>The Verbena, part of our Haven Collection, blends light and space.</p>'
    );
    // the raw FP value still flows separately as a plain string (contract has both fields)
    expect(sval(fb.fieldData['fp_description'])).toBe(
      'The Verbena, part of our Haven Collection, blends light and space.'
    );

    const ov = qmiDef.map((await loadRowById(env, qmiDef, 'recQMIdescOV0001'))!);
    expect(ov.fieldData['description']?.type).toBe('formattedText');
    expect(String(sval(ov.fieldData['description']))).toContain(
      '<p>This specific home features a custom outdoor kitchen.</p>'
    );
    expect(sval(ov.fieldData['fp_description'])).toBe(
      'The Verbena, part of our Haven Collection, blends light and space.'
    );
  });

  it('empty-string qmi description counts as unset (falls back to FP copy)', () => {
    const item = qmiDef.map({
      id: 'recQMIdescEMPTY1',
      published: 1,
      address: '12 Empty St',
      description: '',
      fp_description: 'Plan copy wins over an empty override.',
    });
    expect(item.fieldData['description']?.type).toBe('formattedText');
    expect(String(sval(item.fieldData['description']))).toContain(
      '<p>Plan copy wins over an empty override.</p>'
    );
  });

  it('drops description when neither qmi nor FP has copy (ftIf drops empties)', () => {
    // ftIf (rich text) drops an empty value rather than emitting str('') — same as
    // communities.description. With no copy from either source the field is omitted, so
    // addItems leaves the (empty) live field untouched. In practice the FP copy is the
    // fallback and is non-empty, so an override clear still propagates the plan copy.
    const db = freshDb();
    insertRow(db, 'qmi', { id: 'recQMIdescNONE01', published: 1, synced_address: '13 Bare Rd' });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMIdescNONE01') as Record<string, unknown>;
    const item = qmiDef.map(row);
    expect(item.fieldData['description']).toBeUndefined();
  });

  it('photo_gallery: dropped while qmi.photo_gallery_json does not exist (tolerant probe)', async () => {
    const db = freshDb();
    // Simulate a D1 instance where migration 0010 has NOT been applied yet (the
    // local migration chain already carries it). The view must go first — SQLite
    // refuses to drop a column a view references; framer-push reads base tables.
    db.exec(`DROP VIEW IF EXISTS v_public_qmi`);
    db.exec(`ALTER TABLE qmi DROP COLUMN photo_gallery_json`);
    insertRow(db, 'qmi', { id: 'recQMIgalNOCOL01', published: 1, synced_address: '14 Pre-Mig Pl' });
    const env = consumerEnv(db);
    // loadRowById must not throw — the enrichRow probe swallows "no such column"
    const row = await loadRowById(env, qmiDef, 'recQMIgalNOCOL01');
    expect(row).not.toBeNull();
    const item = qmiDef.map(row!);
    expect(item.fieldData['photo_gallery']).toBeUndefined();
  });

  it('photo_gallery: emits the QMI-own gallery once the column lands; NO FP fallback', async () => {
    const db = freshDb(); // migration 0010 in the chain → qmi.photo_gallery_json exists
    insertRow(db, 'floor_plans', {
      id: 'recFPgallery0001',
      name: 'Gallery Plan',
      slug: 'gallery-plan',
      published: 1,
      fp_additional_images:
        '[{"url":"https://media.esperanzahomes.com/fp/extra-1.jpg"},{"url":"https://media.esperanzahomes.com/fp/extra-2.jpg"}]',
    });
    insertRow(db, 'qmi', {
      id: 'recQMIgalOWN0001',
      published: 1,
      synced_address: '15 Gallery Way',
      synced_floor_plan_id: 'recFPgallery0001',
      // {url, alt} object shape per migration 0010 (galleryUrls accepts both).
      // Entry [0] is the elevation render; [1]/[2] are the first two photos.
      photo_gallery_json:
        '[{"url":"https://media.esperanzahomes.com/qmi/render.jpg","alt":"Render"},{"url":"https://media.esperanzahomes.com/qmi/own-1.jpg","alt":"Kitchen"},{"url":"https://media.esperanzahomes.com/qmi/own-2.jpg","alt":"Patio"}]',
    });
    insertRow(db, 'qmi', {
      id: 'recQMIgalNULL001',
      published: 1,
      synced_address: '16 No Gallery Ln',
      synced_floor_plan_id: 'recFPgallery0001', // FP gallery exists, must NOT leak in
    });
    const env = consumerEnv(db);

    const own = qmiDef.map((await loadRowById(env, qmiDef, 'recQMIgalOWN0001'))!);
    const gal = own.fieldData['photo_gallery'];
    expect(gal?.type).toBe('array');
    // full gallery keeps every entry, render first
    expect((gal as ArrayFieldValue).value.map((v) => v.fieldData['image']?.value)).toEqual([
      'https://media.esperanzahomes.com/qmi/render.jpg',
      'https://media.esperanzahomes.com/qmi/own-1.jpg',
      'https://media.esperanzahomes.com/qmi/own-2.jpg',
    ]);
    // the two standalone photo fields are gallery entries [1] and [2] — the render
    // at [0] is skipped — while the full gallery above still carries everything.
    expect(own.fieldData['gallery_image_1']?.type).toBe('image');
    expect(own.fieldData['gallery_image_1']?.value).toBe('https://media.esperanzahomes.com/qmi/own-1.jpg');
    expect(own.fieldData['gallery_image_2']?.type).toBe('image');
    expect(own.fieldData['gallery_image_2']?.value).toBe('https://media.esperanzahomes.com/qmi/own-2.jpg');

    // null gallery → field dropped (empty); the FP's images stay in fp_* fields only
    const none = qmiDef.map((await loadRowById(env, qmiDef, 'recQMIgalNULL001'))!);
    expect(none.fieldData['photo_gallery']).toBeUndefined();
    expect(none.fieldData['gallery_image_1']).toBeUndefined();
    expect(none.fieldData['gallery_image_2']).toBeUndefined();
    expect(none.fieldData['fp_additional_images_gallery']).toBeDefined();
  });

  it('upserts by record id end-to-end and removes a vanished row as a delete', async () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMI0004ABCDEF',
      published: 1,
      synced_address: '5 Real Rd',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const env = consumerEnv(db) as unknown as Env;
    const mock = createMockFramer(['Quick Move-Ins']);

    // batch: one real upsert + one upsert whose row doesn't exist (→ treated as delete)
    const batch = {
      messages: [
        { body: { collection: 'qmi', action: 'upsert', id: 'recQMI0004ABCDEF' } as const, ack() {}, retry() {} },
        { body: { collection: 'qmi', action: 'upsert', id: 'recDOESNOTEXIST' } as const, ack() {}, retry() {} },
      ],
    };
    await handleQueueBatch(batch, env, mock.connect);

    const state = mock.collections.get('Quick Move-Ins')!;
    expect(state.items.has('recQMI0004ABCDEF')).toBe(true);
    expect(state.items.has('recDOESNOTEXIST')).toBe(false);
    // a vanished row issues removeItems
    expect(state.removeItemsCalls.flat()).toContain('recDOESNOTEXIST');
    // publish+deploy happened once (something changed)
    expect(mock.publishCount).toBe(1);
    expect(mock.disconnectCount).toBe(1);
    // sync_log row written
    const log = db.prepare(`SELECT source, status, notes FROM sync_log`).get() as Record<string, unknown>;
    expect(log['source']).toBe('framer');
    expect(String(log['notes'])).toContain('qmi:');
  });
});

// =============================================================================
// community_ids — the resolved community rec-ID (COALESCE override, synced) emitted
// as a string under the SAME key as floor_plans, so a community CMS page can filter
// `community_ids Contains {communityId}` for QMIs available there.
// =============================================================================
describe('QMI mapper — community_ids (community rec-ID for CMS matching)', () => {
  const mapOne = (db: ReturnType<typeof freshDb>, id: string) =>
    qmiDef.map(db.prepare(qmiDef.selectByIdSql).get(id) as Record<string, unknown>);

  it('emits community_ids as a string = synced_community_id when no override', () => {
    const db = freshDb();
    insertRow(db, 'communities', { id: 'recCOMharvest01', name: 'Harvest Coves' });
    insertRow(db, 'qmi', {
      id: 'recQMIci0001',
      published: 1,
      synced_address: '3706 Westway Court',
      synced_community_name: 'Harvest Coves',
      synced_community_id: 'recCOMharvest01',
    });
    expect(mapOne(db, 'recQMIci0001').fieldData['community_ids']).toEqual({
      type: 'string',
      value: 'recCOMharvest01',
    });
  });

  it('override_community_id wins over synced', () => {
    const db = freshDb();
    insertRow(db, 'communities', { id: 'recCOMsynced01', name: 'Synced Community' });
    insertRow(db, 'communities', { id: 'recCOMoverride01', name: 'Override Community' });
    insertRow(db, 'qmi', {
      id: 'recQMIci0002',
      published: 1,
      synced_address: '1 Synced Way',
      synced_community_id: 'recCOMsynced01',
      override_community_id: 'recCOMoverride01',
    });
    expect(sval(mapOne(db, 'recQMIci0002').fieldData['community_ids'])).toBe('recCOMoverride01');
  });

  it('emits an explicit empty community_ids when the QMI has no community (clear propagates)', () => {
    // String fields mirror D1 exactly: no community → str('') (not dropped) so Framer's
    // "Contains" matching sees an empty value instead of the stale prior community id
    // (addItems merges — a dropped field keeps its previous value on the live site).
    const db = freshDb();
    insertRow(db, 'qmi', { id: 'recQMIci0003', published: 1, synced_address: '2 No Comm Rd' });
    expect(mapOne(db, 'recQMIci0003').fieldData['community_ids']).toEqual({ type: 'string', value: '' });
  });
});

describe('QMI mapper â bath combine + computed monthly payment (O’Neill parity)', () => {
  it('combines full + half baths into the displayed bathroom_count (3 + 1half → 3.5)', () => {
    const db = freshDb();
    insertRow(db, 'qmi', {
      id: 'recQMIbath00001',
      published: 1,
      synced_address: '1 Bath Ln',
      synced_bathroom_count: 3,
      synced_half_bathroom_count: 1,
    });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMIbath00001') as Record<string, unknown>;
    expect(sval(qmiDef.map(row).fieldData['bathroom_count'])).toBe(3.5);
  });

  it('computes estimated_monthly_price (PITI) from price + company-wide incentive_rate', () => {
    const db = freshDb();
    // The prominent monthly uses the PROMOTIONAL rate (incentive_rate), not mortgage_rate.
    db.prepare("INSERT INTO site_settings (key, value) VALUES ('incentive_rate', '6.15')").run();
    insertRow(db, 'qmi', {
      id: 'recQMImonth0001',
      published: 1,
      synced_address: '1 PITI Way',
      synced_price: 214990,
      estimated_monthly_price: 9999, // stored value is ignored when a rate makes it computable
    });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMImonth0001') as Record<string, unknown>;
    expect(sval(qmiDef.map(row).fieldData['estimated_monthly_price'])).toBe(1852.91);
  });

  it('a marketing rate edit re-prices every listing (incentive_rate → 4.99%)', () => {
    const db = freshDb();
    db.prepare("INSERT INTO site_settings (key, value) VALUES ('incentive_rate', '4.99')").run();
    insertRow(db, 'qmi', {
      id: 'recQMImonth0002',
      published: 1,
      synced_address: '2 PITI Way',
      synced_price: 214990,
    });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMImonth0002') as Record<string, unknown>;
    expect(sval(qmiDef.map(row).fieldData['estimated_monthly_price'])).toBe(1701.43);
  });

  it('falls back to the stored monthly when no incentive_rate is configured', () => {
    const db = freshDb(); // migration seeds mortgage_rate but NOT incentive_rate
    insertRow(db, 'qmi', {
      id: 'recQMImonth0003',
      published: 1,
      synced_address: '3 PITI Way',
      synced_price: 214990,
      estimated_monthly_price: 1555.55,
    });
    const row = db.prepare(qmiDef.selectByIdSql).get('recQMImonth0003') as Record<string, unknown>;
    expect(sval(qmiDef.map(row).fieldData['estimated_monthly_price'])).toBe(1555.55);
  });
});
