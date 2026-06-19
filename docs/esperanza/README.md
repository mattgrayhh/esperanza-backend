# Esperanza Homes — Developer Onboarding

Welcome. This packet explains how the Esperanza Homes website and content system
works end-to-end, and exactly how to **edit, deploy, and troubleshoot** every piece
of it. It is written for a developer who is comfortable with JavaScript/TypeScript,
SQL, and the command line, but who is **new to this system** (and new to some of the
Cloudflare pieces). Where a concept is Cloudflare-specific, it's explained the first
time it appears.

> **The one-sentence version:** Sales/pricing data flows from **Snowflake → a Cloudflare
> database (D1)**; marketing edits everything else in a **custom admin panel** that also
> writes to D1; and a worker called **framer-push** copies D1 into the **Framer** site
> that visitors actually see. A few side-modules (PDF brochures, the XML listing feed,
> image hosting) read from the same D1.

---

## Read these in order

| # | Doc | What it covers |
|---|-----|----------------|
| 00 | [Setup & Access](./00-setup-and-access.md) | Accounts, tools to install, cloning the repo, running the admin locally, where secrets live, how deploys happen. **Start here.** |
| 01 | [Data Flow: Snowflake → D1 → Framer](./01-data-flow.md) | The big picture. What comes from Snowflake, what's ingested into D1, what gets translated to Framer, and the all-important `synced_*` vs `override_*` column pattern. |
| 02 | [Module: Ingest & Sync Schedule](./02-module-ingest.md) | The worker that pulls Snowflake every 4 hours. Cron, queues, the "synced columns allowlist," safety guards. |
| 03 | [Module: Admin Panel](./03-module-admin.md) | The Next.js app marketing uses. Auth, the field-builder forms, image upload, audit log. How to add a field or change a form. |
| 04 | [Module: framer-push (D1 → Framer)](./04-module-framer-push.md) | How a D1 row becomes a Framer CMS item. `/backfill` and `/schema` endpoints, field-type rules, the merge gotcha. **The trickiest module.** |
| 05 | [Module: PDF Generator](./05-module-pdf.md) | The worker that renders brochures/lists to PDF with a headless browser. |
| 06 | [Module: Image Hosting & Compression](./06-module-images.md) | R2 buckets, the retired media host, why Cloudflare Images compression is mostly off. |
| 07 | [Module: XML Listing Feed](./07-module-xml-feed.md) | The BDX/Zillow feed worker (lives in its **own** repo). |
| 08 | [Troubleshooting Runbook & Glossary](./08-runbook-and-glossary.md) | Common breakages, the commands to diagnose them, and a glossary of every term and identifier. |

---

## The 60-second mental model

```
  SNOWFLAKE                       CLOUDFLARE                        FRAMER
  (Rhodes data                                                      (the public
   warehouse)                                                        website)
  ───────────       every 4h     ┌───────────────────┐
  pricing &     ───────────────► │  esperanza-ingest │──┐
  availability   (pull + diff)   │  (cron worker)    │  │ writes only
  ONLY                           └───────────────────┘  │ synced_* cols
                                                         ▼
  MARKETING                      ┌───────────────────────────────┐    on every
  (people)      ───────────────► │       D1: "esperanza"         │    write,
  edits in the   admin panel     │   (the source of truth for    │    enqueue ──┐
  admin panel    writes          │    the website)               │              │
                                 └───────────────────────────────┘              │
                                   │           │            │                   ▼
                          reads    │           │ reads       │ reads    ┌──────────────────┐
                          views    ▼           ▼             ▼          │esperanza-framer- │
                                 PDF gen    XML feed       (api)        │     push         │
                                                                        │ (D1 → Framer)    │──► Framer site
                                                                        └──────────────────┘
```

- **Snowflake feeds ONLY pricing & availability** for homes, communities, and cities.
  Everything else (descriptions, photos, marketing copy, SEO) is authored in the admin.
- **D1 is the source of truth** for the website. If it's not in D1, it's not on the site.
- **Framer is a copy**, kept in sync by `framer-push`. You never hand-edit content that
  framer-push manages — you edit D1 (via the admin) and let it propagate.
- **Airtable is dead.** It was the old system, sunset on 2026-06-02. Never query it; it
  has no effect on the live site.

---

## Where the code lives

| Repo / folder | What it is |
|---|---|
| `esperanza-cf/` | The **monorepo**. Contains 5 deployed workers + the admin app + shared DB code. This is 95% of your work. |
| `esperanza-xml-feed/` | A **separate, small repo** for the XML listing feed worker. |

Both are under `~/Dropbox/Claude Projects/` on the shared machine.

---

## Golden rules (the things that bite people)

1. **`master` is the only branch that deploys.** Work on a branch, open a PR, merge to
   `master`, and CI deploys the affected workers. See [00](./00-setup-and-access.md).
2. **Code changes to framer-push don't reach the live site by themselves.** After
   deploying a mapping change you usually must run a manual `POST /backfill`. See [04](./04-module-framer-push.md).
3. **A Framer field's type must match what framer-push sends, or the whole collection
   batch silently fails.** Re-type fields via `POST /schema`, never by hand in Framer.
   See [04](./04-module-framer-push.md).
4. **Verify pushes in the `sync_log` table, not by the HTTP status of a curl.** The work
   happens asynchronously on a queue. See [08](./08-runbook-and-glossary.md).
5. **Always run D1 migrations `--local` before `--remote`.** D1 caps tables at 100
   columns and other limits that local SQLite won't catch. See [01](./01-data-flow.md).
6. **Never store Airtable image URLs.** They're signed and expire. All images live in R2.
   See [06](./06-module-images.md).

---
*Last written 2026-06-15. If something here disagrees with the code, the code wins —
tell whoever maintains this packet so it can be fixed.*
