// =============================================================================
// One-off: re-host QMI hero/og images that were NULLed by a prior cleanup.
//
// Source: Airtable QMI table fields `image_url` / `og_image_url` (string URLs on
// media.esperanzahomes.com — the upstream CDN). The original migrator treated
// media.esperanzahomes.com as "already stable" and passed the path through WITHOUT
// uploading to R2; a later cleanup NULLed those dead refs in D1.
//
// This downloads each source URL and uploads to R2 under the migrator's scheme
// qmi/<recId>/<file>, then UPSERTs the qmi.image_url / qmi.og_image_url column to
// the r2.dev public URL (matching the correctly-migrated featured_image scheme).
// Only image-url columns are written. Verifies each new URL returns 200.
//
// Reuses migrate-images.ts helpers: safeFilename, r2Key, publicUrl, the wrangler
// r2 object put upload path, buildUpsert. Does NOT use migrateImageUrl() directly
// because its isStableUrl() short-circuits any media.esperanzahomes.com source url
// (treats it as already-migrated) — here those ARE the sources we must pull from.
//
// USAGE (from packages/db):
//   CDN_BASE_URL=https://img.hazardhouse.ai \
//   AIRTABLE_PAT=... npx tsx scripts/rehost-qmi-images.mts [--remote|--local] [--dry-run]
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fetchAllRecords, TABLES } from './lib/airtable.js';
import { safeFilename, r2Key, publicUrl, DEFAULT_BUCKET } from './lib/r2.js';
import { buildUpsert } from './lib/d1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const MODE: 'remote' | 'local' = argv.includes('--local') ? 'local' : 'remote';
const BUCKET = DEFAULT_BUCKET;
const DB = 'esperanza';
const COLS = ['image_url', 'og_image_url'] as const;

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ?? 'file.bin';
  } catch {
    return 'file.bin';
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Download bytes from a URL with retry. Returns {buf, contentType} or null on hard 4xx. */
async function download(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const maxRetries = 4;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          await sleep(Math.min(2 ** attempt * 500, 8000));
          continue;
        }
        // hard failure (404 etc.) — source genuinely unavailable
        return null;
      }
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, contentType };
    } catch {
      if (attempt < maxRetries) {
        await sleep(Math.min(2 ** attempt * 500, 8000));
        continue;
      }
      return null;
    }
  }
}

function uploadToR2(key: string, buf: Buffer, contentType: string, filename: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'esp-rehost-'));
  const tmp = join(dir, filename);
  writeFileSync(tmp, buf);
  const args = [
    'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
    `--file=${tmp}`, '--content-type', contentType,
    MODE === 'remote' ? '--remote' : '--local',
  ];
  const maxRetries = 4;
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync('npx', args, { cwd: PKG_DB_DIR, stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
      return;
    } catch (e) {
      if (attempt < maxRetries) continue;
      throw new Error(`R2 put failed for ${key}: ${(e as Error).message}`);
    }
  }
}

