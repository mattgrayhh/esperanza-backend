import type { Theme } from '../theme';
import type { PdfType } from '../env';
import { wrapHtml } from './render';
import { CommunityBrochure } from './community';
import type { CommunityData } from '../data/community';
import { QmiBrochure } from './qmi';
import type { QmiData } from '../data/qmi';
import { FloorPlanBrochure } from './floorplan';
import type { FloorPlanData } from '../data/floorplan';
import { ListBrochure } from './list';
import type { ListData } from '../data/list';

export function renderTemplate(type: PdfType, theme: Theme, data: unknown): string {
  switch (type) {
    case 'community':
      return wrapHtml(theme, <CommunityBrochure theme={theme} data={data as CommunityData} />);
    case 'qmi': {
      const q = data as QmiData;
      // Zero margins so the full-bleed background PNG fills the page edge-to-edge.
      // The floor plan page(s) inherit the same zero margins — acceptable trade-off for now.
      return wrapHtml(theme, (
        <>
          <QmiBrochure theme={theme} data={q} />
          {q.floorPlan ? (
            <div style={{ breakBefore: 'page' }}>
              <FloorPlanBrochure theme={theme} data={q.floorPlan} />
            </div>
          ) : null}
        </>
      ), { top: 0, right: 0, bottom: 0, left: 0 });
    }
    case 'floorplan':
      return wrapHtml(theme, <FloorPlanBrochure theme={theme} data={data as FloorPlanData} />);
    case 'list': {
      const ld = data as ListData;
      // The QMI grid renders full-bleed over the branded template artwork (header/footer are
      // baked into the background image), so it uses zero page margins.
      const margins = ld.kind === 'qmis' ? { top: 0, right: 0, bottom: 0, left: 0 } : undefined;
      return wrapHtml(theme, <ListBrochure theme={theme} data={ld} />, margins);
    }
    default:
      throw new Error(`template not implemented for type: ${type}`);
  }
}
