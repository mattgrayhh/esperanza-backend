# 08 — Troubleshooting Runbook & Glossary

Keep this open while you work. Part 1 is "symptom → cause → fix." Part 2 is the cheat-sheet
of commands. Part 3 is the glossary of every name and identifier in the system.

---

## Part 1 — Symptom → likely cause → fix

### "QMI listing cards show a floor-plan schematic instead of a real photo"
1. **Check the hero field:** Listing cards and community-page QMI grids use
   `qmi.image_url` as the hero. When it is blank or points at a floor-plan
   rendering (`assets-media/…`, `floor_plans/…`), the site shows a schematic.
2. **Check the photo gallery:** The admin **Photo Gallery** column
   (`photo_gallery_json`) often has the correct home photo. If the first gallery
   image is a real `/qmi/…` upload but `image_url` differs, run
   `npx tsx packages/db/scripts/backfill-qmi-hero-from-gallery.ts --remote`
   (add `--dry-run` first). The script copies the best gallery photo into
   `image_url` for every affected home.
3. **No gallery photos:** Homes like 4417 N Pear Ave with an empty gallery still
   need real photos uploaded in the admin before a hero can be set.
4. **Stale runtime override:** Even when D1/API `image_url` is correct, community
   and available listing cards can still show old floor-plan URLs if production
   `community-homes-live.js` / `available-live.js` prefer `qmi-images.json` over
   the live API. Patch those scripts in `esperanza-frontend`, then redeploy via
   the normal frontend CI — **never** patch only a few worker assets via the
   Cloudflare direct-upload API (that replaces the entire static manifest and
   404s the site). See PR #171 for the JS fix; ship it through a full frontend
   deploy.

### "Every page shows Page not found on esperanzahomes.hazardhouse.ai"
1. **Likely cause:** A partial Workers asset upload replaced the frontend Worker's
   static manifest with only a handful of files (e.g. live scripts). Version metadata
   may show `assets.serve_directly: true` instead of the normal `raw_run_worker_first`
   routing. This is an infrastructure mis-deploy, not a Sentry/application bug.
2. **Fix:** Roll production back to the last good deployment in Cloudflare
   Workers → `esperanzahomes` → Deployments (version before the bad upload), or:
   `POST /accounts/{account}/workers/scripts/esperanzahomes/deployments` with the
   previous good `version_id` at 100%. Staging (`esperanzahomes-staging.*.workers.dev`)
   is a separate Worker and is unaffected unless it was deployed separately.
3. **Sentry:** No reset needed — errors are missing static HTML, not thrown exceptions
   in admin/api Workers. Check Cloudflare Worker deployments, not Sentry issue queues.

### "Community page shows no Quick Move-In cards (legacy site has them)"
1. **Confirm the API:** `GET /api/public/qmi` and filter by community name. Only
   **published** homes appear — if D1 has `published = 0`, the card will not render.
2. **Missing baked section:** Some community pages (e.g. Texas Heights) were built without
   a `#specs` section. The shipped `community-homes-live.js` used to exit immediately when
   no `[data-qmi-slug]` elements existed, so nothing rendered. Patch
   `packages/api/live-scripts/community-homes-live.js` (mirrored in `esperanza-frontend`)
   so it fetches published QMIs for the page's community and injects the `#specs` grid at
   runtime when baked cards are absent.
3. **Publish the homes:** If legacy O'Neill shows more cards than the new site, the extra
   homes are likely still **unpublished in D1**. Publish them in the admin (or verify they
   should not be live — sold/early-stage homes).
4. **Deploy:** redeploy `esperanzahomes-frontend` so the updated
   `community-homes-live.js` asset is served. Purging the api cache alone is not enough.

### "I edited a field in the admin but the website didn't change"
1. **Which site are you checking?** Marketing edits flow to **`esperanzahomes.hazardhouse.ai`**
   (the new static frontend reading `esperanza-api`). **`www.esperanzahomes.com` is still the
   legacy O'Neil Interactive site** — it does not read D1 and will never show admin edits
   until DNS cutover.
2. Is the record **published**? The public API serves `v_public_*` views — drafts are
   hidden until published (`togglePublished` or the publish toggle on the record).
3. **Static vs live content:** Most page HTML (copy, galleries, list grids) is **baked at
   frontend build time**. Admin saves purge the api cache (updating live JS islands like
   maps, mortgage-rate calculators, and QMI card reconciliation) and POST
   `FRONTEND_DEPLOY_HOOK_URL` to redeploy `esperanzahomes-frontend`. Without the deploy
   hook configured, operators must redeploy the frontend manually to see baked-content
   changes. The admin **Preview live page** link targets `esperanzahomes.hazardhouse.ai`.
