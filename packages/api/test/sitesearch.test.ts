// =============================================================================
// Tests for the /api/public/sitesearch index serializer.
//
// Two layers:
//   1. Pure-unit tests of buildIndex() — label composition, the QMI double-emit
//      (address record + lot record sharing ONE href), unslugged-row drops, and
//      href templating (default + custom base URLs).
//   2. An integration test that loads the REAL migrations + views.sql into an
//      in-memory better-sqlite3 DB (D1 IS SQLite), seeds published + unpublished
//      rows of each type, runs the real SITESEARCH_SQL against the public views,
//      and asserts the published gate is honored and the columns resolve.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildIndex,
  SITESEARCH_SQL,
  DEFAULT_BASE_URLS,
  type SiteSearchRecord,
} from '../src/sitesearch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..', '..', 'db');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

const MIGRATIONS_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');
const VIEWS_SQL = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');

// -----------------------------------------------------------------------------
// 1. Pure unit tests — buildIndex()
// -----------------------------------------------------------------------------
describe('buildIndex — serializer logic', () => {
  it('maps a community to its href via the slug', () => {
    const out = buildIndex({
      communities: [{ name: 'Anaqua at Tres Lagos', slug: 'anaqua-at-tres-lagos' }],
      floorPlans: [],
      qmis: [],
      blogs: [],
    });
    expect(out).toEqual([
      { label: 'Anaqua at Tres Lagos', type: 'community', href: '/new-homes/anaqua-at-tres-lagos' },
    ]);
  });

  it('maps a floor plan and a blog with their templates', () => {
    const out = buildIndex({
      communities: [],
      floorPlans: [{ name: 'Acuna II', slug: 'acuna-ii' }],
      qmis: [],
      blogs: [{ title: 'Vista Verde Groundbreaking', slug: 'vista-verde-groundbreaking' }],
    });
    expect(out).toContainEqual({ label: 'Acuna II', type: 'floor plan', href: '/floorplans/acuna-ii' });
    expect(out).toContainEqual({
      label: 'Vista Verde Groundbreaking',
      type: 'blog',
      href: '/blog/vista-verde-groundbreaking',
    });
  });

  it('emits TWO records for a QMI — address + lot — sharing one href', () => {
    const out = buildIndex({
      communities: [],
      floorPlans: [],
      qmis: [
        { address: '1000 W Star Flower St', community: 'Rogers Coves', lot_number: '151', slug: '1000-w-star-flower-st' },
      ],
      blogs: [],
    });
    const qmi = out.find((r) => r.type === 'quick move in')!;
    const lot = out.find((r) => r.type === 'lot number')!;
    expect(qmi.label).toBe('1000 W Star Flower St at Rogers Coves');
    expect(lot.label).toBe('Lot 151 — Rogers Coves');
    expect(qmi.href).toBe('/new-homes/available/1000-w-star-flower-st');
    expect(lot.href).toBe(qmi.href); // same destination, exactly like O'Neil
  });

  it('omits the QMI " at <community>" suffix when community is blank', () => {
    const out = buildIndex({
      communities: [], floorPlans: [], blogs: [],
      qmis: [{ address: '123 Main St', community: '', lot_number: null, slug: 'm123' }],
    });
    expect(out).toEqual([
      { label: '123 Main St', type: 'quick move in', href: '/new-homes/available/m123' },
    ]);
  });

  it('drops rows with no slug or no label', () => {
    const out = buildIndex({
      communities: [
        { name: 'Has Slug', slug: 'has-slug' },
        { name: 'No Slug', slug: '' },
        { name: '', slug: 'no-name' },
      ],
      floorPlans: [],
      qmis: [{ address: '', community: '', lot_number: null, slug: 'q1' }], // no usable label
      blogs: [],
    });
    expect(out).toEqual([{ label: 'Has Slug', type: 'community', href: '/new-homes/has-slug' }]);
  });

  it('respects custom base URLs', () => {
    const out = buildIndex(
      { communities: [{ name: 'C', slug: 'c' }], floorPlans: [], qmis: [], blogs: [] },
      { ...DEFAULT_BASE_URLS, community: '/community/' }, // trailing slash tolerated
    );
    expect(out[0]!.href).toBe('/community/c');
  });

  it('trims whitespace in labels', () => {
    const out = buildIndex({
      communities: [{ name: '  Spaced  ', slug: 'spaced' }], floorPlans: [], qmis: [], blogs: [],
    });
    expect(out[0]!.label).toBe('Spaced');
  });
});

