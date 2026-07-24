#!/usr/bin/env -S npx tsx
// =============================================================================
// Set qmi.image_url from og_image_url when og matches the live-site hero but
// image_url does not (community QMI card parity vs www.esperanzahomes.com).
//
// Input: JSON from audit-community-qmi-heroes.mjs (--audit=path) OR pass --ids
// with a prior audit run.
//
// USAGE (from packages/db):
//   node scripts/audit-community-qmi-heroes.mjs > /tmp/audit.json
//   npx tsx scripts/apply-qmi-hero-live-parity.ts --remote --audit=/tmp/audit.json
//   npx tsx scripts/apply-qmi-hero-live-parity.ts --remote --dry-run --audit=...
// =============================================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, getMode } from './lib/cli.js';
import { D1Sink, type Stmt } from './lib/d1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

interface FixableRow {
  id: string;
  address?: string;
  community?: string;
  admin_match: string;
  d1_image_url?: string;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = getMode(args);
  const dryRun = args.flags.has('dry-run');
  const auditPath = args.values.get('audit');
  if (!auditPath) {
    console.error('Pass --audit=/path/to/audit.json from audit-community-qmi-heroes.mjs');
    process.exit(1);
  }

  const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as { fixable?: FixableRow[] };
  const fixable = audit.fixable ?? [];
  if (!fixable.length) {
    console.log('No fixable rows in audit.');
    return;
  }

  const sink = new D1Sink({ kind: 'wrangler', mode, cwd: PKG_DB_DIR, dryRun });
  let updated = 0;

  for (const row of fixable) {
    const hero = (row.admin_match ?? '').trim();
    if (!hero || !row.id) continue;
    const current = (row.d1_image_url ?? '').trim();
    if (current === hero) continue;

    const stmt: Stmt = {
      sql: `UPDATE qmi SET image_url = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?`,
      params: [hero, row.id],
    };
    sink.add(stmt.sql, stmt.params);
    updated++;
    console.log(`${dryRun ? '[dry-run] ' : ''}${row.community ?? ''} | ${row.address ?? row.id} → ${hero.split('/').pop()}`);
  }

  sink.flush();
  console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${updated} homes.`);
}

main();
