#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — Phase 2 verify step.
//
// Asserts the "Done when" conditions from Migration Plan v2 Phase 2:
//   1. Row counts in D1 match the Airtable record counts per entity.
//      (and surfaces the headline ~324 QMI / ~127 published expectation.)
//   2. override_price count == diverged-price count (rows where Airtable
//      Price != last_synced_price). Re-derives diverged from Airtable, compares
//      to COUNT(override_price IS NOT NULL) in D1.
//   3. ZERO airtableusercontent.com urls persisted in ANY text column of ANY table.
//
// Reads D1 via `wrangler d1 execute --json` and Airtable via the same paginating
// REST reader. Exit code 0 = all green; non-zero = at least one assertion failed.
//
// USAGE (from packages/db):
//   AIRTABLE_PAT=... npx tsx scripts/verify-import.ts [--local|--remote] [--dry-run]
//   --dry-run    : skip the Airtable count/divergence cross-checks (D1-only checks:
//                  the airtable-url scan + override==? structural check). Useful when
//                  the PAT is already revoked.
//
// Env: AIRTABLE_PAT (unless --dry-run), CDN_BASE_URL (optional, informational).
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchAllRecords, TABLES } from './lib/airtable.js';
import { num, findAirtableUrl } from './lib/coerce.js';
import { parseArgs, getMode, n } from './lib/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

const TABLE_OF: Record<string, keyof typeof TABLES> = {
  qmi: 'qmi',
  communities: 'communities',
  cities: 'cities',
  floor_plans: 'floorPlans',
  promotions: 'promotions',
  collections: 'collections',
  images: 'images',
  blogs: 'blogs',
  testimonials: 'testimonials',
};

let mode: 'local' | 'remote' = 'local';

function d1Json(command: string): any[] {
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'esperanza',
      mode === 'remote' ? '--remote' : '--local',
      '--json',
      `--command=${command}`,
    ],
    { cwd: PKG_DB_DIR, env: process.env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
  );
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? parsed?.results ?? [];
}

function d1Count(table: string, where = ''): number {
  const rows = d1Json(`SELECT COUNT(*) AS c FROM ${table}${where ? ' WHERE ' + where : ''}`);
  return Number(rows[0]?.c ?? 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mode = getMode(args);
  const skipAirtable = args.flags.has('dry-run');

  if (!skipAirtable && !process.env.AIRTABLE_PAT) {
    console.error('ERROR: AIRTABLE_PAT not set (needed unless --dry-run). Add to packages/db/.dev.vars.');
    process.exit(1);
  }

  console.log(`\n=== Phase 2 verify (D1 mode=${mode}) ===\n`);
  let failures = 0;
  const fail = (msg: string) => {
    console.error(`  ✗ ${msg}`);
    failures++;
  };
  const pass = (msg: string) => console.log(`  ✓ ${msg}`);

  // ── 1. counts match Airtable ─────────────────────────────────────────────────
  console.log('[1] Row counts (D1 vs Airtable)');
  for (const [table, key] of Object.entries(TABLE_OF)) {
    const d1c = d1Count(table);
    if (skipAirtable) {
      console.log(`    ${table}: D1=${n(d1c)} (Airtable check skipped)`);
      continue;
    }
    const at = await fetchAllRecords(TABLES[key]);
    if (d1c === at.length) pass(`${table}: ${n(d1c)} == Airtable ${n(at.length)}`);
    else fail(`${table}: D1=${n(d1c)} != Airtable=${n(at.length)} (delta ${d1c - at.length})`);
  }
  // headline QMI expectation (informational, not a hard fail — counts above are authoritative)
  const qmiTotal = d1Count('qmi');
  const qmiPub = d1Count('qmi', 'published = 1');
  console.log(`    QMI total=${qmiTotal} published=${qmiPub}  (plan headline: ~324 total / ~127 published)`);

  // ── 2. override_price count == diverged-price count ───────────────────────────
  console.log('\n[2] override_price == diverged Price (Price != last_synced_price)');
  const overrideCount = d1Count('qmi', 'override_price IS NOT NULL');
  if (skipAirtable) {
    // structural-only check: report the seeded override_price count. Attribution
    // (who/when) now lives in audit_log, not per-column override_price_at/_by
    // stamps (dropped for the D1 100-col limit), so there is no stamp to verify.
    pass(`override_price rows: ${overrideCount} (Airtable divergence check skipped)`);
  } else {
    const at = await fetchAllRecords(TABLES.qmi);
    let diverged = 0;
    for (const r of at) {
      const price = num(r.fields['Price']);
      const last = num(r.fields['last_synced_price']);
      if (price !== null && last !== null && Math.abs(price - last) >= 0.01) diverged++;
    }
    if (overrideCount === diverged)
      pass(`override_price count ${overrideCount} == diverged-price count ${diverged}`);
    else fail(`override_price count ${overrideCount} != diverged-price count ${diverged}`);
  }

  // ── 3. zero airtableusercontent urls persisted ────────────────────────────────
  console.log('\n[3] No airtableusercontent.com URL persisted in any column');
  let urlHits = 0;
  for (const table of Object.keys(TABLE_OF)) {
    // pull text columns via PRAGMA, scan each row
    const info = d1Json(`PRAGMA table_info(${table})`) as { name: string; type: string }[];
    const textCols = info.filter((c) => c.type === 'TEXT' || c.type === '').map((c) => c.name);
    if (textCols.length === 0) continue;
    const rows = d1Json(`SELECT ${['id', ...textCols].join(', ')} FROM ${table}`);
    for (const row of rows) {
      for (const [col, val] of Object.entries(row)) {
        if (col === 'id') continue;
        const hit = findAirtableUrl(val);
        if (hit) {
          fail(`${table}.${col} (id=${row.id}) -> ${hit}`);
          urlHits++;
        }
      }
    }
  }
  if (urlHits === 0) pass('zero airtableusercontent.com urls in D1');

  // ── verdict ────────────────────────────────────────────────────────────────────
  console.log(`\n=== Verdict: ${failures === 0 ? 'ALL GREEN ✓' : failures + ' FAILURE(S) ✗'} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
