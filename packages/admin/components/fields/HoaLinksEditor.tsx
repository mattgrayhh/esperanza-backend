'use client';

// =============================================================================
// HoaLinksEditor — communities.hoa_links_json widget. Repeatable rows of
// { title, link }. Serializes to the EXACT shape framer-push expects: a JSON array of
// { title, link } objects (the mapper fans the first 7 into hoa_link_title_N /
// hoa_link_N). Saves via saveCommunityHoaLinks, which drops fully-empty rows and
// JSON-stringifies server-side. Capped at 7 rows (only the first 7 are pushed).
//
// Re-skinned with shadcn (Input/Button). The {title, link} row model + saveCommunityHoaLinks
// call (and the MAX=7 cap) are UNCHANGED.
// =============================================================================

import { useState, useTransition } from 'react';
import { saveCommunityHoaLinks } from '../../lib/actions';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { XIcon, PlusIcon } from 'lucide-react';

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
    <div className="grid gap-3">
      <div className="grid gap-2">
        {links.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <Input placeholder="title" value={l.title} onChange={(e) => update(i, { title: e.target.value })} />
            <Input placeholder="https://…" value={l.link} onChange={(e) => update(i, { link: e.target.value })} />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => remove(i)}
              aria-label="Remove link"
              className="text-muted-foreground hover:text-destructive"
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={links.length >= MAX}>
          <PlusIcon /> Add link
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={pending}>
          {pending ? 'Saving…' : 'Save HOA links'}
        </Button>
      </div>
      {links.length >= MAX ? (
        <span className="text-xs text-muted-foreground">Max {MAX} links are pushed to Framer.</span>
      ) : null}
    </div>
  );
}
