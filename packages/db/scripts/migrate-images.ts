#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — Phase 2: image → R2 migrator.
//
// For every image field whose value is an Airtable attachment / expiring
// v5.airtableusercontent.com signed URL, download the bytes and upload to R2 at
// <entity>/<id>/<filename>, then write the resulting STABLE url
// (media.esperanzahomes.com / CDN_BASE_URL) back into the D1 row. NEVER persists
// an airtableusercontent url. If a stable url already exists, it is kept (no
// re-upload — idempotent).
//
// SOURCE OF FRESH URLS: by default this re-reads Airtable (signed urls live only
// ~hours, so a stored copy would already be dead). It re-maps each record with the
// SAME mappers the importer uses, runs the image pass, and UPSERTs only the image
// columns back to D1. Use --from-db to instead scan current D1 rows and migrate any
// non-stable urls still present (e.g. after `import --skip-images` if those urls
// were permanent url-typed fields, not signed attachments).
//
// USAGE (from packages/db):
//   AIRTABLE_PAT=... npx tsx scripts/migrate-images.ts [options]
//   --local | --remote      target D1 (default local)
//   --dry-run               report what WOULD upload; no downloads/uploads/writes
//   --from-db               migrate from current D1 rows instead of re-reading Airtable
//   --only=qmi,floor_plans  limit to entities
//   --bucket=esperanza-cms  R2 bucket
//   --sink=wrangler|sqlite  D1 write path (default wrangler)
//   --sqlite-path=PATH      for sink=sqlite / --from-db sqlite
//   --chunk=200
//
// Env: AIRTABLE_PAT (unless --from-db), CDN_BASE_URL (optional).
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchAllRecords, TABLES, type EntityKey, type AirtableRecord } from './lib/airtable.js';
import {
  mapQmi,
  mapCommunity,
  mapCity,
  mapFloorPlan,
  mapPromotion,
  mapCollection,
  mapImage,
  mapBlog,
  mapTestimonial,
} from './lib/mappers.js';
import { D1Sink, buildUpsert, type SinkOptions } from './lib/d1.js';
import { resolveRowImages, imageColumns } from './lib/images.js';
import { findAirtableUrl } from './lib/coerce.js';
import { type MigrateOptions } from './lib/r2.js';
import { parseArgs, getMode, n, bytesHuman } from './lib/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

const ENTITIES: [EntityKey, string, (r: AirtableRecord) => Record<string, unknown>][] = [
  ['qmi', 'qmi', (r) => mapQmi(r).row],
  ['communities', 'communities', (r) => mapCommunity(r).row],
  ['cities', 'cities', (r) => mapCity(r)],
  ['floorPlans', 'floor_plans', (r) => mapFloorPlan(r)],
  ['promotions', 'promotions', (r) => mapPromotion(r).row],
  ['collections', 'collections', (r) => mapCollection(r)],
  ['images', 'images', (r) => mapImage(r)],
  ['blogs', 'blogs', (r) => mapBlog(r)],
  ['testimonials', 'testimonials', (r) => ({ ...mapTestimonial(r).row })],
];

