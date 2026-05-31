// Generic config-driven list page: /<segment>. Renders the entity's configured list
// columns from the base table (so drafts are visible to the operator), a row link to
// the editor, a "New" button, and a published/active/status indicator per row.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ENTITY_LIST } from '../../lib/entities';
import { buildListView } from '../../lib/build-list-view';

export const dynamic = 'force-dynamic';

function bySegment(segment: string) {
  return ENTITY_LIST.find((e) => e.segment === segment);
}

export default async function EntityListPage({
  params,
}: {
  params: Promise<{ entity: string }>;
}) {
  const { entity } = await params;
  const def = bySegment(entity);
  if (!def) notFound();

  const view = await buildListView(def.key);
  const showLive = view.gateColumn != null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold">{def.label}</h1>
        <Link
          href={`/${def.segment}/new`}
          className="rounded-md bg-[#2f5d4a] px-3 py-1.5 text-sm text-white"
        >
          + New
        </Link>
      </div>
      <p className="mb-3 text-xs text-gray-500">
        {view.rows.length} record(s){view.truncated ? ` (showing first ${view.rows.length})` : ''}
      </p>

      <div className="overflow-x-auto rounded-lg border border-[#e5e1da] bg-white">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[#e5e1da] text-left text-xs uppercase tracking-wide text-gray-500">
              {view.columns.map((c) => (
                <th key={c.field} className="px-3 py-2 font-medium">
                  {c.label}
                </th>
              ))}
              {showLive ? <th className="px-3 py-2 font-medium">State</th> : null}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.id} className="border-b border-[#f0ede7] last:border-0 hover:bg-[#faf9f6]">
                {r.cells.map((cell, i) => (
                  <td key={cell.field} className="px-3 py-2">
                    {i === 0 ? (
                      <Link href={`/${def.segment}/${r.id}`} className="font-medium text-[#2f5d4a] hover:underline">
                        {cell.value || r.id}
                      </Link>
                    ) : cell.kind === 'publish' ? (
                      <PublishPill value={cell.value} />
                    ) : (
                      <span className="text-gray-700">{cell.value || '—'}</span>
                    )}
                  </td>
                ))}
                {showLive ? (
                  <td className="px-3 py-2">
                    <StatePill live={r.live} />
                  </td>
                ) : null}
                <td className="px-3 py-2 text-right">
                  <Link href={`/${def.segment}/${r.id}`} className="text-xs text-gray-400 hover:text-[#2f5d4a]">
                    edit →
                  </Link>
                </td>
              </tr>
            ))}
            {view.rows.length === 0 ? (
              <tr>
                <td colSpan={view.columns.length + (showLive ? 2 : 1)} className="px-3 py-6 text-center text-gray-400">
                  No records.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatePill({ live }: { live: boolean | null }) {
  if (live == null) return <span className="text-gray-400">—</span>;
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        live ? 'bg-[#dfefe4] text-[#2f5d4a]' : 'bg-gray-100 text-gray-500'
      }`}
    >
      {live ? 'live' : 'draft'}
    </span>
  );
}

function PublishPill({ value }: { value: string }) {
  const live = value !== '' && value !== '0' && value !== 'no' && value !== 'false' && value !== 'Draft';
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        live ? 'bg-[#dfefe4] text-[#2f5d4a]' : 'bg-gray-100 text-gray-500'
      }`}
    >
      {value === '' ? (live ? 'live' : 'draft') : value}
    </span>
  );
}
