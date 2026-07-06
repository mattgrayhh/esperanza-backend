# 01 — Data Flow: Snowflake → D1 → Framer

This is the most important concept in the whole system. Once the data flow clicks, every
module makes sense. Read this before the module docs.

---

## The three stages

```
   STAGE 1: SOURCE                STAGE 2: TRUTH                  STAGE 3: PRESENTATION
   ───────────────                ─────────────                  ─────────────────────

   Snowflake  ─┐                 ┌──────────────────┐
   (pricing &  │  esperanza-     │                  │   esperanza-framer-push
    availab.)  ├─ ingest ──────► │   D1: esperanza  ├─► (D1 → Framer) ──► Framer site
              ┌┘  (cron 4h)      │                  │                    (what visitors see)
   Marketing ─┘  admin panel     │  SOURCE OF TRUTH │
   (humans)      (writes)        └──────────────────┘
                                    │   │   │
                                    │   │   └─► esperanza-xml-feed  → Zillow/Realtor/etc.
                                    │   └─────► esperanza-pdf        → brochures & lists
                                    └─────────► esperanza-api        → edge read API
```

1. **Source** — two inputs write into D1:
   - **Snowflake** (the Rhodes Enterprises data warehouse) automatically feeds **only
     pricing and availability**.
   - **Marketing people** edit everything else through the **admin panel**.
2. **Truth** — **D1** (`esperanza`) is the single source of truth. Every reader downstream
   pulls from D1.
3. **Presentation** — several consumers read D1: `framer-push` (the public site),
   `xml-feed` (listing syndication), `pdf` (brochures), and `api` (a read API).

---

## What comes from Snowflake (and what does NOT)

Snowflake feeds **pricing and availability only**, for three entity types:

| Entity | What Snowflake provides |
|---|---|
| **QMI** (Quick Move-In / spec homes) | address, postal code, bed/bath/half-bath counts, living & total square footage, elevation, construction stage, estimated move-in/settlement date, lot number, price, model-home flag, and the links to its city/community/floor-plan. |
| **Communities** | aggregate ranges: square-footage range, bed/bath counts, "price from." |
| **Floor Plans** | bedroom/bathroom min & max, living/total square footage, starting price. |
| **Cities** | (no synced pricing fields — plain passthrough.) |

**Snowflake does NOT provide:** descriptions, marketing copy, photos, galleries, SEO
slugs, videos, virtual tours, brochures, promotions, blogs, testimonials, "coming soon"
flags, or the **publish** decision. All of that is authored by marketing in the admin.

### How Snowflake connects
The ingest worker logs into Snowflake's **REST API** (no driver) using the
`SNOWFLAKE_PASSWORD` secret. Key warehouse coordinates (in `packages/ingest`): account
`lu51183.us-east-2.aws`, user `matt_hazard_house`, database `RHODES_ENTERPRISES`,
warehouse `HAZARD_HOUSE_WH`, schema `ANALYTICS_ZONE`. The main source tables are
`DM_HOUSE` (homes), `DM_FLOOR_PLAN` (plans), and `FCT_HOUSESALES` (sale lifecycle). Only
homes in a hard-coded city whitelist (McAllen, Mission, Edinburg, Brownsville, Harlingen,
Laredo, San Juan, Weslaco, Mercedes) are pulled. Details in [doc 02](./02-module-ingest.md).

### Community pricing (`price_from` precedence — the elevation price source, 0025)

The pricing rule (per the Rhodes team): **a base price comes from the Traditional /
Brick elevation — the cheapest standard one; where brick isn't offered, from the
cheapest elevation offered in that community**. The per-community selector is
**Price Source Elevation** (`communities.close_out_elevation` — the column name is
historical; since migration 0025 it's honored for **every** community, a "Type /
Material" label like `Traditional / Stucco`). `price_from` resolves, highest
priority first:

1. `override_price_from` — a manual price override (always wins, but prefer the
   selector: overrides go stale).
2. **close-out QMI min** (`close_out = 1` only) — the cheapest **published QMI** in
   the community. A close-out community sells what's standing (confirmed against
   the legacy site: Wright Ranch 274,990 / Rogers Coves 239,990 / Cascada 437,990).
