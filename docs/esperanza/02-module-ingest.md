# 02 — Module: Ingest & Sync Schedule

**Worker:** `esperanza-ingest` · **Package:** `packages/ingest` · **Entry:** `src/index.ts`

This worker is the bridge from **Snowflake → D1**. It runs on a timer, figures out what
changed, and writes *only* pricing/availability columns into D1. It is deliberately
"low-privilege": it can never touch marketing content or the publish flag.

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
   through the **synced-columns allowlist** (below).
6. After each successful D1 write, the consumer **enqueues a Framer push** onto
   `esperanza-framer-queue` so the change propagates to the site.
7. Writes a row to `sync_log` summarizing the run.

> The producer (diff) and consumer (apply) are split across a queue so a big run can't time
> out, and so failures retry per-record instead of failing the whole batch.

---

## Schedule (the "sync schedule" answer)

| Worker | Trigger | Cron | What it does |
|---|---|---|---|
| `esperanza-ingest` | cron | `0 */4 * * *` (**every 4 hours**) | Diff Snowflake vs D1, enqueue per-record changes. |
| `esperanza-framer-push` | cron | `0 9 * * *` (**daily 09:00 UTC**) | Backstop: re-push anything changed in the last ~25h (`CRON_LOOKBACK_MINUTES=1500`). |

So pricing/availability is at most ~4 hours stale. The Framer cron is just a safety net —
the *primary* path to Framer is event-driven (enqueued immediately on every write).

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

**Notably absent and intentional:** every `override_*` column, `published`, `slug`,
`description`, `image_url`, galleries.

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
  removed), ingest enqueues an "unpublish" that forces `published = 0`. It can never set
  `published = 1`.
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
| `IMAGES` | R2 `esperanza-cms` | (one-time Airtable image import only) |
| `SYNC_QUEUE` (producer) | `esperanza-sync-queue` | cron → per-record sync messages |
| consumer | `esperanza-sync-queue` (DLQ: `esperanza-sync-queue-dlq`) | apply to D1 (batch 10, 3 retries) |
| `FRAMER_QUEUE` (producer) | `esperanza-framer-queue` | enqueue Framer push after each D1 write |

Secret: `SNOWFLAKE_PASSWORD` · Manual-trigger secret: `INGEST_TRIGGER_TOKEN`.

---

## Files you'd edit

| Goal | File |
|---|---|
| Change schedule, bindings, Snowflake non-secret vars | `wrangler.toml` |
| Entry: cron handler, queue consumer, `/run` endpoint | `src/index.ts` |
| Snowflake login + the four SQL queries + row parsing | `src/snowflake.ts` |
| Diff logic + message shapes + mass-unpublish guard | `src/diff.ts` |
| Apply step (write to D1, derive availability, enqueue Framer) | `src/consumer.ts` |
| **The allowlist** (add a new synced column here) | `src/synced.ts` |
| Availability-text derivation | `src/availability.ts` |

**Adding a new synced field** (e.g. Snowflake starts sending a new attribute): (1) add the
`synced_<x>` column to the D1 schema + migration, (2) read it in `src/snowflake.ts`,
(3) include it in the diff in `src/diff.ts`, (4) **add it to the allowlist in
`src/synced.ts`** (or the apply step will reject it), (5) if it should reach the site, add
the override pairing in the view and the Framer mapper (doc 04).

---

## Verifying / troubleshooting a run

```bash
# Tail live logs while you trigger a run:
cd packages/ingest && npx wrangler tail esperanza-ingest

# Check the last few ingest runs:
npx wrangler d1 execute esperanza --remote --command \
  "SELECT started_at, status, notes, error_message FROM sync_log WHERE source='ingest' ORDER BY started_at DESC LIMIT 5;"
```

If messages keep failing they land in `esperanza-sync-queue-dlq` after 3 retries.

---
**Next:** [03 — Module: Admin Panel](./03-module-admin.md)
