# esperanza-pdf — Deploy & first-PDF runbook (Phases 1–3)

Run these from the **worktree root** (`.claude/worktrees/pdf-platform`) on branch `pdf-platform`. They touch your live Cloudflare account, so run them yourself (e.g. via `!<cmd>` in Claude Code, or your terminal). Prereqs: `wrangler` authenticated to the Esperanza account, **Workers Paid** (required for Browser Rendering), the existing D1 `esperanza` + R2 `esperanza-cms`.

> Note: this deploys **branch** code, not `master`. That's correct for validating the engine live. Merge to `master` when you're happy.

## 1. Apply migration 0004 to remote D1
```bash
wrangler d1 migrations list esperanza --remote      # should show 0004_pdf_platform.sql pending
npm run -w @esperanza/db db:migrate:remote          # = wrangler d1 migrations apply esperanza --remote
wrangler d1 execute esperanza --remote --command "SELECT kind,version FROM pdf_themes"   # expect active|1, draft|1
```

## 2. Set the preview secret (same value on BOTH workers)
```bash
SECRET=$(openssl rand -hex 32)
( cd packages/pdf   && printf '%s' "$SECRET" | wrangler secret put PDF_PREVIEW_SECRET )
( cd packages/admin && printf '%s' "$SECRET" | wrangler secret put PDF_PREVIEW_SECRET )
```

## 3. Deploy the PDF worker (must exist before the admin's service binding resolves)
```bash
npm run -w @esperanza/pdf deploy
# note the deployed URL, e.g. https://esperanza-pdf.<subdomain>.workers.dev
```

## 4. Remote render smoke (proves Browser Rendering works)
```bash
PDF_WORKER_URL=https://esperanza-pdf.<subdomain>.workers.dev npm run -w @esperanza/pdf test:remote
# expects a valid %PDF- > 500 bytes
```
If this 500s on the BROWSER binding, confirm Browser Rendering is enabled on the account (Workers Paid).

## 5. Seed pdf_renders rows + backfill the URL fields
```bash
PDF_PUBLIC_BASE_URL=https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev \
  npm run -w @esperanza/pdf seed-renders -- --remote
wrangler d1 execute esperanza --remote --command \
  "SELECT type, count(*) FROM pdf_renders GROUP BY type"          # community/qmi/floorplan rows
```
This also writes `qmi.dynamic_pdf`, `floor_plans.brochure_pdf_url`, `communities.brochure_pdf_url`.

## 6. See a real PDF
```bash
SLUG=$(wrangler d1 execute esperanza --remote --json --command \
  "SELECT slug FROM pdf_renders WHERE type='community' LIMIT 1" | grep -o '"slug":"[^"]*"' | head -1)
curl -sL "https://esperanza-pdf.<subdomain>.workers.dev/pdf/community/<that-slug>" -o /tmp/test.pdf
open /tmp/test.pdf            # first hit renders (~seconds); re-run → header X-Cache: HIT, instant
```

## 7. (Optional, image-size lever) Generate R2 renditions
Needs R2 S3 creds in env: `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (R2 → Manage API tokens).
```bash
wrangler r2 object list esperanza-cms | head        # CONFIRM the image key prefixes first
npm run -w @esperanza/pdf derive-renditions -- --remote --prefix=floor_plans/   # adjust prefix to reality
```
Without renditions the PDFs still render — just larger. This is the 35MB→<5MB lever.

## 8. Deploy the admin (PDFs section + theme editor)
```bash
npm run -w @esperanza/admin deploy
# then visit /pdfs (drill-down) and /settings/pdf-theme (editor + live preview)
```
The theme editor's live preview iframe resolves through the admin's `PDF` service binding → the deployed `esperanza-pdf` (step 3) using the shared `PDF_PREVIEW_SECRET` (step 2).

## Notes / things to verify
- **Brand assets (Phase 0):** until you upload fonts/logos and set them in the theme (via `/settings/pdf-theme` or a theme seed), PDFs render with fallback fonts and the text wordmark — structurally correct, not brand-perfect.
- **R2 prefix** for renditions (step 7) is an assumption — confirm with `wrangler r2 object list`.
- **Framer community link:** `qmi.dynamic_pdf` + `floor_plans.brochure_pdf_url` already flow to Framer; `communities.brochure_pdf_url` needs the Phase-4 framer-push field addition to appear on the Framer community record (it's reachable by URL regardless).
- **Rollback:** these are additive (new worker, new tables, new nullable column, new admin routes). Nothing existing is mutated; deleting the `esperanza-pdf` worker + ignoring the new admin routes reverts cleanly.
