import type { Theme } from '../theme';
import type { QmiData } from '../data/qmi';
import { Header, Footer, StatRow } from './components';
import { money } from '../data/shared';

export function QmiBrochure({ theme, data }: { theme: Theme; data: QmiData }) {
  const stats = [
    data.totalSqft && { value: data.totalSqft.toLocaleString('en-US'), label: 'Total Sq Ft' },
    data.livingSqft && { value: data.livingSqft.toLocaleString('en-US'), label: 'Living Sq Ft' },
    data.beds != null && { value: String(data.beds), label: 'Bedrooms' },
    data.baths != null && { value: String(data.baths), label: 'Baths' },
    data.garage != null && { value: String(data.garage), label: 'Car Garage' },
    data.stories != null && { value: data.stories.toFixed(1), label: 'Stories' },
  ].filter(Boolean) as { value: string; label: string }[];

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          {theme.brand.logoWordmarkUrl
            ? <img src={theme.brand.logoWordmarkUrl} alt="Esperanza Homes" style={{ height: 44 }} />
            : <span style={{ fontFamily: 'var(--pdf-font-heading)', color: 'var(--pdf-primary)', fontSize: 22 }}>Esperanza</span>}
        </div>
        <div className="pdf-band" style={{ flex: 1, padding: 10, textAlign: 'center', borderRadius: 4 }}>
          {data.completion ? <div style={{ fontWeight: 700 }}>{data.completion}</div> : null}
          <div style={{ fontFamily: 'var(--pdf-font-heading)', fontSize: 20 }}>{money(data.price)}</div>
          {data.estMonthly ? <div style={{ fontSize: 10 }}>From {money(data.estMonthly)}/mo*</div> : null}
        </div>
        <div className="pdf-accent" style={{ flex: 1, padding: 10, textAlign: 'center', borderRadius: 4 }}>
          <div style={{ fontFamily: 'var(--pdf-font-heading)', fontSize: 16 }}>{data.address}</div>
          <div style={{ fontSize: 10 }}>{data.community}</div>
        </div>
      </div>

      <div style={{ height: 220, margin: '12px 0', background: '#dde', borderRadius: 4, overflow: 'hidden' }}>
        {data.heroImageUrl ? <img src={data.heroImageUrl} alt={data.address} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
      </div>

      <StatRow stats={stats} />

      <div className="pdf-band" style={{ textAlign: 'center', padding: 8, borderRadius: 4, margin: '12px 0', fontSize: 11 }}>
        Call or Text {theme.footer.phone} · {theme.footer.salesHours}
      </div>

      {data.description ? <p style={{ fontSize: 11 }}>{data.description}</p> : null}
      {data.features.length ? <ul style={{ fontSize: 11 }}>{data.features.map((f) => <li key={f}>{f}</li>)}</ul> : null}

      <Footer theme={theme} disclaimer={theme.disclaimers.qmi} />
    </div>
  );
}
