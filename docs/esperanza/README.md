# Esperanza Homes — Developer Onboarding

Welcome. This packet explains how the Esperanza Homes website and content system
works end-to-end, and exactly how to **edit, deploy, and troubleshoot** every piece
of it. It is written for a developer who is comfortable with JavaScript/TypeScript,
SQL, and the command line, but who is **new to this system** (and new to some of the
Cloudflare pieces). Where a concept is Cloudflare-specific, it's explained the first
time it appears.

> **The one-sentence version:** Sales/pricing data flows from **Snowflake → a Cloudflare
> database (D1)**; marketing edits everything else in a **custom admin panel** that also
> writes to D1; the **public site** reads D1 via the edge API (and related workers for
> PDF, XML feed, images). **If it's not in D1, it's not on the site.**

---

## Read these in order

| # | Doc | What it covers |
|---|-----|----------------|
| 00 | [Setup & Access](./00-setup-and-access.md) | Accounts, tools to install, cloning the repo, running the admin locally, where secrets live, how deploys happen. **Start here.** |
| 01 | [Data Flow: Snowflake → D1 → Public Site](./01-data-flow.md) | The big picture. What comes from Snowflake, what's ingested into D1, how the API serves data, and the `synced_*` vs `override_*` column pattern. |
| 02 | [Module: Ingest & Sync Schedule](./02-module-ingest.md) | The worker that pulls Snowflake every 4 hours. Cron, queues, the "synced columns allowlist," safety guards. |
| 03 | [Module: Admin Panel](./03-module-admin.md) | The Next.js app marketing uses. Auth, the field-builder forms, image upload, audit log. How to add a field or change a form. |
| 05 | [Module: PDF Generator](./05-module-pdf.md) | The worker that renders brochures/lists to PDF with a headless browser. |
| 06 | [Module: Image Hosting & Compression](./06-module-images.md) | R2 buckets, the retired media host, why Cloudflare Images compression is mostly off. |
| 07 | [Module: XML Listing Feed](./07-module-xml-feed.md) | The BDX/Zillow feed worker (lives in its **own** repo). |
| 08 | [Troubleshooting Runbook & Glossary](./08-runbook-and-glossary.md) | Common breakages, the commands to diagnose them, and a glossary of every term and identifier. |

---

## The 60-second mental model

```
  SNOWFLAKE                       CLOUDFLARE                        PUBLIC SITE
  (Rhodes data                                                      (esperanzahomes.com
   warehouse)                                                        reads D1 via API)
  ───────────       every 4h     ┌───────────────────┐
  pricing &     ───────────────► │  esperanza-ingest │──┐
  availability   (pull + diff)   │  (cron worker)    │  │ writes only
  ONLY                           └───────────────────┘  │ synced_* cols
                                                         ▼
  MARKETING                      ┌───────────────────────────────┐
  (people)      ───────────────► │       D1: "esperanza"         │
  edits in the   admin panel     │   (the source of truth)       │
  admin panel    writes          └───────────────────────────────┘
                                   │           │            │
                          reads    │           │ reads       │ reads
                          views    ▼           ▼             ▼
                                 PDF gen    XML feed       esperanza-api
                                                              │
                                                              ▼
                                                         Public website
```

- **Snowflake feeds ONLY pricing & availability** for homes, communities, and cities.
  Everything else (descriptions, photos, marketing copy, SEO) is authored in the admin.
- **D1 is the source of truth** for the website. If it's not in D1, it's not on the site.
- **Airtable is dead.** It was the old system, sunset on 2026-06-02. Never query it; it
  has no effect on the live site.

---

## Where the code lives

| Repo / folder | What it is |
|---|---|
| `esperanza-cf/` | The **monorepo**. Contains deployed workers + the admin app + shared DB code. |
| `esperanza-xml-feed/` | A **separate, small repo** for the XML listing feed worker. |

---

## Golden rules (the things that bite people)

1. **`master` is the only branch that deploys.** Work on a branch, open a PR, merge to
   `master`, and CI deploys the affected workers. See [00](./00-setup-and-access.md).
2. **Always run D1 migrations `--local` before `--remote`.** D1 caps tables at 100
   columns and other limits that local SQLite won't catch. See [01](./01-data-flow.md).
3. **Never store Airtable image URLs.** They're signed and expire. All images live in R2.
   See [06](./06-module-images.md).

---
*Last updated 2026-07-15. If something here disagrees with the code, the code wins —
tell whoever maintains this packet so it can be fixed.*
