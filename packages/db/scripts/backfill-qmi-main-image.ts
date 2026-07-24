#!/usr/bin/env -S npx tsx
// =============================================================================
// Ensure every published QMI has a usable listing-card hero (qmi.image_url).
//
// Priority:
//   1. pickListingHero(gallery, og_image_url) when it differs from image_url
//   2. og_image_url when image_url is empty or floor-plan schematic only
//   3. Live site og:image (www.esperanzahomes.com) when still missing/wrong vs live
//   4. Linked floor-plan fp_image (ingest-style seed) as last resort
//
// USAGE (from packages/db):
//   npx tsx scripts/backfill-qmi-main-image.ts --remote --dry-run
//   npx tsx scripts/backfill-qmi-main-image.ts --remote
//   --published-only   (default) | --all
//   --skip-live        skip HTTP fetch to esperanzahomes.com
//   --weak-only        only rows with empty image_url or floor_plans/ hero
// =============================================================================
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGalleryUrls } from '../../admin/lib/gallery-urls.js';
import {
  isFloorPlanSchematicUrl,
  pickListingHero,
} from '../lib/listing-hero.js';
import { parseArgs, getMode } from './lib/cli.js';
import { D1Sink } from './lib/d1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');
const LIVE = 'https://www.esperanzahomes.com';

interface QmiRow {
  id: string;
  slug: string;
  address: string;
  published: number;
  image_url: string | null;
  og_image_url: string | null;
  photo_gallery_json: string | null;
  page_url: string | null;
  city_slug: string | null;
  community_slug: string | null;
  fp_image: string | null;
}

function d1Query(mode: 'local' | 'remote', sql: string): unknown[] {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'esperanza', mode === 'remote' ? '--remote' : '--local', '--json', '--command', sql],
    { cwd: PKG_DB_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const jsonStart = out.indexOf('[');
  if (jsonStart < 0) throw new Error(`wrangler d1 returned no JSON:\n${out.slice(-500)}`);
  const parsed = JSON.parse(out.slice(jsonStart));
  const rows = Array.isArray(parsed) ? parsed[0]?.results : parsed?.results;
  return (rows ?? []) as unknown[];
}

function firstFpImageUrl(raw: string | null): string | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const first = parsed[0] as { url?: string };
    return first?.url?.trim() || null;
  } catch {
    return null;
  }
}

function extractMediaNearSlug(html: string, slug: string): string | null {
  const idx = html.indexOf(slug);
  if (idx < 0) return null;
  const slice = html.slice(Math.max(0, idx - 6000), idx + 12000);
  const media = [...slice.matchAll(/https:\/\/media\.esperanzahomes\.com\/[^"'\\s]+/g)].map((m) =>
    m[0].replace(/&amp;/g, '&'),
  );
  return (
    media.find((u) => /width=1920/i.test(u)) ??
    media.find((u) => /width=1000/i.test(u)) ??
    media[0] ??
    null
  );
}

function liveFetchUrls(row: QmiRow): string[] {
  const out: string[] = [];
  const page = (row.page_url ?? '').trim();
  if (page.startsWith('http')) out.push(page);
  if (row.city_slug && row.community_slug && row.slug) {
    out.push(`${LIVE}/new-homes/tx/${row.city_slug}/${row.community_slug}/${row.slug}/`);
    out.push(`${LIVE}/new-homes/tx/${row.city_slug}/${row.community_slug}/`);
  }
  if (row.slug) out.push(`${LIVE}/new-homes/available/${row.slug}/`);
  return [...new Set(out)];
}

function fetchLiveCardHero(urls: string[], slug: string): string | null {
  for (const url of urls) {
    if (!url) continue;
    try {
      const html = execFileSync(
        'curl',
        ['-sL', '-A', 'Mozilla/5.0', '--max-time', '25', url],
        { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 },
      );
      const near = extractMediaNearSlug(html, slug);
      if (near?.trim()) return near.trim();

      const og =
        html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ??
        html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
      const ogUrl = og?.[1]?.replace(/&amp;/g, '&').trim();
      if (ogUrl && !/esperanza-default-og/i.test(ogUrl)) return ogUrl;
    } catch {
      /* try next */
    }
  }
  return null;
}

function loadRows(mode: 'local' | 'remote', publishedOnly: boolean): QmiRow[] {
  const pub = publishedOnly ? 'WHERE q.published = 1' : '';
  const sql = `
    SELECT q.id, q.slug,
           COALESCE(q.override_address, q.synced_address) AS address,
           q.published, q.image_url, q.og_image_url, q.photo_gallery_json, q.page_url,
           ci.slug AS city_slug, c.slug AS community_slug,
           fp.fp_image AS fp_image
    FROM qmi q
    LEFT JOIN communities c ON c.id = COALESCE(q.override_community_id, q.synced_community_id)
    LEFT JOIN cities ci ON ci.id = COALESCE(q.override_city_id, q.synced_city_id)
    LEFT JOIN floor_plans fp ON fp.id = COALESCE(q.override_floor_plan_id, q.synced_floor_plan_id)
    ${pub}
  `.trim();
  return d1Query(mode, sql) as QmiRow[];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = getMode(args);
  const dryRun = args.flags.has('dry-run');
  const skipLive = args.flags.has('skip-live');
  const weakOnly = args.flags.has('weak-only');
  const publishedOnly = !args.flags.has('all');

  let rows = loadRows(mode, publishedOnly);
  if (weakOnly) {
    rows = rows.filter((row) => {
      const cur = (row.image_url ?? '').trim();
      return !cur || isFloorPlanSchematicUrl(cur);
    });
  }
  const sink = new D1Sink({ kind: 'wrangler', mode, cwd: PKG_DB_DIR, dryRun });

  let updated = 0;
  let skipped = 0;
  let liveFetched = 0;

  for (const row of rows) {
    const current = (row.image_url ?? '').trim();
    const gallery = parseGalleryUrls(row.photo_gallery_json ?? '');
    const og = (row.og_image_url ?? '').trim();

    let next =
      pickListingHero({ galleryUrls: gallery, ogImageUrl: og }) ??
      (og || null) ??
      firstFpImageUrl(row.fp_image);

    const weak = !current || isFloorPlanSchematicUrl(current);
    if (weak && !skipLive && row.slug) {
      const liveOg = fetchLiveCardHero(liveFetchUrls(row), row.slug);
      liveFetched++;
      if (liveOg?.trim() && !/esperanza-default-og/i.test(liveOg)) {
        next = liveOg.trim();
        if (!og) {
          sink.add(
            `UPDATE qmi SET og_image_url = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ? AND (og_image_url IS NULL OR TRIM(og_image_url) = '')`,
            [next, row.id],
          );
        }
      }
    }

    if (!next?.trim() || next.trim() === current) {
      skipped++;
      continue;
    }

    sink.add(
      `UPDATE qmi SET image_url = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?`,
      [next, row.id],
    );
    updated++;
    console.log(`${row.address} (${row.slug})`);
    console.log(`  ${current || '(empty)'} → ${next}`);
  }

  sink.flush();
  console.log(
    `\nDone. Updated ${updated}, skipped ${skipped}, live fetches ${liveFetched} (${mode}${dryRun ? ', dry-run' : ''}).`,
  );
}

if (process.argv[1]?.includes('backfill-qmi-main-image')) {
  main();
}
