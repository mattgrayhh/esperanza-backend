---
description: Show recent ingest sync runs to confirm a Snowflake→D1 sync landed
---
Call the `esperanza-ops` MCP tool `sync_status` (optionally filtered by `source` =
`ingest` | `snowflake`, default last 20 rows). Report the latest run's status,
timestamp, duration, the per-collection counts, and any `error_message`. Remember: a sync is
only confirmed by a `sync_log` row, never by an HTTP code. If $ARGUMENTS names a collection,
focus the summary on it.
