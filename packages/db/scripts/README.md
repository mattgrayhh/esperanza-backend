# Phase 2 — Airtable → D1 import + images → R2

One-time migration scripts that read every record from Airtable base
`app2WqQR75HFBQp73` (paginating REST, **not** MCP, past the 94-record cap), map each
field into its bucketed D1 column, migrate attachment / expiring image URLs to R2,
and write to D1 idempotently.

```
scripts/
  import-from-airtable.ts   # deliverable 1 — full importer
  migrate-images.ts         # deliverable 2 — image → R2 migrator (standalone)
  verify-import.ts          # deliverable 3 — verify step (counts / overrides / no signed urls)
  tsconfig.json             # node-typed tsconfig for the scripts
  lib/
    airtable.ts   # paginating REST reader (offset loop, retries/backoff)
    coerce.ts     # value coercion (numbers, checkboxes, links, attachments, FP:* arrays, url guard)
    mappers.ts    # one Airtable-record → bucketed-D1-row mapper per entity
    d1.ts         # D1 write sink (wrangler d1 execute --file) + buildUpsert
    r2.ts         # download + wrangler r2 object put + stable-url logic
    images.ts     # per-entity image-column resolution pass + signed-url stripping
    cli.ts        # tiny arg parser + formatters
```

## How to run

All commands run **from `packages/db/`**. Set the PAT in env or `packages/db/.dev.vars`
(`AIRTABLE_PAT=...`) — never hardcoded, never committed.

```bash
# 0. apply the schema first (creates the esperanza D1 + tables)
npm --prefix ../.. run db:migrate:local     # or db:migrate:remote

# 1. dry run — fetch + map + plan, write NOTHING (no PAT writes, no uploads)
AIRTABLE_PAT=pat... npm run import:dry

# 2. real import into LOCAL D1 (images migrated inline by default)
AIRTABLE_PAT=pat... npm run import -- --local

# 2b. real import into REMOTE (edge) D1
AIRTABLE_PAT=pat... npm run import -- --remote

# 3. (optional) standalone image migration — re-reads Airtable for FRESH signed urls
AIRTABLE_PAT=pat... npm run migrate-images -- --remote
AIRTABLE_PAT=pat... npm run migrate-images:dry          # report only

# 4. verify
AIRTABLE_PAT=pat... npm run verify -- --remote           # full cross-check vs Airtable
npm run verify -- --remote --dry-run                     # D1-only checks (PAT already revoked)

# typecheck the scripts
npm run scripts:typecheck
```

### Importer flags
| flag | meaning |
|---|---|
| `--local` / `--remote` | target local SQLite copy or remote edge D1 (default `--local`) |
| `--dry-run` | fetch + map + would-migrate; print the plan, write nothing |
| `--skip-images` | do NOT migrate images inline; NULL any unmigrated signed urls and run `migrate-images.ts` afterwards |
| `--only=qmi,communities` | import a subset of entities |
| `--sink=wrangler\|sqlite` | D1 write path (default `wrangler`); `sqlite` needs `--sqlite-path` |
| `--sqlite-path=PATH` | throwaway `.sqlite` for `sink=sqlite` |
| `--chunk=200` | statements per `wrangler d1 execute --file` batch |
| `--bucket=esperanza-cms` | R2 bucket name |

`migrate-images.ts` adds `--from-db` (migrate non-stable urls in the *current D1 rows*
instead of re-reading Airtable — a safety net for `import --skip-images` runs).

## Decisions (documented per the task)

**D1 write path = `wrangler d1 execute --file`.** Both `--local` and `--remote` go
through the same code path: the sink renders each parameterized statement to a
literal-quoted `.sql` batch file and runs
`npx wrangler d1 execute esperanza --local|--remote --file=<batch.sql> --yes`. This is
the same mechanism `wrangler d1 migrations apply` uses, so the import hits the **real**
D1 (the local SQLite copy under `.wrangler/state` or the edge DB) with no extra deploy
and no guessing the local DB file path. `better-sqlite3` is still wired in (`--sink=sqlite`,
plus the test/verify harness) for a throwaway local file, but the default is wrangler so
local and remote behave identically. Statements are quote-escaped (`'` → `''`, NULL/number/
boolean literals) — verified against the live schema.

