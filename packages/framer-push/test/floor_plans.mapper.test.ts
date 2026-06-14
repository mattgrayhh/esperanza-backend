// =============================================================================
// Floor Plans mapper test. Focused on the floor_plan_image field added 2026-06-09:
// the top-down layout image (scalar R2 URL on floor_plans.floor_plan_image) must
// map to a Framer `image` field, and drop cleanly when null. Exercises the real
// selectAllSql projection (SELECT * FROM floor_plans) through better-sqlite3.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';
import type { FieldValue, ArrayFieldValue } from '../src/framer-types.js';

const def = COLLECTION_DEFS.floor_plans;
const sval = (v: FieldValue | ArrayFieldValue | undefined) =>
  v && v.type !== 'array' ? (v as FieldValue).value : undefined;

const FP_URL =
  'https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/floor_plans/recFP1/floor-plan.png';

function mapOne(db: ReturnType<typeof freshDb>, id: string) {
  const row = db.prepare(def.selectByIdSql).get(id) as Record<string, unknown>;
  return def.map(row);
}

describe('Floor Plans mapper — floor_plan_image', () => {
  it('emits floor_plan_image as an image field from the floor_plans column', () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFP1',
      name: 'Acuna II',
      slug: 'acuna-ii',
      published: 1,
      floor_plan_image: FP_URL,
    });
    const item = mapOne(db, 'recFP1');
    expect(item.fieldData['floor_plan_image']).toEqual({ type: 'image', value: FP_URL });
  });

  it('drops floor_plan_image when null', () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFP2',
      name: 'Agave',
      slug: 'agave',
      published: 1,
      floor_plan_image: null,
    });
    const item = mapOne(db, 'recFP2');
    expect(item.fieldData['floor_plan_image']).toBeUndefined();
  });

  it('drops floor_plan_image for a non-http value (invariant: stable urls only)', () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFP3',
      name: 'Bahia',
      slug: 'bahia',
      published: 1,
      floor_plan_image: 'not-a-url',
    });
    const item = mapOne(db, 'recFP3');
    expect(sval(item.fieldData['floor_plan_image'] as never)).toBeUndefined();
  });
});

describe('Floor Plans mapper — community_ids (migration 0016)', () => {
  it('emits community_ids as a string field from the floor_plans column', () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFPci1',
      name: 'Lorenzo',
      slug: 'lorenzo',
      published: 1,
      communities: 'Aquero, Cielo Vista',
      community_ids: 'recCOMaquero, recCOMcielo',
    });
    const item = mapOne(db, 'recFPci1');
    expect(item.fieldData['community_ids']).toEqual({
      type: 'string',
      value: 'recCOMaquero, recCOMcielo',
    });
  });

  it('emits an explicit empty community_ids when null/empty (clear propagates to Framer)', () => {
    // String fields mirror D1 exactly: a cleared community_ids emits str('') (not dropped)
    // so Framer's "Contains" matching sees an empty list rather than the stale prior value
    // (addItems merges — a dropped field keeps its previous value on the live site).
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFPci2',
      name: 'Marzano',
      slug: 'marzano',
      published: 1,
      community_ids: null,
    });
    const item = mapOne(db, 'recFPci2');
    expect(item.fieldData['community_ids']).toEqual({ type: 'string', value: '' });
  });
});

describe('Floor Plans mapper — interior_photos (migration 0011)', () => {
  const G1 = 'https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/floor_plans/recFP4/gallery-0-kitchen.jpg';
  const G2 = 'https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/floor_plans/recFP4/gallery-1-living.jpg';

  it('emits interior_photos as an image array from interior_photos_json ({url,alt} shape)', () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFP4',
      name: 'Cielo',
      slug: 'cielo',
      published: 1,
      interior_photos_json: JSON.stringify([
        { url: G1, alt: 'Kitchen' },
        { url: G2, alt: 'Living room' },
      ]),
    });
    const item = mapOne(db, 'recFP4');
    const gal = item.fieldData['interior_photos'] as ArrayFieldValue;
    expect(gal?.type).toBe('array');
    expect(gal.value.map((v) => v.fieldData['image']?.value)).toEqual([G1, G2]);
  });

  it('drops interior_photos when the column is null/empty', () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFP5',
      name: 'Dulce',
      slug: 'dulce',
      published: 1,
      interior_photos_json: null,
    });
    const item = mapOne(db, 'recFP5');
    expect(item.fieldData['interior_photos']).toBeUndefined();
  });
});
