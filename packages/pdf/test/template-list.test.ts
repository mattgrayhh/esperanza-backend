import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/templates';
import { defaultTheme } from '../src/theme';
import type { ListData } from '../src/data/list';

const data: ListData = {
  citySlug: 'mcallen', cityName: 'McAllen', kind: 'locations',
  cards: Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, name: `Community ${i}`, price: 300000 + i, sqft: 2000,
    beds: 3, baths: 2, garage: 2, stories: 1, imageUrl: '',
  })),
};

describe('list template', () => {
  it('renders a city cover + a card per member, paginated', () => {
    const html = renderTemplate('list', defaultTheme, data);
    expect(html).toContain('McAllen');
    expect(html).toContain('Community 0');
    expect(html).toContain('Community 19');
    expect((html.match(/page-break/g) || []).length).toBeGreaterThanOrEqual(1);
  });
});
