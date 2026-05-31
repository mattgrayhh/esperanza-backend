// =============================================================================
// esperanza-cf — Airtable REST reader (Phase 2 import, NOT MCP).
//
// Paginates EVERY record via the public REST API offset loop, blowing past the
// MCP/list 94-record cap. No fields[] projection — we pull the raw record shape
// {id, createdTime, fields:{...}} verbatim (the same contract the cache workers
// emit), so the importer sees the original Airtable field NAMES and native value
// encodings. Empty cells are OMITTED from fields (Airtable does not emit them).
//
// Auth: AIRTABLE_PAT (env). NEVER hardcoded. Read-only — this module only GETs.
// =============================================================================

export const BASE_ID = 'app2WqQR75HFBQp73';

/** Airtable table ids for the 9 managed entities (Plan v2). */
export const TABLES = {
  qmi: 'tblc04KuFhfrHxloa',
  communities: 'tbl7K74YbKr9VpqS5',
  cities: 'tblt4BpBkC986nbX6',
  floorPlans: 'tblygSIHuaZVxGh6I',
  promotions: 'tblJawCzIlz1yhuCN',
  collections: 'tbl1j1n3uTlFFID7r',
  images: 'tblPHrBocFDfQ5PFa',
  blogs: 'tblVKeDOK6O52Whza',
  testimonials: 'tblraemFBmbE8evS4',
} as const;

export type EntityKey = keyof typeof TABLES;

/** Literal Airtable record shape (raw — original field NAMES as keys). */
export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

const API = 'https://api.airtable.com/v0';

function patOrThrow(): string {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) {
    throw new Error(
      'AIRTABLE_PAT is not set. Export it (or put it in packages/db/.dev.vars) before running the import.'
    );
  }
  return pat;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch ALL records for a table via the offset loop (pageSize=100).
 * Retries on 429 / 5xx with exponential backoff. Returns the raw records.
 */
export async function fetchAllRecords(
  tableId: string,
  opts: { pat?: string; pageSize?: number; maxRetries?: number; onPage?: (n: number, total: number) => void } = {}
): Promise<AirtableRecord[]> {
  const pat = opts.pat ?? patOrThrow();
  const pageSize = opts.pageSize ?? 100;
  const maxRetries = opts.maxRetries ?? 6;
  const out: AirtableRecord[] = [];
  let offset: string | undefined;
  let page = 0;

  do {
    const url = new URL(`${API}/${BASE_ID}/${encodeURIComponent(tableId)}`);
    url.searchParams.set('pageSize', String(pageSize));
    if (offset) url.searchParams.set('offset', offset);
    // NO fields[] projection: pull the full raw record (Airtable 422s on unknown
    // field names, and we want every column anyway).

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${pat}` },
      });
      if (res.ok) {
        const json = (await res.json()) as { records: AirtableRecord[]; offset?: string };
        out.push(...(json.records ?? []));
        offset = json.offset;
        page += 1;
        opts.onPage?.(page, out.length);
        break;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const backoff = Math.min(2 ** attempt * 500, 15000);
        attempt += 1;
        await sleep(backoff);
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new Error(`Airtable GET ${tableId} failed: ${res.status} ${res.statusText} ${body}`);
    }
  } while (offset);

  return out;
}
