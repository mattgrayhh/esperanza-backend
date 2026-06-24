import type { Env } from './env';
import { loadActiveTheme } from './theme';
import { renderTemplate } from './templates';
import { renderPdf as realRender } from './render';
import { stableHash } from './hash';
import { getObject as realGet, putObject as realPut } from './store';
import { loadFilteredListData, type FilteredKind, type ListFilters } from './data/list';

// On-demand "download the current filter selection" lists are rendered off the request path
// (via RENDER_Q) because a full set — e.g. all ~126 published QMIs ≈ 15 pages — exceeds the
// renderer's default 30s printToPDF timeout AND the Worker request budget. The bulk render
// runs in the queue consumer with a generous timeout and is cached in R2 by a content hash;
// the dataHash makes the cache self-invalidate when the matching inventory changes.
export const FILTERED_RENDER_TIMEOUT_MS = 110_000;

export function parseListFilters(sp: URLSearchParams): ListFilters {
  const n = (k: string): number | undefined => {
    const v = sp.get(k);
    if (v == null || v === '') return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const s = (k: string): string | undefined => sp.get(k) || undefined;
  return {
    city: s('city'),
    community: s('community'),
    collection: s('collection'),
    minBeds: n('minBeds'),
    minBaths: n('minBaths'),
    minPrice: n('minPrice'),
    maxPrice: n('maxPrice'),
    minSqft: n('minSqft'),
    maxSqft: n('maxSqft'),
    stories: n('stories'),
    garage: n('garage'),
    availableNow: sp.get('status') === 'available' || sp.get('availableNow') === 'true',
  };
}

export interface FilteredResolved {
  key: string;
  theme: Awaited<ReturnType<typeof loadActiveTheme>>['theme'];
  data: Awaited<ReturnType<typeof loadFilteredListData>>;
}

// Resolve a `/pdf/filtered/<kind>?<query>` request to its deterministic R2 key + render data.
// The route, the poll endpoint, and the queue consumer all call this so they agree on the key.
export async function resolveFiltered(env: Env, kind: FilteredKind, sp: URLSearchParams): Promise<FilteredResolved> {
  const filters = parseListFilters(sp);
  const { theme } = await loadActiveTheme(env.DB);
  const data = await loadFilteredListData(env.DB, kind, filters, env.PDF_PUBLIC_BASE_URL);
  const items = kind === 'qmis' ? data.qmis : data.cards;
  const dataHash = await stableHash(items.map((i: any) => [i.id, i.price ?? null, i.availability ?? null]));
  const key = `pdf/filtered/${kind}/${await stableHash({ filters, dataHash })}.pdf`;
  return { key, theme, data };
}

export interface FilteredRenderDeps {
  render?: (env: Env, html: string, margins?: any, timeoutMs?: number) => Promise<Uint8Array>;
  getObject?: (key: string) => Promise<unknown | null>;
  putObject?: (key: string, pdf: Uint8Array) => Promise<void>;
}

// Queue consumer: render + store a filtered list. Idempotent — if the R2 object already exists
// (a duplicate send or a retry after success), this is a no-op so we never re-render needlessly.
export async function renderFilteredJob(env: Env, kind: FilteredKind, query: string, deps: FilteredRenderDeps = {}): Promise<'rendered' | 'cached'> {
  const getObject = deps.getObject ?? ((k: string) => realGet(env, k));
  const putObject = deps.putObject ?? ((k: string, b: Uint8Array) => realPut(env, k, b));
  const render = deps.render ?? realRender;

  const { key, theme, data } = await resolveFiltered(env, kind, new URLSearchParams(query));
  if (await getObject(key)) return 'cached';
  const html = renderTemplate('list', theme, data);
  const pdf = await render(env, html, theme.page.marginsMm, FILTERED_RENDER_TIMEOUT_MS);
  await putObject(key, pdf);
  return 'rendered';
}
