#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — one-shot repair: cities block-JSON image sub-fields that were
// stringified to the literal "[object Object]" at import.
//
// ROOT CAUSE: mappers.ts cityCopyBlocksJson / cityVenueBlocksJson resolve image
// sub-fields via `firstAttachmentUrl(x['<Name> (Attachment)']) ?? str(x['<Name>'])`.
// For sub-fields whose `(Attachment)` column does NOT exist on the Cities table
// (Live In Image, Image 0, Section 1 Image, Section 1a Image, the venue images),
// the fallback `str(x['<Name>'])` ran on the PLAIN attachment ARRAY field. str()
// hits its array branch -> v.map(String) -> "[object Object]". That literal was
// then JSON-embedded; because it is not an http(s) url, resolveRowImages skipped
// it and the guard (findAirtableUrl) never flagged it.
//
// THIS SCRIPT: re-reads each affected city from Airtable (fresh signed urls),
// and for every block image sub-key currently holding "[object Object]" (or any
// non-stable, non-r2.dev value), downloads the real attachment, uploads it to R2
// at cities/<recId>/<file>, and rewrites ONLY that sub-key with the r2.dev url.
// All other keys are preserved verbatim. Writes corrected JSON back to remote D1.
//
// Reuses migrateImageUrl() from lib/r2.ts (download + `wrangler r2 object put`).
// Set CDN_BASE_URL to the r2.dev public base so written urls match the rest of
// the (correctly) migrated city images.
//
// USAGE (from packages/db, AIRTABLE_PAT exported):
//   CDN_BASE_URL=https://img.hazardhouse.ai \
//     npx tsx scripts/fix-city-block-images.ts [--dry-run]
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchAllRecords, TABLES } from './lib/airtable.js';
import { attachments } from './lib/coerce.js';
import { migrateImageUrl, isStableUrl, type MigrateOptions } from './lib/r2.js';
import { D1Sink, type SinkOptions } from './lib/d1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

// JSON sub-key -> Airtable source field name (the PLAIN attachment field).
const COPY_FIELDS: Record<string, string> = {
  live_in_image: 'Live In Image',
  image_0: 'Image 0',
  section_1_image: 'Section 1 Image',
  section_1a_image: 'Section 1a Image',
  section_2_image: 'Section 2 Image',
  section_3_image: 'Section 3 Image',
};
const VENUE_FIELDS: Record<string, string> = {
  eat_image: 'Eat Image',
  shop_image: 'Shop Image',
  play_image: 'Play Image',
  relax_image: 'Relax Image',
  stay_image: 'Stay Image',
};

/** A sub-key value needs fixing if it isn't already a stable r2.dev/cdn url. */
function needsFix(v: unknown): boolean {
  return typeof v === 'string' && v !== '' && !isStableUrl(v);
}

