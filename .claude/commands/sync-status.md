---
description: Show recent ingest sync runs from sync_log
---
Call the `esperanza-ops` MCP tool `sync_status` (optionally filtered by `source` =
`ingest` | `snowflake`, default last 20 rows). Report the latest run's status,
timestamp, duration, the per-collection counts, and any `error_message`. Historical
rows with `source = 'framer'` may still appear from before Framer sync was retired.
