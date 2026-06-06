---
slug: synced-fields-and-overrides
title: Synced fields and overrides (the lock)
category: Getting Started
categorySort: 10
sort: 20
summary: What the lock means, how to override a synced value, and how to undo it.
keywords: lock, unlock, override, snowflake, synced, revert, follow
---

Fields that Snowflake fills automatically show a `synced` badge and appear
**locked** — the box shows the current synced value and can't be typed in.
That's on purpose: as prices, square footage, or dates change in MarkSystems,
these fields keep themselves up to date.

## Which fields are synced?

- **Homes**: address, price, beds/baths, square footage, elevation and
  material type, construction stage, lot number, move-in date, model-home
  flag, and the city / community / floor-plan assignment.
- **Communities**: square-footage range, bed and bath ranges, and
  `Price From` (the lowest base plan price in that community).
- **Floor Plans**: beds/baths, living and total square footage, and
  `Starting Price` (the lowest current base price across communities).

## Override a synced value

1. Find the field and tick `Unlock to override`.
2. Type your value.
3. `Save`.

The field now shows an `override` badge. **Your value wins** on the website,
and it survives every future sync — only this field is pinned; everything else
on the record keeps syncing normally.

## Go back to following Snowflake

1. Untick the checkbox (re-lock the field).
2. `Save`.

The override is removed and the field shows the live synced value again.

## When should I override?

Sparingly. Overrides are for marketing judgment calls — a promo price, a
friendlier address spelling. If a synced value looks *wrong*, the better fix
is usually upstream in MarkSystems, so every system agrees.

Every override (set or removed) is recorded in the audit log with who and when.
