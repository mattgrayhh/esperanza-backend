---
slug: create-a-promotion
title: Create a promotion or incentive
category: Promotions & Incentives
categorySort: 50
sort: 10
summary: Banner, badge, copy, CTA, image, and scheduling — the anatomy of a promotion.
keywords: incentive, promo, special, offer, banner, badge, deal, campaign
entity: promotions
---

Promotions are reusable offers ("$15K Your Way", rate buydowns, closing-cost
credits) that render on the website as banners, badges, and detail sections on
the pages you target.

## How the form works

The form is organized by **where the promo shows**. Each surface has a toggle;
flip it on and only that surface's fields appear. Leave it off and they stay
hidden — so you only fill in what you're actually using.

1. Open `Promotions` → `New`.
2. **Promotion** (always shown):
   - `Title` — internal name + the title on the incentive page.
   - `Rate Override %` — leave **blank** to inherit the company-wide Incentive
     Rate (Settings → Site). Enter a value to override it for this promo only.
   - `Sort Order`, `Start Date`, `End Date` — scheduling. The promo turns itself
     on/off on those dates; leave blank for always-on.
3. Turn on the surfaces you want and fill their fields:
   - **Show on Site Banner** → `Banner Copy`, `Banner Button Text`, `Banner
     Button Link`. (Leave the button text blank for a text-only banner.)
   - **Show on Cards** → `Card Banner Text` (the image-overlaid banner on the
     top-left corner of the card), `Card Button Text`, `Card Button Link`,
     `Card Copy`. Shows on home / community / floor-plan cards.
   - **Show on Incentive Page** → `Image`, `Description / Excerpt`, and
     `Available Homes / Communities` (the picker — which homes/communities this
     incentive applies to on the incentives page). The `Title` (above) is the
     card title. `PDF (optional)` attaches a downloadable flyer.
4. Toggle `Published` and hit **Save** (the page Save persists everything,
   including the Available Homes/Communities picker).

**All surface toggles start OFF** — a brand-new promo shows nowhere until you
turn a surface on. The Site Banner button and Card button each appear only when
you fill in their button text. Each surface's fields are independent, so the
card can read differently from the banner.

## Promotion vs. the Incentive text fields

Homes, communities, cities, floor plans, and collections also have a plain
`Incentive` text field. Use that for a one-off line on a single record. Use a
**Promotion** when the offer has dates, a CTA, a badge, or applies to more
than one page — and so it can be retired in one place when it ends.
