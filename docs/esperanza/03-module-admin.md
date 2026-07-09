# 03 — Module: Admin Panel

**Worker:** `esperanza-admin` · **Package:** `packages/admin` · **Stack:** Next.js 15
(App Router) deployed to Cloudflare via **OpenNext**.

This is the CMS marketing uses to edit all nine content entities. It's the **only write
path** into D1 for human-authored content. Every write it makes (a) records an audit-log
row and (b) enqueues a Framer push.

> Running it locally and the env/secrets gotchas are in
> [doc 00 §5–6](./00-setup-and-access.md). This doc is about how it works and how to change
> it.

---

## Deploy & build

OpenNext compiles the Next.js app into a Worker. The commands:

```bash
cd packages/admin
npm run dev        # local Next.js dev server (localhost:3000)
npm run preview    # opennextjs-cloudflare build && preview  (runs the compiled worker locally)
npm run deploy     # opennextjs-cloudflare build && deploy   (what CI runs on merge to master)
```

Note it deploys via `npm run deploy` (OpenNext), **not** a raw `wrangler deploy`.

---

## Authentication

- **Auth.js v5 (NextAuth), Credentials provider + JWT session.** Not Cloudflare Access.
- Users live in the **`admin_users`** D1 table; passwords are **PBKDF2** hashed
  (`lib/password.ts`).
  > ⚠️ Cloudflare's runtime (workerd) caps PBKDF2 at **100,000 iterations** and throws
  > above it. Node/vitest allow more, so a unit test can pass while production throws. Keep
  > iterations ≤ 100k and test against the worker runtime.
- Login flow: `POST /api/auth/callback/credentials` → `authorizeCredentials()` verifies the
  hash → issues a JWT cookie signed with `AUTH_SECRET`. `middleware.ts` checks the JWT on
  every request and redirects to `/login` if missing.
- **Roles:** `admin` | `editor`. The Field Builder (settings) is gated to `admin`.
- **Local dev bypass:** set `ADMIN_DEV_EMAIL` in `.dev.vars`; only works under `next dev`,
  hard-disabled in production.
- **Password emails** go out via **MailLayer** (`lib/maillayer.ts`, needs
  `MAILLAYER_API_KEY`); if email fails the generated password is shown on screen.

**Seed / create a user:**
```bash
npm run -w @esperanza/admin seed-admin -- \
  --email alice@example.com --name "Alice" --role admin [--password P] [--remote]
```
Omit `--remote` to seed your local D1; include it to create a real production login.

---

## Unified record edit shell

Every record detail screen (generic `EntityEditForm`, bespoke QMI, bespoke Community)
shares one layout:

| Region | Component | Purpose |
|---|---|---|
| Breadcrumb | `RecordEditBreadcrumb` | `{Collection} › {Record name}` |
| Sticky action bar | `StickyActionBar` | Save, last-save message; delete (generic entity) when applicable |
| Main column | entity fields + section cards | Editable content; MarkSystems synced fields collapse under **From MarkSystems** |
| Placement rail | `PlacementRail` | **Publish/status toggle**, visitor URL, copy/open-live, section map; community edit adds Media (logo, video, full gallery) then **Recent activity** as the last rail block |
| Toast | `EditToast` | Brief save confirmation (4s) |
| Leave guard | `UnsavedLeaveToast` | When the form is dirty, blocks in-app navigation (links, browser back) with Save / Discard / Stay; tab close/refresh uses the browser `beforeunload` prompt |

`useEditSaveFeedback` tracks dirty state from form `input`/`change` events, drives the sticky bar status (`Unsaved changes` / `Saved … ago`), and wires the leave guard. **Save** on the leave toast submits the page form and navigates after a successful save; **Discard** clears dirty state and completes the pending navigation.

Live URLs are built in `lib/live-site.ts` from `https://www.esperanzahomes.com` + paths
that mirror `packages/api/src/sitesearch.ts` (QMI uses `qmiPublicSlug` for underscore
slugs). `buildEditView`, `buildQmiDetailView`, and `buildCommunityDetailView` each attach
a `liveSite` placement object the shell consumes.

Media uploaders stay **inside** the page `<form>` so they submit with the main Save. The
**bespoke community** editor adds a **site header preview** at the top of the form
(`CommunitySiteHeader`): 2/3 featured image, 1/3 secondary + photo-gallery thumbnail — matching
the live community page layout with admin card styling (rounded corners, gap, bordered slots);
drag onto any panel to replace. Logo, featured video, and the ordered **Photo Gallery** (`photo_gallery_json`) stay in the placement rail Media card; **Description image** sits directly under **Description** in Community Details.