**Idempotent** — every write is `INSERT … ON CONFLICT(id) DO UPDATE` keyed on the Airtable
record id (which is reused verbatim as the D1 `id`). Re-running is safe. `promotion_targets`
are rebuilt per promo (`DELETE` then re-`INSERT … ON CONFLICT DO NOTHING`).

**CDN base = `media.esperanzahomes.com`** (the schema/README/invariant-test standard).
The task referenced `cdn.esperanzahomes.com`; both hosts are accepted as already-stable.
To emit `cdn.` instead, set `CDN_BASE_URL=https://cdn.esperanzahomes.com`. R2 keys are
`<entity>/<id>/<filename>`.

**Image URL safety.** Permanent url-typed fields (`image_url`, `og_image_url`, `page_url`)
pass through. Attachment fields and any `v5.airtableusercontent.com` signed url are
downloaded and re-uploaded to R2; only the stable url is persisted. A hard guard
(`findAirtableUrl`) runs on every row before write — if a forbidden url somehow remains,
the offending column is NULLed and the run is flagged `partial` (exit 2). An
`airtableusercontent.com` url is **never** stored.

**Links resolve by ID, not text.** QMI→FP/Community/City, Community→City, and
Testimonial→FP/Community all resolve via the Airtable linked-record id fields
(`firstLinkId(fields['... (Link)'])`). Any linked id absent from the imported set is
collected and logged (`unresolved links` in the summary + `sync_log.unresolved_links`),
never silently dropped.

**override_price seeding.** `override_price` is seeded **only** where Airtable
`Price != last_synced_price` (a human edited the price); `override_price_at` is the import
timestamp and `override_price_by = 'airtable-import'`. All **other** `override_*` columns
import as `NULL` by design (effective value falls back to `synced_*`). `synced_price` is
the current Airtable `Price`; `last_synced_price` is carried verbatim so the next Snowflake
ingest's divergence check behaves identically to today.

## Promotions targeting translation (best-effort — assumptions)

The legacy model spread targeting across three independent linked-record columns
(`Community`, `Floor Plan`, `Collection`) plus a non-authoritative `Applies To` select.
The importer translates that into explicit `promotion_targets` rows:

- **Community link** → `target_type='community', target_id=<communityId>` (one row each).
- **No links + `Applies To` = `Sitewide`/empty** → `target_type='global'`.
- **Floor Plan / Collection links** → **no target row emitted** and **logged for manual
  review** (`promotions.<field>(no-scope)` in the unresolved-links report). Rationale: the
  new model's scopes are `global | city | community | qmi`. A floor-plan-scoped promo would
  need to fan out to *every QMI on that plan* (which the importer can't authoritatively do
  here), and there is no `collection` scope at all. These are surfaced so marketing can
  re-tag them in the admin's scope picker.
- `applies_to` is still stored on the promotion row as an informational label.
- `active` is driven by the `Published` checkbox only (the live `Active` field does not
  exist); `start_date`/`end_date` (`Expiration Date`) are carried and are **enforced** by
  the read-time resolver (`lib/promo.ts`), unlike the legacy system.

## Verify assertions (deliverable 3)

`verify-import.ts` asserts:
1. **Counts match** — D1 `COUNT(*)` per table == Airtable record count per table
   (and prints the plan headline ~324 QMI / ~127 published for eyeballing).
2. **override_price count == diverged-price count** — re-derives the diverged set from
   Airtable (`Price != last_synced_price`) and compares to
   `COUNT(qmi.override_price IS NOT NULL)`. With `--dry-run` it instead checks every seeded
   override is fully stamped.
3. **Zero `airtableusercontent.com` urls** persisted in any TEXT column of any table.

Exit 0 = all green; non-zero = at least one assertion failed.

## Status of local verification

`npm run scripts:typecheck` (tsc --noEmit) → **clean**. A smoke harness exercised the real
mapping → guard → upsert path against an in-memory SQLite DB built from
`migrations/0000_init.sql` (31/31 assertions: override seeding, checkbox semantics, numeric
postal_code, FP:* JSON preservation, signed-url stripping, link-by-id, HOA/coords derivation,
promotion_targets translation, idempotent re-run, full-DB url scan). The rendered
`wrangler --file` SQL was confirmed to execute against the live schema with quote-escaping
intact. The live `--local`/`--remote` runs additionally require a Cloudflare login + a
provisioned `esperanza` D1 / `esperanza-cms` R2 (operator runbook step 1) and `AIRTABLE_PAT`.
