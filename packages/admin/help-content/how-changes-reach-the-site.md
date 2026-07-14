---
slug: how-changes-reach-the-site
title: How changes reach the live site (and what to check when they don't)
category: Publishing
categorySort: 60
sort: 10
summary: The publish pipeline, expected timing, and a troubleshooting checklist.
keywords: not showing, not updating, publish, sync, live site, troubleshoot, cache
---

## The pipeline

1. You `Save` in the admin → the change lands in the database instantly.
2. The website is pushed the change **immediately** (typically under a
   minute). A nightly sweep re-pushes everything as a safety net.
3. Snowflake-driven changes (prices, new homes, sold homes) arrive on the
   sync schedule — every 4 hours — then push to the site the same way.
4. PDF brochures regenerate automatically after content changes.

## Don't want to wait for the 4-hour sync?

Use the **Sync now** button at the top of the Dashboard. It runs the same
MarkSystems/Snowflake sync immediately (it takes a minute or so to finish), and
anything it pulls in pushes to the website right after. You only need this for
*upstream* changes — your own admin edits already reach the site in moments
without it.

## "My change isn't showing" checklist

1. **Is the record `Live`?** A `Draft` never appears, and `Coming Soon` shows
   only the teaser page.
2. **Hard-refresh** the page (Cmd+Shift+R) — your browser may be showing its
   own cached copy.
3. **Wait one minute** and refresh again — pushes are fast but not literally
   instant.
4. **Is the field synced (locked)?** If you edited upstream in MarkSystems,
   it appears after the next 4-hour sync. If you need it now, hit **Sync now**
   on the Dashboard, or use `Unlock to override`.
5. Still stuck after ~10 minutes? Tell a Full Admin — they can check the sync
   dashboard and re-push.
