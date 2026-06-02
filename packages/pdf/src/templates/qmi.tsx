import type { Theme } from '../theme';
import type { QmiData } from '../data/qmi';
import { EqualHousingMark } from './components';
import { money } from '../data/shared';

const moneyCents = (n: number | null): string =>
  n == null ? '' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DEFAULT_QMI_DISCLAIMER =
  'The information provided in this document regarding available quick move-in homes at Esperanza Homes is intended for informational purposes only. While we strive to present accurate and up-to-date information, all details—including but not limited to pricing, availability, home features, and community amenities—are not guaranteed and are subject to change without prior notice. Dimensions and floor plans are approximate and may differ from the actual homes. Incentives and promotional offers are valid only when financing through Stonewood Home Lending and are subject to specific terms and conditions and may be limited to select homes and communities. For comprehensive terms, conditions, and further information regarding our homes and offerings, please consult with an Esperanza Homes sales consultant or visit esperanzahomes.com.';

/** Per-home Quick Move-In spec sheet — matches the branded marketing one-pager 1:1.
 *  Header (logo · green price box · gold address box) → est-completion bar → hero photo →
 *  6-stat band → contact band → description + features → fine-print footer. */
export function QmiBrochure({ theme, data }: { theme: Theme; data: QmiData }) {
  const stats = [
    data.totalSqft != null && { value: data.totalSqft.toLocaleString('en-US'), label: 'Total Square Feet' },
    data.livingSqft != null && { value: data.livingSqft.toLocaleString('en-US'), label: 'Living Square Feet' },
    data.beds != null && { value: String(data.beds), label: data.beds === 1 ? 'Bedroom' : 'Bedrooms' },
    data.baths != null && { value: String(data.baths), label: 'Baths' },
    data.garage != null && { value: String(data.garage), label: 'Car Garage' },
    data.stories != null && { value: data.stories.toFixed(1), label: data.stories === 1 ? 'Story' : 'Stories' },
  ].filter(Boolean) as { value: string; label: string }[];

  const disclaimer = theme.disclaimers.qmi?.trim() ? theme.disclaimers.qmi : DEFAULT_QMI_DISCLAIMER;
  const boxText = theme.brand.colors.bandText;

  return (
    <div style={{ fontFamily: 'var(--pdf-font-body)', color: 'var(--pdf-ink)' }}>
      {/* ── Header: logo · green price box · gold address box, with est-completion bar below ── */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 14 }}>
        <div style={{ width: '30%', display: 'flex', alignItems: 'center' }}>
          {theme.brand.logoWordmarkUrl
            ? <img src={theme.brand.logoWordmarkUrl} alt="Esperanza Homes" style={{ width: '100%', maxHeight: 88 }} />
            : <span style={{ color: 'var(--pdf-primary)', fontSize: 30, fontWeight: 700 }}>Esperanza</span>}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', gap: 5 }}>
            <div style={{ flex: 1, background: 'var(--pdf-primary)', color: boxText, textAlign: 'center', padding: '10px 8px', lineHeight: 1.25, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              {data.statusHeadline ? <div style={{ fontSize: 15, fontWeight: 700 }}>{data.statusHeadline}</div> : null}
              {data.price != null ? <div style={{ fontSize: 21, fontWeight: 700, marginTop: 1 }}>{money(data.price)}</div> : null}
              {data.estMonthly != null ? <div style={{ fontSize: 9.5, opacity: 0.95 }}>From {moneyCents(data.estMonthly)}*/month</div> : null}
            </div>
            <div style={{ flex: 1, background: 'var(--pdf-accent)', color: boxText, textAlign: 'center', padding: '10px 8px', lineHeight: 1.3, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              {data.address ? <div style={{ fontSize: 16, fontWeight: 700 }}>{data.address}</div> : null}
              {data.community ? <div style={{ fontSize: 11.5 }}>{data.community}</div> : null}
              {data.lot ? <div style={{ fontSize: 11.5 }}>Homesite {data.lot}</div> : null}
            </div>
          </div>
          {data.completion ? (
            <div style={{ background: '#cdcdcd', color: '#333', textAlign: 'center', padding: '7px 8px', fontSize: 12.5 }}>
              Est. Completion Date: {data.completion}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Hero photo ── */}
      <div style={{ height: 322, margin: '14px 0', background: '#dde7e0', overflow: 'hidden' }}>
        {data.heroImageUrl ? <img src={data.heroImageUrl} alt={data.address} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
      </div>

      {/* ── 6-stat band ── */}
      {stats.length ? (
        <div style={{ display: 'flex', background: '#efeeec', padding: '14px 0' }}>
          {stats.map((s, i) => (
            <div key={s.label} style={{ flex: 1, textAlign: 'center', borderLeft: i === 0 ? 'none' : '1px solid #d7d5d0', padding: '0 4px' }}>
              <div style={{ fontSize: 27, fontWeight: 400, color: '#333', lineHeight: 1.05 }}>{s.value}</div>
              <div style={{ fontSize: 7.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8a8a8a', marginTop: 3 }}>{s.label}</div>
            </div>
          ))}
        </div>
      ) : null}

      {/* ── Contact band ── */}
      <div style={{ background: '#6e6e69', color: '#fff', textAlign: 'center', padding: '9px 16px', fontSize: 11.5, lineHeight: 1.3, marginTop: 14 }}>
        Call or Text {theme.footer.phone} or visit our Sales Office {theme.footer.salesHours} for more info!
      </div>

      {/* ── Description + features ── */}
      {data.description ? <p style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--pdf-ink)', margin: '16px 0 0' }}>{data.description}</p> : null}
      {data.features.length ? (
        <ul style={{ fontSize: 11.5, lineHeight: 1.55, color: 'var(--pdf-ink)', margin: '10px 0 0', paddingLeft: 18 }}>
          {data.features.map((f) => <li key={f}>{f}</li>)}
        </ul>
      ) : null}

      {/* ── Fine-print footer ── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginTop: 26 }}>
        <div style={{ flex: 1, fontSize: 6.5, lineHeight: 1.4, color: '#8a8a8a', textAlign: 'justify' }}
          dangerouslySetInnerHTML={{ __html: disclaimer }} />
        {theme.footer.showEqualHousingLogo ? (
          <div style={{ flexShrink: 0 }}><EqualHousingMark /></div>
        ) : null}
      </div>
    </div>
  );
}