4. Check admin Worker logs for **`[purge]`** and **`[site-rebuild]`** after saving. A
   successful cache bust returns `X-Purge-Applied: 1` from `esperanza-api`. Common failures:
   - `PURGE_KEY unset` — set the same secret on `esperanza-admin` and `esperanza-api`
   - `purge not applied` — key mismatch or the api worker wasn't redeployed after the
     authenticated-purge change (PR #150, 2026-07-19)
   - `FRONTEND_DEPLOY_HOOK_URL unset` — baked HTML won't rebuild automatically
5. Is there a **stale redirect** shadowing the page? Some legacy URLs 308-redirect and hide
   the live page. That's an operator config issue.
6. Is the page driven by a **live fetch island** (maps, settings, QMI card grid reconcile)
   rather than baked HTML? Those read `/api/public/<entity>` through the frontend worker
   proxy, which caches ~60s independently — admin purges both layers when
   `FRONTEND_PUBLIC_URL` is set. Promotions edits also purge `communities`/`cities`/`qmi`
   because the resolved promo is flattened onto those. If a fetch-driven surface still lags,
   the purge is best-effort and the TTL (≤5 min) is the backstop — wait it out or hit
   `GET {API_PUBLIC_URL}/api/public/<entity>?purge=1` with `X-Purge-Key`.

### "4.99% promo banners show gold/tan instead of green on the live site"
1. **Confirm the API first:** `GET /api/public/qmi` must return `promo_banner_style: "green"`
   for 4.99% homes (e.g. 2434 Nilgai Trail). If it says `green` but the site is gold, the
   bug is in **`esperanza-frontend` runtime JS**, not D1 or the admin.
2. **Detail pages** bake `<div class="status-banner overlay-promo … tan" data-live="promo">`.
   `hydrate-live.js` updates the text from the API but (on the shipped build) does **not**
   swap `tan` → `green`. Patch `packages/api/live-scripts/hydrate-live.js` in this repo
   (mirrored in `esperanza-frontend`) so hydration also sets the bar class from
   `promo_banner_style`, then redeploy the frontend worker.
3. **Listing cards** (`available-live.js`) must prefer `promo_banner_style` over stale
   `live-facts.json` badge colors — see `packages/api/live-scripts/available-live.js`.
4. **Deploy:** merge the backend PR, then redeploy `esperanzahomes-frontend` (GitHub Actions
   `deploy.yml` or the admin's `FRONTEND_DEPLOY_HOOK_URL`). Purging the api cache alone is
   not enough — the JS assets are baked on the frontend worker.

### "A published home has a page but doesn't appear in the header search bar"
1. **Which search data source is the page using?** `sitesearch-live.js` fetches
   `/sitesearch.json`. The live index is now served at **`/api/public/sitesearch.json`**
   (same O'Neil row shape, hierarchical QMI hrefs from D1). The static asset baked at
   frontend build time is often stale and omits newly published homes.
2. **Verify the live index:** `GET /api/public/sitesearch.json` and search for the address.
   QMI hrefs must look like `/new-homes/tx/{city}/{community}/{dash-slug}/` — not
   `/new-homes/available/{underscore_slug}` (those 404 on the current frontend).
3. **Frontend wiring:** until `sitesearch-live.js` is pointed at `/api/public/sitesearch.json`
   (or the frontend worker proxies `/sitesearch.json` there), operators must redeploy
   `esperanza-frontend` to refresh the baked search file after publishing new homes.
4. Admin saves purge both `sitesearch` and `sitesearch.json` automatically when `PURGE_KEY`
   is set.

### "Schedule An Exploratory Visit still shows the old native form"
1. **Which form IDs:** Community pages use `#detailpagescheduletourform` (POST
   `/xhr/tour/`). `/new-homes/available/` uses `#generalscheduletourform` (POST
   `/xhr/general-tour/`). Both should be replaced at runtime by HubSpot embed portal
   `8139268`, form `97ec81f8-e976-448d-aa61-dc4853b8ac10`.
2. **Canonical script:** `packages/api/live-scripts/schedule-tour-hubspot-live.js` (mirror
   to `esperanza-frontend`). `community-homes-live.js` and `available-live.js` load it
   when a schedule-tour form is on the page.
3. **Seven community pages** (Tres Lagos master plan, Bentsen Palm master plan, Aquero,
   Vista Verde, Wright Ranch, Villas Las Lagunas, Silos at La Sienna) do **not** ship
   `community-homes-live.js`. Add `<script src="/schedule-tour-hubspot-live.js"></script>`
   to the global footer in `esperanza-frontend` so those pages get the HubSpot form.
4. **Deploy:** mirror all three live scripts and redeploy via normal frontend CI — never
   partial asset upload (see "Every page shows Page not found" above).

### "I added a field but it's not in the admin form"
You deployed code but didn't **seed a `field_definitions` row**. Run
`npx tsx packages/db/scripts/seed-field-definitions.ts --remote`. See
[doc 03](./03-module-admin.md).

### "The home catalog suddenly looks empty / way fewer homes"
Check `sync_log` for the **mass-unpublish guard** warning. A truncated Snowflake response
can look like a flood of "sold" homes; the guard skips unpublishes but check whether an
earlier run slipped through. Recovery is to republish the legacy-live set. See
[doc 02](./02-module-ingest.md).

### "My remote migration failed but local passed"
You likely hit the **D1 100-column limit** (or another remote-only limit) that local SQLite
doesn't enforce. Split the table / move columns into a view. Always `--local` first. See
[doc 01](./01-data-flow.md).

### "An image is broken / shows a `media.esperanzahomes.com` URL"
That host is retired. Re-host the asset to R2 and update the record. Never store
`airtableusercontent.com` URLs (they expire). See [doc 06](./06-module-images.md).

### "The XML feed shows communities but no homes"
No QMI has **"Include in XML Feed"** ticked. It's a data task, not a bug. See
[doc 07](./07-module-xml-feed.md).

### "A brochure PDF is wrong / stale"
PDFs are cached in R2 and tracked in `pdf_renders`. Bump `theme_version` (design change) or
re-trigger via the entity edit / render queue. QMI PDF address comes from the **Slug**
field. See [doc 05](./05-module-pdf.md).

### "Pricing/availability is wrong on a home"
Remember `COALESCE(override_*, synced_*)`: a manual **override** in the admin wins over
Snowflake. If the override is set, Snowflake updates won't show. Clear the override to fall
back to Snowflake. See [doc 01](./01-data-flow.md).

---

## Part 2 — Command cheat-sheet

> Run these from the relevant package dir (or repo root). `--remote` hits production D1;
> omit it for your local copy. Set the bearer tokens from worker secrets / Matt.

```bash
# ── Identity / deploy ──────────────────────────────────────────────
npx wrangler whoami                       # confirm hello@hazard.house account
npx wrangler tail <worker-name>           # live logs (e.g. esperanza-ingest)

# ── D1: query the database ─────────────────────────────────────────
npx wrangler d1 execute esperanza --remote --command "SELECT count(*) FROM qmi WHERE published=1;"
npx wrangler d1 execute esperanza --remote --command \
  "SELECT started_at,status,notes,error_message FROM sync_log ORDER BY started_at DESC LIMIT 15;"

# ── D1: migrations & views ─────────────────────────────────────────
npm run db:generate                       # create migration from schema.ts changes
npm run db:migrate:local                  # apply to local D1 (ALWAYS first)
npm run db:migrate:remote                 # apply to production D1
npx wrangler d1 execute esperanza --remote --file=packages/db/views.sql --yes   # refresh views

# ── Seed admin field definitions / users ───────────────────────────
npx tsx packages/db/scripts/seed-field-definitions.ts --remote
npm run -w @esperanza/admin seed-admin -- --email a@b.com --name "A" --role admin --remote

# ── Trigger ingest (Snowflake → D1) on demand ──────────────────────
curl -X POST "https://<ingest-url>/run" -H "Authorization: Bearer $INGEST_TRIGGER_TOKEN"

# ── R2 (images / PDFs) ─────────────────────────────────────────────
npx wrangler r2 object put esperanza-cms/floor_plans/recXXXX/plan.jpg --file=./plan.jpg
npx wrangler r2 object get esperanza-cms/brand/esperanza-homes-logo.jpg --file=/tmp/logo.jpg

# ── Secrets ────────────────────────────────────────────────────────
npx wrangler secret put WEBHOOK_TOKEN     # set/rotate a worker secret (run in that package)
npx wrangler secret list                  # what's set on this worker

# ── Tests / typecheck (repo root) ──────────────────────────────────
npm test
npm run typecheck
```

### Verification habit (do this, always)
Because pushes and syncs are asynchronous (queues), **never** judge success by an HTTP code.
Judge by:
- `sync_log` rows (`source='ingest'`, `status='success'`),
- the actual row in D1 (`wrangler d1 execute … SELECT …`),
- the live site / `esperanza-api` response for site changes.

---

## Part 3 — Glossary & identifiers

### Concepts
| Term | Meaning |
|---|---|
| **D1** | Cloudflare's serverless SQLite database. Our one DB is named `esperanza`. The source of truth. |
| **R2** | Cloudflare object storage (S3-like). Our bucket is `esperanza-cms` (images + PDFs). |
| **Worker** | A serverless edge program. We have 6 (5 in the monorepo + the XML feed). |
| **Queue** | Async message pipe between workers, with retries + a dead-letter queue (DLQ). |
| **Cron trigger** | A schedule attached to a worker. |
| **OpenNext** | Tool that compiles the Next.js admin into a Cloudflare Worker. |
| **Framer** | *(retired 2026-07-06)* The old no-code host of the public website. Replaced by a static frontend (`esperanza-frontend`) served by a Cloudflare Worker at `esperanzahomes.hazardhouse.ai`, reading dynamic data from `esperanza-api`. |
| **`synced_*` / `override_*`** | Paired columns: Snowflake writes `synced_`, marketing writes `override_`; views resolve `COALESCE(override, synced)` so overrides win. |
| **`v_public_*`** | D1 views that apply override-resolution + `published=1` filtering + joins; downstream readers use these. |
| **`field_definitions`** | D1 table that drives the admin forms; a new editable field needs a row here. |
| **`sync_log`** | D1 table; one row per ingest run. Primary observability. |
| **`audit_log`** | D1 table; every admin write records who changed what. |
| **`eci_key`** | A QMI's natural key from Snowflake (CompanyCode+DevCode+HouseNumber, e.g. `006LP00000051`). |
| **BDX** | Builder Data Exchange — the XML listing format the feed emits for Zillow/Realtor/etc. |
| **Airtable** | The OLD system. Sunset 2026-06-02. Dead — never query it. |

### Workers
| Worker | Repo / package | Role | Doc |
|---|---|---|---|
| `esperanza-ingest` | `esperanza-cf` / `packages/ingest` | Snowflake → D1 (cron 4h) | 02 |
| `esperanza-admin` | `esperanza-cf` / `packages/admin` | the CMS (Next.js/OpenNext) | 03 |
| `esperanza-pdf` | `esperanza-cf` / `packages/pdf` | brochures/lists (headless Chrome) | 05 |
| `esperanza-api` | `esperanza-cf` / `packages/api` | edge read API over `v_public_*` | — |
| `esperanza-ops` | `esperanza-cf` / `packages/ops` | ops control plane (MCP + REST) | — |
| `esperanza-xml-feed` | **`esperanza-xml-feed`** (separate) | BDX listing feed | 07 |
| ~~`renderings`~~ | `esperanza-cf` / `packages/renderings` | descoped, not deployed | — |

### Queues
| Queue | Producer → Consumer |
|---|---|
| `esperanza-sync-queue` (DLQ `…-dlq`) | ingest cron → ingest consumer (apply to D1) |
| `esperanza-pdf-render` (DLQ `…-dlq`) | pdf serve/admin → pdf consumer (render PDF) |

### Key identifiers
| Thing | Value |
|---|---|
| Cloudflare account | `hello@hazard.house` (ID `c76a6d99ed7d6d45449990974f5c40b3`) |
| D1 database | name `esperanza`, id `023ea995-0abc-4165-a1e1-6e2373fc43e9` |
| R2 bucket | `esperanza-cms` |
| R2 public base | `https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev` |
| Retired image host | `media.esperanzahomes.com` (dead — do not use) |
| Snowflake | account `lu51183.us-east-2.aws`, db `RHODES_ENTERPRISES`, wh `HAZARD_HOUSE_WH` |
| XML builder number | `230` (corporate `HF-111`) |

### Secrets (where, not values)
`AUTH_SECRET`, `PDF_PREVIEW_SECRET`, `INGEST_TRIGGER_TOKEN`,
`MAILLAYER_API_KEY`, `SNOWFLAKE_PASSWORD` — set per
worker via `wrangler secret put`. Local dev values in each package's gitignored
`.dev.vars`. CI holds only `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Working values
kept locally (out of git) in `~/.claude/secrets/esperanza-cf.env`.

---
*End of packet. Back to the [README index](./README.md).*
