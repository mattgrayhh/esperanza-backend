import type { Theme } from '../theme';
import type { ListData } from '../data/list';
import { CoverBand, Footer, FloorPlanCard, QmiListHeader, BrandFooter, QmiCard } from './components';

const PER_PAGE = 9;
const TITLES = { locations: 'Locations', qmis: 'Quick Move-In Homes', plans: 'Floor Plans' } as const;

function paginate<T>(items: T[]): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += PER_PAGE) pages.push(items.slice(i, i + PER_PAGE));
  if (pages.length === 0) pages.push([]);
  return pages;
}

export function ListBrochure({ theme, data }: { theme: Theme; data: ListData }) {
  // Quick Move-In Homes — marketing one-pager with promo-banner cards.
  if (data.kind === 'qmis') {
    const pages = paginate(data.qmis);
    return (
      <div>
        {pages.map((cards, pi) => (
          <div key={pi} className={pi < pages.length - 1 ? 'page-break' : undefined}>
            <QmiListHeader theme={theme} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginTop: 10 }}>
              {cards.map((c) => <QmiCard key={c.id} card={c} />)}
            </div>
            <BrandFooter theme={theme} disclaimer={theme.disclaimers.list} />
          </div>
        ))}
      </div>
    );
  }

  // locations / plans — existing styling.
  const pages = paginate(data.cards);
  return (
    <div>
      {pages.map((cards, pi) => (
        <div key={pi} className={pi < pages.length - 1 ? 'page-break' : undefined}>
          <CoverBand theme={theme} title={data.cityName} subtitle={TITLES[data.kind]} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 14 }}>
            {cards.map((c) => <FloorPlanCard key={c.id} plan={c} />)}
          </div>
          <Footer theme={theme} disclaimer={theme.disclaimers.list} />
        </div>
      ))}
    </div>
  );
}
