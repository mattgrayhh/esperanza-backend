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
      synced_price_from: 350000,
      synced_bed_count: '3-5',
      synced_bath_count: '2-4',
      synced_square_footage_range: '1,800 - 3,200',
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
      brochure_pdf_url: 'https://esperanza-pdf.round-base-ed8c.workers.dev/pdf/community/tres-lagos',
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

    // embed_image = first gallery image as a discrete single-image field (here the
    // gallery falls back to photo_gallery_image_url, so gallery[0] = g1.jpg).
    expect(f['embed_image']?.type).toBe('image');
    expect(sval(f['embed_image'])).toBe('https://media.esperanzahomes.com/com/tres-lagos/g1.jpg');

    // markdown → HTML formattedText
    // description is rich text (ftIf): plain copy is wrapped in <p>…</p>.
    expect(f['description']?.type).toBe('formattedText');
    expect(String(sval(f['description']))).toContain('<p>A lakeside community.</p>');
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

    // dynamic community brochure PDF (auto-filled by ensurePdfRender). The mapper emits
    // the URL as a string; the push path coerces it to a link via field_definitions
    // (communities.brochure_pdf_url framer_type='link', MAPPER_FRAMER_TYPE) — same proven
    // pattern as floor_plans.brochure_pdf_url.
    expect(f['brochure_pdf_url']?.type).toBe('string');
    expect(sval(f['brochure_pdf_url'])).toBe(
      'https://esperanza-pdf.round-base-ed8c.workers.dev/pdf/community/tres-lagos'
    );

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

  it('lat_long is built from the clean numeric columns, not the legacy text/URL', () => {
    // Regression: Los Arroyos had lat_long=null and map_coordinates holding a full
    // Google Maps URL, so the old `lat_long ?? map_coordinates` fallback pushed the
    // URL into the map-binding field. Now lat_long is derived from latitude/longitude.
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOM0005ABCDEF',
      name: 'Los Arroyos',
      published: 1,
      coming_soon: 1,
      latitude: 26.20356,
      longitude: -97.73547,
      lat_long: null,
      map_coordinates: 'https://maps.google.com/maps?q=26.20356,-97.73547',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const f = mapOne(db, 'recCOM0005ABCDEF').fieldData;
    // bare "lat,long" the map layer can parse — NOT the Google URL
    expect(sval(f['lat_long'])).toBe('26.20356,-97.73547');
    // and the Google link lands on get_directions (directions column is empty)
    expect(f['get_directions']?.type).toBe('link');
    expect(sval(f['get_directions'])).toBe('https://maps.google.com/maps?q=26.20356,-97.73547');
  });

  it('lat_long ignores dirty legacy text (whitespace + dropped sign)', () => {
    // Cascada at Tres Lagos: lat_long text had a leading-space and a positive
    // longitude (sign dropped); the numeric columns are correct, so we use them.
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOM0006ABCDEF',
      name: 'Cascada at Tres Lagos',
      published: 1,
      latitude: 26.3409143,
      longitude: -98.269991,
      lat_long: '  26.3409143, 98.2699910',
      map_coordinates: 'https://maps.google.com/maps?q=26.3409143,-98.2699910',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const f = mapOne(db, 'recCOM0006ABCDEF').fieldData;
    expect(sval(f['lat_long'])).toBe('26.3409143,-98.269991');
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

  it('emits an EXPLICIT empty string when a string field is cleared (propagates the clear to Framer)', () => {
    // Regression: clearing a community link/text field in the admin set the D1 column
    // to NULL, but the mapper dropped the empty value from the payload. Framer's
    // addItems MERGES, so a dropped field keeps its previous (stale, 404) value — the
    // field "repopulated" on the live site. A space was the only workaround because it
    // wasn't empty. String fields must mirror D1 exactly: empty → str('') so the clear
    // actually reaches Framer (and the operator's "hide field when empty" rule fires).
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOM0005ABCDEF',
      name: 'Cleared Links',
      published: 1,
      featured_video: null, // cleared in the admin
      schedule_visit: '', // cleared in the admin
      // lending omitted entirely (never set)
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const f = mapOne(db, 'recCOM0005ABCDEF').fieldData;

    // Present in the payload, typed string, value '' — NOT dropped.
    expect(f['featured_video']?.type).toBe('string');
    expect(sval(f['featured_video'])).toBe('');
    expect(f['schedule_visit']?.type).toBe('string');
    expect(sval(f['schedule_visit'])).toBe('');
    expect(f['lending']?.type).toBe('string');
    expect(sval(f['lending'])).toBe('');

    // Numbers still drop empties (no "0" leak) and formattedText still drops blanks.
    expect(f['price_from']).toBeUndefined();
    expect(f['amenities_rich']).toBeUndefined();
  });

  it('derives floor_plan_ids as the reciprocal of floor_plans.community_ids (CSV membership, space-tolerant, exact-id)', () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOMaqualina01',
      name: 'Aqualina at Tres Lagos',
      published: 1,
      updated_at: '2026-06-14T12:00:00.000Z',
    });
    // A second community — guards against a bare substring match leaking plans.
    insertRow(db, 'communities', {
      id: 'recCOMsapphire02',
      name: 'Sapphire at La Sienna',
      published: 1,
      updated_at: '2026-06-14T12:00:00.000Z',
    });
    // Blanco lists BOTH communities with the live ", " (comma-space) separator.
    insertRow(db, 'floor_plans', {
      id: 'recFPblanco0001',
      name: 'Blanco',
      slug: 'blanco',
      published: 1,
      community_ids: 'recCOMaqualina01, recCOMsapphire02',
    });
    // Agave is only in Aqualina (no surrounding space).
    insertRow(db, 'floor_plans', {
      id: 'recFPagave00001',
      name: 'Agave',
      slug: 'agave',
      published: 1,
      community_ids: 'recCOMaqualina01',
    });
    // A draft plan still appears in the list (the Floor Plans collection's own
    // draft gate controls render visibility, not this membership CSV).
    insertRow(db, 'floor_plans', {
      id: 'recFPdraft00001',
      name: 'Draft Plan',
      slug: 'draft-plan',
      published: 0,
      community_ids: 'recCOMaqualina01',
    });
    // An unrelated plan that references neither community.
    insertRow(db, 'floor_plans', {
      id: 'recFPother00001',
      name: 'Other',
      slug: 'other',
      published: 1,
      community_ids: 'recCOMsomewhere9',
    });

    const aqualina = mapOne(db, 'recCOMaqualina01').fieldData['floor_plan_ids'];
    expect(aqualina?.type).toBe('string');
    const aqualinaIds = String(sval(aqualina)).split(',');
    expect(aqualinaIds).toEqual(
      expect.arrayContaining(['recFPblanco0001', 'recFPagave00001', 'recFPdraft00001'])
    );
    expect(aqualinaIds).not.toContain('recFPother00001');

    // Sapphire only gets Blanco — and the ", " separator must not break the match.
    const sapphire = String(sval(mapOne(db, 'recCOMsapphire02').fieldData['floor_plan_ids']));
    expect(sapphire.split(',')).toEqual(['recFPblanco0001']);
  });

  it('emits per-community Plan List / Sale List PDF links + published plan/home counts', () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOMaqualina01', name: 'Aqualina at Tres Lagos', slug: 'aqualina-at-tres-lagos',
      published: 1, updated_at: '2026-06-15T12:00:00.000Z',
    });
    // two PUBLISHED plans offered (counted) + one draft plan (excluded from plan_count)
    insertRow(db, 'floor_plans', { id: 'fp1', name: 'Blanco', slug: 'blanco', published: 1, community_ids: 'recCOMaqualina01' });
    insertRow(db, 'floor_plans', { id: 'fp2', name: 'Agave', slug: 'agave', published: 1, community_ids: 'recCOMaqualina01, recCOMother' });
    insertRow(db, 'floor_plans', { id: 'fp3', name: 'Draft', slug: 'draft', published: 0, community_ids: 'recCOMaqualina01' });
    // two PUBLISHED homes in the community (synced + override) + one unpublished (excluded)
    insertRow(db, 'qmi', { id: 'q1', published: 1, synced_community_id: 'recCOMaqualina01', updated_at: '2026-06-15T12:00:00.000Z' });
    insertRow(db, 'qmi', { id: 'q2', published: 1, override_community_id: 'recCOMaqualina01', updated_at: '2026-06-15T12:00:00.000Z' });
    insertRow(db, 'qmi', { id: 'q3', published: 0, synced_community_id: 'recCOMaqualina01', updated_at: '2026-06-15T12:00:00.000Z' });

    const f = mapOne(db, 'recCOMaqualina01').fieldData;
    expect(f['plan_list_pdf_url']?.type).toBe('link');
    expect(sval(f['plan_list_pdf_url'])).toBe(
      'https://esperanza-pdf.round-base-ed8c.workers.dev/pdf/list/community-aqualina-at-tres-lagos-plans'
    );
    expect(f['sale_list_pdf_url']?.type).toBe('link');
    expect(sval(f['sale_list_pdf_url'])).toBe(
      'https://esperanza-pdf.round-base-ed8c.workers.dev/pdf/list/community-aqualina-at-tres-lagos-qmis'
    );
    expect(sval(f['plan_count'])).toBe(2); // published plans only
    expect(sval(f['home_count'])).toBe(2); // published homes only
  });

  it('drops the list links when a community has no slug (nothing registered to link to)', () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOMnoSlug001', name: 'No Slug', published: 1, updated_at: '2026-06-15T12:00:00.000Z',
    });
    const f = mapOne(db, 'recCOMnoSlug001').fieldData;
    expect(f['plan_list_pdf_url']).toBeUndefined();
    expect(f['sale_list_pdf_url']).toBeUndefined();
  });
});
