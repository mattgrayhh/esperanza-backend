#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — PDF platform Task 1.12: derive-renditions.
//
// For each source image in the R2 bucket under the floor-plan and community
// image prefixes, generate -w1200 and -w2000 JPEG variants via sharp and upload
// them so the brochure templates can embed web-optimised images.
//
// This is the 35 MB → <5 MB lever described in the PDF platform design.
//
// LISTING: uses the Cloudflare R2 S3-compatible ListObjectsV2 XML API.
// DOWNLOAD: `wrangler r2 object get <bucket>/<key> --pipe` → stdout → sharp.
// UPLOAD: `wrangler r2 object put <bucket>/<key> --file=<tmp>` (same pattern as
//         packages/db/scripts/lib/r2.ts).
//
// Required env vars for remote operation:
//   CLOUDFLARE_ACCOUNT_ID  — your CF account (used for the S3-compat endpoint)
//   R2_ACCESS_KEY_ID       — R2 API token access-key-id (S3-compat)
//   R2_SECRET_ACCESS_KEY   — R2 API token secret (S3-compat)
//
// USAGE (from packages/pdf):
//   npx tsx scripts/derive-renditions.ts [options]
//   --local | --remote          target R2 (default local)
//   --dry-run                   list what WOULD be produced; no downloads/uploads
//   --prefix=floor_plans/       process only this R2 prefix (repeatable or comma-sep)
//   --bucket=esperanza-cms      override bucket name (default esperanza-cms)
//
// Default prefixes (image keys the PDF templates reference):
//   floor_plans/   — floor-plan images (cover + elevations + gallery)
//   communities/   — community images (featured, gallery, logo)
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { parseArgs, getMode, n, bytesHuman } from '../../db/scripts/lib/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Run wrangler from packages/pdf (has the IMAGES r2_bucket binding in wrangler.toml).
const PKG_PDF_DIR = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_BUCKET = 'esperanza-cms';
const DEFAULT_PREFIXES = ['floor_plans/', 'communities/'];
const VARIANTS: Array<{ name: 'w1200' | 'w2000'; width: number }> = [
  { name: 'w1200', width: 1200 },
  { name: 'w2000', width: 2000 },
];

/** Regex to detect keys that are already a rendition (skip them as sources). */
const RENDITION_RE = /-w(1200|2000)\.[a-z]+$/i;

/** Detect existing rendition variant suffix in a key. */
function isRendition(key: string): boolean {
  return RENDITION_RE.test(key);
}

/** Build the rendition key for a source key + variant. */
function renditionKey(sourceKey: string, variant: 'w1200' | 'w2000'): string {
  return sourceKey.replace(/(\.[a-z]+)$/i, `-${variant}$1`);
}

// ---------------------------------------------------------------------------
// S3-compatible list (Cloudflare R2)
// ---------------------------------------------------------------------------

/** Minimal parsed S3 list object. */
interface S3Object {
  key: string;
  size: number;
}

/**
 * Build an AWS Signature V4 signed URL for the R2 S3-compat ListObjectsV2.
 * Uses only stdlib — no aws-sdk dep — to stay consistent with the rest of the
 * scripts which avoid heavy deps.
 */
import { createHmac, createHash } from 'node:crypto';

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function deriveSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

interface ListR2Opts {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
}

