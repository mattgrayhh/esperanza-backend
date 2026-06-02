import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/templates';
import { defaultTheme } from '../src/theme';
import type { ListData, QmiCardData } from '../src/data/list';

const locations: ListData = {
  citySlug: 'mcallen', cityName: 'McAllen', kind: 'locations', isMaster: false, qmis: [],
  cards: Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, name: `Community ${i}`, price: 300000 + i, sqft: 2000,
    beds: 3, baths: 2, garage: 2, stories: 1, imageUrl: '',
  })),
};

const qmi = (over: Partial<QmiCardData>): QmiCardData => ({
  id: 'q', community: 'Los Prados', city: 'Mercedes', beds: 3, baths: 2, sqft: 1101,
  availability: 'Available JUN/JUL 2026', address: '4102 Appaloosa Dr', lot: '51',
  estMonthly: 1534.21, price: 179990, imageUrl: '', promo: null, ...over,
});

describe('list template', () => {
  it('renders a city cover + a card per member, paginated (locations)', () => {
    const html = renderTemplate('list', defaultTheme, locations);
    expect(html).toContain('McAllen');
    expect(html).toContain('Community 0');
    expect(html).toContain('Community 19');
    expect((html.match(/page-break/g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the Quick Move-In Homes grid with card fields + monthly cents', () => {
    const data: ListData = {
      citySlug: 'all', cityName: '', kind: 'qmis', isMaster: true, cards: [],
      qmis: [qmi({})],
    };
    const html = renderTemplate('list', defaultTheme, data);
    expect(html).toContain('Quick Move-In Homes');
    expect(html).toContain('Los Prados');
    expect(html).toContain('3 Beds • 2 Bath • 1,101 SQFT');
    expect(html).toContain('Lot #51');
    expect(html).toContain('$1,534.21'); // monthly keeps cents
    expect(html).toContain('$179,990');  // price is whole dollars
  });

  it('renders the three promo banner styles', () => {
    const data: ListData = {
      citySlug: 'all', cityName: '', kind: 'qmis', isMaster: true, cards: [],
      qmis: [
        qmi({ id: 'g', promo: { style: 'green', text: 'Now Selling' } }),
        qmi({ id: 'f', promo: { style: 'flex', text: 'Unlock Your Flex Discount Now!' } }),
        qmi({ id: 'r', promo: { style: 'rate', text: '4.99% Rate', rateLabel: '4.99%' } }),
      ],
    };
    const html = renderTemplate('list', defaultTheme, data);
    expect(html).toContain('Now Selling');
    expect(html).toContain('Unlock Your Flex Discount Now!');
    expect(html).toContain('4.99%');            // rate corner badge
    expect(html).toContain('#33402b');          // flex dark banner color
  });
});
