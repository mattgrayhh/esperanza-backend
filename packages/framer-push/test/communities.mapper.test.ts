// =============================================================================
// Communities mapper test. Asserts the full field set maps: markdown→HTML for the
// *_rich formattedText blocks, HOA links JSON → hoa_link_title_N/hoa_link_N (x7),
// lat/long parsed from map_coordinates, the SINGLE-gate draft (= !published — the
// `draft` column was dropped in migration 0005), and image fields read from the
// stable *_url columns.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';
import type { FieldValue, ArrayFieldValue } from '../src/framer-types.js';

const def = COLLECTION_DEFS.communities;
const sval = (v: FieldValue | ArrayFieldValue | undefined) =>
  v && v.type !== 'array' ? (v as FieldValue).value : undefined;

function mapOne(db: ReturnType<typeof freshDb>, id: string) {
  const row = db.prepare(def.selectByIdSql).get(id) as Record<string, unknown>;
  return def.map(row);
}

describe('Communities mapper — rich text, HOA links, coords, gates', () => {
  it('maps the full field set including markdown→HTML and HOA links', () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOM0001ABCDEF',
      name: 'Tres Lagos',
      slug: 'tres-lagos',
      town: 'Conroe',
      published: 1,
      address: '123 Lake Dr',
      map_coordinates: '@30.3119,-95.4561,15z',
      price_from: 350000,
      bed_count: '3-5',
      bath_count: '2-4',
      square_footage_range: '1,800 - 3,200',
      description: 'A lakeside community.',
      amenities: '- Pool\n- Clubhouse\n- **Trails**',
      featured_image_url: 'https://media.esperanzahomes.com/com/tres-lagos/hero.jpg',
      featured_image_alt: 'Tres Lagos hero',
      secondary_image_url: 'https://media.esperanzahomes.com/com/tres-lagos/2.jpg',
      photo_gallery_image_url: 'https://media.esperanzahomes.com/com/tres-lagos/g1.jpg',
      design_copy_rich: '## Design\nThoughtful homes.',
      education_rich: 'Top-rated *schools* nearby.',
      internet_details: 'Fiber up to **1 Gbps**.',
      water_details: 'Municipal water & sewer.',
      office_phone: '936-555-0100',
      master_planned: 1,
      coming_soon: 0,
      hoa_links_json: JSON.stringify([
        { title: 'HOA Docs', link: 'https://hoa.example.com/docs' },
        { title: 'Bylaws', link: 'https://hoa.example.com/bylaws' },
      ]),
      updated_at: '2026-05-30T12:00:00.000Z',
    });

    const item = mapOne(db, 'recCOM0001ABCDEF');
    expect(item.id).toBe('recCOM0001ABCDEF');
    expect(item.slug).toBe('tres-lagos');
    expect(item.draft).toBe(false); // !published (single gate)

    const f = item.fieldData;
    expect(sval(f['name'])).toBe('Tres Lagos');
    expect(sval(f['town'])).toBe('Conroe');
    expect(sval(f['price_from'])).toBe(350000);
    expect(sval(f['bed_range'])).toBe('3-5');
    expect(sval(f['sqft_range'])).toBe('1,800 - 3,200');

    // coordinates parsed from map_coordinates
    expect(sval(f['latitude'])).toBeCloseTo(30.3119, 4);
    expect(sval(f['longitude'])).toBeCloseTo(-95.4561, 4);

    // image fields read from stable *_url columns, typed image
    expect(f['image_url']?.type).toBe('image');
    expect(sval(f['image_url'])).toBe('https://media.esperanzahomes.com/com/tres-lagos/hero.jpg');
    expect(sval(f['secondary_image'])).toContain('/2.jpg');

    // markdown → HTML formattedText
    expect(f['amenities_rich']?.type).toBe('formattedText');
    expect(String(sval(f['amenities_rich']))).toContain('<ul>');
    expect(String(sval(f['amenities_rich']))).toContain('<li>Pool</li>');
    expect(String(sval(f['amenities_rich']))).toContain('<strong>Trails</strong>');
    expect(f['design_copy_rich']?.type).toBe('formattedText');
    expect(String(sval(f['design_copy_rich']))).toContain('<h2>Design</h2>');
    expect(String(sval(f['education_rich']))).toContain('<em>schools</em>');

    // Utilities block: live Communities (Managed) types Internet/Water Details as
    // formattedText (regression guard for the "Expected formattedText but got string"
    // backfill error on community `los-prados`).
    expect(f['internet_details']?.type).toBe('formattedText');
    expect(String(sval(f['internet_details']))).toContain('<strong>1 Gbps</strong>');
    expect(f['water_details']?.type).toBe('formattedText');
    expect(String(sval(f['water_details']))).toContain('Municipal water');

    // booleans always emitted
    expect(sval(f['master_planned'])).toBe(true);
    expect(sval(f['coming_soon'])).toBe(false);
    expect(sval(f['published'])).toBe(true);

    // HOA links expanded into N=1..7 title + link pairs
    expect(sval(f['hoa_link_title_1'])).toBe('HOA Docs');
    expect(f['hoa_link_1']?.type).toBe('link');
    expect(sval(f['hoa_link_1'])).toBe('https://hoa.example.com/docs');
    expect(sval(f['hoa_link_title_2'])).toBe('Bylaws');
    expect(sval(f['hoa_link_2'])).toBe('https://hoa.example.com/bylaws');
    // unused HOA slots dropped
    expect(f['hoa_link_title_3']).toBeUndefined();
    expect(f['hoa_link_3']).toBeUndefined();
  });

  it('draft:true when not published (single gate)', () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOM0002ABCDEF',
      name: 'Unpublished',
      published: 0,
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    expect(mapOne(db, 'recCOM0002ABCDEF').draft).toBe(true);
  });

  it('draft:false when published (the explicit `draft` column was dropped in 0005)', () => {
    // Pre-0005 a second gate existed (explicit draft=1 hid a published row); migration
    // 0005 dropped communities.draft, so published is now the SINGLE gate: a published
    // community is always live (draft:false).
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOM0003ABCDEF',
      name: 'Published',
      published: 1,
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    expect(mapOne(db, 'recCOM0003ABCDEF').draft).toBe(false);
  });

  it('drops empty formattedText (never overwrites with blank)', () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOM0004ABCDEF',
      name: 'No Copy',
      published: 1,
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const f = mapOne(db, 'recCOM0004ABCDEF').fieldData;
    expect(f['amenities_rich']).toBeUndefined();
    expect(f['design_copy_rich']).toBeUndefined();
    expect(f['latitude']).toBeUndefined();
  });
});