3. **elevation price source** — from `community_elevation_prices` (synced from
   `DM_FLOOR_PLAN`, scoped to the community's **published development plans**;
   does **not** require the "Floor Plans Offered" picker): the pinned
   Price Source Elevation → `Traditional / Brick` where offered → the cheapest
   offered elevation. `NULL` when the community has no elevation rows.
4. **close-out auto-MIN** — the lowest published plan in the "Floor Plans Offered"
   picker (last resort for close-outs with no QMIs and no elevation rows).
5. `synced_price_from` — the normal Snowflake value (itself Traditional/Brick-
   preferred since 0025 — see `communityPriceFromSql` in ingest).

The resolution is computed live (nothing derived is stored on `communities`). The
three code sites (`framer-push` `selectById` + `selectAll`, the `pdf` list query)
share `communityPriceFromExpr()` from `@esperanza/db/elevation-price`;
`packages/db/views.sql` (`v_public_communities`) keeps a literal copy — keep it
identical. The elevation label is internal-only (never pushed to Framer).

**Per-plan, per-community prices** follow the same rule: `GET
/api/public/floorplans` serves `communityPrices` from `COMMUNITY_PLAN_PRICE_SQL`
and the community "Plan List" PDF prices each plan with
`communityPlanPriceExpr()` (both in `@esperanza/db/elevation-price`) — pinned
elevation → Traditional / Brick → cheapest offered, falling back to the plan's
dev-wide price when the community has no elevation rows for it.

**Every surface that shows a price reads this one resolution — no plain `COALESCE(override,
synced)` shortcuts** (those skip close-out and show a stale, lower number). Concretely:

- **Community card / API / PDF** — `v_public_communities.price_from` (above).
- **Admin community detail** (stats card *and* the map-pin preview) — reads
  `price_from` straight from `v_public_communities` (`packages/admin/lib/community-detail.ts`),
  so the admin never shows a different number than the live site.
- **City "Homes from"** — the Framer *Cities* collection pushes `price_from` =
  `MIN(v_public_communities.price_from)` across that city's **published** communities
  (`CITY_COUNTS_SQL` in `framer-push`). Because it reads the view, the close-out logic is
  applied exactly once and the city figure can never drift from the community cards.
- **`close_out` flag** — the boolean itself is pushed to the Framer *Community* collection
  (for badging / conditional layout); the price effect is already in `price_from`.

> ⚠ The **city-page neighborhood map** (`cities.neighborhoods_map_json`, currently on the
> unmerged `feat/city-neighborhoods-map` branch) builds each pin's `priceFrom` from
> `COALESCE(override_price_from, synced_price_from)` — **not** close-out aware. When that
> branch is merged it must read the close-out `price_from` (e.g. from `v_public_communities`)
> or close-out communities will show a lower number on the map than on their cards.

---

## The `synced_*` vs `override_*` column pattern (★ critical)

This is the mechanism that lets Snowflake and marketing coexist without fighting. **Learn
this pattern — it appears in the schema, the admin UI, and the views.**

For any field that *could* come from Snowflake, the D1 table has **two columns**:

| Column | Written by | Meaning |
|---|---|---|
| `synced_<field>` | **ingest only** (from Snowflake) | the latest value Snowflake reported |
| `override_<field>` | **admin only** (marketing) | a manual value that *wins* if set |

The public views resolve them with `COALESCE(override_<field>, synced_<field>)` — i.e.
**the manual override wins; otherwise fall back to the Snowflake value.**

```
   Snowflake says price = 320000      ──► writes synced_price = 320000
   Marketing types price = 315000     ──► writes override_price = 315000
   The website shows ──► COALESCE(override_price, synced_price) = 315000  (override wins)

   If marketing clears the override   ──► override_price = NULL
   The website shows ──► COALESCE(NULL, 320000) = 320000  (back to Snowflake)
```

**Why it matters operationally:**
- ingest is **only ever allowed to write `synced_*` columns** (enforced by an allowlist —
  see [doc 02](./02-module-ingest.md)). It can never clobber a marketing override, a
  description, or the publish flag.
- In the admin, fields that have a synced counterpart show **both** the synced value and
  an override box (the `SyncedOverrideField` widget), so marketing can see "Snowflake says
  X" and choose to override.
- `published` is **not** synced — marketing controls visibility. ingest may force
  `published = 0` only when a home sells/disappears from Snowflake; it can never set
  `published = 1`.