async function listR2Objects(opts: ListR2Opts): Promise<S3Object[]> {
  const endpoint = `https://${opts.accountId}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';

  const objects: S3Object[] = [];
  let continuationToken: string | null = null;

  do {
    const url = new URL(`${endpoint}/${opts.bucket}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', opts.prefix);
    url.searchParams.set('max-keys', '1000');
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

    // Sort query params for canonical request.
    const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const canonicalQueryString = sortedParams
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateStamp = amzDate.slice(0, 8);
    const host = `${opts.accountId}.r2.cloudflarestorage.com`;

    const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-date';
    const payloadHash = sha256Hex('');
    const canonicalUri = `/${opts.bucket}/`;

    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = deriveSigningKey(opts.secretAccessKey, dateStamp, region, service);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // Use the URL with sorted params for the actual fetch.
    const fetchUrl = `${endpoint}/${opts.bucket}/?${canonicalQueryString}`;

    const res = await fetch(fetchUrl, {
      headers: {
        'x-amz-date': amzDate,
        Authorization: authHeader,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`R2 ListObjectsV2 failed ${res.status}: ${body.slice(0, 400)}`);
    }

    const xml = await res.text();

    // Parse keys + sizes from the XML (minimal parser — no deps).
    const keyMatches = xml.matchAll(/<Key>([^<]+)<\/Key>/g);
    const sizeMatches = xml.matchAll(/<Size>([^<]+)<\/Size>/g);
    const keys = [...keyMatches].map((m) => m[1] ?? '');
    const sizes = [...sizeMatches].map((m) => Number(m[1] ?? '0'));
    for (let i = 0; i < keys.length; i++) {
      objects.push({ key: keys[i] ?? '', size: sizes[i] ?? 0 });
    }

    const nextToken = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
    continuationToken = nextToken ?? null;
  } while (continuationToken);

  return objects;
}

