// =============================================================================
// Blogs mapper test. Focused on the video_url field added by migration 0012:
// a Vimeo URL string (same convention as communities.featured_video) must map
// to a plain Framer `string` field, and drop cleanly when null — so blog rows
// without a video never emit the key (Framer rejects unknown keys). Exercises
// the real selectByIdSql (SELECT * FROM blogs) through better-sqlite3.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';

const def = COLLECTION_DEFS.blogs;

function mapOne(db: ReturnType<typeof freshDb>, id: string) {
  const row = db.prepare(def.selectByIdSql).get(id) as Record<string, unknown>;
  return def.map(row);
}

describe('Blogs mapper — video_url (migration 0012)', () => {
  it('emits video_url as a string field', () => {
    const db = freshDb();
    insertRow(db, 'blogs', {
      id: 'recBLOG001',
      title: 'Welcome to Tres Lagos',
      slug: 'welcome-to-tres-lagos',
      published: 1,
      video_url: 'https://vimeo.com/123456789',
    });
    const item = mapOne(db, 'recBLOG001');
    expect(item.fieldData['video_url']).toEqual({
      type: 'string',
      value: 'https://vimeo.com/123456789',
    });
  });

  it('emits content as formattedText, passing sanitized HTML through verbatim', () => {
    const db = freshDb();
    const html =
      '<h2>A new chapter</h2><p>Visit <a href="https://example.com">Example</a>.</p>' +
      '<p><img src="https://pub.r2.dev/blogs/recBLOG003/photo.jpg"></p>';
    insertRow(db, 'blogs', {
      id: 'recBLOG003',
      title: 'Rich post',
      slug: 'rich-post',
      published: 1,
      content: html,
    });
    const item = mapOne(db, 'recBLOG003');
    expect(item.fieldData['content']).toEqual({ type: 'formattedText', value: html });
  });

  it('wraps legacy plain-text content (no tags) into HTML paragraphs', () => {
    const db = freshDb();
    insertRow(db, 'blogs', {
      id: 'recBLOG004',
      title: 'Plain post',
      slug: 'plain-post',
      published: 1,
      content: 'First line.\nSecond line.',
    });
    const item = mapOne(db, 'recBLOG004');
    const cv = item.fieldData['content'] as { type: string; value: string };
    expect(cv.type).toBe('formattedText');
    expect(cv.value).toContain('<p>');
    expect(cv.value).toContain('First line.');
  });

  it('emits publish_date as a Framer date field (ISO from YYYY-MM-DD)', () => {
    const db = freshDb();
    insertRow(db, 'blogs', {
      id: 'recBLOG006',
      title: 'Dated post',
      slug: 'dated-post',
      published: 1,
      publish_date: '2024-06-10',
    });
    const item = mapOne(db, 'recBLOG006');
    expect(item.fieldData['publish_date']).toEqual({
      type: 'date',
      value: '2024-06-10T00:00:00.000Z',
    });
  });

  it('drops publish_date when empty (no key emitted)', () => {
    const db = freshDb();
    insertRow(db, 'blogs', {
      id: 'recBLOG007',
      title: 'Undated',
      slug: 'undated',
      published: 1,
      publish_date: null,
    });
    const item = mapOne(db, 'recBLOG007');
    expect('publish_date' in item.fieldData).toBe(false);
  });

  it('drops content when empty (no key emitted)', () => {
    const db = freshDb();
    insertRow(db, 'blogs', {
      id: 'recBLOG005',
      title: 'Empty content',
      slug: 'empty-content',
      published: 1,
      content: '',
    });
    const item = mapOne(db, 'recBLOG005');
    expect('content' in item.fieldData).toBe(false);
  });

  it('emits an explicit empty string for video_url when null (clear propagates to Framer)', () => {
    // String fields mirror D1 exactly: a null/cleared column emits str('') (not dropped)
    // so the clear reaches Framer. addItems merges, so a dropped field would keep the
    // stale value on the live site.
    const db = freshDb();
    insertRow(db, 'blogs', {
      id: 'recBLOG002',
      title: 'No video here',
      slug: 'no-video-here',
      published: 1,
      video_url: null,
    });
    const item = mapOne(db, 'recBLOG002');
    expect(item.fieldData['video_url']).toEqual({ type: 'string', value: '' });
  });
});