**Side widgets on main Save:** Promotion targeting (`__promo_targets`), community HOA links
(`__hoa_links`), and community floor-plan membership (`__community_floor_plans`) mirror
into the edit form as hidden JSON fields. The page's primary **Save changes** persists them
alongside column edits — standalone save buttons on those widgets are hidden by default.

---

## Field-driven forms (`field_definitions`)

The edit and list screens are **rendered from the `field_definitions` D1 table**, not from
hard-coded JSX. `resolveFieldConfig(entityKey)` (`lib/field-config-source.ts`) reads the
rows for an entity, ordered by `sort`, and builds the form. If an entity has **zero** rows,
it falls back to the static config in `lib/field-config.ts` (so the form is never empty).

Field `type` → widget mapping (`typeToWidget()`):

| `type` | Widget |
|---|---|
| `text`, `long`, `number`, `currency`, `bool`, `date`, `url`, `select` | `GenericField` |
| `rich` | `RichTextEditor` — universal TipTap WYSIWYG (headings, bullet/numbered lists, bold/italic, links, quotes, inline R2 images) for ALL rich fields |
| `image` | `ImageUploader` — rail: full-width vertical preview (`compact`); main form: horizontal `sm` row |
| `imageGallery` / `elevationGallery` | `ImageGalleryEditor` / elevation grid editor |
| `syncedOverride` (QMI etc.) | `SyncedOverrideField` — shows the Snowflake `synced_` value + an override box |
| bespoke: `hoaLinks`, `jsonBlocks`, `promoScopeTag`, `communityFloorPlans` | custom editors with their own save buttons |

#### Rich-text editor (`RichTextEditor`)
Every `rich` field (community description/amenities, the floor-plan `*_rich` copy blocks,
city venue copy, blog content, …) uses one TipTap WYSIWYG so marketing formats content
visually — no markdown syntax. Notes:
- **Storage = Framer-safe HTML** (`h1`–`h4`, `p`, `strong`, `em`, `a`, `ul`, `ol`, `li`,
  `blockquote`, `br`, `img`). TipTap's schema constrains output; `saveEntity` also runs
  `sanitizeRichHtml` (strips `<script>/<style>/<iframe>/on*=`) as a second line of defense.
- **Legacy values were markdown** (e.g. amenities `- bullet`). `lib/markdown.ts:toEditorHtml`
  converts markdown→HTML on load so it renders correctly; the field is rewritten as HTML on
  the next save (progressive migration — no bulk data change needed).
- **framer-push `ftIf`** is HTML-aware: passes HTML through, falls back to markdown→HTML for
  any not-yet-edited value. So the swap is backward compatible; no Framer field re-type
  (these stay `formattedText`) and no mandatory backfill.
  - **Exception — `qmi.description`:** this one was a plain `textarea` pushed via `sIf`
    (Framer `string`), so promoting it to the rich editor (+ `ftIf`) **does** require a
    one-time Framer re-type. On the QMI detail screen the Description editor overrides the
    floor-plan copy: leave it blank and the linked plan's description flows through (shown
    read-only beneath the editor); set it to reformat that copy for this home — e.g. turn
    the features into a real bullet list. The fallback now renders markdown too, so a plan
    whose copy is `- Feature` lines shows bullets even without an override. Rollout order
    (the field type must match before the batch, per the framer-push golden rule):
    reseed `field_definitions` `--remote` → `/push-schema` (re-types `qmi.description`
    `string`→`formattedText`) → deploy → `/backfill?keys=qmi` (long timeout, ~356 homes).
  - **`qmi.floor_plan_image` (optional home override):** blank inherits the linked plan's
    top-down layout (`floor_plans.floor_plan_image` via JOIN). Upload on the QMI media rail
    only when the production home differs from the standard plan sketch — same override
    pattern as description. framer-push emits `COALESCE(qmi override, plan default)`.
  - **QMI site header:** the detail page opens with a live-site hero preview (main image
    2/3 + gallery photos 2 and 3 in the right column), matching the community editor
    pattern. Address + Available now badges live in the sticky action bar (not
    duplicated under Overview). Overview stats: beds / baths / Total SqFt / Living SqFt,
    then a second-row price box with pencil override (`QmiPriceOverrideStat` — same
    `price` submit contract as SyncedOverrideField; not duplicated under MarkSystems).
    Floor Plan Assignment lives in the collapsed MarkSystems panel.
  - **QMI listing card preview:** Marketing opens with a live-style listing card
    (`QmiListingCardPreview`) above Incentive. Hover/focus Incentive, Availability Text,
    Available Now, or Self Tour Available spotlights the matching banner (tan incentive,
    gray/green availability, self-tour + house icon) while the rest of the image fades.
    Edits update the preview live; Available Now forces a green **AVAILABLE NOW** banner.
- **Toolbar offers H1/H2/H3 + Body.** H1 is available because it was requested, but a Framer
  page already has its own page-title H1 — prefer H2/H3 for in-body section headings to avoid
  duplicate-H1 SEO.
