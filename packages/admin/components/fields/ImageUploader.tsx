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
import { filterAcceptedFiles } from '../../lib/dropped-files';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ImageIcon, UploadIcon, RefreshCwIcon, XIcon, FileTextIcon, ExternalLinkIcon } from 'lucide-react';

const AIRTABLE_HOST = 'airtableusercontent.com';
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif'];
const ACCEPT = 'image/*,application/pdf';

/** True when the url points at a real image (vs a PDF/doc we should show as a file).
 *  Inspect only the FILENAME's extension — splitting the whole URL on '.' would trip on
 *  the dots in the host (e.g. pub-….r2.dev), mis-flagging extension-less image keys. */
function isImageUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? '';
  const file = path.split('/').pop() ?? '';
  if (!file.includes('.')) return true; // no extension on the key → assume image
  const ext = file.split('.').pop()!.toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

function fileName(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'file';
  } catch {
    return url.split(/[?#]/)[0]?.split('/').pop() || 'file';
  }
}

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
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function onPick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    startTransition(async () => {
      try {
        const res = await uploadImage(entity, id, field, file);
        if (res.ok) {
          setUrl(res.url);
        } else {
          setErr(res.error);
        }
      } catch (e) {
        // A THROWN server action (transient worker/R2 hiccup, OpenNext body/infra
        // failure) would otherwise silently revert the spinner with no feedback —
        // looks like the upload "stalls out". Surface it so the operator can retry.
        setErr(e instanceof Error ? e.message : 'Upload failed — please retry.');
      } finally {
        // allow re-picking the same filename
        if (fileRef.current) fileRef.current.value = '';
      }
    });
  }

  function onDrop(files: Iterable<File>) {
    const accepted = filterAcceptedFiles(files, ACCEPT);
    if (accepted.length === 0) {
      setErr('Drop an image (or PDF) file here.');
      return;
    }
    onPick(accepted[0]); // single-value field — first accepted file wins
  }

  // A previously-stored Airtable attachment URL must never be previewed (it expires and
  // is rejected on save). Treat it as "no usable image" and prompt a re-upload.
  const isAirtable = url.includes(AIRTABLE_HOST);
  const hasFile = url !== '' && !isAirtable;
  // Download/brochure/PDF fields hold documents even when the migrated R2 key has no
  // extension — detect them by field name so they show a file card, not a broken <img>
  // (feedback [14]). Plus any url whose filename is a non-image extension.
  const isDocField = /download|brochure|pdf/i.test(field);
  const isDoc = hasFile && (isDocField || !isImageUrl(url));
  const hasImage = hasFile && !isDoc;

  return (
    <div className="grid gap-1.5 text-sm">
      <Label className="font-medium text-foreground">{label}</Label>

      {/* The column value travels via this HIDDEN input — never a visible URL field. */}
      <input type="hidden" name={field} value={isAirtable ? '' : url} />

      {/* Inline preview — image thumbnail, a file card for PDFs/docs, or an empty
          placeholder. Also a dropzone: drag a file onto it to upload/replace. */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!pending) onDrop(e.dataTransfer.files);
        }}
        className={cn(
          'relative flex h-32 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30 transition-colors',
          dragOver && 'border-2 border-dashed border-primary bg-primary/5'
        )}
      >
        {hasImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : isDoc ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex flex-col items-center gap-1.5 px-3 text-center text-muted-foreground hover:text-foreground"
          >
            <FileTextIcon className="size-7 text-primary" />
            <span className="max-w-full truncate text-xs font-medium">
              {fileName(url).includes('.') ? fileName(url) : 'Attached file'}
            </span>
            <span className="inline-flex items-center gap-1 text-primary text-xs">
              View <ExternalLinkIcon className="size-3" />
            </span>
          </a>
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted-foreground">
            <ImageIcon className="size-6" />
            <span className="text-xs">
              {isAirtable ? 'Stale Airtable image — re-upload' : 'No file yet — drag one here or Upload'}
            </span>
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
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
          {hasFile ? <RefreshCwIcon /> : <UploadIcon />}
          {pending ? 'Uploading…' : hasFile ? 'Replace' : 'Upload'}
        </Button>
        {hasFile ? (
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
