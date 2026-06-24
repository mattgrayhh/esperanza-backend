import type { BrowserWorker } from '@cloudflare/puppeteer';

export type PdfType = 'community' | 'qmi' | 'floorplan' | 'list';
export type RenderStatus = 'not_built' | 'rendering' | 'live' | 'stale' | 'error';

// A normal job renders one (type, slug) entity. A `filtered` job renders an on-demand
// filtered list ("download current selection") off the request path — `query` is the
// original `/pdf/filtered/<kind>` querystring, which the consumer re-resolves to the same
// R2 key so the render is deterministic and idempotent.
export interface RenderJob {
  type: PdfType;
  slug: string;
  reason: string;
  filtered?: { kind: 'qmis' | 'plans'; query: string };
}

export interface Env {
  BROWSER: BrowserWorker;
  RENDERER: DurableObjectNamespace;
  DB: D1Database;
  IMAGES: R2Bucket;
  RENDER_Q?: Queue<RenderJob>;
  IMAGES_PUBLIC_BASE_URL: string;
  PDF_PUBLIC_BASE_URL: string;
  ADMIN_ORIGIN: string;
  PDF_PREVIEW_SECRET?: string;
}