- **Inline image upload** needs the record id (R2 key `<entity>/<id>/…`); on the few detail
  screens that render a field without an id the image button is hidden (text formatting still
  works).

### ★ Adding a new editable field (the standard procedure)
A new field is **two changes**, code + data:

1. If it's a real DB column, add it to the schema + migration (`packages/db`) and run
   migrations (doc 01).
2. **Seed a `field_definitions` row** so the admin renders it. The seed script reads the
   static config and upserts rows (idempotent on `UNIQUE(entity, key)`):
   ```bash
   npx tsx packages/db/scripts/seed-field-definitions.ts --remote   # or --local
   ```
   Without this row, the field **will not appear** in the live admin even though your code
   is deployed. (This is the #1 "I added a field but can't see it" gotcha.)
3. If the field should reach the website, also map it in framer-push and create the Framer
   field (doc 04).

To add a brand-new field **type** (not just a field), touch `lib/field-builder.ts`
(`FIELD_TYPES`), `lib/field-config-source.ts` (`typeToWidget`), and the form handling in
`lib/actions.ts`, plus a new widget component under `components/fields/`.

---

## On every write: audit log + Framer enqueue

All writes go through Server Actions in **`lib/actions.ts`**, which call `postWrite()`
after the D1 commit. `postWrite()`:
- inserts `audit_log` rows — `{entity, entityId, field, action, oldValue, newValue, actor,
  created_at}` — chunked at **≤14 rows per INSERT** (D1 bind-parameter limit;
  `lib/audit-chunk.ts`);
- enqueues `env.FRAMER_QUEUE.send({collection, action:'upsert', id})` so framer-push
  re-reads the row and updates Framer;
- for entities with brochures, marks PDFs stale via the render queue.

`actor` is the logged-in user's email from the Auth.js session.

---

## Dashboard (`/`)

Operator worklist, not a scoreboard. Layout (top → bottom):

1. **Needs attention** — actionable tiles only (homes ready to publish, drafts in the
   readiness funnel, Framer sync failures). Empty state is an explicit “All clear.”
2. **At a glance** — QMI published/ready/in-progress bar + compact community and
   promotion counts.
3. **Recent activity** + **All collections** jump list.

QMI readiness gates (unpublished homes): house number present, complete published floor
plan, live PDF render. Data is server-rendered from D1 in `app/(app)/page.tsx`.

---

## Status page (`/status`)

Infra / site-service health for the stack marketing and ops rely on. Entry points:

- **Header pill** (top-right of `AppHeader`) — colored status indicator + “Status”;
  overall health drives the pill tone (green / amber / rose / sky). Not in the sidebar.

Page layout mirrors a public status page: overall banner (“All Systems Operational”),
then grouped components with a 90-day uptime bar each.

| Group | Components (placeholders today) |
|---|---|
| Snowflake / MarkSystems | Snowflake, MarkSystems |
| Cloudflare | `esperanza-admin`, `esperanza-ingest`, `esperanza-framer-push`, `esperanza-api`, `esperanza-pdf`, `esperanza-ops`, `esperanza-xml-feed`, `rhodes-availability`, D1 `esperanza`, R2 `esperanza-cms` |
| Website | `esperanzahomes.com` (future: ping every few minutes) |
| Site services | Lotvue, HubSpot, Mapbox |

**Data:** `lib/status-page.ts` → `getStatusSnapshot()`. All rows are **placeholders** until
Sentry (and a website ping checker) are wired; keep the snapshot shape stable when swapping
the feed. UI: `components/status-page-view.tsx`, header pill: `components/status-header-pill.tsx`.

---

## Image upload

- **Bucket:** R2 `esperanza-cms` (binding `IMAGES`); public base URL
  `https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev`.
- Three upload helpers in `lib/actions.ts`:
  - `uploadImage()` — store file + write the stable URL into a D1 column. Key:
    `<entity>/<id>/<filename>`.
  - `uploadGalleryImage()` — gallery images; returns the URL (caller stores it in the
    gallery JSON). Used by `ImageGalleryEditor`.
  - `uploadBlockImage()` — images embedded in JSON content blocks.
- **Validation rejects `airtableusercontent.com` URLs** — those are expiring signed URLs
  and must never be persisted (doc 06).

---

## The nine entities (`lib/entities.ts`)

`qmi`, `communities`, `cities`, `floor_plans` (publishable), `blogs` (Draft/Published/
Scheduled), `promotions`, `collections`, `images` (DAM), `testimonials` (non-publishable).
Each registry entry: `{key, label, segment, table, publishable}`.

---

## Help/Knowledge-Base (and the rule that comes with it)

Marketing-facing help articles live in `packages/admin/help-content/*.md` (YAML
frontmatter: `slug`, `title`, `category`, `entity`, …). A codegen step
(`scripts/generate-help.ts`, run via `npm run gen:help`, auto-run by `predev`/`predeploy`)
compiles them into `lib/help-content.generated.ts`, rendered at `/help`.

> 📌 **KB-sync rule:** any change to an admin feature, flow, or function **must include a
> knowledge-base update in the same change.** Code change + KB update are one atomic
> delivery — don't ship a new field/widget/flow without updating or adding the help
> article that explains it to marketing.

---

## Files you'd edit

| Goal | File(s) |
|---|---|
| Add a field to a form | seed `field_definitions` row (script above); static defaults in `lib/field-config.ts` |
| Add a new field *type* | `lib/field-builder.ts`, `lib/field-config-source.ts`, `lib/actions.ts`, `components/fields/*` |
| Change auth / the login gate | `lib/auth.ts`, `lib/auth.config.ts`, `middleware.ts` |
| Change password policy/hashing | `lib/password.ts` |
| Change image upload | `lib/actions.ts` (`uploadImage`/`uploadGalleryImage`), `components/fields/ImageUploader.tsx` |
| Change audit/enqueue behavior | `lib/actions.ts` (`postWrite`), `lib/audit-chunk.ts` |
| Change the edit shell / live-site links | `components/record-edit/*`, `lib/live-site.ts`, `lib/build-edit-view.ts` |
| Add/edit help | `help-content/*.md` then `npm run gen:help` |
| Change Status page / header pill | `lib/status-page.ts`, `components/status-page-view.tsx`, `components/status-header-pill.tsx`, `app/(app)/status/page.tsx` |
| Change the community price-source selector UI | `lib/field-config.ts` (communities `close_out_elevation`) + the `buildFieldView` special-case in `lib/build-edit-view.ts` (renders it as the synced/override control) |

### Promotion surfaces ("Where it shows" + visual previews)

A promotion renders on up to five independent surfaces, each an explicit boolean on
`promotions` (migrations 0021 + 0024): `show_site_banner`, `show_incentive_page`,
`show_card_badge` (corner badge + card incentive line — gates the api's
banner/badge flatten in `toResolved()`, so a global-surface-only promo no longer
stamps badge-less home cards), `show_banner_button`, `show_card_cta`. They compose
with `promotion_targets` (surface = WHERE, targets = WHICH). The promotions list
shows a derived **Shows On** column (`build-list-view.ts`).

**Visual previews** (promo editor, `EntityEditForm` when `entityKey === 'promotions'`):

- **Site banner** (`PromotionSurfacesSection`) — `show_site_banner` + `show_banner_button`;
  green ticker preview; center copy = `badge_text` (Banner Overlay Promo); CTA pill =
  `cta_label` / `cta_url` when banner button is on.
- **Card surfaces** (same section) — `show_card_badge` / `show_card_cta` with a listing-card
  preview (corner badge + Headline incentive line + Learn More CTA); shared editors for
  `badge_text`, `banner_text`, `cta_label`, `cta_url` (single FormData source).
- **Incentives page** (`PromotionIncentiveSection`) — master `show_incentive_page`;
  live card preview; Image / Title / Description section toggles reveal editors and
  spotlight the matching region (`image_url`, `title`, `copy`).

Jump nav is hidden on the promo editor. Ungrouped fields render as **Promotion Details**
(Start/End dates first). The old text **"Where will this show"** box in
`PromoScopeTagPicker` is hidden (targeting + `__promo_targets` unchanged). The empty
**Where it shows** field group is omitted once surface toggles move into the preview
sections.

### Promotion targeting saves with the page Save

`PromoScopeTagPicker` mirrors its live selection into the edit `<form>` as a hidden
`__promo_targets` JSON field. `saveEntity` calls `savePromotionTargets` when that field is
present — targeting-only edits still save (runs before the empty-patch early-return).

The four scope columns (Cities / Communities / Floor Plans / QMIs) render as stacked
accordion rows (`Collapsible` from `@base-ui/react`). Sections with active selections
open by default; empty sections collapse. Count badges remain visible on closed headers.

### Community HOA links + floor plans save with the page Save

`HoaLinksEditor` emits `__hoa_links`; `CommunityFloorPlansPicker` emits
`__community_floor_plans`. `saveEntity('communities', …)` persists both via
`saveCommunityHoaLinks` / `saveCommunityFloorPlans`. On the bespoke community detail page,
**Floor Plans Offered** lives inside **Community Details** (above LotVue Map) as a
multi-select combobox. The collapsible **Utilities** subsection groups gas, internet,
water, electric, and **Security Details**; HOA links stay in their own panel below the form.

---
**Next:** [04 — Module: framer-push (D1 → Framer)](./04-module-framer-push.md)