interface PerCity {
  city: string;
  id: string;
  fixed: string[];
  unrecoverable: string[];
  skippedAlreadyStable: number;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.AIRTABLE_PAT) {
    console.error('ERROR: AIRTABLE_PAT not set');
    process.exit(1);
  }
  const cdn = process.env.CDN_BASE_URL ?? '(default media.esperanzahomes.com — set CDN_BASE_URL!)';
  console.log(`=== fix city block images === dryRun=${dryRun} cdn=${cdn}\n`);

  const imgOpts: MigrateOptions = {
    bucket: 'esperanza-cms',
    mode: 'remote',
    cwd: PKG_DB_DIR,
    dryRun,
  };

  // 1) which cities currently carry [object Object] (read remote D1)
  const d1 = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'esperanza',
      '--remote',
      '--json',
      `--command=SELECT id, city_name, city_copy_blocks_json, city_venue_blocks_json FROM cities WHERE city_copy_blocks_json LIKE '%[object Object]%' OR city_venue_blocks_json LIKE '%[object Object]%'`,
    ],
    { cwd: PKG_DB_DIR, env: process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const parsed = JSON.parse(d1);
  const rows: any[] = parsed?.[0]?.results ?? parsed?.results ?? [];
  const byId = new Map<string, any>(rows.map((r) => [String(r.id), r]));
  console.log(`cities needing repair: ${rows.length}\n`);

  // 2) fetch Airtable cities (fresh attachment urls)
  const recs = await fetchAllRecords(TABLES.cities);
  const recById = new Map(recs.map((r) => [r.id, r]));

  const reports: PerCity[] = [];
  const writes: { id: string; copy: string | null; venue: string | null }[] = [];

  for (const [id, dbRow] of byId) {
    const rec = recById.get(id);
    const report: PerCity = {
      city: dbRow.city_name,
      id,
      fixed: [],
      unrecoverable: [],
      skippedAlreadyStable: 0,
    };
    if (!rec) {
      report.unrecoverable.push('(entire Airtable record missing)');
      reports.push(report);
      continue;
    }
    const af = rec.fields;

    let copyChanged = false;
    let venueChanged = false;
    let copyObj: Record<string, unknown> | null = null;
    let venueObj: Record<string, unknown> | null = null;

    // ---- copy block ----
    if (typeof dbRow.city_copy_blocks_json === 'string' && dbRow.city_copy_blocks_json) {
      copyObj = JSON.parse(dbRow.city_copy_blocks_json);
      for (const [subKey, srcField] of Object.entries(COPY_FIELDS)) {
        if (!(subKey in copyObj!)) continue;
        const cur = copyObj![subKey];
        if (!needsFix(cur)) {
          if (typeof cur === 'string' && isStableUrl(cur)) report.skippedAlreadyStable++;
          continue;
        }
        const srcUrl = attachments(af[srcField])[0]?.url ?? null;
        const srcName = attachments(af[srcField])[0]?.filename;
        if (!srcUrl) {
          report.unrecoverable.push(`${subKey} (no '${srcField}' attachment in Airtable)`);
          continue;
        }
        const res = await migrateImageUrl('cities', id, srcUrl, srcName, imgOpts);
        copyObj![subKey] = res.url;
        copyChanged = true;
        report.fixed.push(subKey);
      }
    }

    // ---- venue block ----
    if (typeof dbRow.city_venue_blocks_json === 'string' && dbRow.city_venue_blocks_json) {
      venueObj = JSON.parse(dbRow.city_venue_blocks_json);
      for (const [subKey, srcField] of Object.entries(VENUE_FIELDS)) {
        if (!(subKey in venueObj!)) continue;
        const cur = venueObj![subKey];
        if (!needsFix(cur)) {
          if (typeof cur === 'string' && isStableUrl(cur)) report.skippedAlreadyStable++;
          continue;
        }
        const srcUrl = attachments(af[srcField])[0]?.url ?? null;
        const srcName = attachments(af[srcField])[0]?.filename;
        if (!srcUrl) {
          report.unrecoverable.push(`${subKey} (no '${srcField}' attachment in Airtable)`);
          continue;
        }
        const res = await migrateImageUrl('cities', id, srcUrl, srcName, imgOpts);
        venueObj![subKey] = res.url;
        venueChanged = true;
        report.fixed.push(subKey);
      }
    }

    reports.push(report);
    if (copyChanged || venueChanged) {
      writes.push({
        id,
        copy: copyChanged ? JSON.stringify(copyObj) : null,
        venue: venueChanged ? JSON.stringify(venueObj) : null,
      });
    }
  }

  // 3) write corrected JSON back to remote D1 via the proven D1Sink --file path
  //    (single-quote-escaped literals; safe for apostrophes in the copy text).
  const sinkOpts: SinkOptions = {
    kind: 'wrangler',
    mode: 'remote',
    cwd: PKG_DB_DIR,
    dbName: 'esperanza',
    dryRun,
  };
  const sink = new D1Sink(sinkOpts);
  for (const w of writes) {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (w.copy !== null) {
      sets.push('city_copy_blocks_json = ?');
      params.push(w.copy);
    }
    if (w.venue !== null) {
      sets.push('city_venue_blocks_json = ?');
      params.push(w.venue);
    }
    if (sets.length === 0) continue;
    params.push(w.id);
    sink.add(`UPDATE cities SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  sink.close();

  printReport(reports, writes, dryRun);
}

function printReport(reports: PerCity[], writes: any[], dryRun: boolean) {
  console.log(`\n=== report (${dryRun ? 'DRY RUN' : 'APPLIED'}) ===`);
  for (const r of reports) {
    console.log(`\n${r.city} (${r.id})`);
    console.log(`  fixed (${r.fixed.length}): ${r.fixed.join(', ') || '—'}`);
    if (r.skippedAlreadyStable) console.log(`  already-stable kept: ${r.skippedAlreadyStable}`);
    if (r.unrecoverable.length) console.log(`  UNRECOVERABLE: ${r.unrecoverable.join('; ')}`);
  }
  const total = reports.reduce((a, r) => a + r.fixed.length, 0);
  const unrec = reports.reduce((a, r) => a + r.unrecoverable.length, 0);
  console.log(`\nTOTAL fixed sub-fields: ${total}; unrecoverable: ${unrec}; cities touched: ${writes.length}`);
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.stack : e);
  process.exit(1);
});
