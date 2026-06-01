import { describe, it, expect } from 'vitest';
import { freshDb } from '../../db/test/helpers';
import { buildPdfTree, computeRegenerateUpdate } from '../lib/pdf-tree';

const rows = [
  { type: 'community', slug: 'anaqua', city_slug: 'mcallen', community_id: 'c1', status: 'live', entity_id: 'c1' },
  { type: 'qmi', slug: '00000149', city_slug: 'mcallen', community_id: 'c1', status: 'stale', entity_id: 'q1' },
  { type: 'floorplan', slug: 'hickory', city_slug: 'mcallen', community_id: 'c1', status: 'not_built', entity_id: 'fpH' },
  { type: 'list', slug: 'mcallen-locations', city_slug: 'mcallen', community_id: null, status: 'live', entity_id: null },
];

describe('buildPdfTree', () => {
  it('groups city → community → {plans, specs} with city-level lists', () => {
    const tree = buildPdfTree(rows as any);
    const c = tree.find((x) => x.citySlug === 'mcallen')!;
    expect(c.lists.map((l) => l.slug)).toContain('mcallen-locations');
    const comm = c.communities.find((x) => x.communityId === 'c1')!;
    expect(comm.plans.map((p) => p.slug)).toContain('hickory');
    expect(comm.specs.map((s) => s.slug)).toContain('00000149');
    expect(comm.self?.slug).toBe('anaqua');
  });
});

describe('computeRegenerateUpdate', () => {
  it('marks a single render stale', () => {
    const db = freshDb();
    db.exec(`INSERT INTO pdf_renders (type,slug,status) VALUES ('community','anaqua','live')`);
    const { sql, binds } = computeRegenerateUpdate('community', 'anaqua');
    db.prepare(sql).run(...(binds as any[]));
    expect((db.prepare(`SELECT status FROM pdf_renders WHERE slug='anaqua'`).get() as any).status).toBe('stale');
  });
});
