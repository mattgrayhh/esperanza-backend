import type { Theme } from '../theme';
import type { PdfType } from '../env';
import { wrapHtml } from './render';
import { CommunityBrochure } from './community';
import type { CommunityData } from '../data/community';
import { QmiBrochure } from './qmi';
import type { QmiData } from '../data/qmi';

export function renderTemplate(type: PdfType, theme: Theme, data: unknown): string {
  switch (type) {
    case 'community':
      return wrapHtml(theme, <CommunityBrochure theme={theme} data={data as CommunityData} />);
    case 'qmi':
      return wrapHtml(theme, <QmiBrochure theme={theme} data={data as QmiData} />);
    default:
      throw new Error(`template not implemented for type: ${type}`);
  }
}
