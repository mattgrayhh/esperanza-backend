#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — Airtable→D1 COVERAGE AUDIT (one-off, read-only).
//
// verify-import.ts only checks row counts, override_price divergence, and that no
// airtableusercontent url leaked. It does NOT prove that descriptions / images /
// tags / copy actually made it into D1. This script does that, per entity:
//
//   1. Pull EVERY Airtable record (offset loop) and compute, per field NAME, how
//      many records carry a non-empty value (fill count + %).
//   2. Detect COVERAGE GAPS: Airtable fields that DO carry data but whose name is
//      never referenced in mappers.ts (i.e. the importer drops them entirely).
//   3. Query D1 (local|remote) for per-COLUMN non-empty counts.
//   4. Detect POPULATION GAPS: D1 columns that are 100% empty even though the row
//      count is non-zero (candidate import bugs — wrong field name / NULL-out).
//      override_* columns are NULL by design at import, so they are exempt.
//
// Emits a machine-readable JSON (default /tmp/esperanza-coverage-audit.json) plus a
// human summary to stdout. Read-only: no writes to Airtable or D1.
//
// USAGE (from packages/db, with AIRTABLE_PAT exported):
//   AIRTABLE_PAT=... npx tsx scripts/audit-coverage.ts [--remote|--local] [--out=PATH]
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetchAllRecords, TABLES, type EntityKey } from './lib/airtable.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

const TABLE_OF: Record<string, EntityKey> = {
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

let mode: 'local' | 'remote' = 'remote';

function d1Json(command: string): any[] {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'esperanza', mode === 'remote' ? '--remote' : '--local', '--json', `--command=${command}`],
    { cwd: PKG_DB_DIR, env: process.env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
  );
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? parsed?.results ?? [];
}

/** non-empty for an Airtable cell value */
function nonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true; // numbers, booleans
}

function sampleType(v: unknown): string {
  if (Array.isArray(v)) {
    const first = v[0];
    if (first && typeof first === 'object' && 'url' in (first as object)) return 'attachment[]';
    if (typeof first === 'string' && (first as string).startsWith('rec')) return 'link[]';
    return `array(${typeof first})[]`;
  }
  if (typeof v === 'object' && v !== null) return 'object';
  return typeof v;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--local')) mode = 'local';
  if (argv.includes('--remote')) mode = 'remote';
  const outArg = argv.find((a) => a.startsWith('--out='));
  const outPath = outArg ? outArg.slice('--out='.length) : '/tmp/esperanza-coverage-audit.json';

  if (!process.env.AIRTABLE_PAT) {
    console.error('ERROR: AIRTABLE_PAT not set. Export it or add it to packages/db/.dev.vars.');
    process.exit(1);
  }

  const mapperSrc = readFileSync(join(__dirname, 'lib', 'mappers.ts'), 'utf8');
  const referenced = (fieldName: string): boolean => {
    // mappers.ts indexes Airtable fields as x['Field Name'] / x["Field Name"].
    return (
      mapperSrc.includes(`'${fieldName}'`) ||
      mapperSrc.includes(`"${fieldName}"`) ||
      mapperSrc.includes(`\`${fieldName}\``)
    );
  };

  const report: Record<string, any> = { mode, generatedFor: 'esperanza coverage audit', tables: {} };

  console.log(`\n=== Airtable→D1 COVERAGE AUDIT (D1 mode=${mode}) ===\n`);

  for (const [table, key] of Object.entries(TABLE_OF)) {
    process.stdout.write(`• ${table}: fetching Airtable … `);
    const recs = await fetchAllRecords(TABLES[key]);
    // per-field fill stats
    const fill: Record<string, { count: number; type: string }> = {};
    for (const r of recs) {
      for (const [fname, val] of Object.entries(r.fields)) {
        if (!fill[fname]) fill[fname] = { count: 0, type: sampleType(val) };
        if (nonEmpty(val)) fill[fname].count++;
      }
    }
    const at = recs.length;
    const airtableFields = Object.entries(fill)
      .map(([name, s]) => ({ name, count: s.count, pct: at ? Math.round((s.count / at) * 100) : 0, type: s.type }))
      .sort((a, b) => b.count - a.count);

    // coverage gaps: Airtable fields with data NOT referenced by mappers.ts
    const coverageGaps = airtableFields.filter((f) => f.count > 0 && !referenced(f.name));

    // D1 per-column non-empty
    process.stdout.write(`D1 … `);
    const info = d1Json(`PRAGMA table_info(${table})`) as { name: string; type: string }[];
    const cols = info.map((c) => c.name).filter((c) => !['created_at', 'updated_at'].includes(c));
    const aggs = cols
      .map((c) => `SUM(CASE WHEN "${c}" IS NOT NULL AND TRIM(CAST("${c}" AS TEXT)) NOT IN ('','[]','{}') THEN 1 ELSE 0 END) AS "${c}"`)
      .join(', ');
    const d1rows = d1Json(`SELECT COUNT(*) AS __total, ${aggs} FROM ${table}`);
    const d1row = d1rows[0] ?? {};
    const d1Total = Number(d1row.__total ?? 0);
    const d1Cols = cols
      .map((c) => ({ name: c, count: Number(d1row[c] ?? 0), pct: d1Total ? Math.round((Number(d1row[c] ?? 0) / d1Total) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

    // population gaps: D1 columns 100% empty (rowcount>0), excluding intentionally-NULL buckets
    const exemptEmpty = (c: string) => c.startsWith('override_') || c === 'custom_fields' || c === 'id';
    const populationGaps = d1Cols.filter((c) => c.count === 0 && d1Total > 0 && !exemptEmpty(c.name));

    report.tables[table] = {
      airtableRecords: at,
      d1Rows: d1Total,
      countMatch: at === d1Total,
      coverageGaps,
      populationGaps,
      airtableFields,
      d1Cols,
    };

    console.log(
      `AT=${at} D1=${d1Total} ${at === d1Total ? '✓' : '✗ MISMATCH'}  | coverageGaps=${coverageGaps.length} populationGaps=${populationGaps.length}`
    );
    if (coverageGaps.length)
      console.log(
        `    ⚠ unmapped Airtable fields with data: ` +
          coverageGaps.map((g) => `${g.name}(${g.count}/${at},${g.type})`).join(', ')
      );
    if (populationGaps.length)
      console.log(`    ⚠ D1 columns 100% empty: ` + populationGaps.map((g) => g.name).join(', '));
  }

  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report → ${outPath}\n`);
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
