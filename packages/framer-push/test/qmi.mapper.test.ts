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

    // floor_plan_slug derived from FP name, underscored
    expect(sval(f['floor_plan_slug'])).toBe('kestrel');
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
