// =============================================================================
// Collections mapper test. Focused on the `content` field ("About this
// Collection"): it holds Framer-subset HTML (admin TipTap WYSIWYG) and must map
// to a Framer `formattedText` field, passing HTML through verbatim — was sIf
// (plain string), which rendered the literal <p>…</p> tags on the live site.
// Exercises the real selectByIdSql (SELECT * FROM collections) via better-sqlite3.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';

const def = COLLECTION_DEFS.collections;

function mapOne(db: ReturnType<typeof freshDb>, id: string) {
  const row = db.prepare(def.selectByIdSql).get(id) as Record<string, unknown>;
  return def.map(row);
}

describe('Collections mapper — content (rich text)', () => {
  it('emits content as formattedText, passing sanitized HTML through verbatim', () => {
    const db = freshDb();
    const html =
      '<p>The Villas Home Collection is perfect for those who value style.</p>' +
      '<p>Experience the perfect blend of elegance and practicality.</p>';
    insertRow(db, 'collections', {
      id: 'recCOL001',
      title: 'Villas Home Collection',
      slug: 'villas-home-collection',
      published: 1,
      content: html,
    });
    const item = mapOne(db, 'recCOL001');
    expect(item.fieldData['content']).toEqual({ type: 'formattedText', value: html });
  });

  it('wraps legacy plain-text content (no tags) into HTML paragraphs', () => {
    const db = freshDb();
    insertRow(db, 'collections', {
      id: 'recCOL002',
      title: 'Plain Collection',
      slug: 'plain-collection',
      published: 1,
      content: 'First line.\nSecond line.',
    });
    const cv = mapOne(db, 'recCOL002').fieldData['content'] as { type: string; value: string };
    expect(cv.type).toBe('formattedText');
    expect(cv.value).toContain('<p>');
    expect(cv.value).toContain('First line.');
  });

  it('drops content when empty', () => {
    const db = freshDb();
    insertRow(db, 'collections', {
      id: 'recCOL003',
      title: 'Empty Collection',
      slug: 'empty-collection',
      published: 1,
      content: '',
    });
    expect('content' in mapOne(db, 'recCOL003').fieldData).toBe(false);
  });
});