// -----------------------------------------------------------------------------
// 2. Integration — real views + published gate
// -----------------------------------------------------------------------------
describe('SITESEARCH_SQL against the real public views', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(MIGRATIONS_SQL);
    db.exec(VIEWS_SQL);

    // communities: 1 published (with slug), 1 unpublished
    db.prepare(`INSERT INTO communities (id, name, slug, published) VALUES (?,?,?,?)`)
      .run('c1', 'Anaqua at Tres Lagos', 'anaqua-at-tres-lagos', 1);
    db.prepare(`INSERT INTO communities (id, name, slug, published) VALUES (?,?,?,?)`)
      .run('c2', 'Hidden Community', 'hidden', 0);

    // floor_plans: 1 published, 1 unpublished
    db.prepare(`INSERT INTO floor_plans (id, name, slug, published) VALUES (?,?,?,?)`)
      .run('f1', 'Acuna II', 'acuna-ii', 1);
    db.prepare(`INSERT INTO floor_plans (id, name, slug, published) VALUES (?,?,?,?)`)
      .run('f2', 'Hidden Plan', 'hidden-plan', 0);

    // blogs: 1 published, 1 unpublished
    db.prepare(`INSERT INTO blogs (id, title, slug, published) VALUES (?,?,?,?)`)
      .run('b1', 'Vista Verde Groundbreaking', 'vista-verde', 1);
    db.prepare(`INSERT INTO blogs (id, title, slug, published) VALUES (?,?,?,?)`)
      .run('b2', 'Draft Post', 'draft-post', 0);

    // qmi: 1 published (synced address + community + lot + slug), 1 unpublished
    db.prepare(
      `INSERT INTO qmi (id, slug, synced_address, synced_community_name, lot_number, published)
       VALUES (?,?,?,?,?,?)`,
    ).run('q1', '1000-w-star-flower-st', '1000 W Star Flower St', 'Rogers Coves', '151', 1);
    db.prepare(
      `INSERT INTO qmi (id, slug, synced_address, synced_community_name, lot_number, published)
       VALUES (?,?,?,?,?,?)`,
    ).run('q2', 'hidden-qmi', '999 Hidden Way', 'Rogers Coves', '999', 0);
  });

  function run(sql: string): any[] {
    return db.prepare(sql).all();
  }

  it('the views drop unpublished rows, so the index excludes them', () => {
    const out = buildIndex({
      communities: run(SITESEARCH_SQL.communities),
      floorPlans: run(SITESEARCH_SQL.floorPlans),
      qmis: run(SITESEARCH_SQL.qmis),
      blogs: run(SITESEARCH_SQL.blogs),
    });

    const labels = out.map((r) => r.label);
    expect(labels).not.toContain('Hidden Community');
    expect(labels).not.toContain('Hidden Plan');
    expect(labels).not.toContain('Draft Post');
    expect(out.some((r) => r.href.includes('hidden-qmi'))).toBe(false);

    // The one published QMI yields exactly two records (address + lot).
    const qmiRecords = out.filter((r) => r.href === '/new-homes/available/1000-w-star-flower-st');
    expect(qmiRecords.map((r) => r.type).sort()).toEqual(['lot number', 'quick move in']);

    // Published community / floor plan / blog all present with correct hrefs.
    expect(out).toContainEqual({
      label: 'Anaqua at Tres Lagos', type: 'community', href: '/new-homes/anaqua-at-tres-lagos',
    });
    expect(out).toContainEqual({ label: 'Acuna II', type: 'floor plan', href: '/floorplans/acuna-ii' });
    expect(out).toContainEqual({ label: 'Vista Verde Groundbreaking', type: 'blog', href: '/blog/vista-verde' });
  });
});
