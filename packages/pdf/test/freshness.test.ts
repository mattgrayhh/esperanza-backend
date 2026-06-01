import { describe, it, expect } from 'vitest';
import { decideFreshness } from '../src/freshness';

describe('decideFreshness', () => {
  it('absent when no row or no object', () => {
    expect(decideFreshness(null, 5)).toBe('absent');
    expect(decideFreshness({ status: 'not_built', r2_key: null, theme_version: null } as any, 5)).toBe('absent');
  });
  it('fresh when live + theme matches + object present', () => {
    expect(decideFreshness({ status: 'live', r2_key: 'pdf/community/c.pdf', theme_version: 5 } as any, 5)).toBe('fresh');
  });
  it('stale-present when object exists but stale or theme bumped', () => {
    expect(decideFreshness({ status: 'stale', r2_key: 'k', theme_version: 5 } as any, 5)).toBe('stale-present');
    expect(decideFreshness({ status: 'live', r2_key: 'k', theme_version: 4 } as any, 5)).toBe('stale-present');
  });
});
