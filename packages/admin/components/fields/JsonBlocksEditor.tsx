'use client';

// =============================================================================
// JsonBlocksEditor — cities.city_copy_blocks_json + city_venue_blocks_json widget.
//
// Both columns are FLAT { key -> value } objects (framer-push parses them and drops
// absent keys). This editor edits BOTH at once (they save together via saveCityBlocks)
// and emits exactly that flat-object shape.
//
//   * Known keys render as a labeled form (CITY_COPY_BLOCK_KEYS / CITY_VENUE_BLOCK_KEYS).
//   * Keys whose VALUE is an image (isImageBlockKey: *_image, image_0, live_in_image)
//     get an inline R2 uploader (uploadBlockImage → stable URL stored as the value).
//   * Venue *_venues keys are markdown (textarea); other string keys are text/textarea.
//   * Free-key fallback: operators can add arbitrary extra keys (schema is open for copy).
//
// On save we drop blank values (matches the mapper's "absent keys dropped" rule).
// =============================================================================

import { useState, useTransition } from 'react';
import { saveCityBlocks, uploadBlockImage } from '../../lib/actions';
import {
  CITY_COPY_BLOCK_KEYS,
  CITY_VENUE_BLOCK_KEYS,
  isImageBlockKey,
} from '../../lib/field-config';

type Blocks = Record<string, string>;

const VENUE_MARKDOWN = new Set(['eat_venues', 'shop_venues', 'play_venues', 'relax_venues', 'stay_venues']);

export function JsonBlocksEditor({
  id,
  initialCopy,
  initialVenue,
  onResult,
}: {
  id: string;
  initialCopy: Blocks;
  initialVenue: Blocks;
  onResult?: (msg: string) => void;
}) {
  const [copy, setCopy] = useState<Blocks>(initialCopy);
  const [venue, setVenue] = useState<Blocks>(initialVenue);
  const [pending, startTransition] = useTransition();

  function onSave() {
    startTransition(async () => {
      const res = await saveCityBlocks(id, copy, venue);
      onResult?.(res.ok ? 'Blocks saved' : `Error: ${res.error}`);
    });
  }

  return (
    <div className="grid gap-6">
      <BlockGroup
        id={id}
        title="Copy Blocks — city_copy_blocks_json"
        knownKeys={CITY_COPY_BLOCK_KEYS}
        allowFreeKeys
        markdownKeys={undefined}
        blocks={copy}
        onChange={setCopy}
      />
      <BlockGroup
        id={id}
        title="Venue Blocks — city_venue_blocks_json"
        knownKeys={CITY_VENUE_BLOCK_KEYS}
        allowFreeKeys={false}
        markdownKeys={VENUE_MARKDOWN}
        blocks={venue}
        onChange={setVenue}
      />
      <button
        type="button"
        onClick={onSave}
        disabled={pending}
        className="justify-self-start rounded-md bg-[#2f5d4a] px-4 py-2 text-sm text-white disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save blocks'}
      </button>
    </div>
  );
}

function BlockGroup({
  id,
  title,
  knownKeys,
  allowFreeKeys,
  markdownKeys,
  blocks,
  onChange,
}: {
  id: string;
  title: string;
  knownKeys: readonly string[];
  allowFreeKeys: boolean;
  markdownKeys?: ReadonlySet<string>;
  blocks: Blocks;
  onChange: (next: Blocks) => void;
}) {
  const [newKey, setNewKey] = useState('');
  // Render the known keys first (in order), then any extra keys already present.
  const extraKeys = Object.keys(blocks).filter((k) => !knownKeys.includes(k));
  const orderedKeys = [...knownKeys, ...extraKeys];

  const set = (k: string, v: string) => onChange({ ...blocks, [k]: v });
  const addKey = () => {
    const k = newKey.trim();
    if (!k || k in blocks || knownKeys.includes(k)) return;
    onChange({ ...blocks, [k]: '' });
    setNewKey('');
  };

  return (
    <div className="rounded-lg border border-[#e5e1da] bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="grid gap-2">
        {orderedKeys.map((k) => (
          <BlockRow
            key={k}
            id={id}
            blockKey={k}
            value={blocks[k] ?? ''}
            isImage={isImageBlockKey(k)}
            isMarkdown={Boolean(markdownKeys?.has(k))}
            onChange={(v) => set(k, v)}
          />
        ))}
      </div>
      {allowFreeKeys ? (
        <div className="mt-3 flex gap-2">
          <input
            placeholder="add custom key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="rounded border border-[#d8d3ca] px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={addKey}
            className="rounded border border-[#2f5d4a] px-2 py-1 text-xs text-[#2f5d4a]"
          >
            + key
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BlockRow({
  id,
  blockKey,
  value,
  isImage,
  isMarkdown,
  onChange,
}: {
  id: string;
  blockKey: string;
  value: string;
  isImage: boolean;
  isMarkdown: boolean;
  onChange: (v: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onPick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    startTransition(async () => {
      const res = await uploadBlockImage('cities', id, blockKey, file);
      if (res.ok) onChange(res.url);
      else setErr(res.error);
    });
  }

  return (
    <div className="grid grid-cols-[200px_1fr] items-start gap-3">
      <span className="self-center font-mono text-xs text-gray-600">{blockKey}</span>
      {isImage ? (
        <div className="grid gap-1">
          {value && !value.includes('airtableusercontent.com') ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt={blockKey} className="h-16 w-auto rounded border border-[#e5e1da] object-contain" />
          ) : null}
          <div className="flex items-center gap-2">
            <input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="stable image URL"
              className="flex-1 rounded border border-[#d8d3ca] px-2 py-1 font-mono text-xs"
            />
            <input type="file" accept="image/*" disabled={pending} onChange={(e) => onPick(e.target.files?.[0])} className="text-xs" />
          </div>
          {pending ? <span className="text-xs text-gray-500">Uploading…</span> : null}
          {err ? <span className="text-xs text-red-600">{err}</span> : null}
        </div>
      ) : isMarkdown ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder="markdown"
          className="rounded border border-[#d8d3ca] px-2 py-1 text-sm"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-[#d8d3ca] px-2 py-1 text-sm"
        />
      )}
    </div>
  );
}
