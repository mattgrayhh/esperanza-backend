---
description: Re-push one or more D1 collections to Framer (after a framer-push code change)
---
Call the `esperanza-ops` MCP tool `backfill` with `keys` = the collection(s) in $ARGUMENTS
(e.g. `qmi`, `communities`, `floor_plans`, `blogs`, `cities`). Then call `sync_status` and
confirm a new success row landed for each key. Note: large collections (qmi) run long and
asynchronously — do not treat a slow response as failure; verify via `sync_status`.
