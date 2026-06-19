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

## Field-driven forms (`field_definitions`)

The edit and list screens are **rendered from the `field_definitions` D1 table**, not from
hard-coded JSX. `resolveFieldConfig(entityKey)` (`lib/field-config-source.ts`) reads the
rows for an entity, ordered by `sort`, and builds the form. If an entity has **zero** rows,
it falls back to the static config in `lib/field-config.ts` (so the form is never empty).

Field `type` → widget mapping (`typeToWidget()`):

| `type` | Widget |
|---|---|
| `text`, `long`, `number`, `currency`, `bool`, `date`, `url`, `select` | `GenericField` |
| `rich` | rich-text (TipTap) editor with inline R2 image upload |
| `image` | `ImageUploader` |
| `imageGallery` / `elevationGallery` | `ImageGalleryEditor` / elevation grid editor |
| `syncedOverride` (QMI etc.) | `SyncedOverrideField` — shows the Snowflake `synced_` value + an override box |
| bespoke: `hoaLinks`, `jsonBlocks`, `promoScopeTag`, `communityFloorPlans` | custom editors with their own save buttons |

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
| Add/edit help | `help-content/*.md` then `npm run gen:help` |

---
**Next:** [04 — Module: framer-push (D1 → Framer)](./04-module-framer-push.md)
