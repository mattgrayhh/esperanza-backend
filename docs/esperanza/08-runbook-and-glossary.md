# 08 — Troubleshooting Runbook & Glossary

Keep this open while you work. Part 1 is "symptom → cause → fix." Part 2 is the cheat-sheet
of commands. Part 3 is the glossary of every name and identifier in the system.

---

## Part 1 — Symptom → likely cause → fix

### "I edited a field in the admin but the website didn't change"
1. Did framer-push actually push? Check `sync_log` (`source='framer'`) for a recent
   `success` row. If nothing, the queue may be backed up — `wrangler tail
   esperanza-framer-push`.
2. Is the Framer **page** bound to the field? framer-push only fills the CMS field; an
   operator still has to bind that field on the Framer page layout. New fields often aren't
   bound yet.
3. Is there a **stale redirect** shadowing the page? Some legacy URLs 308-redirect and hide
   the live CMS page. That's a Framer/operator config issue.
4. Is the page driven by a **no-code Fetch** (e.g. company rates, or a community's resolved
   promo banner/badge) rather than CMS? Those read `esperanza-api` (`/api/public/<entity>`),
   which caches each entity (qmi 60s, the rest 300s). Admin writes now auto-purge that cache
   (`postWrite` → `purgePublicCache`; promotions edits also purge `communities`/`cities`/`qmi`
   because the resolved promo is flattened onto those). If a Fetch-driven surface still lags,
   the purge is best-effort and the TTL (≤5 min) is the backstop — wait it out or hit
   `GET {API_PUBLIC_URL}/api/public/<entity>?purge=1`.

### "A whole collection stopped updating in Framer"
Almost always a **field-type mismatch**: `field_definitions.framer_type` (D1) ≠ the live
Framer field type, so `addItems` throws and aborts the batch. The error names the *item*,
not the field. Fix: reseed the correct `framer_type` in D1, then `POST /schema` to re-type
the Framer field, then `POST /backfill`. See [doc 04](./04-module-framer-push.md).

### "I added a field but it's not in the admin form"
You deployed code but didn't **seed a `field_definitions` row**. Run
`npx tsx packages/db/scripts/seed-field-definitions.ts --remote`. See
[doc 03](./03-module-admin.md).

### "The home catalog suddenly looks empty / way fewer homes"
Check `sync_log` for the **mass-unpublish guard** warning. A truncated Snowflake response
can look like a flood of "sold" homes; the guard skips unpublishes but check whether an
earlier run slipped through. Recovery is to republish the legacy-live set. See
[doc 02](./02-module-ingest.md).

### "`/backfill` curl hung up / 'Connection closed'"
Large collection (QMI ~350). The worker is probably still finishing. Re-run with
`--max-time 500` and **verify in `sync_log`**, not the curl exit code. A 0-row "closed"
result is usually harmless. See [doc 04](./04-module-framer-push.md).

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
npx wrangler tail <worker-name>           # live logs (e.g. esperanza-framer-push)

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

# ── framer-push: backfill / re-type / re-run ───────────────────────
curl --max-time 500 -X POST "https://<framer-push-url>/backfill?keys=qmi,communities" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN"
curl -X POST "https://<framer-push-url>/schema" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" -H "Content-Type: application/json" \
  -d '{"collection":"qmi","fields":[{"key":"my_field","framer_type":"string"}]}'
curl -X POST "https://<framer-push-url>/cron" -H "Authorization: Bearer $WEBHOOK_TOKEN"

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
- `sync_log` rows (`source='ingest'` or `source='framer'`, `status='success'`),
- the actual row in D1 (`wrangler d1 execute … SELECT …`),
- the actual item in the Framer CMS for site changes.

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
| **Framer** | The no-code site builder hosting the public website; has a CMS we push into. |
| **Managed collection** | A Framer CMS collection whose schema/data is owned by the API (framer-push). Field types can't be changed in the Framer UI — only via `POST /schema`. |
| **`synced_*` / `override_*`** | Paired columns: Snowflake writes `synced_`, marketing writes `override_`; views resolve `COALESCE(override, synced)` so overrides win. |
| **`v_public_*`** | D1 views that apply override-resolution + `published=1` filtering + joins; downstream readers use these. |
| **`field_definitions`** | D1 table that drives the admin forms; a new editable field needs a row here. |
| **`sync_log`** | D1 table; one row per ingest run / framer-push batch. Primary observability. |
| **`audit_log`** | D1 table; every admin write records who changed what. |
| **`eci_key`** | A QMI's natural key from Snowflake (CompanyCode+DevCode+HouseNumber, e.g. `006LP00000051`). |
| **BDX** | Builder Data Exchange — the XML listing format the feed emits for Zillow/Realtor/etc. |
| **Airtable** | The OLD system. Sunset 2026-06-02. Dead — never query it. |

### Workers
| Worker | Repo / package | Role | Doc |
|---|---|---|---|
| `esperanza-ingest` | `esperanza-cf` / `packages/ingest` | Snowflake → D1 (cron 4h) | 02 |
| `esperanza-admin` | `esperanza-cf` / `packages/admin` | the CMS (Next.js/OpenNext) | 03 |
| `esperanza-framer-push` | `esperanza-cf` / `packages/framer-push` | D1 → Framer | 04 |
| `esperanza-pdf` | `esperanza-cf` / `packages/pdf` | brochures/lists (headless Chrome) | 05 |
| `esperanza-api` | `esperanza-cf` / `packages/api` | edge read API over `v_public_*` | — |
| `esperanza-xml-feed` | **`esperanza-xml-feed`** (separate) | BDX listing feed | 07 |
| ~~`renderings`~~ | `esperanza-cf` / `packages/renderings` | descoped, not deployed | — |

### Queues
| Queue | Producer → Consumer |
|---|---|
| `esperanza-sync-queue` (DLQ `…-dlq`) | ingest cron → ingest consumer (apply to D1) |
| `esperanza-framer-queue` (DLQ `…-dlq`) | admin + ingest → framer-push (push to Framer) |
| `esperanza-pdf-render` (DLQ `…-dlq`) | pdf serve/admin → pdf consumer (render PDF) |

### Key identifiers
| Thing | Value |
|---|---|
| Cloudflare account | `hello@hazard.house` (ID `c76a6d99ed7d6d45449990974f5c40b3`) |
| D1 database | name `esperanza`, id `023ea995-0abc-4165-a1e1-6e2373fc43e9` |
| R2 bucket | `esperanza-cms` |
| R2 public base | `https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev` |
| Framer project id | `t47CBg6stJkC8hsPgamo` |
| Retired image host | `media.esperanzahomes.com` (dead — do not use) |
| Snowflake | account `lu51183.us-east-2.aws`, db `RHODES_ENTERPRISES`, wh `HAZARD_HOUSE_WH` |
| XML builder number | `230` (corporate `HF-111`) |

### Secrets (where, not values)
`AUTH_SECRET`, `PDF_PREVIEW_SECRET`, `WEBHOOK_TOKEN`, `INGEST_TRIGGER_TOKEN`,
`MAILLAYER_API_KEY`, `SNOWFLAKE_PASSWORD`, `FRAMER_API_KEY`, `FRAMER_PROJECT_URL` — set per
worker via `wrangler secret put`. Local dev values in each package's gitignored
`.dev.vars`. CI holds only `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Working values
kept locally (out of git) in `~/.claude/secrets/esperanza-cf.env`.

---
*End of packet. Back to the [README index](./README.md).*
