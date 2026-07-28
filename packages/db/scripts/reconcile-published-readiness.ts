#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — retroactively apply the auto-publish readiness gate.
//
// WHY THIS EXISTS
// Between 2026-07-26 and 2026-07-28 the ingest's auto-publish leg ran without a
// readiness gate: it published any home present in the Snowflake available set that
// carried an image, regardless of construction stage or how far out its move-in date
// was. Published QMIs went 112 → 262, including graded pads and "Preliminary Plan
// Review" rows with move-in dates as far out as 2027-02-26.
//
// packages/ingest/src/diff.ts now gates the unattended path (isPublishReady). This
// script applies the SAME rule to the homes that were already published, so the
// live catalogue matches the rule going forward.
//
// A home is kept published when it is finished (READY_STAGES) or due inside
// PUBLISH_HORIZON_DAYS. Everything else is listed for unpublish.
//
// SAFETY
//   * Dry-run by default. --apply is required to write, and it prints the count and
//     the rule it used before doing so.
//   * Only ever sets published = 0, and only on rows that are currently 1.
//   * Refuses to run if it would unpublish more than --max-unpublish (default 200),
//     mirroring the ingest's mass-unpublish guard: a surprise of that size means the
//     rule or the data is wrong, not that 200 homes should vanish.
//   * Admin-published homes are NOT special-cased — there is no column recording who
//     published a row, which is why audit attribution was added alongside this. Review
//     the printed list before applying.
//
// USAGE (from packages/db):
//   npx tsx scripts/reconcile-published-readiness.ts [--local|--remote] [--apply]
//                                                    [--horizon-days=120] [--max-unpublish=200]
// Default mode is --local, dry-run. Always dry-run --remote and read the list first.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PUBLISH_HORIZON_DAYS,
  addDays,
  isPublishReady,
  todayIsoDate,
} from '../../ingest/src/availability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

const argv = process.argv.slice(2);
const mode: 'local' | 'remote' = argv.includes('--remote') ? 'remote' : 'local';
const apply = argv.includes('--apply');
const numArg = (name: string, dflt: number): number => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) ? n : dflt;
};
const horizonDays = numArg('horizon-days', PUBLISH_HORIZON_DAYS);
const maxUnpublish = numArg('max-unpublish', 200);

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
  return parsed?.[0]?.results ?? [];
}

interface Row {
  id: string;
  synced_address: string | null;
  synced_community_name: string | null;
  synced_construction_stage: string | null;
  effective_move_in: string | null;
}

const today = todayIsoDate();
const cutoff = addDays(today, horizonDays);

console.log(`Mode: ${mode} · ${apply ? 'APPLY' : 'dry-run'}`);
console.log(`Rule: keep published when stage is move-in-ready OR move-in <= ${cutoff} (today ${today} + ${horizonDays}d)\n`);

const rows = d1Json(
  `SELECT id, synced_address, synced_community_name, synced_construction_stage,
          COALESCE(override_move_in_date, synced_move_in_date) AS effective_move_in
     FROM qmi WHERE published = 1`
) as Row[];

const keep: Row[] = [];
const drop: Row[] = [];
for (const r of rows) {
  (isPublishReady(r.synced_construction_stage, r.effective_move_in, today, horizonDays) ? keep : drop).push(r);
}

console.log(`Published now: ${rows.length}`);
console.log(`  keep:      ${keep.length}`);
console.log(`  unpublish: ${drop.length}\n`);

// Grouped so a human can sanity-check the shape before trusting the list.
const byStage = new Map<string, number>();
for (const r of drop) {
  const k = r.synced_construction_stage ?? '(none)';
  byStage.set(k, (byStage.get(k) ?? 0) + 1);
}
console.log('Would unpublish, by construction stage:');
for (const [stage, n] of [...byStage].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${stage}`);
}

console.log('\nWould unpublish, detail:');
for (const r of drop.sort((a, b) => (a.effective_move_in ?? '').localeCompare(b.effective_move_in ?? ''))) {
  console.log(
    `  ${r.id}  ${(r.effective_move_in ?? 'no date').padEnd(12)} ${String(r.synced_construction_stage ?? '').padEnd(30)} ${r.synced_address ?? ''} (${r.synced_community_name ?? ''})`
  );
}

if (!apply) {
  console.log(`\nDry run — nothing written. Re-run with --apply to unpublish ${drop.length} home(s).`);
  process.exit(0);
}

if (drop.length > maxUnpublish) {
  console.error(
    `\nREFUSING: ${drop.length} unpublishes exceeds --max-unpublish=${maxUnpublish}. ` +
      `A change that large means the rule or the data is wrong. Re-check, then raise the cap deliberately.`
  );
  process.exit(1);
}

// Chunked so no single statement approaches D1's bound-parameter ceiling (~100).
const CHUNK = 50;
let written = 0;
for (let i = 0; i < drop.length; i += CHUNK) {
  const slice = drop.slice(i, i + CHUNK);
  const ids = slice.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(',');
  d1Json(
    `UPDATE qmi SET published = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE published = 1 AND id IN (${ids})`
  );
  // Attribution, matching the ingest's machine actor so the admin can explain the change.
  d1Json(
    `INSERT INTO audit_log (entity, entity_id, field, action, old_value, new_value, actor)
     SELECT 'qmi', id, 'published', 'unpublish', '1', '0', 'readiness-reconcile'
       FROM qmi WHERE id IN (${ids}) AND published = 0`
  );
  written += slice.length;
  console.log(`  applied ${written}/${drop.length}`);
}
console.log(`\nDone. Unpublished ${written} home(s). Purge the api cache so the site follows.`);
