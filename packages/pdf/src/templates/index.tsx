import type { Theme } from '../theme';
import type { PdfType } from '../env';
import { wrapHtml } from './render';
import { CommunityBrochure } from './community';
import type { CommunityData } from '../data/community';
import { QmiBrochure } from './qmi';
import type { QmiData } from '../data/qmi';
import { FloorPlanBrochure } from './floorplan';
import type { FloorPlanData } from '../data/floorplan';

export function renderTemplate(type: PdfType, theme: Theme, data: unknown): string {
  switch (type) {
    case 'community':
      return wrapHtml(theme, <CommunityBrochure theme={theme} data={data as CommunityData} />);
    case 'qmi': {
      const q = data as QmiData;
      return wrapHtml(theme, (
        <>
          <QmiBrochure theme={theme} data={q} />
          {q.floorPlan ? (
            <div style={{ breakBefore: 'page' }}>
              <FloorPlanBrochure theme={theme} data={q.floorPlan} />
            </div>
          ) : null}
        </>
      ));
    }
    case 'floorplan':
      return wrapHtml(theme, <FloorPlanBrochure theme={theme} data={data as FloorPlanData} />);
    default:
      throw new Error(`template not implemented for type: ${type}`);
  }
}