// ---------------------------------------------------------------------------
// Download via wrangler r2 object get --pipe
// ---------------------------------------------------------------------------
function downloadR2Object(bucket: string, key: string, mode: 'local' | 'remote'): Buffer {
  const result = spawnSync(
    'npx',
    [
      'wrangler',
      'r2',
      'object',
      'get',
      `${bucket}/${key}`,
      '--pipe',
      mode === 'remote' ? '--remote' : '--local',
    ],
    { cwd: PKG_PDF_DIR, env: process.env, maxBuffer: 50 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    const err = result.stderr?.toString() ?? '';
    throw new Error(`wrangler r2 get failed for ${key}: ${err.slice(0, 200)}`);
  }
  return result.stdout as Buffer;
}

// ---------------------------------------------------------------------------
// Upload via wrangler r2 object put (mirrors packages/db/scripts/lib/r2.ts)
// ---------------------------------------------------------------------------
function uploadR2Object(
  bucket: string,
  key: string,
  buf: Buffer,
  mode: 'local' | 'remote'
): void {
  const dir = mkdtempSync(join(tmpdir(), 'esp-rendition-'));
  const tmp = join(dir, 'rendition.jpg');
  writeFileSync(tmp, buf);
  try {
    execFileSync(
      'npx',
      [
        'wrangler',
        'r2',
        'object',
        'put',
        `${bucket}/${key}`,
        `--file=${tmp}`,
        '--content-type',
        'image/jpeg',
        mode === 'remote' ? '--remote' : '--local',
      ],
      { cwd: PKG_PDF_DIR, stdio: ['ignore', 'inherit', 'inherit'], env: process.env }
    );
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Check whether a rendition key already exists (via wrangler get, exit 0 = exists)
// ---------------------------------------------------------------------------
function renditionExists(bucket: string, key: string, mode: 'local' | 'remote'): boolean {
  const result = spawnSync(
    'npx',
    [
      'wrangler',
      'r2',
      'object',
      'get',
      `${bucket}/${key}`,
      '--pipe',
      mode === 'remote' ? '--remote' : '--local',
    ],
    { cwd: PKG_PDF_DIR, env: process.env, maxBuffer: 64 * 1024 }
  );
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Process one source image → produce renditions
// ---------------------------------------------------------------------------
interface RenditionResult {
  sourceKey: string;
  variant: 'w1200' | 'w2000';
  action: 'uploaded' | 'skipped_exists' | 'dry_run' | 'error';
  bytes?: number;
  error?: string;
}

async function processSourceKey(
  bucket: string,
  sourceKey: string,
  mode: 'local' | 'remote',
  dryRun: boolean
): Promise<RenditionResult[]> {
  const results: RenditionResult[] = [];

  for (const variant of VARIANTS) {
    const destKey = renditionKey(sourceKey, variant.name);

    if (dryRun) {
      results.push({ sourceKey, variant: variant.name, action: 'dry_run' });
      continue;
    }

    // Skip if rendition already exists.
    if (renditionExists(bucket, destKey, mode)) {
      results.push({ sourceKey, variant: variant.name, action: 'skipped_exists' });
      continue;
    }

    try {
      // Download source.
      const srcBuf = downloadR2Object(bucket, sourceKey, mode);

      // Resize + JPEG encode via sharp.
      const outBuf = await sharp(srcBuf)
        .resize({ width: variant.width, withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();

      // Upload rendition.
      uploadR2Object(bucket, destKey, outBuf, mode);

      results.push({ sourceKey, variant: variant.name, action: 'uploaded', bytes: outBuf.length });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`  ERROR ${sourceKey} ${variant.name}: ${error}`);
      results.push({ sourceKey, variant: variant.name, action: 'error', error });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = getMode(args);
  const dryRun = args.flags.has('dry-run');
  const bucket = args.values.get('bucket') ?? DEFAULT_BUCKET;

  // --prefix may be given multiple times (but parseArgs handles =val form only;
  // collect comma-sep too for convenience).
  const rawPrefix = args.values.get('prefix');
  const prefixes = rawPrefix
    ? rawPrefix.split(',').map((p) => p.trim()).filter(Boolean)
    : DEFAULT_PREFIXES;

  // For remote listing, require Cloudflare credentials.
  const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'] ?? '';
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'] ?? '';
  if (mode === 'remote' && (!accountId || !accessKeyId || !secretAccessKey)) {
    console.error(
      'ERROR: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set for --remote mode.'
    );
    process.exit(1);
  }

  console.log(`\n=== derive-renditions ===`);
  console.log(`mode=${mode} bucket=${bucket} dryRun=${dryRun}`);
  console.log(`prefixes: ${prefixes.join(', ')}\n`);

  // Summary counters.
  let totalSources = 0;
  let totalUploaded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalBytes = 0;

  for (const prefix of prefixes) {
    console.log(`Listing ${bucket}/${prefix}...`);

    let sourceKeys: string[];
    if (mode === 'remote') {
      const objects = await listR2Objects({ accountId, accessKeyId, secretAccessKey, bucket, prefix });
      sourceKeys = objects
        .map((o) => o.key)
        .filter((k) => !isRendition(k) && /\.(jpe?g|png|webp|gif|tiff?)$/i.test(k));
    } else {
      // For local mode: use wrangler d1 execute isn't relevant here.
      // We can't list local R2 via wrangler; fall back to a note and skip.
      console.warn(
        `  NOTE: listing local R2 objects requires Cloudflare credentials even for local mode.\n` +
        `  Set CLOUDFLARE_ACCOUNT_ID + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY to enable listing,\n` +
        `  or use --remote to target the live bucket.\n` +
        `  Skipping prefix ${prefix} in local mode.`
      );
      continue;
    }

    console.log(`  found ${n(sourceKeys.length)} source images (non-rendition)`);
    totalSources += sourceKeys.length;

    for (let i = 0; i < sourceKeys.length; i++) {
      const key = sourceKeys[i];
      if (!key) continue;
      if (i % 25 === 0 || i === sourceKeys.length - 1) {
        process.stdout.write(`\r  processing ${i + 1}/${sourceKeys.length}...`);
      }

      const results = await processSourceKey(bucket, key, mode, dryRun);
      for (const r of results) {
        if (r.action === 'uploaded') {
          totalUploaded++;
          totalBytes += r.bytes ?? 0;
        } else if (r.action === 'skipped_exists') {
          totalSkipped++;
        } else if (r.action === 'error') {
          totalErrors++;
        }
      }
    }
    console.log('');
  }

  console.log(`\n=== Summary (${dryRun ? 'DRY RUN' : mode}) ===`);
  console.log(`source images found : ${n(totalSources)}`);
  console.log(`renditions uploaded : ${n(totalUploaded)} (${bytesHuman(totalBytes)})`);
  console.log(`already existed     : ${n(totalSkipped)}`);
  console.log(`errors              : ${n(totalErrors)}`);
  console.log('\nDone.');

  if (totalErrors > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
