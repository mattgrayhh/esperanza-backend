---
slug: synced-fields-and-overrides
title: Synced fields and overrides (the lock)
category: Getting Started
categorySort: 10
sort: 20
summary: What the lock means, how to override a synced value, and how to undo it.
keywords: lock, unlock, override, snowflake, synced, revert, follow, close-out, closeout, homes from, price from, sold out
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
  `Price From` (the lowest base plan price in that community). See
  *Close-out communities* below for how `Price From` changes when a community
  sells out of quick move-in homes.
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

## Close-out communities

When a community sells out of its quick move-in homes, its synced `Price From`
(the lowest base plan price for the whole development) can read *lower* than
reality, because it still counts a cheaper plan that's no longer buildable
there. To fix this, open the community and turn on the **Close-Out Community**
toggle (in the admin section of the form).

With Close-Out on, `Price From` is taken from the **lowest published floor plan
that's actually offered in this community** — the plans you've checked in the
**Floor Plans Offered** panel — instead of the development-wide minimum. It
recalculates on its own as plan prices change, so there's nothing to keep
updating by hand.

Precedence, highest first:

1. A manual `Price From` **override**, if you've set one (always wins).
2. **Close-Out**: the lowest published offered plan's starting price.
3. Otherwise the normal synced value.

So a close-out community needs its **Floor Plans Offered** list trimmed to only
the plans still buildable there — that list is what the price is drawn from. If
no offered plan qualifies, `Price From` quietly falls back to the synced value
(it never goes blank). The toggle only affects the price; it doesn't change
anything else on the page.

## When should I override?

Sparingly. Overrides are for marketing judgment calls — a promo price, a
friendlier address spelling. If a synced value looks *wrong*, the better fix
is usually upstream in MarkSystems, so every system agrees.

Every override (set or removed) is recorded in the audit log with who and when.
