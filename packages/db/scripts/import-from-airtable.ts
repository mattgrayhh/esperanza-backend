#!/usr/bin/env -S npx tsx
// =============================================================================
// esperanza-cf — Phase 2: Airtable → D1 importer.
//
// Paginates EVERY record (offset loop, past the 94 cap; NOT MCP) for base
// app2WqQR75HFBQp73, maps each field into its bucketed D1 column, resolves
// QMI/Testimonial/Community links via Airtable LINKED-RECORD IDs (logging
// unresolved), seeds override_price ONLY where Price != last_synced_price,
// translates the legacy Promotions link-soup into promotion_targets rows, and
// upserts (idempotent on id) into D1 via `wrangler d1 execute`.
//
// Image handling: by DEFAULT this importer also migrates images inline (the same
// pass migrate-images.ts runs) so a row is never written carrying an expiring
// airtableusercontent url. Use --skip-images to NULL unmigrated image fields and
// run migrate-images.ts separately afterwards.
//
// USAGE (from packages/db):
//   AIRTABLE_PAT=... npx tsx scripts/import-from-airtable.ts [options]
//
//   --local            write to local D1 (default)
//   --remote           write to remote (edge) D1
//   --dry-run          fetch + map + (would-)migrate, print plan, write NOTHING
//   --skip-images      do not migrate images inline; NULL any unmigrated signed
//                      urls (migrate-images.ts fills them later)
//   --only=qmi,communities   import only these entities (comma list)
//   --sink=wrangler|sqlite   write path (default wrangler). sqlite needs --sqlite-path
//   --sqlite-path=PATH       throwaway .sqlite for sink=sqlite / verification
//   --chunk=200              statements per wrangler --file batch
//   --bucket=esperanza-cms   R2 bucket name
//
// Env: AIRTABLE_PAT (required), CDN_BASE_URL (optional, defaults media.esperanzahomes.com).
// NEVER hardcodes secrets.
// =============================================================================

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchAllRecords, TABLES, type EntityKey, type AirtableRecord } from './lib/airtable.js';
import {
  mapQmi,
  mapCommunity,
  mapCity,
  mapFloorPlan,
  mapPromotion,
  mapCollection,
  mapImage,
  mapBlog,
  mapTestimonial,
} from './lib/mappers.js';
import { D1Sink, buildUpsert, type SinkOptions } from './lib/d1.js';
import { resolveRowImages, stripUnmigratedImages } from './lib/images.js';
import { findAirtableUrl } from './lib/coerce.js';
import { parseArgs, getMode, n, bytesHuman } from './lib/cli.js';
import type { MigrateOptions } from './lib/r2.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DB_DIR = join(__dirname, '..'); // packages/db — has wrangler.toml with DB + IMAGES bindings

const IMPORT_TS = new Date().toISOString();

interface Counters {
  fetched: Record<string, number>;
  written: Record<string, number>;
  publishedQmi: number;
  overridePriceSeeded: number;
  divergedPrices: number;
  unresolvedLinks: { entity: string; id: string; field: string; targetId: string }[];
  promotionTargets: number;
  imagesUploaded: number;
  imageBytes: number;
  guardViolations: { table: string; id: string; hit: string }[];
}