---

## D1: the database itself

- **Name:** `esperanza` · **ID:** `023ea995-0abc-4165-a1e1-6e2373fc43e9` (the same ID is in
  every worker's `wrangler.toml` — that's how they all share one database).
- **Binding:** every worker accesses it as `env.DB`.

### The nine content entities (tables)
`qmi`, `communities`, `cities`, `floor_plans`, `promotions`, `collections`, `images`
(a digital-asset library), `blogs`, `testimonials`.

### Operational tables (not content)
| Table | Purpose |
|---|---|
| `field_definitions` | Drives the admin forms (see below). One row per editable field. |
| `audit_log` | Every admin write appends a row: who changed what field, old → new value. |
| `sync_log` | One row per ingest run and per framer-push batch. **Your main observability tool.** |
| `pdf_renders` / `pdf_themes` / `pdf_render_log` | PDF generation state (doc 05). |
| `admin_users` | Admin panel logins (PBKDF2-hashed passwords). |
| `promotion_targets` | Which entities a promotion applies to. |

### The public views: `v_public_*`
For each publishable entity there's a view — `v_public_qmi`, `v_public_communities`,
`v_public_cities`, `v_public_floor_plans`, `v_public_blogs`, etc. These views:
- apply the `COALESCE(override, synced)` resolution,
- filter to `published = 1`,
- join in lookups (e.g. a QMI's floor-plan details) that don't fit in the base table.

**Downstream readers query the views, not the raw tables.** The `api` worker and the
`xml-feed` worker both read `v_public_*`. (framer-push reads a mix — see doc 04.) The views
are defined in `packages/db/views.sql`.

---

## `field_definitions`: why the admin forms are data-driven

The admin doesn't hard-code its edit forms. It reads the **`field_definitions`** table and
renders a form from it. Each row says: this entity has a field with this `key`, this
`label`, this `type` (text / long / rich / number / currency / bool / date / url / image /
select / or a bespoke widget), and this sort order.

**Consequence for you:** adding a new editable field is usually *not* just a code change —
you also have to **seed a `field_definitions` row** (via a seed script) or the field won't
appear in the admin. Full procedure in [doc 03](./03-module-admin.md).

(There's a safe fallback: if an entity has zero `field_definitions` rows, the admin renders
a static built-in config instead of an empty form.)

---

## How D1 reaches Framer (preview of doc 04)

Framer is a **copy** of D1, not a second source of truth. Two paths keep it in sync:

1. **Event-driven (primary):** every admin write and every ingest change **enqueues a
   message** onto `esperanza-framer-queue` (`{collection, action, id}`). The `framer-push`
   worker consumes it, re-reads the full row from D1, and upserts it into the Framer CMS.
2. **Nightly backstop:** a cron in `framer-push` re-pushes anything changed in the last
   ~25 hours, catching any missed events.

Plus a **manual** path (`POST /backfill`) you'll use after deploying mapping changes.
This is covered in detail — including the field-type rules that trip people up — in
[doc 04](./04-module-framer-push.md).

---

## Migrations: changing the D1 schema

The schema is defined with **Drizzle ORM** in `packages/db/schema.ts`. To change it:

```bash
# 1. Edit packages/db/schema.ts
# 2. Generate a migration file (creates packages/db/migrations/NNNN_*.sql):
npm run db:generate

# 3. Apply LOCALLY first and test:
npm run db:migrate:local       # wrangler d1 migrations apply esperanza --local

# 4. Only then apply to production:
npm run db:migrate:remote      # wrangler d1 migrations apply esperanza --remote

# 5. If you changed views.sql, apply it explicitly (views aren't migrations):
npx wrangler d1 execute esperanza --remote --file=packages/db/views.sql --yes
```

> ⚠️ **The 100-column limit.** D1 caps a table at **100 columns**. Local SQLite (and the
> better-sqlite3 used in unit tests) does **not** enforce this, so tests pass and then the
> remote migration fails. **Always** run `--local` (and ideally apply to a throwaway remote
> first) before trusting a wide migration. The QMI table already had to drop lookup columns
> and move them into a view because of this.

---
**Next:** [02 — Module: Ingest & Sync Schedule](./02-module-ingest.md)
