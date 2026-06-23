# Working in esperanza-cf

This monorepo is the live Esperanza Homes site backend. Read `docs/esperanza/README.md`
first — it explains the whole system. These are the rules that keep the live site safe.

## The model in one line
Snowflake → D1 (`esperanza`, the source of truth) → `framer-push` → Framer (the public site).
Marketing edits everything non-pricing in the admin. **If it's not in D1, it's not on the site.**

## Golden rules
1. `master` is the only branch that deploys. Work on a branch → PR → merge. CI deploys only
   the packages that changed (everything if `packages/db/` or root files change).
2. Code changes to `framer-push` do NOT reach the live site by themselves. After deploying a
   mapping change, run a backfill: use the `/backfill` command (drives the esperanza-ops
   `backfill` tool). Large collections (qmi ≈ 356) need a long timeout.
3. A Framer field's type must match what `framer-push` sends, or the WHOLE collection batch
   silently fails (the error names the item, not the field). Re-type via the `/push-schema`
   command (reseeds D1 framer_type first), never by hand in Framer.
4. Verify pushes in the `sync_log` table (`/sync-status`), not by a curl's HTTP code — the work
   is asynchronous on a queue.
5. Run D1 migrations `--local` before `--remote`. Tables cap at 100 columns; ~100 bound params
   per statement.
6. Never store `airtableusercontent.com` image URLs (signed/expiring). Images live in R2.
7. Airtable is dead (sunset 2026-06-02). Never query it; it has no effect on the live site.

## Privileged operations go through esperanza-ops
You do not have raw Cloudflare/Snowflake/webhook secrets. Backfills, schema pushes, ingest
triggers, and PDF rebuilds run through the `esperanza-ops` MCP tools (see `.mcp.json`). Code,
migrations, and PRs are normal git work in your own checkout.

## Admin change = knowledge update (same delivery)
Any change to an admin panel feature/flow MUST include a `docs/esperanza/` update in the same PR.
