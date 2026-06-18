// =============================================================================
// packages/admin — bespoke community detail view-model builder tests.
// Harness mirrors community-counts.test.ts: in-memory better-sqlite3 + full
// migration chain + drizzle. vi.doMock patches getReadDb before each dynamic import.
// =============================================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const INIT_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(INIT_SQL);

  sqlite.exec(`INSERT INTO communities (id,name,slug,town,description,published,coming_soon,
      synced_price_from, latitude, longitude, featured_image_url, master_planned)
    VALUES ('recC','Agave','agave','Phoenix','Desert living',1,0, 396990, 33.45, -112.07,
      'https://r2/agave.jpg', 1);`);

  vi.doMock('../lib/db', () => ({ getReadDb: () => drizzle(sqlite) }));
});

describe('buildCommunityDetailView', () => {
  it('builds hero, status, stats, basic info, and a map community from coords', async () => {
    const { buildCommunityDetailView } = await import('../lib/community-detail');
    const v = await buildCommunityDetailView('recC');
    expect(v).not.toBeNull();
    expect(v!.displayName).toBe('Agave');
    expect(v!.status).toBe('Live');
    expect(v!.hero.featuredImageUrl).toContain('agave.jpg');
    expect(v!.stats.startingPrice).toContain('396,990');
    expect(v!.map.community).not.toBeNull();
    expect(v!.map.community!.coordinates).toEqual([-112.07, 33.45]); // [lng,lat]
    expect(v!.map.community!.masterPlanned).toBe(true);
    expect(v!.basicInfo.some((f) => f.field === 'price_from')).toBe(true);
  });

  it('returns map.community = null when coordinates are missing', async () => {
    sqlite.exec(`UPDATE communities SET latitude=NULL, longitude=NULL WHERE id='recC';`);
    const { buildCommunityDetailView } = await import('../lib/community-detail');
    const v = await buildCommunityDetailView('recC');
    expect(v!.map.community).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    const { buildCommunityDetailView } = await import('../lib/community-detail');
    expect(await buildCommunityDetailView('nope')).toBeNull();
  });

  it('does not surface any of the 6 pared fields', async () => {
    const { buildCommunityDetailView } = await import('../lib/community-detail');
    const v = await buildCommunityDetailView('recC');
    const all = [...v!.basicInfo, ...v!.remaining.flatMap((g) => g.fields),
                 ...Object.values(v!.media)];
    const fields = new Set(all.map((f: any) => f.field));
    for (const dead of ['directions','community_logo_alt','photo_gallery_image_alt',
                        'secondary_image_alt','security_details','community_map_embed']) {
      expect(fields.has(dead)).toBe(false);
    }
  });

  it('places featured_image_alt in media.featuredAlt and not in remaining', async () => {
    const { buildCommunityDetailView } = await import('../lib/community-detail');
    const v = await buildCommunityDetailView('recC');
    // featuredAlt must exist on media and reference the right field
    expect(v!.media.featuredAlt).toBeDefined();
    expect(v!.media.featuredAlt.field).toBe('featured_image_alt');
    // featured_image_alt must NOT appear anywhere in remaining
    const remainingFields = v!.remaining.flatMap((g) => g.fields).map((f) => f.field);
    expect(remainingFields).not.toContain('featured_image_alt');
  });
});
