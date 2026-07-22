import { describe, expect, it } from 'vitest';
import { pickHeroFromGallery } from '../scripts/backfill-qmi-hero-from-gallery.js';

describe('pickHeroFromGallery', () => {
  it('prefers a /qmi/ upload over floor-plan or assets-media urls', () => {
    const urls = [
      'https://img.hazardhouse.ai/floor_plans/recABC/plan.jpg',
      'https://img.hazardhouse.ai/assets-media/153/2026/4/30/SP013.jpg',
      'https://img.hazardhouse.ai/qmi/recXYZ/photo_1.jpg',
    ];
    expect(pickHeroFromGallery(urls)).toBe('https://img.hazardhouse.ai/qmi/recXYZ/photo_1.jpg');
  });

  it('falls back to first non-floor-plan url when no /qmi/ photo exists', () => {
    const urls = [
      'https://img.hazardhouse.ai/floor_plans/recABC/plan.jpg',
      'https://img.hazardhouse.ai/assets-media/153/hero.jpg',
    ];
    expect(pickHeroFromGallery(urls)).toBe('https://img.hazardhouse.ai/assets-media/153/hero.jpg');
  });

  it('returns null for an empty gallery', () => {
    expect(pickHeroFromGallery([])).toBeNull();
  });
});
