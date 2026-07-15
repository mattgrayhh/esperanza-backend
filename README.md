# esperanza-cf

Pure-Cloudflare CMS stack for **Esperanza Homes** — replaces Airtable end-to-end.
The public read path is edge-served, marketing edits all 9 entities in one owned admin,
there is no cross-vendor egress, and Airtable's seat-cost / API-limits / schema-rigidity
are gone.

> Implements the **Esperanza Cloudflare Migration Plan v2** (cold-swap, pre-launch).
> Snowflake feeds **only pricing/availability** for QMI, Communities, and Cities;
> everything else is marketing-authored with D1 as source of truth.

## Architecture summary

```
              ┌──────────────┐         ┌──────────────────────────┐
  Snowflake ──┤ ingest (cron)├──enqueue┤  esperanza-sync-queue     │
  (pricing/   │  diff vs D1  │         │  (per-record sync msgs)   │
   avail.)    └──────────────┘         └────────────┬─────────────┘
                                                     │ consume (allow-listed
                                                     │ synced columns only)
                                                     ▼
  OneDrive ──► renderings (MS Graph) ──► R2 ──►  ┌────────┐   ┌──────────────────┐
  (floor-plan renderings, sp_ no-clobber)        │   D1   │◄──┤ admin (Next.js 15)│
                                                 │esperanza│   │ OpenNext+Access   │
  Airtable ──► (one-time import, Phase 2) ──────►│        │   │ all 9 entities    │
                                                 └───┬────┘   └─────────┬────────┘
                                                     │ read              │ every write:
                                          v_public_* │ (replicas+Cache)  │ audit_log +
                                                     ▼                   │ cache purge
                                            ┌────────────────┐           ▼
  public site / XML feed ◄── code-comp ◄────┤ api (edge read)│      PDF re-render queue
  (live image URLs from R2 /               └────────────────┘
   media.esperanzahomes.com)
```

**Stores**
- **D1 `esperanza`** — relational source of truth. Binding `DB` in every worker.
  Field-complete schema bucketed by ownership; `synced_/override_` pairs only for the
  QMI Snowflake write-set and `communities.square_footage_range`; `promotions` +
  `promotion_targets`; `floor_plans.synced_image_url`; `audit_log`; `sync_log`.
  `v_public_*` views COALESCE only where a synced/override pair exists.
- **R2 `esperanza-cms`** — image bucket. Binding `IMAGES`. Served via stable
  `media.esperanzahomes.com`. **Never persist expiring `airtableusercontent.com` URLs.**

**Queues**
- **`esperanza-sync-queue`** — producer: `ingest` cron. consumer: `ingest` (writes only
  allow-listed synced columns; forces `published=0` on sold/removed only, never `=1`).

**Packages** (npm workspaces, `packages/*`)

| Package | Role | Bindings |
|---|---|---|
| `db` | Drizzle schema, migrations, `v_public_*` views, one-time Airtable import | `DB`, `IMAGES` |
| `ingest` | Snowflake→D1 cron diff + queue consumer | `DB`, `IMAGES`, `SYNC_QUEUE` (prod+cons) |
| `renderings` | OneDrive (MS Graph)→R2, `floor_plans.synced_image_url` | `DB`, `IMAGES` |
| `api` | Public read API (edge), promo resolution at read time | `DB`, `IMAGES` |
| `admin` | Next.js 15 admin, all 9 entities, behind Cloudflare Access | `DB`, `IMAGES` |

The 9 entities: **QMI, Communities, Cities, Floor Plans, Promotions, Collections,
Images, Blogs, Testimonials.**

---

## RUNBOOK (operator-only — needs a Cloudflare account + the real secrets)

The code is greenfield and verifies offline (`npm install && npm run typecheck && npm test`
all pass; the admin builds with `opennextjs-cloudflare build`). Every step below from §1
onward requires a Cloudflare login and provisions live resources. Run from the **repo
root** unless a step says "from `packages/<x>`". Follow the steps **in order** — several
later steps depend on artifacts created by earlier ones (the `database_id`, the queues,
the R2 custom domain).

### 0. Prereqs (local, no creds)
```bash
npm install            # NOT run by the scaffolder — run this first (links the workspaces)
git init && git add -A && git commit -m "Initial import"   # RECOMMENDED — repo is NOT yet under version control
npx wrangler login     # authenticate the operator's Cloudflare account
```
> **`git init` is recommended now.** The project is not under version control. Initialise
> before provisioning so the `database_id` fills (§2) and any tuning are tracked. The
> `.gitignore` already excludes `node_modules/`, `.next/`, `.open-next/`, `*.tsbuildinfo`,
> `.dev.vars`, `.wrangler/`, and stray `packages/*/{src,test,scripts}` JS/`.d.ts` emit.