interface Summary {
  scanned: number;
  uploaded: number;
  bytes: number;
  rowsTouched: number;
  alreadyStable: number;
  violations: { table: string; id: string; hit: string }[];
  perTable: Record<string, { uploaded: number; rows: number }>;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.flags.has('dry-run');
  const fromDb = args.flags.has('from-db');
  const mode = getMode(args);
  const bucket = args.values.get('bucket') ?? 'esperanza-cms';
  const sinkKind = (args.values.get('sink') as 'wrangler' | 'sqlite') ?? 'wrangler';
  const chunk = Number(args.values.get('chunk') ?? 200);
  const only = (args.values.get('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const wants = (e: string) => only.length === 0 || only.includes(e);

  if (!fromDb && !process.env.AIRTABLE_PAT) {
    console.error('ERROR: AIRTABLE_PAT is not set (needed unless --from-db). Add it to packages/db/.dev.vars.');
    process.exit(1);
  }

  console.log(`\n=== image → R2 migration ===`);
  console.log(`mode=${mode} source=${fromDb ? 'D1 rows' : 'Airtable (fresh signed urls)'} dryRun=${dryRun}`);
  console.log(`bucket=${bucket} cdn=${process.env.CDN_BASE_URL ?? 'media.esperanzahomes.com'}\n`);

  const s: Summary = {
    scanned: 0,
    uploaded: 0,
    bytes: 0,
    rowsTouched: 0,
    alreadyStable: 0,
    violations: [],
    perTable: {},
  };

  const sinkOpts: SinkOptions = {
    kind: sinkKind,
    mode,
    cwd: PKG_DB_DIR,
    dbName: 'esperanza',
    dryRun,
    sqlitePath: args.values.get('sqlite-path'),
  };
  const sink = new D1Sink(sinkOpts);
  const imgOpts: MigrateOptions = { bucket, mode, cwd: PKG_DB_DIR, dryRun };

  for (const [key, table, mapFn] of ENTITIES) {
    if (!wants(table)) continue;
    const cols = imageColumns(table);
    if (cols.length === 0) continue;
    s.perTable[table] = { uploaded: 0, rows: 0 };

    if (fromDb) {
      await migrateFromDb(table, cols, sinkOpts, imgOpts, sink, s);
    } else {
      process.stdout.write(`migrating ${table} images … `);
      const recs = await fetchAllRecords(TABLES[key], {
        onPage: (_p, total) => process.stdout.write(`\rmigrating ${table} images … fetched ${total}`),
      });
      let i = 0;
      for (const r of recs) {
        const full = mapFn(r);
        // keep only id + image columns for a targeted upsert
        const row: Record<string, unknown> = { id: r.id };
        for (const col of cols) if (col in full) row[col] = full[col];
        const st = await resolveRowImages(table, r.id, row, imgOpts);
        s.scanned += st.scanned;
        s.uploaded += st.uploaded;
        s.bytes += st.bytes;
        s.perTable[table]!.uploaded += st.uploaded;

        // guard before write
        const hit = findAirtableUrl(row);
        if (hit) {
          s.violations.push({ table, id: r.id, hit });
          for (const [k, v] of Object.entries(row)) if (findAirtableUrl(v)) row[k] = null;
        }

        // only upsert when at least one image column is non-null (avoid clobbering with all-NULL)
        const hasImage = cols.some((col) => row[col] != null);
        if (hasImage && Object.keys(row).length > 1) {
          const up = buildUpsert(table, row);
          sink.add(up.sql, up.params);
          s.rowsTouched++;
          s.perTable[table]!.rows++;
        }
        i++;
        if (i % 50 === 0) process.stdout.write(`\rmigrating ${table} images … ${i}/${recs.length}`);
      }
      console.log(`\rmigrating ${table} images … ${recs.length} records, ${s.perTable[table]!.uploaded} uploaded ✓        `);
    }
    sink.flush(chunk);
  }

  // sync_log telemetry
  if (!dryRun) {
    sink.add(
      `INSERT INTO sync_log (run_id, source, status, started_at, finished_at, unresolved_links, notes) VALUES (?, 'import', ?, ?, ?, ?, ?)`,
      [
        `migrate-images-${new Date().toISOString()}`,
        s.violations.length ? 'partial' : 'success',
        new Date().toISOString(),
        new Date().toISOString(),
        0,
        JSON.stringify({ uploaded: s.uploaded, rowsTouched: s.rowsTouched, perTable: s.perTable }),
      ]
    );
    sink.flush(chunk);
  }
  sink.close();

  console.log(`\n=== Migration summary (${dryRun ? 'DRY RUN' : mode}) ===`);
  console.log(`urls scanned: ${n(s.scanned)}`);
  console.log(`uploaded to R2: ${n(s.uploaded)} (${bytesHuman(s.bytes)})`);
  console.log(`rows updated in D1: ${n(s.rowsTouched)}`);
  console.log('per table:', s.perTable);
  if (s.violations.length) {
    console.error(`\n!! ${s.violations.length} rows still carried a forbidden url (NULLed before write):`);
    for (const v of s.violations.slice(0, 20)) console.error(`   - ${v.table} ${v.id}: ${v.hit}`);
    process.exitCode = 2;
  }
  console.log('\nDone.');
}

/**
 * --from-db: read current D1 rows for `table`, migrate any non-stable image url
 * still present. Reads via `wrangler d1 execute --json`. Only practical for
 * permanent-url fields (signed urls are already dead by now); primarily a safety
 * net for `import --skip-images` runs.
 */
async function migrateFromDb(
  table: string,
  cols: string[],
  sinkOpts: SinkOptions,
  imgOpts: MigrateOptions,
  sink: D1Sink,
  s: Summary
): Promise<void> {
  const selectCols = ['id', ...cols].join(', ');
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      sinkOpts.dbName ?? 'esperanza',
      sinkOpts.mode === 'remote' ? '--remote' : '--local',
      '--json',
      `--command=SELECT ${selectCols} FROM ${table}`,
    ],
    { cwd: sinkOpts.cwd, env: process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  let rows: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(out);
    rows = parsed?.[0]?.results ?? parsed?.results ?? [];
  } catch {
    console.warn(`  (could not parse d1 --json for ${table}; skipping --from-db for it)`);
    return;
  }
  for (const dbRow of rows) {
    const id = String(dbRow.id);
    const row: Record<string, unknown> = { id };
    for (const col of cols) if (dbRow[col] != null) row[col] = dbRow[col];
    if (Object.keys(row).length === 1) continue;
    const st = await resolveRowImages(table, id, row, imgOpts);
    s.scanned += st.scanned;
    s.uploaded += st.uploaded;
    s.bytes += st.bytes;
    s.perTable[table]!.uploaded += st.uploaded;
    const hit = findAirtableUrl(row);
    if (hit) {
      s.violations.push({ table, id, hit });
      for (const [k, v] of Object.entries(row)) if (findAirtableUrl(v)) row[k] = null;
    }
    if (st.uploaded > 0) {
      const up = buildUpsert(table, row);
      sink.add(up.sql, up.params);
      s.rowsTouched++;
      s.perTable[table]!.rows++;
    }
  }
  console.log(`migrating ${table} images (from D1) … ${rows.length} rows, ${s.perTable[table]!.uploaded} uploaded ✓`);
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
