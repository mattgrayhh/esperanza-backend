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

  it('drops video_url when null', () => {
    const db = freshDb();
    insertRow(db, 'blogs', {
      id: 'recBLOG002',
      title: 'No video here',
      slug: 'no-video-here',
      published: 1,
      video_url: null,
    });
    const item = mapOne(db, 'recBLOG002');
    expect(item.fieldData['video_url']).toBeUndefined();
  });
});
