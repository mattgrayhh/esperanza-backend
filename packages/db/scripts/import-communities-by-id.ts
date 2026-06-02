#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — targeted single/multi community importer (by Airtable rec id).
//
// WHY THIS EXISTS (vs running import-from-airtable.ts --only=communities):
// A few communities created in Airtable AFTER the bulk cutover were absent from
// D1 (the new source of truth). Re-running the full communities import would
// re-upsert ALL ~32 community rows, which risks clobbering rows a CONCURRENT
// workflow is editing. This script imports ONLY the explicitly named record ids,
// reusing the EXACT same mapper + R2 image migration + airtableusercontent guard
// + idempotent upsert as the bulk importer, so the rows land identically.
//
// Pipeline per record (faithful subset of import-from-airtable.ts writeRow):
//   1. GET the record from Airtable REST by id (raw fields).
//   2. mapCommunity(record)  -> bucketed D1 column row (id = Airtable rec id).
//   3. resolveRowImages('communities', ...) -> migrate every attachment/signed
//      image url to R2 (CDN_BASE_URL controls the stable base).
//   4. HARD GUARD findAirtableUrl(row): any surviving airtableusercontent url ->
//      null that column (never persist a forbidden/expiring url).
//   5. published := source Active state. Communities have no live `Active` field;
//      the source publish gate is the `Published` checkbox (mapCommunity already
//      sets published=boolInt(Published)). Coming-Soon-only rows therefore land
//      published=0 (Draft) — matching the live state — for marketing to publish.
//   6. Intersect the mapped row with the REAL communities table columns (the
//      mapper emits a `draft` key dropped in migration 0005; also skips any other
//      column not physically present) so buildUpsert never references a missing col.
//   7. buildUpsert + D1Sink (idempotent ON CONFLICT(id)) -> remote (or local) D1.
//
// USAGE (from packages/db):
//   AIRTABLE_PAT=... CDN_BASE_URL=https://pub-...r2.dev \
//     npx tsx scripts/import-communities-by-id.ts --remote rechXXXX,recgYYYY
//   flags: --remote (default local) | --dry-run | --bucket=esperanza-cms
//
// Env: AIRTABLE_PAT (required), CDN_BASE_URL (optional; stable image base).
// NEVER hardcodes secrets.
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BASE_ID, TABLES, type AirtableRecord } from './lib/airtable.js';
import { mapCommunity } from './lib/mappers.js';
import { D1Sink, buildUpsert } from './lib/d1.js';
import { resolveRowImages } from './lib/images.js';
import { findAirtableUrl } from './lib/coerce.js';
import type { MigrateOptions } from './lib/r2.js';
import { cdnBase } from './lib/r2.js';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..'); // packages/db — wrangler.toml with DB + IMAGES bindings
const API = 'https://api.airtable.com/v0';

async function getRecord(tableId: string, recId: string, pat: string): Promise<AirtableRecord> {
  const url = `${API}/${BASE_ID}/${encodeURIComponent(tableId)}/${recId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Airtable GET ${recId} failed: ${res.status} ${res.statusText} ${body}`);
  }
  return (await res.json()) as AirtableRecord;
}

/** Physical columns of the communities table (read live from D1). */
function communityColumns(mode: 'local' | 'remote'): Set<string> {
  const args = [
    'wrangler', 'd1', 'execute', 'esperanza',
    mode === 'remote' ? '--remote' : '--local',
    '--json',
    '--command', `SELECT name FROM pragma_table_info('communities');`,
  ];
  const out = execFileSync('npx', args, { cwd: PKG_DB_DIR, env: process.env }).toString();
  const parsed = JSON.parse(out);
  const results = parsed[0]?.results ?? [];
  return new Set(results.map((r: { name: string }) => r.name));
}

async function main() {
  const argv = process.argv.slice(2);
  const mode: 'local' | 'remote' = argv.includes('--remote') ? 'remote' : 'local';
  const dryRun = argv.includes('--dry-run');
  const bucket = (argv.find((a) => a.startsWith('--bucket='))?.split('=')[1]) ?? 'esperanza-cms';
  // positional = comma/space separated list of rec ids
  const ids = argv
    .filter((a) => !a.startsWith('--'))
    .flatMap((a) => a.split(','))
    .map((s) => s.trim())
    .filter((s) => s.startsWith('rec'));

  if (!process.env.AIRTABLE_PAT) {
    console.error('ERROR: AIRTABLE_PAT not set (export or add to packages/db/.dev.vars).');
    process.exit(1);
  }
  if (ids.length === 0) {
    console.error('ERROR: pass one or more Airtable community rec ids (comma-separated).');
    process.exit(1);
  }
  const pat = process.env.AIRTABLE_PAT;

  console.log(`\n=== Targeted communities import ===`);
  console.log(`mode=${mode} dryRun=${dryRun} base=${BASE_ID} cdn=${cdnBase()}`);
  console.log(`ids=${ids.join(', ')}\n`);

  const cols = communityColumns(mode);
  const sink = new D1Sink({ kind: 'wrangler', mode, dbName: 'esperanza', cwd: PKG_DB_DIR, dryRun });
  const imgOpts: MigrateOptions = { bucket, mode, cwd: PKG_DB_DIR, dryRun };

  const report: Array<Record<string, unknown>> = [];

  for (const id of ids) {
    const rec = await getRecord(TABLES.communities, id, pat);
    const { row } = mapCommunity(rec);

    // image migration (mutates row in place → stable R2 urls)
    const st = await resolveRowImages('communities', id, row, imgOpts);

    // HARD GUARD: never persist a forbidden airtableusercontent url
    const hit = findAirtableUrl(row);
    if (hit) {
      console.warn(`  ! guard: ${id} carried a forbidden url; nulling offending column(s)`);
      for (const [k, v] of Object.entries(row)) if (findAirtableUrl(v)) row[k] = null;
    }

    // published := source Active state. Communities have no `Active` field; the
    // live publish gate is the Published checkbox (mapCommunity already set it).
    const published = row.published === 1 ? 1 : 0;

    // intersect with REAL columns (drop `draft` etc. not physically present)
    const filtered: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(row)) {
      if (cols.has(k)) filtered[k] = v;
      else dropped.push(k);
    }
    if (dropped.length) console.log(`  (dropped non-schema keys for ${id}: ${dropped.join(', ')})`);

    const up = buildUpsert('communities', filtered);
    sink.add(up.sql, up.params);

    report.push({
      id,
      name: filtered.name,
      slug: filtered.slug,
      town: filtered.town,
      published,
      city_id: filtered.city_id,
      price_from: filtered.price_from,
      featured_image_url: filtered.featured_image_url,
      images_uploaded: st.uploaded,
      image_bytes: st.bytes,
      guard_hit: hit ?? null,
    });
  }

  sink.flush(200);
  sink.close();

  console.log(`\n=== Summary (${dryRun ? 'DRY RUN — nothing written' : mode}) ===`);
  for (const r of report) {
    console.log(
      `  ${r.id}  name=${JSON.stringify(r.name)} slug=${JSON.stringify(r.slug)} town=${JSON.stringify(r.town)} ` +
        `published=${r.published} city_id=${r.city_id ?? 'NULL'} price_from=${r.price_from ?? 'NULL'} ` +
        `images_uploaded=${r.images_uploaded} featured=${r.featured_image_url ?? 'NULL'} guard=${r.guard_hit ?? 'clean'}`
    );
  }
  console.log(`statements ${dryRun ? 'planned' : 'executed'}: ${sink.executed}`);
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