function newCounters(): Counters {
  return {
    fetched: {},
    written: {},
    publishedQmi: 0,
    overridePriceSeeded: 0,
    divergedPrices: 0,
    unresolvedLinks: [],
    promotionTargets: 0,
    imagesUploaded: 0,
    imageBytes: 0,
    guardViolations: [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.flags.has('dry-run');
  const skipImages = args.flags.has('skip-images');
  const mode = getMode(args);
  const sinkKind = (args.values.get('sink') as 'wrangler' | 'sqlite') ?? 'wrangler';
  const chunk = Number(args.values.get('chunk') ?? 200);
  const bucket = args.values.get('bucket') ?? 'esperanza-cms';
  const only = (args.values.get('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const wants = (e: string) => only.length === 0 || only.includes(e);

  // PAT presence (read lazily by airtable.ts, but fail early with a clear msg)
  if (!process.env.AIRTABLE_PAT) {
    console.error('ERROR: AIRTABLE_PAT is not set. Export it or add it to packages/db/.dev.vars.');
    process.exit(1);
  }

  console.log(`\n=== Airtable → D1 import ===`);
  console.log(`mode=${mode} sink=${sinkKind} dryRun=${dryRun} skipImages=${skipImages}`);
  console.log(`base=app2WqQR75HFBQp73  cdn=${process.env.CDN_BASE_URL ?? 'media.esperanzahomes.com'}\n`);

  const c = newCounters();

  const sinkOpts: SinkOptions = {
    kind: sinkKind,
    mode,
    cwd: PKG_DB_DIR,
    dbName: 'esperanza',
    dryRun,
    sqlitePath: args.values.get('sqlite-path'),
  };
  const sink = new D1Sink(sinkOpts);

  const imgOpts: MigrateOptions = { bucket, mode, cwd: PKG_DB_DIR, dryRun };

  // ── fetch everything (offset loop) ───────────────────────────────────────────
  const raw: Partial<Record<EntityKey, AirtableRecord[]>> = {};
  const fetchOne = async (key: EntityKey, label: string) => {
    process.stdout.write(`fetching ${label} … `);
    const recs = await fetchAllRecords(TABLES[key], {
      onPage: (_p, total) => process.stdout.write(`\rfetching ${label} … ${total}`),
    });
    raw[key] = recs;
    c.fetched[label] = recs.length;
    console.log(`\rfetching ${label} … ${recs.length} records ✓        `);
  };

  // order: dimension tables first so link validation can see them
  const order: [EntityKey, string][] = [
    ['cities', 'cities'],
    ['communities', 'communities'],
    ['floorPlans', 'floor_plans'],
    ['promotions', 'promotions'],
    ['collections', 'collections'],
    ['images', 'images'],
    ['blogs', 'blogs'],
    ['testimonials', 'testimonials'],
    ['qmi', 'qmi'],
  ];
  for (const [key, label] of order) {
    if (!wants(label)) continue;
    await fetchOne(key, label);
  }

  // known-id sets for link resolution
  const cityIds = new Set((raw.cities ?? []).map((r) => r.id));
  const communityIds = new Set((raw.communities ?? []).map((r) => r.id));
  const floorPlanIds = new Set((raw.floorPlans ?? []).map((r) => r.id));

  // ── helper to write one mapped row (images pass + guard + upsert) ────────────
  const writeRow = async (table: string, id: string, row: Record<string, unknown>) => {
    if (!skipImages) {
      const st = await resolveRowImages(table, id, row, imgOpts);
      c.imagesUploaded += st.uploaded;
      c.imageBytes += st.bytes;
    } else {
      stripUnmigratedImages(table, row);
    }

    // HARD GUARD: never persist a forbidden url
    const hit = findAirtableUrl(row);
    if (hit) {
      c.guardViolations.push({ table, id, hit });
      // null out the offending columns so the rest of the row still imports clean
      for (const [k, v] of Object.entries(row)) {
        if (findAirtableUrl(v)) row[k] = null;
      }
    }
    const up = buildUpsert(table, row);
    sink.add(up.sql, up.params);
    c.written[table] = (c.written[table] ?? 0) + 1;
  };

  // ── CITIES ────────────────────────────────────────────────────────────────────
  if (wants('cities')) for (const r of raw.cities!) await writeRow('cities', r.id, mapCity(r));

  // ── COMMUNITIES (validate City link) ───────────────────────────────────────────
  if (wants('communities'))
    for (const r of raw.communities!) {
      const { row, cityId } = mapCommunity(r);
      if (cityId && cityIds.size && !cityIds.has(cityId))
        c.unresolvedLinks.push({ entity: 'communities', id: r.id, field: 'city_id', targetId: cityId });
      await writeRow('communities', r.id, row);
    }

  // ── FLOOR PLANS ─────────────────────────────────────────────────────────────────
  if (wants('floor_plans')) for (const r of raw.floorPlans!) await writeRow('floor_plans', r.id, mapFloorPlan(r));

  // ── PROMOTIONS + promotion_targets translation ──────────────────────────────────
  if (wants('promotions'))
    for (const r of raw.promotions!) {
      const { row, communityIds: cids, floorPlanIds: fpids, collectionIds, appliesTo } = mapPromotion(r);
      await writeRow('promotions', r.id, row);

      // Translate legacy link-soup → promotion_targets. ASSUMPTIONS (documented):
      //  * Community links            -> target_type='community', target_id=<communityId>
      //  * Floor Plan links           -> target_type='qmi' is WRONG (FP != QMI); the new
      //    model has no 'floorplan' scope, so FP-targeted promos are recorded as the
      //    set of QMIs on that floor plan IS NOT known here → we instead emit NO target
      //    for floor-plan-only promos and LOG them for manual review (collection links too).
      //  * No links at all + Applies To 'Sitewide' (or empty) -> target_type='global'.
      // Rebuild targets idempotently: delete this promo's existing targets, re-insert.
      sink.add(`DELETE FROM promotion_targets WHERE promotion_id = ?`, [r.id]);

      const targets: { type: string; id: string | null }[] = [];
      for (const cid of cids) {
        if (communityIds.size && !communityIds.has(cid))
          c.unresolvedLinks.push({ entity: 'promotions', id: r.id, field: 'community', targetId: cid });
        targets.push({ type: 'community', id: cid });
      }
      // Floor-plan / collection links have no direct scope in the new model → review.
      for (const fp of fpids)
        c.unresolvedLinks.push({ entity: 'promotions', id: r.id, field: 'floor_plan(no-scope)', targetId: fp });
      for (const col of collectionIds)
        c.unresolvedLinks.push({ entity: 'promotions', id: r.id, field: 'collection(no-scope)', targetId: col });

      // global iff there were NO usable targets and it's sitewide/empty
      if (targets.length === 0 && (!appliesTo || /sitewide/i.test(appliesTo))) {
        targets.push({ type: 'global', id: null });
      }

      for (const t of targets) {
        sink.add(
          `INSERT INTO promotion_targets (promotion_id, target_type, target_id) VALUES (?, ?, ?) ` +
            `ON CONFLICT(promotion_id, target_type, target_id) DO NOTHING`,
          [r.id, t.type, t.id]
        );
        c.promotionTargets++;
      }
    }

  // ── COLLECTIONS / IMAGES / BLOGS ────────────────────────────────────────────────
  if (wants('collections')) for (const r of raw.collections!) await writeRow('collections', r.id, mapCollection(r));
  if (wants('images')) for (const r of raw.images!) await writeRow('images', r.id, mapImage(r));
  if (wants('blogs')) for (const r of raw.blogs!) await writeRow('blogs', r.id, mapBlog(r));

  // ── TESTIMONIALS (validate FP + Community links) ─────────────────────────────────
  if (wants('testimonials'))
    for (const r of raw.testimonials!) {
      const { row, floorPlanId, communityId } = mapTestimonial(r);
      if (floorPlanId && floorPlanIds.size && !floorPlanIds.has(floorPlanId))
        c.unresolvedLinks.push({ entity: 'testimonials', id: r.id, field: 'floor_plan_id', targetId: floorPlanId });
      if (communityId && communityIds.size && !communityIds.has(communityId))
        c.unresolvedLinks.push({ entity: 'testimonials', id: r.id, field: 'community_id', targetId: communityId });
      await writeRow('testimonials', r.id, row);
    }

  // ── QMI (validate City/Community/FloorPlan links; price-override accounting) ──────
  if (wants('qmi'))
    for (const r of raw.qmi!) {
      const { row, links, price, lastSyncedPrice } = mapQmi(r);
      if (price !== null && lastSyncedPrice !== null && Math.abs(price - lastSyncedPrice) >= 0.01) {
        c.divergedPrices++;
        c.overridePriceSeeded++;
      }
      if (row.published === 1) c.publishedQmi++;
      if (links.city && cityIds.size && !cityIds.has(links.city))
        c.unresolvedLinks.push({ entity: 'qmi', id: r.id, field: 'synced_city_id', targetId: links.city });
      if (links.community && communityIds.size && !communityIds.has(links.community))
        c.unresolvedLinks.push({ entity: 'qmi', id: r.id, field: 'synced_community_id', targetId: links.community });
      if (links.floorPlan && floorPlanIds.size && !floorPlanIds.has(links.floorPlan))
        c.unresolvedLinks.push({ entity: 'qmi', id: r.id, field: 'synced_floor_plan_id', targetId: links.floorPlan });
      await writeRow('qmi', r.id, row);
    }

  // ── flush + sync_log ─────────────────────────────────────────────────────────────
  sink.flush(chunk);

  // write a sync_log telemetry row (skip in dry-run)
  if (!dryRun) {
    const notesObj = {
      fetched: c.fetched,
      written: c.written,
      overridePriceSeeded: c.overridePriceSeeded,
      promotionTargets: c.promotionTargets,
      imagesUploaded: c.imagesUploaded,
      skipImages,
    };
    sink.add(
      `INSERT INTO sync_log (run_id, source, status, started_at, finished_at, qmis_created, qmis_unpublished, prices_updated, prices_skipped_override, unresolved_links, notes) ` +
        `VALUES (?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `import-${IMPORT_TS}`,
        c.guardViolations.length ? 'partial' : 'success',
        IMPORT_TS,
        new Date().toISOString(),
        c.written.qmi ?? 0,
        c.publishedQmi,
        c.overridePriceSeeded,
        0,
        c.unresolvedLinks.length,
        JSON.stringify(notesObj),
      ]
    );
    sink.flush(chunk);
  }

  sink.close();

  // ── report ───────────────────────────────────────────────────────────────────────
  console.log(`\n=== Import summary (${dryRun ? 'DRY RUN — nothing written' : mode} ) ===`);
  console.log('fetched:', c.fetched);
  console.log('written:', dryRun ? '(planned) ' + JSON.stringify(c.written) : c.written);
  console.log(`statements ${dryRun ? 'planned' : 'executed'}: ${n(sink.executed)}`);
  console.log(`QMI published (live): ${c.publishedQmi}`);
  console.log(`override_price seeded (diverged prices): ${c.overridePriceSeeded} (== diverged ${c.divergedPrices})`);
  console.log(`promotion_targets rows: ${c.promotionTargets}`);
  console.log(`images uploaded: ${c.imagesUploaded} (${bytesHuman(c.imageBytes)})${skipImages ? ' [skip-images: stripped unmigrated]' : ''}`);
  console.log(`unresolved links: ${c.unresolvedLinks.length}`);
  if (c.unresolvedLinks.length) {
    const byField: Record<string, number> = {};
    for (const u of c.unresolvedLinks) byField[`${u.entity}.${u.field}`] = (byField[`${u.entity}.${u.field}`] ?? 0) + 1;
    console.log('  unresolved by field:', byField);
    for (const u of c.unresolvedLinks.slice(0, 25))
      console.log(`   - ${u.entity} ${u.id} ${u.field} -> ${u.targetId} (target not in imported set)`);
    if (c.unresolvedLinks.length > 25) console.log(`   … and ${c.unresolvedLinks.length - 25} more`);
  }
  if (c.guardViolations.length) {
    console.error(`\n!! GUARD: ${c.guardViolations.length} rows had a forbidden airtableusercontent url (columns NULLed):`);
    for (const g of c.guardViolations.slice(0, 20)) console.error(`   - ${g.table} ${g.id}: ${g.hit}`);
    process.exitCode = 2;
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
