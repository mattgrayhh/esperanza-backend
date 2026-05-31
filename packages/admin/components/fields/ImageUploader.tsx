'use client';

// =============================================================================
// ImageUploader — the DAM image widget. Operators UPLOAD/REPLACE a file directly and
// see an INLINE PREVIEW; they NEVER see or type a raw URL (URLs are useless to the
// marketing team — Decision-log: DAM operator requirement).
//
// How the column value still reaches saveEntity:
//   * a HIDDEN <input name={field}> carries the current stable URL into the parent
//     <form action={saveEntity}> FormData — exactly the same field name/value contract
//     as before. The URL is never rendered in a visible/editable text input.
//   * the file picker uploads the chosen asset via the uploadImage server action
//     (R2 → <entity>/<id>/<filename> → returns the STABLE r2.dev URL, which is also
//     persisted + revalidated server-side). On success we update the hidden input + the
//     inline preview from res.url. The operator never copies/pastes a URL.
//
// Airtable guard preserved: a v5.airtableusercontent.com URL is never previewed and is
// surfaced as an error (it can only arrive as legacy stored data — there is no manual
// entry path anymore). The server (uploadImage / saveEntity) rejects it too.
//
// Skinned with shadcn (Label/Button) + lucide icons.
// =============================================================================

import { useRef, useState, useTransition } from 'react';
import { uploadImage } from '../../lib/actions';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ImageIcon, UploadIcon, RefreshCwIcon, XIcon } from 'lucide-react';

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
  const fileRef = useRef<HTMLInputElement>(null);

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
      // allow re-picking the same filename
      if (fileRef.current) fileRef.current.value = '';
    });
  }

  // A previously-stored Airtable attachment URL must never be previewed (it expires and
  // is rejected on save). Treat it as "no usable image" and prompt a re-upload.
  const isAirtable = url.includes(AIRTABLE_HOST);
  const hasImage = url !== '' && !isAirtable;

  return (
    <div className="grid gap-1.5 text-sm">
      <Label className="font-medium text-foreground">
        {label} <span className="font-mono text-xs font-normal text-muted-foreground">{field}</span>
      </Label>

      {/* The column value travels via this HIDDEN input — never a visible URL field. */}
      <input type="hidden" name={field} value={isAirtable ? '' : url} />

      {/* Inline preview (or an empty placeholder) — operators see the image, not a URL. */}
      <div className="relative flex h-32 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30">
        {hasImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground">
            <ImageIcon className="size-6" />
            <span className="text-xs">{isAirtable ? 'Stale Airtable image — re-upload' : 'No image yet'}</span>
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        disabled={pending}
        onChange={(e) => onPick(e.target.files?.[0])}
        className="hidden"
      />

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => fileRef.current?.click()}
        >
          {hasImage ? <RefreshCwIcon /> : <UploadIcon />}
          {pending ? 'Uploading…' : hasImage ? 'Replace' : 'Upload'}
        </Button>
        {hasImage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setUrl('');
              setErr(null);
            }}
          >
            <XIcon />
            Remove
          </Button>
        ) : null}
      </div>

      {err ? <span className="text-xs text-destructive">{err}</span> : null}
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
