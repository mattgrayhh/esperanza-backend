# 02 — Module: Ingest & Sync Schedule

**Worker:** `esperanza-ingest` · **Package:** `packages/ingest` · **Entry:** `src/index.ts`

This worker is the bridge from **Snowflake → D1**. It runs on a timer, figures out what
changed, and writes *only* pricing/availability columns into D1. It is deliberately
"low-privilege": it can never touch marketing content. The one flag it owns is `published`
— and only as a mechanical mirror of Snowflake availability: force `0` when a home leaves
the available set (sold/removed), set `1` when an imaged home re-enters it (both guarded
against truncated runs). It never edits copy, images, overrides, or slugs.

---

## What it does, in order

Every run (`runIngest()`):
1. **Logs into Snowflake** (REST API, using the `SNOWFLAKE_PASSWORD` secret).
2. **Runs four queries** against the warehouse:
   - `qmisSql()` — spec homes (`DM_HOUSE` ⋈ `FCT_HOUSESALES`), filtered to spec homes that
     aren't completed, in the city whitelist.
   - `communitiesSql()` — community aggregates (counts, min/max ranges) from `DM_HOUSE`.
   - `floorPlansSql()` — plan bed/bath/sqft/price from `DM_FLOOR_PLAN`. Since 0025 the
     "starting at" price prefers the `Traditional / Brick` elevation where offered,
     falling back to the cheapest offered (MIN-any caught cheaper non-standard
     elevations, e.g. Agave's Contemporary/Brick).
   - `communityPriceFromSql()` — each community's "price from," Traditional/Brick-
     preferred since 0025 (same rule as `floorPlansSql`). Community bath ranges in
     `communitiesSql()` include half baths (`BASE_BATHROOMS + 0.5 * BASE_HALFBATHROOMS`).
3. **Loads current D1 state** and **diffs** Snowflake against D1's existing `synced_*`
   values. Only genuine changes produce work — no churn.
4. **Enqueues** one message per changed record onto `esperanza-sync-queue`.
5. The **same worker's queue consumer** drains that queue and applies the changes to D1
   through the **synced-columns allowlist** (below). The D1 write *is* the job's output —
   the public site reads the updated data at request time via `esperanza-api`.
6. Writes a row to `sync_log` summarizing the run.

> The producer (diff) and consumer (apply) are split across a queue so a big run can't time
> out, and so failures retry per-record instead of failing the whole batch.

---

## Schedule (the "sync schedule" answer)

| Worker | Trigger | Cron | What it does |
|---|---|---|---|
| `esperanza-ingest` | cron | `0 */4 * * *` (**every 4 hours**) | Diff Snowflake vs D1, enqueue per-record changes. |

So pricing/availability is at most ~4 hours stale.

### Running it on demand
You don't have to wait for the cron. Trigger a run manually:

```bash
curl -X POST "https://<esperanza-ingest-worker-url>/run" \
  -H "Authorization: Bearer $INGEST_TRIGGER_TOKEN"
# → {"ok":true,"ran":"ingest"}
```

(`INGEST_TRIGGER_TOKEN` is a worker secret.) The admin panel also exposes a "Sync now"
button that calls this.

---

## The synced-columns allowlist (★ the safety mechanism)

**File:** `packages/ingest/src/synced.ts`

ingest can write **only** an explicit, frozen list of `synced_*` columns. Everything else
— overrides, descriptions, images, `published`, slugs — is structurally off-limits. The
apply step calls `assertQmiPatchAllowed()` (and the community/floor-plan equivalents),
which throws if any disallowed column sneaks in. This is defense-in-depth: even a bug in
the mapper can't corrupt marketing content.

The allowlists (abridged):

- **QMI:** `synced_address`, `synced_postal_code`, `synced_bedroom_count`,
  `synced_bathroom_count`, `synced_half_bathroom_count`, `synced_living_square_footage`,
  `synced_total_square_footage`, `synced_elevation`, `synced_construction_stage`,
  `synced_move_in_date`, `synced_lot_number`, `synced_elevation_type`,
  `synced_material_type`, `synced_is_model_home`, `synced_start_type`,
  `synced_construction_stage_index`, `synced_estimated_settlement_date`,
  `synced_city_id`/`_name`, `synced_community_id`/`_name`, `synced_floor_plan_id`/`_name`,
  `synced_price`, `last_synced_price`, plus the keys `eci_key`, `mark_job_number`,
  `housenumber`.
- **Communities:** `synced_square_footage_range`, `synced_bed_count`, `synced_bath_count`,
  `synced_price_from`.
- **Floor Plans:** `synced_bedroom_min/max`, `synced_bathroom_min/max`,
  `synced_living_square_footage`, `synced_total_square_footage`, `synced_starting_price`.
- **Close-out elevation prices** (`community_elevation_prices` table): a per
  (community × development plan × elevation) sales price, derived from a fifth
  `DM_FLOOR_PLAN` query (`MIN(salesprice)` grouped by development, model, elevation type +
  material). Unlike the queue/diff-driven entities above, this small fully-derived lookup is
  **rebuilt wholesale each run** (resolve development→community + model→floor-plan via the
  existing name maps, then DELETE-all + chunked INSERT). It feeds the close-out
  `close_out_elevation` price (see [doc 01](./01-data-flow.md)). Rows that don't resolve are
  dropped and counted in the sync_log note.

**Notably absent and intentional:** every `override_*` column, `slug`, `description`,
`image_url`, galleries. (`published` is the sole exception — ingest mirrors Snowflake
availability onto it in both directions; see the publish/unpublish bullets below.)

---

## Special behaviors you should know

- **The natural key is `eci_key`** (CompanyCode+DevCode+HouseNumber, e.g. `006LP00000051`).
  It's globally unique and set by the importer. If absent, ingest falls back to
  `housenumber|community-name`.
- **Marketing price rounding (0025):** Snowflake's `RATIFIED_SALES_PRICE` is the raw
  base+options figure; the site advertises the next price ending in **990**
  (218,127 → 218,990). `roundUpTo990()` applies at **parse time**
  (`parseQmiRows` in `snowflake.ts`) so `priceWillChange()` compares
  like-for-like and doesn't re-enqueue every home every run.
- **eci_key duplicate guard (0025):** a `qmi.upsert` create whose `eci_key` already
  exists in D1 routes to the UPDATE path against that row (consumer.ts) — a real
  dup (4122 Westway Court, eci 003HC00000046) got inserted twice when the diff
  missed the match. No unique index: the surviving prod dup row would block it.
- **Price divergence:** ingest owns `synced_price` and `last_synced_price` (used to detect
  drift) but **never** touches `override_price`.
- **Unpublish on sale:** if a published QMI's `eci_key` disappears from Snowflake (sold /
  removed), ingest enqueues an "unpublish" that forces `published = 0`.