### 1. Provision shared resources
```bash
# --- D1 database (prints a database_id — COPY IT, you need it in §2) ---
npx wrangler d1 create esperanza

# --- R2 bucket for images ---
npx wrangler r2 bucket create esperanza-cms
# Attach the stable custom domain (images are served from here; D1 stores ONLY this
# host, NEVER airtableusercontent.com). Add the domain in the dashboard:
#   R2 → esperanza-cms → Settings → Public access → Custom Domains → cdn.esperanzahomes.com
# (the worker var IMAGES_PUBLIC_BASE_URL must match the host you attach — see §4 note).

# --- Queues: Snowflake→D1 sync pipeline + dead-letter queue ---
npx wrangler queues create esperanza-sync-queue          # Snowflake→D1 sync (ingest)
npx wrangler queues create esperanza-sync-queue-dlq      # DLQ — referenced by ingest consumer
```
The DLQ is **required** (not optional): the ingest consumer names it in `wrangler.toml`
(`esperanza-sync-queue-dlq`) and a deploy fails if it doesn't exist. The DLQ is an
inspection bucket with **no consumer** by design.

### 2. Fill the `database_id` placeholders  ⚠️ REQUIRED before any deploy/migration
`wrangler d1 create esperanza` printed a `database_id`. **All 5** `wrangler.toml` files
ship with `database_id = "REPLACE_AFTER_PROVISION"`. Replace the placeholder with the
real id in every one:
```
packages/db/wrangler.toml
packages/ingest/wrangler.toml
packages/renderings/wrangler.toml
packages/api/wrangler.toml
packages/admin/wrangler.toml
```
Verify none remain:
```bash
grep -rn "REPLACE_AFTER_PROVISION" packages/*/wrangler.toml   # must print nothing
```

### 3. Set secrets per worker (`wrangler secret put`)
Run each **from the named package directory** — wrangler binds the secret to that
Worker. You're prompted for the value interactively; nothing is written to the repo.

```bash
# ingest  — from packages/ingest
#   (Snowflake account/user/db/warehouse/schema are non-secret [vars] in wrangler.toml.)
npx wrangler secret put SNOWFLAKE_PASSWORD       # Snowflake REST login password
npx wrangler secret put AIRTABLE_PAT             # ONE-TIME for the Phase 2 import (§5); revoke after

# renderings  — from packages/renderings  (MS Graph / OneDrive app registration)
npx wrangler secret put MS_GRAPH_TENANT_ID
npx wrangler secret put MS_GRAPH_CLIENT_ID
npx wrangler secret put MS_GRAPH_CLIENT_SECRET

# api    — NO secrets (public read path)
# admin  — NO app secrets (authn is Cloudflare Access in front of it — §6).
#          Only non-secret [vars]: IMAGES_PUBLIC_BASE_URL (and optional CF_ACCESS_* for
#          belt-and-suspenders JWT verification).
```
For local dev, copy each
`.dev.vars.example` → `.dev.vars` in the package and fill values there (`.dev.vars` is
gitignored). NEVER set `ADMIN_DEV_BYPASS`/`ADMIN_DEV_EMAIL` in `wrangler.toml` — they
live only in admin `.dev.vars` so the edge auth gate is never bypassable when deployed.

### 4. Apply schema migrations + create the public views
Apply against **local first** (smoke-test), then **remote**. Migrations create the
tables; `views.sql` creates the `v_public_*` read views the `api` Worker queries.
```bash
# generate is only needed if you changed schema.ts; the committed 0000_init.sql is current.
npm run db:generate                                          # optional — drizzle-kit generate

# tables — local then remote
npm run db:migrate:local                                     # wrangler d1 migrations apply esperanza --local
npm run db:migrate:remote                                    # wrangler d1 migrations apply esperanza --remote

# v_public_* views — local then remote (run from packages/db)
npx wrangler d1 execute esperanza --local  --file=packages/db/views.sql --yes
npx wrangler d1 execute esperanza --remote --file=packages/db/views.sql --yes
```
> Re-running `views.sql` is safe (it `DROP VIEW IF EXISTS` then recreates). The views
> COALESCE `override_*`/`synced_*` only where a pair exists and filter out
> unpublished/draft rows — the public read path never sees drafts.

### 5. One-time Airtable import + image migration (Phase 2)
Reads Airtable base `app2WqQR75HFBQp73`, maps each record into its bucketed D1 column,
downloads attachment/expiring image URLs and re-uploads them to R2 (**only stable
`cdn.esperanzahomes.com` URLs are persisted — never `airtableusercontent.com`**), and
writes D1 idempotently (`INSERT … ON CONFLICT(id) DO UPDATE`). **Run from `packages/db`.**

