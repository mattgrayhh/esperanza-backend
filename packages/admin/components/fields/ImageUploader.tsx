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
//
// Re-skinned with shadcn (Input/Label/Button). The `name={field}` text input STILL
// carries the column value into saveEntity's FormData; the airtableusercontent guard is
// unchanged (client + server).
// =============================================================================

import { useRef, useState, useTransition } from 'react';
import { uploadImage } from '../../lib/actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

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
    });
  }

  function onUrlChange(next: string) {
    setUrl(next);
    setErr(next.includes(AIRTABLE_HOST) ? 'Airtable attachment URLs are not allowed.' : null);
  }

  const isAirtable = url.includes(AIRTABLE_HOST);

  return (
    <div className="grid gap-1.5 text-sm">
      <Label className="font-medium text-foreground">
        {label} <span className="font-mono text-xs font-normal text-muted-foreground">{field}</span>
      </Label>

      {url && !isAirtable ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="h-24 w-auto rounded-lg border border-border bg-card object-contain"
        />
      ) : null}

      <div className="flex items-center gap-2">
        {/* The text input carries the column value into saveEntity's FormData. */}
        <Input
          name={field}
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="stable image URL"
          aria-invalid={isAirtable}
          className="flex-1 font-mono text-xs"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          disabled={pending}
          onChange={(e) => onPick(e.target.files?.[0])}
          className="hidden"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => fileRef.current?.click()}
        >
          {pending ? 'Uploading…' : 'Upload'}
        </Button>
      </div>

      {err ? <span className="text-xs text-destructive">{err}</span> : null}
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
