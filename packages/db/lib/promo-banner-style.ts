// =============================================================================
// Promo listing-card banner style — shared by admin previews and the public API.
//
// Live-site rule (QMI listing cards + address detail promo tabs):
//   • 4.99% rate promos  → green bar (#2f5d4a)
//   • flex promos        → gold bar (#c4b59a)
//   • everything else    → green (default)
//
// 4.99 is checked before flex so combined copy ("4.99% … OR … Flex Cash") stays green.
// =============================================================================

export type PromoBannerStyle = 'green' | 'gold';

/** Tailwind classes matching the live-site promo bar colors. */
export const PROMO_BANNER_STYLE_CLASSES: Record<PromoBannerStyle, string> = {
  green: 'bg-[#2f5d4a] text-white',
  gold: 'bg-[#c4b59a] text-black',
};

/**
 * Classify promo banner copy into green (rate / default) or gold (flex).
 * Returns `green` for blank input — callers should omit the bar when text is empty.
 */
export function classifyPromoBannerStyle(text: string): PromoBannerStyle {
  const t = text.trim();
  if (!t) return 'green';
  if (/4\.99\s*%?/i.test(t)) return 'green';
  if (/flex/i.test(t)) return 'gold';
  return 'green';
}

/** Text shown on the listing-card promo bar: per-home incentive overrides resolved promo. */
export function listingPromoBannerText(incentive: string, promoText: string): string {
  return incentive.trim() || promoText.trim();
}