- **Publish on re-availability (★, 2026-07-21):** the mirror direction. If an EXISTING row
  whose `eci_key` IS in the current available Snowflake set is `published = 0` **and already
  has an `image_url`**, ingest enqueues a "publish" that sets `published = 1` (guarded
  `WHERE published = 0`). This closes the gap where a new build or a relisted
  "Sales Canceled" home stayed invisible until a manual admin flip — the standing task
  behind the recurring "missing homes" parity findings. **Imaged-only** so no un-curated
  draft card ever surfaces; un-imaged available homes are left hidden (and should show up in
  the parity WARN for a human). Publishing is **suppressed on a truncated run** (same
  `< 50%` Snowflake-shrink signal as the unpublish guard), so a partial result can never
  mass-flip visibility. See `packages/ingest/test/republish.test.ts`.
- **Readiness gate on auto-publish (★, 2026-07-28):** presence in Snowflake plus an image
  is **not** enough. Snowflake lists a home from the moment it is a graded pad, so those
  two conditions alone published `Build Pad` and `Preliminary Plan Review` rows with
  move-in dates out to 2027-02-26 — published QMIs went 112 → 262 and marketing reported
  homes going live that nobody published. A home is auto-publishable only when it is
  **finished** (`isReadyConstructionStage`, i.e. `Buyer Sign Off`) **or due within
  `PUBLISH_HORIZON_DAYS` (120)**. The horizon is not arbitrary: a scrape of the legacy
  O'Neill listing on 2026-07-28 showed 121 homes whose availability envelope stopped dead
  at NOV/DEC 2026, ~120 days out. The gate judges the **incoming** Snowflake stage/date
  with `override_move_in_date` winning — the same COALESCE `v_public_qmi` applies, so it
  decides on what a visitor would actually see. A missing date is never publishable.
  `?force=1` releases the staging **cap**, NOT the readiness gate. Rejections are counted
  separately in `sync_log` as "withheld by readiness gate" so they are never mistaken for
  a reviewable backlog. See `packages/ingest/test/publish-readiness-gate.test.ts`.
  To retro-apply the rule to already-published homes:
  `npx tsx scripts/reconcile-published-readiness.ts --remote` (dry-run; `--apply` writes).
