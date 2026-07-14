// =============================================================================
// Shared elevation → hero-image matching. Pins the compose + match contract used
// by the api QMI serializer AND the admin QMI detail so they can't drift.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { pickElevationImage, composeElevation } from '../lib/elevation-image.js';

describe('composeElevation', () => {
  it('joins style + material into the gallery label form', () => {
    expect(composeElevation('Traditional', 'Brick')).toBe('Traditional Brick');
    expect(composeElevation('Tuscan', 'Stucco')).toBe('Tuscan Stucco');
  });
  it('drops a blank material (single-word styles like Farmhouse)', () => {
    expect(composeElevation('Farmhouse', '')).toBe('Farmhouse');
    expect(composeElevation('Farmhouse', null)).toBe('Farmhouse');
    expect(composeElevation(null, null)).toBe('');
  });
});

const GALLERY = JSON.stringify([
  { url: 'https://img/trad-brick.jpg', type: 'Traditional Brick' },
  { url: 'https://img/farmhouse.jpg', type: 'Farmhouse' },
]);

describe('pickElevationImage', () => {
  it('returns the url whose type matches (case/space-insensitive)', () => {
    expect(pickElevationImage(GALLERY, 'Traditional Brick')).toBe('https://img/trad-brick.jpg');
    expect(pickElevationImage(GALLERY, '  traditional   brick ')).toBe('https://img/trad-brick.jpg');
    expect(pickElevationImage(GALLERY, 'Farmhouse')).toBe('https://img/farmhouse.jpg');
  });
  it('returns null when nothing matches or input is empty/invalid (fp_image fallback)', () => {
    expect(pickElevationImage(GALLERY, 'Contemporary Stucco')).toBeNull();
    expect(pickElevationImage(GALLERY, '')).toBeNull();
    expect(pickElevationImage('', 'Traditional Brick')).toBeNull();
    expect(pickElevationImage('not json', 'Traditional Brick')).toBeNull();
    expect(pickElevationImage(null, 'Traditional Brick')).toBeNull();
  });
  it('accepts an already-parsed array too', () => {
    expect(pickElevationImage(JSON.parse(GALLERY), 'Farmhouse')).toBe('https://img/farmhouse.jpg');
  });
});