```bash
# 0. dry run — fetch + map + plan, write NOTHING
AIRTABLE_PAT=pat... npm run import:dry

# 1. real import (images migrated inline by default). Local first, then remote:
AIRTABLE_PAT=pat... npm run import -- --local
AIRTABLE_PAT=pat... npm run import -- --remote

# 2. (optional) standalone image re-migration — re-reads Airtable for FRESH signed urls
AIRTABLE_PAT=pat... npm run migrate-images -- --remote

# 3. verify (counts / overrides / NO signed urls persisted)
AIRTABLE_PAT=pat... npm run verify -- --remote
```
**FK / link-ordering note.** Links resolve by Airtable record **id** (QMI→floor_plan/
community/city, community→city, testimonial→floor_plan/community). To avoid
"unresolved links" warnings, import the **referenced** entities before the referencing
ones — i.e. **cities, then communities, then floor_plans, before qmi** (qmi references
all three). The full run does all 9 in one pass and logs any unresolved link to
`sync_log.unresolved_links` (never silently dropped), but if you import subsets with
`--only=`, respect that order:
```bash
AIRTABLE_PAT=pat... npm run import -- --remote --only=cities,communities,floor_plans
AIRTABLE_PAT=pat... npm run import -- --remote --only=qmi
AIRTABLE_PAT=pat... npm run import -- --remote --only=promotions,collections,images,blogs,testimonials
```
After a clean verify, **revoke the Airtable PAT** (it's never needed again — the live
sync is Snowflake, not Airtable). `npm run verify -- --remote --dry-run` does D1-only
checks once the PAT is gone.

### 6. Cloudflare Access for the admin (`admin.esperanzahomes.com`)
The admin Worker must sit behind **Cloudflare Access** — it holds no login secrets and
trusts the `Cf-Access-Authenticated-User-Email` header Access injects (used for
`audit_log.actor` + `override_*_by` attribution). Set this up before/at admin deploy:
1. Deploy admin (§7) and bind it to a custom domain/route for `admin.esperanzahomes.com`
   (Workers → Custom Domains, once the zone is on the account).
2. Zero Trust → Access → Applications → **Add a self-hosted application**:
   - Application domain: `admin.esperanzahomes.com`
   - Session duration: e.g. 24h
3. Add an **Access policy**: Action *Allow*, rule *Emails ending in* `@esperanzahomes.com`
   (or an explicit allow-list / IdP group for the marketing team).
4. Confirm an unauthenticated request to `admin.esperanzahomes.com` is **challenged**
   (the in-Worker `middleware.ts` also 401s if the Access header is ever missing on a
   non-local host — defense in depth).

### 7. Deploy the Workers
```bash
npm run -w @esperanza/api          deploy     # public edge read API (first-unconstrained replicas)
npm run -w @esperanza/ingest       deploy     # Snowflake→D1 cron (0 */4 * * *) + sync-queue consumer
npm run -w @esperanza/renderings   deploy     # OneDrive→R2 floor-plan renderings  ⚠ see note
npm run -w @esperanza/admin        deploy     # runs `opennextjs-cloudflare build` THEN deploy (NOT wrangler deploy)
```
- **admin** uses OpenNext: its `deploy` script is `opennextjs-cloudflare build &&
  opennextjs-cloudflare deploy` — it emits `.open-next/worker.js` + `.open-next/assets`
  (referenced by `wrangler.toml`) and deploys that. Do **not** call `wrangler deploy`
  directly for admin. (The build is verified working offline; deploy needs the login.)
- **⚠ renderings** is currently a scaffold (`package.json` + `wrangler.toml`, no `src/`).
  Its `deploy` (`wrangler deploy`) has no Worker entry to ship yet — implement the MS
  Graph→R2 fetch handler before this step, or skip it (floor-plan renderings won't sync
  until then; nothing else depends on it for launch).

---

## Notes
- **`database_id` placeholders must be filled after provisioning** (§2) — all 5
  `wrangler.toml`s ship with `REPLACE_AFTER_PROVISION`.
- **Migrations + views go local then remote** (§4); `views.sql` is idempotent.
- **The sync DLQ is required**, not optional (§1) — the ingest consumer references it by name.
- `compatibility_date`, cron cadences (`ingest 0 */4 * * *`), batch sizes, and DLQ names
  in the per-package `wrangler.toml`s are sane defaults — tune per phase.
- Secrets live only in Cloudflare (`wrangler secret put`) or local `.dev.vars`
  (gitignored). The `*.dev.vars.example` files list names only, never values.
- **The admin is the only write path** and every write: edits D1 on the PRIMARY session
  (read-your-writes), inserts `audit_log`, purges the public API cache, and may enqueue
  PDF re-renders. QMI Snowflake-set edits route through `@esperanza/db/override`;
  `togglePublished` is the only `published=1` path; image uploads store only stable R2 URLs.
