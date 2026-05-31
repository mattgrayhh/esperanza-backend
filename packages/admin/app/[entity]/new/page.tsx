// "New record" route: /<segment>/new. Confirms then creates a fresh record via the
// createEntity server action and redirects to its editor. Kept as an explicit confirm
// step (rather than auto-creating on navigation) so an accidental click doesn't litter
// empty rows.
import { notFound, redirect } from 'next/navigation';
import { ENTITY_LIST } from '../../../lib/entities';
import { createEntity } from '../../../lib/actions';

export const dynamic = 'force-dynamic';

function bySegment(segment: string) {
  return ENTITY_LIST.find((e) => e.segment === segment);
}

export default async function NewEntityPage({
  params,
}: {
  params: Promise<{ entity: string }>;
}) {
  const { entity } = await params;
  const def = bySegment(entity);
  if (!def) notFound();

  async function create() {
    'use server';
    const res = await createEntity(def!.key);
    if (res.ok) redirect(`/${def!.segment}/${res.id}`);
    throw new Error(res.error);
  }

  return (
    <div className="max-w-lg">
      <h1 className="mb-3 text-xl font-bold">New {def.label.replace(/s$/, '')}</h1>
      <p className="mb-4 text-sm text-gray-600">
        Creates a blank {def.label.replace(/s$/, '')} record (unpublished). You can fill in fields
        and publish it from the editor.
      </p>
      <form action={create} className="flex gap-3">
        <button type="submit" className="rounded-md bg-[#2f5d4a] px-4 py-2 text-sm text-white">
          Create record
        </button>
        <a href={`/${def.segment}`} className="rounded-md border border-[#d8d3ca] px-4 py-2 text-sm">
          Cancel
        </a>
      </form>
    </div>
  );
}
