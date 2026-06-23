---
description: Show recent framer-push / ingest sync runs to confirm a push landed
---
Call the `esperanza-ops` MCP tool `sync_status` (optionally filtered by `source` =
`framer` | `ingest` | `snowflake`, default last 20 rows). Report the latest run's status,
timestamp, duration, the per-collection counts, and any `error_message`. Remember: a push is
only confirmed by a `sync_log` row, never by an HTTP code. If $ARGUMENTS names a collection,
focus the summary on it.
