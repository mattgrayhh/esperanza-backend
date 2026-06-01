// =============================================================================
// PDFs section — /pdfs  (SERVER COMPONENT).
//
// Reads all pdf_renders rows via the D1 primary session (read-your-writes),
// builds the city→community tree via buildPdfTree, and passes the serializable
// result to the PdfTree client component. Also reads the active theme version for
// the header badge.
//
// Convention: follows the same force-dynamic / getReadDb() pattern used by the
// blogs and QMI list pages — one RSC fetch, client renders.
// =============================================================================

import { getReadDb } from '../../lib/db';
import { pdfRenders, pdfThemes } from '@esperanza/db';
import { buildPdfTree, type PdfRenderRowLite } from '../../lib/pdf-tree';
import { PdfTree } from '../../components/pdfs/PdfTree';

export const dynamic = 'force-dynamic';

// The PDF worker stores rendered files at this public R2 endpoint.
// e.g. https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev/pdf/community/anaqua
const PDF_PUBLIC_BASE_URL = 'https://pub-9c9bfee574a54b62b2623e361b3ad305.r2.dev';

export default async function PdfsPage() {
  const db = getReadDb();

  // Fetch all renders — keep only the fields we need for the tree + leaf display.
  const allRenders = await db
    .select({
      type: pdfRenders.type,
      slug: pdfRenders.slug,
      city_slug: pdfRenders.citySlug,
      community_id: pdfRenders.communityId,
      status: pdfRenders.status,
      entity_id: pdfRenders.entityId,
    })
    .from(pdfRenders);

  const rows: PdfRenderRowLite[] = allRenders.map((r) => ({
    type: r.type,
    slug: r.slug,
    city_slug: r.city_slug ?? null,
    community_id: r.community_id ?? null,
    status: r.status,
    entity_id: r.entity_id ?? null,
  }));

  const tree = buildPdfTree(rows);

  // Active theme version for the header badge. May be absent if no theme seeded yet.
  const themeRows = await db
    .select({ version: pdfThemes.version })
    .from(pdfThemes)
    .limit(1);
  const themeVersion = themeRows[0]?.version ?? null;

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground">PDFs</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {rows.length} render{rows.length === 1 ? '' : 's'} across {tree.length} cit{tree.length === 1 ? 'y' : 'ies'}
          </p>
        </div>
        {themeVersion != null ? (
          <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground">
            Theme v{themeVersion}
          </span>
        ) : null}
      </div>

      <PdfTree tree={tree} publicBase={PDF_PUBLIC_BASE_URL} themeVersion={themeVersion} />
    </div>
  );
}
