'use client';

// =============================================================================
// HoaLinksEditor — communities.hoa_links_json widget. Repeatable rows of
// { title, link }. Serializes to the EXACT shape framer-push expects: a JSON array of
// { title, link } objects (the mapper fans the first 7 into hoa_link_title_N /
// hoa_link_N). Saves via saveCommunityHoaLinks, which drops fully-empty rows and
// JSON-stringifies server-side. Capped at 7 rows (only the first 7 are pushed).
// =============================================================================

import { useState, useTransition } from 'react';
import { saveCommunityHoaLinks } from '../../lib/actions';

interface HoaLink {
  title: string;
  link: string;
}

const MAX = 7;

export function HoaLinksEditor({
  id,
  initial,
  onResult,
}: {
  id: string;
  initial: HoaLink[];
  onResult?: (msg: string) => void;
}) {
  const [links, setLinks] = useState<HoaLink[]>(initial.length ? initial : [{ title: '', link: '' }]);
  const [pending, startTransition] = useTransition();

  const update = (i: number, patch: Partial<HoaLink>) =>
    setLinks((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setLinks((rows) => rows.filter((_, j) => j !== i));
  const add = () => setLinks((rows) => (rows.length >= MAX ? rows : [...rows, { title: '', link: '' }]));

  function onSave() {
    startTransition(async () => {
      const res = await saveCommunityHoaLinks(id, links);
      onResult?.(res.ok ? 'HOA links saved' : `Error: ${res.error}`);
    });
  }

  return (
    <div className="grid gap-2">
      <div className="grid gap-2">
        {links.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <input
              placeholder="title"
              value={l.title}
              onChange={(e) => update(i, { title: e.target.value })}
              className="rounded border border-[#d8d3ca] px-2 py-1.5 text-sm"
            />
            <input
              placeholder="https://…"
              value={l.link}
              onChange={(e) => update(i, { link: e.target.value })}
              className="rounded border border-[#d8d3ca] px-2 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label="Remove link"
              className="px-2 text-gray-500 hover:text-red-600"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={add}
          disabled={links.length >= MAX}
          className="rounded-md border border-[#2f5d4a] bg-white px-3 py-1.5 text-sm text-[#2f5d4a] disabled:opacity-40"
        >
          + Add link
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="rounded-md bg-[#2f5d4a] px-3 py-1.5 text-sm text-white disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save HOA links'}
        </button>
      </div>
      {links.length >= MAX ? (
        <span className="text-xs text-gray-400">Max {MAX} links are pushed to Framer.</span>
      ) : null}
    </div>
  );
}
