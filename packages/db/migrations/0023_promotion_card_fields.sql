-- =============================================================================
-- 0023 — promotions: per-surface CARD fields.
--
-- The incentive form is being reorganized into progressive-disclosure surface
-- sections (Site Banner / Card / Incentive Page). "Separate fields per surface"
-- means the CARD button + copy are independent of the SITE BANNER's
-- cta_label / cta_url, so a promo can word its card differently from its banner.
--
-- Three nullable TEXT columns (additive, safe):
--   · card_button_text  — the card CTA button label (was: shared cta_label).
--   · card_button_link  — the card CTA button href  (was: shared cta_url).
--   · card_copy         — the card's body copy       (was: shared `copy`).
-- (badge_text stays the card's top-left image-overlay text; cta_label/cta_url
--  become BANNER-only; `copy` becomes the Incentive Page description.)
--
-- Surfaced to Framer/API per the card surface; v_public_promotions is rebuilt to
-- expose them alongside the migration-0020/0021 columns.
--
-- Apply with:
--   wrangler d1 migrations apply esperanza --local      (dev)
--   wrangler d1 migrations apply esperanza --remote      (prod)
-- After the remote apply: reseed field_definitions, then framer-push /push-schema
-- (create the new card fields) + /backfill?keys=promotions.
-- =============================================================================
ALTER TABLE promotions ADD COLUMN card_button_text TEXT;
ALTER TABLE promotions ADD COLUMN card_button_link TEXT;
ALTER TABLE promotions ADD COLUMN card_copy TEXT;

DROP VIEW IF EXISTS v_public_promotions;
CREATE VIEW v_public_promotions AS
SELECT
  p.id, p.title, p.banner_text, p.badge_text, p.copy,
  p.cta_label, p.cta_url, p.image_url,
  p.card_button_text, p.card_button_link, p.card_copy,
  p.pdf_url, p.rate_override,
  COALESCE(NULLIF(p.rate_override, ''),
    (SELECT value FROM site_settings WHERE key = 'incentive_rate')) AS effective_rate,
  p.show_site_banner, p.show_incentive_page, p.show_banner_button, p.show_card_cta,
  p.sort_order, p.start_date, p.end_date, p.published
FROM promotions p
WHERE p.published = 1;
