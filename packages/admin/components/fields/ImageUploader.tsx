'use client';

// =============================================================================
// ImageUploader — image widget. Shows the current image (if any), an upload control,
// and the stored stable URL. Uploads via the uploadImage server action (R2 → column),
// which keys the object at <entity>/<id>/<filename> and persists the returned stable
// URL into the named column. FORBIDS v5.airtableusercontent.com URLs both on manual
// entry (client guard) and on save (server guard in actions.ts / uploadImage).
//
// The text input lets an operator paste an already-stable URL; the file input uploads
// a new asset. Both write the same column on submit (text via saveEntity, file via the
// immediate uploadImage round-trip which also persists + revalidates).
// =============================================================================

import { useState, useTransition } from 'react';
import { uploadImage } from '../../lib/actions';

const AIRTABLE_HOST = 'airtableusercontent.com';

export function ImageUploader({
  entity,
  id,
  field,
  label,
  initialUrl,
  help,
}: {
  entity: string;
  id: string;
  field: string;
  label: string;
  initialUrl: string;
  help?: string;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onPick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    startTransition(async () => {
      const res = await uploadImage(entity, id, field, file);
      if (res.ok) {
        setUrl(res.url);
      } else {
        setErr(res.error);
      }
    });
  }

  function onUrlChange(next: string) {
    setUrl(next);
    setErr(next.includes(AIRTABLE_HOST) ? 'Airtable attachment URLs are not allowed.' : null);
  }

  const isAirtable = url.includes(AIRTABLE_HOST);

  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium text-gray-700">
        {label} <span className="font-mono text-xs text-gray-400">{field}</span>
      </span>
      {url && !isAirtable ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="h-24 w-auto rounded border border-[#e5e1da] object-contain bg-white"
        />
      ) : null}
      <div className="flex items-center gap-2">
        {/* The hidden-ish text input carries the column value into saveEntity's FormData. */}
        <input
          name={field}
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="stable image URL"
          className="flex-1 rounded border border-[#d8d3ca] px-2 py-1.5 font-mono text-xs"
        />
        <input
          type="file"
          accept="image/*"
          disabled={pending}
          onChange={(e) => onPick(e.target.files?.[0])}
          className="text-xs"
        />
      </div>
      {pending ? <span className="text-xs text-gray-500">Uploading…</span> : null}
      {err ? <span className="text-xs text-red-600">{err}</span> : null}
      {help ? <span className="text-xs text-gray-400">{help}</span> : null}
    </label>
  );
}
