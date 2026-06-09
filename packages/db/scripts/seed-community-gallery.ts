#!/usr/bin/env -S npx tsx
// =============================================================================
// One-off: seed communities.photo_gallery_json from Airtable gallery attachments.
//
// For each community in D1, fetch the Airtable record, pull ALL attachment URLs
// from "Photo Gallery Image (Attachment)", migrate them to R2 (stable CDN urls),
// and write photo_gallery_json = JSON.stringify([url, url, ...]) to D1.
//
// Idempotent: if photo_gallery_json is already populated for a row (non-null,
// non-empty array), it is skipped — pass --force to overwrite anyway.
//
// Run from packages/db (wrangler.toml with DB + IMAGES bindings):
//   AIRTABLE_PAT=... CDN_BASE_URL=https://pub-...r2.dev \
//     npx tsx scripts/seed-community-gallery.ts --remote
//
// Flags:
//   --remote    write to production D1 (default: local)
//   --dry-run   print what would be written, no network writes
//   --force     overwrite even if photo_gallery_json already set
//   --bucket=X  R2 bucket name (default: esperanza-cms)
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BASE_ID, TABLES } from './lib/airtable.js';
const COMMUNITIES_TABLE = TABLES.communities;
import { migrateImageUrl, cdnBase, type MigrateOptions } from './lib/r2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');
const API = 'https://api.airtable.com/v0';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const mode: 'local' | 'remote' = argv.includes('--remote') ? 'remote' : 'local';
const dryRun = argv.includes('--dry-run');
const force = argv.includes('--force');
const bucketArg = argv.find((a) => a.startsWith('--bucket='));
const bucket = bucketArg ? bucketArg.split('=')[1] : 'esperanza-cms';

const PAT = process.env.AIRTABLE_PAT;
if (!PAT) { console.error('AIRTABLE_PAT env var required'); process.exit(1); }

console.log(`mode=${mode} dryRun=${dryRun} force=${force} bucket=${bucket} cdn=${cdnBase()}`);

// ---------------------------------------------------------------------------
// Airtable helpers
// ---------------------------------------------------------------------------
interface AttachmentField {
  id: string;
  url: string;
  filename: string;
  size?: number;
  type?: string;
}

interface CommunityRecord {
  id: string;
  fields: {
    'Photo Gallery Image (Attachment)'?: AttachmentField[];
    Name?: string;
  };
}

async function fetchAllCommunities(): Promise<CommunityRecord[]> {
  const records: CommunityRecord[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({
      fields: ['Photo Gallery Image (Attachment)', 'Name'].map((f) => `fields[]=${encodeURIComponent(f)}`).join('&'),
      pageSize: '100',
    });
    if (offset) params.set('offset', offset);
    const url = `${API}/${BASE_ID}/${encodeURIComponent(COMMUNITIES_TABLE)}?${params.toString().replace(/fields\[\]=/g, 'fields%5B%5D=').replace(/&fields%5B%5D=/g, '&fields%5B%5D=')}`;
    const res = await fetch(
      `${API}/${BASE_ID}/${encodeURIComponent(COMMUNITIES_TABLE)}?fields%5B%5D=${encodeURIComponent('Photo Gallery Image (Attachment)')}&fields%5B%5D=${encodeURIComponent('Name')}${offset ? `&offset=${offset}` : ''}&pageSize=100`,
      { headers: { Authorization: `Bearer ${PAT}` } }
    );
    if (!res.ok) throw new Error(`Airtable list failed: ${res.status} ${await res.text().catch(() => '')}`);
    const body = await res.json() as { records: CommunityRecord[]; offset?: string };
    records.push(...body.records);
    offset = body.offset;
  } while (offset);
  return records;
}

// ---------------------------------------------------------------------------
// D1 helpers (via wrangler exec)
// ---------------------------------------------------------------------------
function d1Query(sql: string): Array<Record<string, unknown>> {
  const args = [
    'wrangler', 'd1', 'execute', 'esperanza',
    mode === 'remote' ? '--remote' : '--local',
    '--json', '--command', sql,
  ];
  const out = execFileSync('npx', args, { cwd: PKG_DB_DIR, env: process.env }).toString();
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function d1Exec(sql: string): void {
  const args = [
    'wrangler', 'd1', 'execute', 'esperanza',
    mode === 'remote' ? '--remote' : '--local',
    '--command', sql,
  ];
  execFileSync('npx', args, { cwd: PKG_DB_DIR, env: process.env, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Fetch all community rows from D1 (just id + photo_gallery_json)
  const d1Rows = d1Query(`SELECT id, photo_gallery_json FROM communities`) as Array<{
    id: string;
    photo_gallery_json: string | null;
  }>;
  const d1Map = new Map(d1Rows.map((r) => [r.id, r.photo_gallery_json]));
  console.log(`D1: ${d1Map.size} community rows`);

  // Fetch all records from Airtable
  console.log('Fetching Airtable communities…');
  const atRecords = await fetchAllCommunities();
  console.log(`Airtable: ${atRecords.length} records`);

  const opts: MigrateOptions = { bucket, mode, cwd: PKG_DB_DIR, dryRun };

  let updated = 0;
  let skipped = 0;
  let noGallery = 0;
  let notInD1 = 0;

  for (const rec of atRecords) {
    const name = rec.fields['Name'] ?? rec.id;
    const existing = d1Map.get(rec.id);

    // Skip if already populated (unless --force)
    if (!force && existing) {
      try {
        const arr = JSON.parse(existing);
        if (Array.isArray(arr) && arr.length > 0) {
          skipped++;
          continue;
        }
      } catch { /* fall through */ }
    }

    if (!d1Map.has(rec.id)) {
      console.warn(`  SKIP ${rec.id} (${name}): not in D1`);
      notInD1++;
      continue;
    }

    const attachments = rec.fields['Photo Gallery Image (Attachment)'] ?? [];
    if (attachments.length === 0) {
      console.log(`  SKIP ${rec.id} (${name}): no gallery attachments`);
      noGallery++;
      continue;
    }

    console.log(`  ${rec.id} (${name}): migrating ${attachments.length} images…`);

    const stableUrls: string[] = [];
    for (const att of attachments) {
      try {
        const res = await migrateImageUrl('communities', rec.id, att.url, att.filename, opts);
        stableUrls.push(res.url);
        console.log(`    [${res.uploaded ? 'uploaded' : res.migrated ? 'migrated' : 'stable'}] ${att.filename} → ${res.url}`);
      } catch (err) {
        console.error(`    ERROR migrating ${att.filename}: ${err}`);
      }
    }

    if (stableUrls.length === 0) {
      console.warn(`  SKIP ${rec.id}: no stable urls after migration`);
      continue;
    }

    const json = JSON.stringify(stableUrls);
    if (dryRun) {
      console.log(`  DRY-RUN would set photo_gallery_json = ${json.slice(0, 120)}…`);
    } else {
      // Escape single quotes in the JSON (shouldn't occur in URLs but defensive)
      const escaped = json.replace(/'/g, "''");
      d1Exec(`UPDATE communities SET photo_gallery_json = '${escaped}' WHERE id = '${rec.id}'`);
      console.log(`  ✓ wrote ${stableUrls.length} urls`);
    }
    updated++;
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped} noGallery=${noGallery} notInD1=${notInD1}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
