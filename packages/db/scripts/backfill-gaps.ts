#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — SURGICAL gap backfill (one-off).
//
// The original remote import left a set of columns 100% empty even though the
// source Airtable field carries data — partly stale-import (qmi.lot_number), partly
// mapper field-name drift on floor_plans (now fixed in lib/mappers.ts). A FULL
// re-import would re-download/re-upload ~2,900 images (migrateImageUrl has no
// existence check) AND, unless CDN_BASE_URL is pinned to the r2.dev base, rewrite
// every image url to a non-resolving media.esperanzahomes.com host.
//
// So this backfill is COLUMN-SCOPED: it recomputes ONLY the gap columns via the
// (corrected) mappers, migrates ONLY the few gap image columns (pinned to the
// r2.dev base), and issues UPDATE … SET <gap cols only> WHERE id=? — never touching
// the already-correct image columns. Idempotent.
//
// USAGE (from packages/db, AIRTABLE_PAT exported):
//   AIRTABLE_PAT=… npx tsx scripts/backfill-gaps.ts [--local|--remote] [--dry-run]
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchAllRecords, TABLES } from './lib/airtable.js';
import { mapQmi, mapFloorPlan } from './lib/mappers.js';
import { D1Sink } from './lib/d1.js';
import { migrateImageUrl, type MigrateOptions } from './lib/r2.js';
import { findAirtableUrl } from './lib/coerce.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

// Pin the public image base so migrated images get RESOLVING r2.dev urls (the zone
// esperanzahomes.com is not on this CF account) and existing r2.dev urls count as stable.
const R2_DEV_BASE = 'https://img.hazardhouse.ai';
if (!process.env.CDN_BASE_URL) process.env.CDN_BASE_URL = R2_DEV_BASE;

// Confirmed gap columns (source has data, D1 empty). Split by handling.
const GAPS = {
  qmi: {
    map: mapQmi as (r: any) => any,
    pick: (m: any) => m.row ?? m, // mapQmi returns { row, ... }
    text: ['lot_number'],
    imageSingle: [] as string[],
    imageArray: ['featured_image'],
  },
  floor_plans: {
    map: mapFloorPlan as (r: any) => any,
    pick: (m: any) => m,
    text: [
      'collection',
      'bedroom_min',
      'bedroom_max',
      'bathroom_min',
      'bathroom_max',
      'plan_viewer_url',
      'virtual_tour_url',
      'energy_cost_low',
      'energy_cost_high',
      'energy_cost_avg',
    ],
    // brochure_pdf_url/brochure_pdf are media.esperanzahomes.com urls (stable, kept as-is
    // by migrateImageUrl); hero_image_2/3 are signed attachments -> migrate to r2.dev.
    imageSingle: ['hero_image_2', 'hero_image_3', 'brochure_pdf_url', 'brochure_pdf'],
    imageArray: [] as string[],
  },
} as const;

const TABLE_KEY: Record<string, keyof typeof TABLES> = { qmi: 'qmi', floor_plans: 'floorPlans' };

async function main() {
  const argv = process.argv.slice(2);
  const mode: 'local' | 'remote' = argv.includes('--remote') ? 'remote' : 'local';
  const dryRun = argv.includes('--dry-run');
  if (!process.env.AIRTABLE_PAT) {
    console.error('ERROR: AIRTABLE_PAT not set.');
    process.exit(1);
  }

  console.log(`\n=== Surgical gap backfill (mode=${mode}${dryRun ? ', DRY-RUN' : ''}) ===`);
  console.log(`image base (CDN_BASE_URL) = ${process.env.CDN_BASE_URL}\n`);

  const imgOpts: MigrateOptions = { mode, cwd: PKG_DB_DIR, dryRun, bucket: 'esperanza-cms' };
  const sink = new D1Sink({ kind: 'wrangler', mode, cwd: PKG_DB_DIR, dbName: 'esperanza', dryRun });

  for (const [table, cfg] of Object.entries(GAPS)) {
    process.stdout.write(`• ${table}: fetching … `);
    const recs = await fetchAllRecords(TABLES[TABLE_KEY[table]!]);
    console.log(`${recs.length} records`);

    const gapCols = [...cfg.text, ...cfg.imageSingle, ...cfg.imageArray];
    let updates = 0;
    let imagesMigrated = 0;
    const samples: any[] = [];

    for (const r of recs) {
      const mapped = cfg.pick(cfg.map(r));
      const out: Record<string, unknown> = {};

      for (const col of cfg.text) out[col] = mapped[col] ?? null;

      for (const col of cfg.imageSingle) {
        const v = mapped[col];
        if (typeof v === 'string' && v) {
          const res = await migrateImageUrl(table, r.id, v, undefined, imgOpts);
          out[col] = res.url;
          if (res.uploaded) imagesMigrated++;
        } else {
          out[col] = v ?? null;
        }
      }

      for (const col of cfg.imageArray) {
        const json = mapped[col];
        if (typeof json === 'string' && json && json !== '[]') {
          let arr: any[] = [];
          try { arr = JSON.parse(json); } catch {}
          for (const item of arr) {
            if (item && typeof item === 'object' && typeof item.url === 'string') {
              const res = await migrateImageUrl(table, r.id, item.url, item.filename, imgOpts);
              item.url = res.url;
              if (res.uploaded) imagesMigrated++;
            }
          }
          out[col] = JSON.stringify(arr);
        } else {
          out[col] = json ?? null;
        }
      }

      // guard: never persist a forbidden url
      for (const [k, v] of Object.entries(out)) if (findAirtableUrl(v)) out[k] = null;

      // skip rows where every gap col is null/empty (nothing to write)
      const hasData = gapCols.some((c) => {
        const v = out[c];
        return v !== null && v !== undefined && v !== '' && v !== '[]';
      });
      if (!hasData) continue;

      if (samples.length < 3) samples.push({ id: r.id, ...out });

      const setCols = gapCols.map((c) => `${c} = ?`).join(', ');
      sink.add(
        `UPDATE ${table} SET ${setCols}, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?`,
        [...gapCols.map((c) => out[c] ?? null), r.id]
      );
      updates++;
    }

    console.log(`  → ${updates} rows to update, ${imagesMigrated} images migrated`);
    console.log(`  sample:`, JSON.stringify(samples[0] ?? {}, null, 0).slice(0, 300));
  }

  sink.flush(150);
  sink.close();
  console.log(`\nStatements ${dryRun ? 'planned' : 'executed'}: ${sink.executed}\n${dryRun ? '(dry-run — nothing written)' : 'Done.'}`);
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