- **Machine publishes are attributed (2026-07-28):** every ingest flip of `published`
  writes an `audit_log` row (`actor = ingest-autopublish`, action `publish`/`unpublish`)
  in addition to `sync_log`. Before this, the ingest wrote only `sync_log` while the
  admin's edit history reads `audit_log`, so ~150 auto-published homes appeared with no
  actor and editors could not tell who had published them. No-op flips write no row.
  The admin renders the actor as "Snowflake sync (auto-publish)". See
  `packages/ingest/test/machine-publish-audit.test.ts`.
- **Availability text** (e.g. "Available JUN 2026" / "Available Now") is auto-derived from
  the move-in date (`src/availability.ts`) — but only if marketing hasn't written custom
  copy. Hand-authored availability text survives.
- **Mass-unpublish guard (★):** if a run would unpublish more than 20% of published rows
  *and* the Snowflake QMI count looks suspiciously low (< 50% of known eci-keyed rows), the
  guard **trips, skips all unpublishes, and logs a warning** to `sync_log`. Upserts still
  proceed. This exists because a truncated Snowflake result once nearly emptied the
  catalog. If you ever see the catalog suddenly shrink, check `sync_log` for this guard
  first — it's usually a bad Snowflake response, not real sales.

---

## Bindings & queues (`packages/ingest/wrangler.toml`)

| Binding | Resource | Role |
|---|---|---|
| `DB` | D1 `esperanza` | read state + write synced columns |
| `IMAGES` | R2 `esperanza-cms` | R2 image bucket binding |
| `SYNC_QUEUE` (producer) | `esperanza-sync-queue` | cron → per-record sync messages |
| consumer | `esperanza-sync-queue` (DLQ: `esperanza-sync-queue-dlq`) | apply to D1 (batch 10, 3 retries) |
| consumer | `esperanza-sync-queue-dlq` | record dead messages to `sync_log` (status `dlq`), ack — no re-enqueue |

Secrets: `SNOWFLAKE_PASSWORD` · manual-trigger `INGEST_TRIGGER_TOKEN` · `PURGE_KEY`
(X-Purge-Key for the api cache purge fired after each consumer batch).

---

## Files you'd edit

| Goal | File |
|---|---|
| Change schedule, bindings, Snowflake non-secret vars | `wrangler.toml` |
| Entry: cron handler, queue consumer, `/run` endpoint | `src/index.ts` |
| Snowflake login + the four SQL queries + row parsing | `src/snowflake.ts` |
| Diff logic + message shapes + mass-unpublish guard | `src/diff.ts` |
| Apply step (write to D1, derive availability) | `src/consumer.ts` |
| **The allowlist** (add a new synced column here) | `src/synced.ts` |
| Availability-text derivation | `src/availability.ts` |

**Adding a new synced field** (e.g. Snowflake starts sending a new attribute): (1) add the
`synced_<x>` column to the D1 schema + migration, (2) read it in `src/snowflake.ts`,
(3) include it in the diff in `src/diff.ts`, (4) **add it to the allowlist in
`src/synced.ts`** (or the apply step will reject it), (5) if it should reach the site, add
the override pairing in the public view (doc 01) so `esperanza-api` serves it.

---

## Verifying / troubleshooting a run

```bash
# Tail live logs while you trigger a run:
cd packages/ingest && npx wrangler tail esperanza-ingest

# Check the last few ingest runs:
npx wrangler d1 execute esperanza --remote --command \
  "SELECT started_at, status, notes, error_message FROM sync_log WHERE source='ingest' ORDER BY started_at DESC LIMIT 5;"
```

If messages keep failing they land in `esperanza-sync-queue-dlq` after 3 retries; the DLQ
consumer records each one as a `sync_log` row (status `dlq`, message body in
`error_message`) — fix the underlying data, then re-run the ingest (`POST /run`).
Concurrent runs are prevented by a `sync_lock` D1 row (15-min TTL); a second trigger
writes a `sync_log` row with status `skipped` and exits without touching the lock.

**Every exit path now leaves a `sync_log` row** — `success`, `warning` (unpublish guard),
`error`, `skipped`, or `dlq`. The lock is acquired *inside* the run's try/catch precisely
so that a failure in the acquisition itself is recorded. It was outside until 2026-07-26,
and that gap is why the 0029 migration miss ran silently for six days: the run threw before
it could log, so `sync_log` stopped rather than going red and every dashboard kept showing
the previous success. If you are ever asked "is the sync healthy", answer with the **age of
the newest good row**, or just `curl .../health/sync` on `esperanza-ops`.

---
**Next:** [03 — Module: Admin Panel](./03-module-admin.md)