function d1Json(command: string): any[] {
  const out = execFileSync('npx', [
    'wrangler', 'd1', 'execute', DB,
    MODE === 'remote' ? '--remote' : '--local', '--json', `--command=${command}`,
  ], { cwd: PKG_DB_DIR, env: process.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? parsed?.results ?? [];
}

function d1Exec(stmts: { sql: string; params: unknown[] }[]): void {
  if (stmts.length === 0) return;
  const render = (s: { sql: string; params: unknown[] }) => {
    let i = 0;
    const sql = s.sql.replace(/\?/g, () => {
      const v = s.params[i++];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
      return `'${String(v).replace(/'/g, "''")}'`;
    });
    return sql.endsWith(';') ? sql : sql + ';';
  };
  const dir = mkdtempSync(join(tmpdir(), 'esp-rehost-sql-'));
  const file = join(dir, 'batch.sql');
  writeFileSync(file, stmts.map(render).join('\n') + '\n', 'utf8');
  execFileSync('npx', [
    'wrangler', 'd1', 'execute', DB,
    MODE === 'remote' ? '--remote' : '--local', `--file=${file}`, '--yes',
  ], { cwd: PKG_DB_DIR, stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
}

async function main() {
  if (!process.env.AIRTABLE_PAT) throw new Error('AIRTABLE_PAT not set');
  console.log(`\n=== rehost qmi images === mode=${MODE} dryRun=${DRY} bucket=${BUCKET}`);
  console.log(`cdn base = ${publicUrl('').replace(/\/$/, '')}`);

  // 1. current D1 state: which qmi rows have NULL image_url / og_image_url
  const dbRows = d1Json(
    'SELECT id, image_url, og_image_url FROM qmi'
  );
  const isNull = new Map<string, { image_url: boolean; og_image_url: boolean }>();
  for (const r of dbRows) {
    isNull.set(String(r.id), {
      image_url: r.image_url === null || r.image_url === undefined,
      og_image_url: r.og_image_url === null || r.og_image_url === undefined,
    });
  }
  console.log(`D1 qmi rows: ${dbRows.length}`);

  // 2. Airtable source
  const recs = await fetchAllRecords(TABLES.qmi);
  console.log(`Airtable qmi records: ${recs.length}`);

  const stats = {
    rehosted: { image_url: 0, og_image_url: 0 },
    skippedNotNull: { image_url: 0, og_image_url: 0 },
    noSource: { image_url: 0, og_image_url: 0 },
    download404: [] as { id: string; col: string; url: string }[],
    rowsTouched: 0,
  };
  const newUrls: { id: string; col: string; url: string }[] = [];
  const upserts: { sql: string; params: unknown[] }[] = [];

  for (const r of recs) {
    const x = r.fields as Record<string, unknown>;
    const nullState = isNull.get(r.id);
    if (!nullState) continue; // not in D1 (shouldn't happen)
    const row: Record<string, unknown> = { id: r.id };

    for (const col of COLS) {
      const src = x[col];
      if (typeof src !== 'string' || !src.trim()) {
        if (nullState[col]) stats.noSource[col]++;
        continue;
      }
      if (!nullState[col]) { stats.skippedNotNull[col]++; continue; } // already populated in D1
      // download from upstream source
      const filename = safeFilename(deriveName(src), `${r.id}.bin`);
      const key = r2Key('qmi', r.id, filename);
      const stable = publicUrl(key);
      if (DRY) {
        console.log(`  [dry] ${r.id} ${col}: ${src}  ->  ${stable}`);
        row[col] = stable;
        stats.rehosted[col]++;
        newUrls.push({ id: r.id, col, url: stable });
        continue;
      }
      const dl = await download(src);
      if (!dl) {
        console.warn(`  !! ${r.id} ${col}: source download FAILED (404/err): ${src}`);
        stats.download404.push({ id: r.id, col, url: src });
        continue;
      }
      uploadToR2(key, dl.buf, dl.contentType, filename);
      row[col] = stable;
      stats.rehosted[col]++;
      newUrls.push({ id: r.id, col, url: stable });
    }

    if (Object.keys(row).length > 1) {
      upserts.push(buildUpsert('qmi', row));
      stats.rowsTouched++;
    }
  }

  if (!DRY && upserts.length) {
    console.log(`\nwriting ${upserts.length} qmi rows to D1 (${MODE}) …`);
    // chunk the upserts
    for (let i = 0; i < upserts.length; i += 100) d1Exec(upserts.slice(i, i + 100));
  }

  console.log('\n=== rehost stats ===');
  console.log(JSON.stringify(stats, null, 2));

  // 3. verify new URLs return 200
  if (!DRY && newUrls.length) {
    console.log(`\nverifying ${newUrls.length} new R2 URLs …`);
    let ok = 0; const bad: { url: string; code: string }[] = [];
    for (const { url } of newUrls) {
      const code = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', url], { encoding: 'utf8' }).trim();
      if (code === '200') ok++; else bad.push({ url, code });
    }
    console.log(`verified 200: ${ok}/${newUrls.length}`);
    if (bad.length) console.log('NON-200:', JSON.stringify(bad, null, 2));
  }

  // 4. final D1 count of qmi with a working image_url
  if (!DRY) {
    const after = d1Json(
      'SELECT SUM(CASE WHEN image_url IS NOT NULL THEN 1 ELSE 0 END) AS image_set, ' +
      'SUM(CASE WHEN og_image_url IS NOT NULL THEN 1 ELSE 0 END) AS og_set, COUNT(*) AS total FROM qmi'
    );
    console.log('\nFINAL D1 qmi:', JSON.stringify(after[0]));
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
