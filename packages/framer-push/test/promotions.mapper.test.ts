// =============================================================================
// Promotions mapper test. Asserts the full field set maps: target-id csv lists
// from promotion_targets, the image FALLBACK chain (own → first linked community
// → first linked Floor Plan render — resolved in the consumer's enrichRow), the
// publish gate (published=false → draft:true; gate renamed from `active` in 0005),
// and link-typed cta_link.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, d1, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';
import { loadRowById } from '../src/consumer.js';
import type { ConsumerEnv } from '../src/consumer.js';
import type { FieldValue, ArrayFieldValue } from '../src/framer-types.js';

const def = COLLECTION_DEFS.promotions;
const sval = (v: FieldValue | ArrayFieldValue | undefined) =>
  v && v.type !== 'array' ? (v as FieldValue).value : undefined;

function env(db: ReturnType<typeof freshDb>): ConsumerEnv {
  return {
    DB: d1(db),
    FRAMER_PROJECT_URL: 'https://framer.com/projects/Test--t47CBg6stJkC8hsPgamo-egL7H',
    FRAMER_API_KEY: 'test-token',
  };
}

describe('Promotions mapper — targets, image fallback, gate', () => {
  it('maps the full field set with own image and community target ids', async () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOMTGT0001AB',
      name: 'Tres Lagos',
      featured_image_url: 'https://media.esperanzahomes.com/com/tres-lagos/hero.jpg',
    });
    insertRow(db, 'promotions', {
      id: 'recPROMO0001ABC',
      title: 'Spring Savings',
      banner_text: 'Save big this spring',
      badge_text: 'LIMITED',
      copy: 'Up to $20k in upgrades.',
      cta_label: 'Learn more',
      cta_url: 'https://esperanzahomes.com/promo/spring',
      image_url: 'https://media.esperanzahomes.com/promo/spring.jpg',
      sort_order: 5,
      end_date: '2026-06-30',
      published: 1,
      applies_to: 'Select communities',
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    db.prepare(
      `INSERT INTO promotion_targets (promotion_id, target_type, target_id) VALUES (?, ?, ?)`
    ).run('recPROMO0001ABC', 'community', 'recCOMTGT0001AB');

    const row = await loadRowById(env(db), def, 'recPROMO0001ABC');
    const item = def.map(row!);

    expect(item.id).toBe('recPROMO0001ABC');
    expect(item.slug).toBe('spring-savings');
    expect(item.draft).toBe(false); // active

    const f = item.fieldData;
    expect(sval(f['title'])).toBe('Spring Savings');
    expect(sval(f['banner_text'])).toBe('Save big this spring');
    expect(sval(f['card_badge_text'])).toBe('LIMITED');
    expect(sval(f['copy'])).toBe('Up to $20k in upgrades.');
    expect(sval(f['cta_label'])).toBe('Learn more');
    expect(f['cta_link']?.type).toBe('link');
    expect(sval(f['cta_link'])).toBe('https://esperanzahomes.com/promo/spring');
    expect(f['applies_to']).toBeUndefined(); // [P2] legacy label no longer emitted (targeting via promotion_targets)
    expect(sval(f['sort_order'])).toBe(5);
    expect(sval(f['published'])).toBe(true);
    expect(sval(f['expiration_date'])).toBe('2026-06-30');

    // own image used (no fallback needed)
    expect(f['image']?.type).toBe('image');
    expect(sval(f['image'])).toBe('https://media.esperanzahomes.com/promo/spring.jpg');

    // community target id surfaced as csv
    expect(sval(f['community_ids'])).toBe('recCOMTGT0001AB');
  });

  it('borrows the first linked community image when the promo has none', async () => {
    const db = freshDb();
    insertRow(db, 'communities', {
      id: 'recCOMNOIMG001A',
      name: 'No Image Comm',
      featured_image_url: null,
    });
    insertRow(db, 'communities', {
      id: 'recCOMHASIMG01A',
      name: 'Has Image Comm',
      featured_image_url: 'https://media.esperanzahomes.com/com/has/hero.jpg',
    });
    insertRow(db, 'promotions', {
      id: 'recPROMO0002ABC',
      title: 'Borrowed Image',
      published: 1,
      // no image_url
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    // two community targets; first (insertion order) has no image, second does.
    const t = db.prepare(
      `INSERT INTO promotion_targets (promotion_id, target_type, target_id) VALUES (?, ?, ?)`
    );
    t.run('recPROMO0002ABC', 'community', 'recCOMNOIMG001A');
    t.run('recPROMO0002ABC', 'community', 'recCOMHASIMG01A');

    const row = await loadRowById(env(db), def, 'recPROMO0002ABC');
    const item = def.map(row!);
    expect(sval(item.fieldData['image'])).toBe('https://media.esperanzahomes.com/com/has/hero.jpg');
  });

  it('surfaces floor_plan target ids and borrows the linked Floor Plan render (migration 0014)', async () => {
    const db = freshDb();
    insertRow(db, 'floor_plans', {
      id: 'recFP00IMG0001A',
      name: 'Kestrel',
      published: 1,
      synced_image_url: 'https://media.esperanzahomes.com/fp/kestrel/render.jpg',
    });
    insertRow(db, 'promotions', {
      id: 'recPROMO0003ABC',
      title: 'FP Image',
      published: 1,
      // no image_url, no community target → fallback walks to the FP render
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    db.prepare(
      `INSERT INTO promotion_targets (promotion_id, target_type, target_id) VALUES (?, ?, ?)`
    ).run('recPROMO0003ABC', 'floor_plan', 'recFP00IMG0001A');

    const row = await loadRowById(env(db), def, 'recPROMO0003ABC');
    const item = def.map(row!);
    // floor_plan target id surfaced as csv (Framer matches it against the page's plan)
    expect(sval(item.fieldData['floor_plan_ids'])).toBe('recFP00IMG0001A');
    // image fallback chain reaches the linked FP render
    expect(item.fieldData['image']?.type).toBe('image');
    expect(sval(item.fieldData['image'])).toBe('https://media.esperanzahomes.com/fp/kestrel/render.jpg');
  });

  it('draft:true when published=false (hard-hide; gate renamed from active in 0005)', () => {
    const db = freshDb();
    insertRow(db, 'promotions', {
      id: 'recPROMO0004ABC',
      title: 'Expired Promo',
      published: 0,
      updated_at: '2026-05-30T12:00:00.000Z',
    });
    const row = db.prepare(def.selectByIdSql).get('recPROMO0004ABC') as Record<string, unknown>;
    const item = def.map(row);
    expect(item.draft).toBe(true);
    expect(sval(item.fieldData['published'])).toBe(false);
  });
});

describe('Promotions mapper — pdf link + effective rate (migration 0020)', () => {
  it('emits pdf as a link and rate inherited from incentive_rate', async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO site_settings (key, value) VALUES ('incentive_rate', '4.99')`).run();
    insertRow(db, 'promotions', {
      id: 'recPROMOPDF01',
      title: 'PDF Promo',
      pdf_url: 'https://ehi.hazardhouse.ai/promo/flyer.pdf',
      published: 1,
      updated_at: '2026-06-20T12:00:00.000Z',
    });
    const row = await loadRowById(env(db), def, 'recPROMOPDF01');
    const item = def.map(row!);
    expect(item.fieldData['pdf']?.type).toBe('link');
    expect(sval(item.fieldData['pdf'])).toBe('https://ehi.hazardhouse.ai/promo/flyer.pdf');
    expect(sval(item.fieldData['rate'])).toBe('4.99');
  });

  it('rate uses the per-promo override when set', async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO site_settings (key, value) VALUES ('incentive_rate', '4.99')`).run();
    insertRow(db, 'promotions', {
      id: 'recPROMOOV01',
      title: 'Override Promo',
      rate_override: '3.25',
      published: 1,
      updated_at: '2026-06-20T12:00:00.000Z',
    });
    const row = await loadRowById(env(db), def, 'recPROMOOV01');
    const item = def.map(row!);
    expect(sval(item.fieldData['rate'])).toBe('3.25');
  });

  it('rate is empty when neither override nor incentive_rate set; pdf dropped when absent', async () => {
    const db = freshDb();
    insertRow(db, 'promotions', {
      id: 'recPROMONONE1',
      title: 'No Rate',
      published: 1,
      updated_at: '2026-06-20T12:00:00.000Z',
    });
    const row = await loadRowById(env(db), def, 'recPROMONONE1');
    const item = def.map(row!);
    expect(sval(item.fieldData['rate'])).toBe(''); // sIf emits str('') for empty
    expect(item.fieldData['pdf']).toBeUndefined(); // linkIf drops absent url
  });
});
