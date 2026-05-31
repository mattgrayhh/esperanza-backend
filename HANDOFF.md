# Esperanza Cloudflare Migration + Admin — HANDOFF

_Last updated 2026-05-31. This is the entry point for the next agent. Also read the auto-memory at `~/.claude/projects/-Users-mgd/memory/` — `project_esperanza_cf_migration.md` is the running log, and the `reference_*` files capture the gotchas below._

## What this is
Replacing Airtable with a **100% Cloudflare** stack for Esperanza Homes (Rhodes subsidiary): **D1** (data) + **R2** (images) + **Workers/Queues/Cron** (sync) + a **Next.js 15 / OpenNext admin** (the editorial layer for the marketing team). Public read path is edge-served; the Framer site reads it. Site is **pre-launch** (cold-swap acceptable).

- **Repo:** `~/Dropbox/Claude Projects/esperanza-cf` (npm workspaces; **git-init'd**, commits are checkpoints; latest ≈ `9052fef`). Spec: `docs/specs/2026-05-31-field-builder-design.md`. Operator runbook: `README.md` §0–§9.
- **Verify any time (all green as of handoff):** `npm run typecheck` (6 pkgs, exit 0), `npm test` (**169 tests**), `npm run -w @esperanza/admin build:cf` (OpenNext build).
- **Deploy a worker:** `npm run -w @esperanza/<pkg> deploy` (admin = OpenNext build+deploy).

## Live resources (operator's Cloudflare account)
- **D1 `esperanza`** `database_id=023ea995-0abc-4165-a1e1-6e2373fc43e9` (region ENAM). Migrations 0000 (schema), 0001 (admin_users), 0002 (field_definitions + custom_fields) applied **local + remote**.
- **R2 `esperanza-cms`** — public via **r2.dev**: `https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev` (zone `esperanzahomes.com` is NOT on this account, so no custom domain yet). `IMAGES_PUBLIC_BASE_URL` = this. ~2,900 images migrated.
- **Queues:** `esperanza-sync-queue`(+dlq), `esperanza-framer-queue`(+dlq).
- **`esperanza-api`** DEPLOYED: `https://esperanza-api.round-base-ed8c.workers.dev` — public read API, validated against the live cache-worker golden (128 published QMIs, promo resolution, r2.dev images, 0 expiring URLs).
- **`esperanza-admin`** DEPLOYED: `https://esperanza-admin.round-base-ed8c.workers.dev` — Auth.js v5 login. Bootstrap user **matt@hazard.house** (role `admin`); password was set this session and is in the transcript → **rotate it** via `npm run -w @esperanza/admin seed-admin -- --email matt@hazard.house --password 'NEW' --remote`. `AUTH_SECRET` set.
- **`esperanza-ingest`** built, NOT cron-active (account caps at **5 cron triggers**, all held by legacy workers; freed at cutover). **`esperanza-framer-push`** built, NOT deployed-active (its `*/5` cron mutates the live Framer CMS — only deploy after §8 audit). **`esperanza-renderings`** = stub (DESCOPED).

## Data model (the keystone)
- **3 ownership buckets:** (a) Snowflake-synced + override = QMI pricing/availability fields (`synced_*`/`override_*`; only `price` has the `last_synced_price` shadow) + `communities.square_footage_range`; (b) external = floor-plan renderings; (c) **admin-owned** (D1 = source of truth) = everything else. Ingest writes ONLY an allow-list of synced columns; admin owns the rest. `published` precedence: ingest may force `=0` (sold) only; admin owns `=1`.
- **v_public_* views** COALESCE override over synced; `v_public_qmi` resolves `fp_*` (floor-plan lookups incl. `fp_image`) via a JOIN to `floor_plans` (NOT denormalized columns — D1 caps tables at 100 cols).
- **Promotions targeting** = `promotion_targets` (target_type global|city|community|qmi); the api resolves the effective promo per entity by specificity.
- **Housemaster # = `qmi.housenumber`** (e.g. 00000149) = the Snowflake match key; `eci_key`/`mark_job_number` are detail-only.
- **Field Builder (Phase A):** `field_definitions` registry (197 rows, seeded from the old static config) now drives the generic admin form/list; user-added fields store values in a `custom_fields` JSON column. Synced fields flagged `system` (locked).

## Status by area
| Area | State |
|---|---|
| D1 schema + import (all 9 entities, ~2900 images) | ✅ live |
| `esperanza-api` (read path) | ✅ deployed + validated |
| `framer-push` (D1→Framer, 9 collections) | ✅ built; deploy at cutover |
| `ingest` (Snowflake→D1) | ✅ built; cron blocked until cutover |
| Admin: shadcn re-skin (@efferd base-nova + bundui), Geist | ✅ live |
| Admin bespoke: QMI list + real-estate detail; Images DAM; Blogs list+calendar | ✅ live |
| Admin: Auth.js v5 (Credentials, D1 admin_users) | ✅ live |
| Field Builder Phase A (data-driven engine) + B (Settings→Fields UI, rich-text/select/currency widgets, custom_fields) | ✅ live |
| UX feedback batch 1 (~25 notes) | ✅ live |
| Dev feedback tool (⌘⇧K / ?feedback=1 → MD) | ✅ live (being packaged as the `/vr` skill) |

## NEXT (in priority order)
1. **Field Builder Phase C — Framer schema sync.** Wire a field add/retype to call `setFields` on the matching Framer Managed collection (via the `framer-api` headless-plugin session that `framer-push` already uses — `packages/framer-push/src/framer.ts`), store `framer_field_id` back on `field_definitions`, then `framer-push` upserts include custom values from `custom_fields`. Type map + destructive-change confirm + pending-sync retry. (Spec §Phase C.) Today the builder updates the admin instantly but changes don't reach Framer.
2. **RBAC (Stage 5, fully specced in memory).** 3 roles: Full Admin / Marketing Admin / General Marketing. `can(role,capability)` enforced at nav + route + **server-action** layer + a user-management UI (retire the CLI seed). Matrix: content+images+publish = all; KPI dashboard = admin+marketing_admin; data-feed/admin settings = admin only; user mgmt = admin(all)/marketing_admin(general only). General Marketing CAN publish; Marketing Admin manages General users (not admins). `admin_users.role` + `isAdmin()` helper already exist.
3. **Remaining UX feedback** (`~/Downloads/admin-feedback.md`, 44 notes; ~25 done). Field-builder-native (group/accordion [20,24], more removals/retypes) can be self-served. Design-chat items: **tri-state status** Coming Soon/Live/Draft (schema + admin + Framer; replaces the `published` bool), **true gallery** (Main/Secondary/Thumbnail + drag, pick from DAM) [25,31], **collections cards** [38], **image titles + sort facets** [39,40], **promo on-site previews + rename "Promotion Location"** [36,37], **logo upload** [3], **Blogs WordPress split view** [41], **Cities visual layout** [28,29], **energy calculator** [35], inline toggle in communities list [7].
4. **Public-site go-live cutover (README §7–§9):** free 2 cron slots (disable legacy `esperanza-data-sync` + `esperanza-framer-sync`) → deploy `ingest` + `framer-push` → run `/audit-sync-fields` (confirm Framer field IDs match before any push) → flip the 5 Framer code components + XML feed from the legacy cache endpoints to `esperanza-api` (keep legacy crons disabled-not-deleted as rollback). Then decommission Airtable.

## Known gotchas (verify these still apply; see memory `reference_*`)
- **D1 caps tables at 100 columns** — better-sqlite3 tests don't catch it; always `wrangler d1 migrations apply --local` before `--remote`.
- **Workers PBKDF2 max 100,000 iterations** — auth password hashing is pinned to 100k (vitest on Node allows more, so unit tests miss it).
- **Tailwind v4:** never `@theme inline { --font-sans: var(--font-sans) }` (circular → empty → body falls back to Times). Font tokens live in non-inline `@theme`.
- **Airtable attachments → R2:** store only `{url,filename}` (full attachment objects carry nested `thumbnails.*.url` expiring URLs); retry `r2 object put` (transient code 10001).
- **Account 5-cron-trigger limit** (blocks ingest/framer-push until legacy crons are disabled).
- **Next static-segment precedence:** bespoke `app/qmi|images|blogs/*` shadow `app/[entity]/*` — each MUST also provide `[id]` + `new` routes or they 404.
- **Latent (flagged, not fixed):** `build-edit-view` reads real-column values as `row[snake_case]` but Drizzle bare `select()` returns camelCase keys — multi-word columns (e.g. `featured_image_url`) may render blank in the GENERIC edit form. Worth checking; custom_fields reads already use the camelCase property.
- **`@efferd` shadcn registry is paid** — `EFFERD_REGISTRY_TOKEN` env + `components.json registries` (Bearer header). bundui kit (github.com/bundui/shadcn-ui-kit-dashboard) is the open-source source for bespoke layouts.

## How edits get made now
The marketing team (or you) review the deployed admin with the **dev feedback tool** (⌘⇧K or `?feedback=1`), drop notes, Save to `.md`; the engineer reads that file and batch-applies. (Being packaged as the global `/vr` skill.)
