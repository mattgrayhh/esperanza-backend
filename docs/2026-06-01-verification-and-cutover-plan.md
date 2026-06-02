# Esperanza CF — End-to-End Verification + Cutover Plan — 2026-06-01

Source: Phase-0 read-only verification (7 parallel agents) + live Framer schema read + manual recon.
Account: **hello@hazard.house** (`c76a6d99ed7d6d45449990974f5c40b3`). D1 `esperanza` `023ea995…`. R2 `esperanza-cms`.
Live Framer project: **t47CBg6stJkC8hsPgamo "Esperanza Homes"** (confirmed via site-map — all CMS dynamic pages bind the "(Managed)" collections).

## TL;DR
The migration is structurally sound (API validated, image URLs 100% stable, sync workers correct, status-model
schema in place). The blocker is **freshness, not correctness**: the ingest cron never registered (account was at
the 5-cron cap), so D1 froze at the 5/31 import. Activating ingest (part of cutover) is what makes data current.
Two more real items: (a) `coming_soon` is only half-wired (communities only), (b) the Framer **code-component**
flip is not a bare URL swap — path prefix + field-shape differ.

## A. Migration completeness (Airtable → D1)
- **Row parity:** 8/9 tables still exact. **qmi drifted 326→ (Airtable 330)** — 4 new spec homes created in Airtable 6/1–6/2, never imported (one-time importer, no live re-sync). [coverage-audit: high]
- **Field coverage:** no NEW gaps. Every flag maps to a documented 5/31 by-design non-issue (FP:* resolved via view JOIN, HOA/city blocks aggregated to *_json, genuinely-empty source fields). 5/31 backfills intact.

## B. Data accuracy vs Snowflake + live site
- **Snowflake→D1 ingest cron has NEVER run** (sync_log: 2 `import` rows, 0 `snowflake`). D1 = frozen 5/31 snapshot. [high]
- Via Airtable-as-Snowflake-proxy (no local SF password): **23 QMI prices stale** ($8k–$53k delta), **9 construction_stage stale**, **4 net-new homes missing**, minor sqft/half-bath drift. All explained by Airtable rows modified 6/1–6/2 post-import. No human price overrides exist; community sqft ranges 32/32 correct.
- Vs live esperanzahomes.com: **prices match exactly** on every home sampled. Drift: **3 for-sale homes + 2 communities (Aquero/Laredo, Los Arroyos/Harlingen) missing from D1**; **Mercedes (Los Prados) published with 0 QMI in API but live shows 7**; **per-home BATH count + TOTAL sqft disagree on most homes sampled** (NEEDS verification — may be field-mapping artifact vs genuine drift); `city.moveInHomesCount` is a stale aggregate. [high/medium]
- **Root cause for nearly all of the above = ingest never ran.** Activating ingest (cutover Step B) reconciles prices, construction stages, missing homes, and missing communities. Bath/sqft mismatch to be verified separately.

