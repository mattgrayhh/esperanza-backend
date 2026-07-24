#!/usr/bin/env -S npx tsx
// =============================================================================
// CLI: authenticated purge of /api/public/* edge cache (same as admin postWrite).
//
// USAGE (from packages/db, with secrets in env or packages/admin/.dev.vars):
//   export $(grep -E '^(PURGE_KEY|API_PUBLIC_URL|FRONTEND_PUBLIC_URL)=' ../admin/.dev.vars | xargs)
//   npx tsx scripts/purge-public-cache.ts --entity=qmi
// =============================================================================
import { parseArgs } from './lib/cli.js';
import { purgeAfterRemoteD1Write } from './lib/purge-public-cache-cli.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entity = args.values.get('entity') ?? 'qmi';
  const ok = await purgeAfterRemoteD1Write(entity, { reason: 'manual CLI' });
  if (!ok) process.exitCode = 1;
  else console.log('[purge] done');
}

main();
