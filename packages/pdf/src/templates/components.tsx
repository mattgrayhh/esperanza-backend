import type { Theme } from '../theme';
import { money } from '../data/shared';

export function Header({ theme, title }: { theme: Theme; title: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
      {theme.brand.logoWordmarkUrl
        ? <img src={theme.brand.logoWordmarkUrl} alt="Esperanza Homes" style={{ height: 44 }} />
        : <span style={{ fontFamily: 'var(--pdf-font-heading)', color: 'var(--pdf-primary)', fontSize: 22 }}>Esperanza</span>}
      <span className="pdf-band" style={{ padding: '10px 24px', borderRadius: 4, fontFamily: 'var(--pdf-font-heading)', fontSize: 18 }}>{title}</span>
    </div>
  );
}

export function Footer({ theme, disclaimer }: { theme: Theme; disclaimer: string }) {
  return (
    <div style={{ borderTop: '1px solid #ddd', marginTop: 18, paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 8, color: 'var(--pdf-neutral)' }}>
      <div style={{ maxWidth: '78%' }}>
        <div style={{ marginBottom: 4 }}>{theme.footer.website} · {theme.footer.phone} · {theme.footer.salesHours}</div>
        <div dangerouslySetInnerHTML={{ __html: disclaimer }} />
      </div>
      {theme.footer.showEqualHousingLogo
        ? (theme.brand.logoMonogramUrl
            ? <img src={theme.brand.logoMonogramUrl} alt="" style={{ height: 28 }} />
            : <span aria-hidden>⌂=</span>)
        : null}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="pdf-label" style={{ fontSize: 13, margin: '14px 0 10px' }}>{children}</div>;
}

export interface PlanCardData {
  id: string; name: string; beds: number | null; baths: number | null; garage: number | null;
  stories: number | null; sqft: number | null; price: number | null; imageUrl: string;
}
export function FloorPlanCard({ plan }: { plan: PlanCardData }) {
  return (
    <div style={{ textAlign: 'center', breakInside: 'avoid' }}>
      <div style={{ height: 120, background: '#eef0ee', borderRadius: 3, overflow: 'hidden' }}>
        {plan.imageUrl ? <img src={plan.imageUrl} alt={plan.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
      </div>
      <div style={{ fontFamily: 'var(--pdf-font-heading)', fontSize: 16, color: 'var(--pdf-primary)', marginTop: 6 }}>{plan.name}</div>
      <div style={{ fontSize: 10 }}>
        {[plan.beds && `${plan.beds} Bed`, plan.garage && `${plan.garage} Car Garage`, plan.baths != null && `${plan.baths} Bath`].filter(Boolean).join(' · ')}
        <br />
        {[plan.stories != null && `${plan.stories} ${plan.stories === 1 ? 'Story' : 'Stories'}`, plan.sqft && `${plan.sqft.toLocaleString('en-US')} Sq. Ft.`].filter(Boolean).join(' · ')}
      </div>
      {plan.price != null ? <div style={{ fontWeight: 700, marginTop: 2 }}>{money(plan.price)}</div> : null}
    </div>
  );
}
