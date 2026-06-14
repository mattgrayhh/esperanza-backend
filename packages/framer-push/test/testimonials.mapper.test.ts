// =============================================================================
// Testimonials mapper — community_ids. A testimonial belongs to ONE community
// (testimonials.community_id → communities.id), so it emits a single rec-ID under
// the SAME `community_ids` key/string shape as floor_plans/qmi, letting a community
// CMS page filter testimonials with `community_ids Contains {communityId}`.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { freshDb, insertRow } from './helpers.js';
import { COLLECTION_DEFS } from '../src/collections.js';

const def = COLLECTION_DEFS.testimonials;

function mapOne(db: ReturnType<typeof freshDb>, id: string) {
  const row = def.selectByIdSql
    ? (db.prepare(def.selectByIdSql).get(id) as Record<string, unknown>)
    : undefined;
  if (!row) throw new Error(`no testimonial row for ${id}`);
  return def.map(row);
}

describe('Testimonials mapper — community_ids (single community rec-ID)', () => {
  it('emits community_ids as a string = the testimonial community_id', () => {
    const db = freshDb();
    insertRow(db, 'communities', { id: 'recCOMharvest01', name: 'Harvest Coves' });
    insertRow(db, 'testimonials', {
      id: 'recTSTimonial01',
      person_name: 'Jane Buyer',
      community_id: 'recCOMharvest01',
      community_name: 'Harvest Coves',
      status: 'Live',
    });
    const item = mapOne(db, 'recTSTimonial01');
    expect(item.fieldData['community_ids']).toEqual({
      type: 'string',
      value: 'recCOMharvest01',
    });
  });

  it('drops community_ids when the testimonial has no linked community', () => {
    const db = freshDb();
    insertRow(db, 'testimonials', {
      id: 'recTSTnocomm002',
      person_name: 'Anon',
      status: 'Live',
    });
    const item = mapOne(db, 'recTSTnocomm002');
    expect(item.fieldData['community_ids']).toBeUndefined();
  });
});