## C. Status model (decision: gate all; coming-soon on QMI/Communities/Floor Plans)
- Today: published+coming_soon on qmi/communities/floor_plans; cities/testimonials free-text `status`; blogs `published`; promotions date `active`; collections/images always-live. communities also has an unused `draft` col.
- **`coming_soon` is only half-wired:** present on the 3 base tables (migration 0003) but NOT in `v_public_qmi`/`v_public_floor_plans`, NOT in the api serializers (qmi/floorplans), NOT pushed by framer-push (only communities). Latent today (all-zero) but silently drops the flag the moment an editor sets it. [medium — 3 agents agree]
- **Migration 0005 (behavior-preserving) — to implement:**
  - ADD `published` to cities, collections, images; ADD `coming_soon` to cities.
  - RENAME `promotions.active` → `published` (15 published / 2 hidden, no row change).
  - Normalize `testimonials.status` → `published` (74 pub / 1 draft); `cities.status` → `published`(11)+`coming_soon`(1=Corpus Christi).
  - DROP `communities.draft` (all 0 — no-op).
  - Update `v_public_*` (gate published everywhere; surface coming_soon on qmi/floorplans), api serializers, framer-push gates, **`field_definitions` seed** (admin form registry — else admin won't show the new gates), + the backfills above.
  - Verify: cities SUM(published)=11, SUM(coming_soon)=1; testimonials SUM(published)=74; promotions SUM(published)=15.

## D. API read path (esperanza-api) — PASS
- All 9 entities 200, published-gate counts match D1 exactly. **Image URLs 100% stable — zero airtableusercontent/expiring URLs** across all payloads. Promotions targeting resolves. CORS/404 correct.
- Issues: `coming_soon` absent from qmi/floorplans payloads (see C); Calallen city has null slug → broken route risk [low].

## E. Admin portal (image fields) — to fix
- Make ALL image fields render as the image (thumbnail/preview), not a URL/link, across generic edit form + list/table + bespoke views; pick-from-DAM where applicable.
- Fix latent `build-edit-view` bug: reads `row[snake_case]` but Drizzle returns camelCase → multi-word image cols (e.g. `featured_image_url`) render blank.
- (Full QA pass pending admin password.)

## F. Framer CMS — reuse existing "(Managed)" collections
All 9 exist on t47CB: Floor Plans `czFXxWqH9`(62), Quick Move-Ins `iVpvSc4im`(330), Communities `aFxxkciqK`(32),
Blogs `sR7Cm51rn`(124), Promotions `A4DWaswyn`(18), Cities `wl3b20LLC`(11), Collections `y2wXMJNom`(6),
Images `fi6Vs4c7h`(630), Testimonials `Of60Iks8a`(75).
- **Item drift:** Framer QMI=330 vs D1=326; Promotions=18 vs 17 — stale items the new D1→Framer push reconciles (soft-delete via draft:true). Deprecated hand-built `Communities`(fURVULLJK)/`Floor Plans / Homes`(jDDhbFrbD) still linger (separate, not migrated).
- **TWO Framer consumption modes** (both must cut over):
  1. **CMS-sync** (framer-push → Managed collections → dynamic pages): verify framer-push writes field keys matching live field IDs; add a `coming_soon` field to the QMI + Floor Plans Managed collections.
  2. **Embed code-components** (5 .tsx read JSON from legacy cache workers on page load): **field-shape drift** — legacy cache emits Airtable keys (`Community (Link)`, `FP: Starting Price`), new api emits D1 keys (`slug`, `Price`, `total_square_footage`). A bare URL swap 200s but renders BLANK. Must adapt components OR add an api compatibility shape. [high]

## G. Cutover runbook (FULL cutover — operator decided; aggregator feed non-critical pre-launch)
Cron cap is **account-wide 5/5**. Only 3 are Esperanza-legacy. **DO NOT touch bhh-marks-sync (`0 8`) or rhodes-availability (`*/15`)** — unrelated production.
- **Step A — free 3 legacy Esperanza cron slots** (disable, don't delete; rollback): redeploy with empty triggers:
  - `Esperanza/esperanza-data-sync` (`0 */4`), `esperanza-sync` (=esperanza-framer-sync, `*/5`), `Esperanza/qmi-brochure-worker` (`0 6`).
- **Step B — activate new crons** (after A; both are deployed but have 0 registered crons): `npm run -w @esperanza/ingest deploy` (registers `0 */4` — read-only into D1, runs reconciliation = fixes the staleness), then **after the field audit** `npm run -w @esperanza/framer-push deploy` (registers `*/5` — mutates live Framer).
- **Step B-pre — field audit:** run `/audit-sync-fields` + per-component field-read diff; resolve every mismatch before framer-push deploy + the URL flip.
- **Step C — flip 5 Framer code components** (in the live project, on the component instance): set `cacheWorkerUrl` = `https://esperanza-api.round-base-ed8c.workers.dev/api/public` (WITH `/api/public` suffix). Components: QuickMoveIns-Cached, FloorPlansCatalog, Communities, SingleLocationMap, LocationPickerFixed. Resolve field-shape drift (F.2) first. Publish + smoke-test.
- **Step D — disable XML feed** (no cron, returns 500 live; safe).
- **Step E — rollback-safe:** keep legacy data-sync/framer-sync/qmi-brochure + qmi-cache/communities-cache deployed-but-disabled. Cron math never exceeds 5; the 2 non-Esperanza crons preserved throughout.

## Execution order (this session)
1. **Remediation (local-first, safe — D1 not yet live-serving):** migration 0005 + views + api + framer-push gates + field_definitions + backfills; coming_soon full wiring; admin image-field rendering + camelCase bug; re-import 4 missing QMI from Airtable; Calallen slug. Tests green, then apply remote.
2. **Framer wiring:** framer-push↔Managed field-ID parity; add coming_soon field to QMI/Floor Plans Managed; resolve code-component field-shape drift.
3. **Admin QA** (deployed, needs password) + **Cities-detail redesign** (page `SqyTFwTxP`).
4. **Cutover** A→audit→B→C→D→E (production; reported per step).
