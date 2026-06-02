import type { Theme } from '../theme';
import type { ListData, QmiCardData } from '../data/list';
import { CoverBand, Footer, FloorPlanCard, QmiCard } from './components';

const PER_PAGE = 9;
const TITLES = { locations: 'Locations', qmis: 'Quick Move-In Homes', plans: 'Floor Plans' } as const;

function paginate<T>(items: T[]): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += PER_PAGE) pages.push(items.slice(i, i + PER_PAGE));
  if (pages.length === 0) pages.push([]);
  return pages;
}

// One full-bleed Letter page painted with the branded template artwork; cards sit in the
// empty middle region (insets clear the baked-in header band and footer).
function QmiGridPage({ bg, cards }: { bg?: string; cards: QmiCardData[] }) {
  return (
    <div style={{
      position: 'relative', width: '8.5in', height: '11in', overflow: 'hidden',
      backgroundImage: bg ? `url("${bg}")` : undefined, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
    }}>
      <div style={{ position: 'absolute', top: '1.5in', left: '0.45in', right: '0.45in', bottom: '1.05in' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', columnGap: 14, rowGap: 12 }}>
          {cards.map((c) => <QmiCard key={c.id} card={c} />)}
        </div>
      </div>
    </div>
  );
}

export function ListBrochure({ theme, data }: { theme: Theme; data: ListData }) {
  // Quick Move-In Homes — cards laid over the branded template one-pager.
  if (data.kind === 'qmis') {
    const pages = paginate(data.qmis);
    return (
      <div>
        {pages.map((cards, pi) => (
          <div key={pi} style={pi < pages.length - 1 ? { breakAfter: 'page' } : undefined}>
            <QmiGridPage bg={data.templateBgUrl} cards={cards} />
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
