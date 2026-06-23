---
description: Re-type a managed Framer CMS collection's fields (reseed D1 framer_type first)
---
Call the `esperanza-ops` MCP tool `push_schema` with `collection` = $ARGUMENTS. This reseeds
the D1 `field_definitions.framer_type` then rebuilds the Framer collection's fields and re-pushes.
WARNING (Tier-2): a wrong type aborts the whole collection batch. Confirm the intended field
types with the user before running, then verify with `sync_status`.
