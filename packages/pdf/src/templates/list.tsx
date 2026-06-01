import type { Theme } from '../theme';
import type { ListData } from '../data/list';
import { CoverBand, Footer, FloorPlanCard } from './components';

const PER_PAGE = 9;
const TITLES = { locations: 'Locations', qmis: 'Quick Move-In Homes', plans: 'Floor Plans' } as const;

export function ListBrochure({ theme, data }: { theme: Theme; data: ListData }) {
  const pages: (typeof data.cards)[] = [];
  for (let i = 0; i < data.cards.length; i += PER_PAGE) pages.push(data.cards.slice(i, i + PER_PAGE));
  if (pages.length === 0) pages.push([]);
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
