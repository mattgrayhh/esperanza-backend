import { describe, it, expect } from 'vitest';
import { renditionUrl } from '../src/data/shared';
describe('renditionUrl', () => {
  it('inserts the variant before the extension', () => {
    expect(renditionUrl('https://x/y/hickory.jpg', 'w1200')).toBe('https://x/y/hickory-w1200.jpg');
    expect(renditionUrl('https://x/y/a.png?v=2', 'w2000')).toBe('https://x/y/a-w2000.png?v=2');
  });
  it('returns empty for empty input', () => { expect(renditionUrl('', 'w1200')).toBe(''); });
});
