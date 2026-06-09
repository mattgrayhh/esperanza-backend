'use client';

// =============================================================================
// ImageGalleryEditor — ordered multi-image gallery widget.
//
// Stores an ordered JSON array of stable R2 image URLs in a single hidden
// <input name={field}> so the parent <form action={saveEntity}> picks it up
// on submit.  Operators upload via R2 (uploadGalleryImage); they never type URLs.
//
// UX:
//   · Grid of thumbnails with remove (×) buttons.
//   · "Add image" button at the end opens the file picker.
//   · Re-order: arrow-up / arrow-down buttons per image.
// =============================================================================

import { useRef, useState, useTransition } from 'react';
import { uploadGalleryImage } from '../../lib/actions';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { UploadIcon, XIcon, ChevronUpIcon, ChevronDownIcon, ImageIcon } from 'lucide-react';

const AIRTABLE_HOST = 'airtableusercontent.com';

function parseUrls(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((u) => typeof u === 'string' && u.length > 0);
  } catch {
    // legacy newline-separated fallback
    return raw.split('\n').map((u) => u.trim()).filter(Boolean);
  }
  return [];
}

export function ImageGalleryEditor({
  entity,
  id,
  field,
  label,
  initialValue,
  help,
}: {
  entity: string;
  id: string;
  field: string;
  label: string;
  initialValue: string;
  help?: string;
}) {
  const [urls, setUrls] = useState<string[]>(() => parseUrls(initialValue));
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function move(index: number, dir: -1 | 1) {
    setUrls((prev) => {
      const next = [...prev];
      const swap = index + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[index], next[swap]] = [next[swap]!, next[index]!];
      return next;
    });
  }

  function remove(index: number) {
    setUrls((prev) => prev.filter((_, i) => i !== index));
  }

  function onPick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    const index = urls.length; // slot for the new image
    startTransition(async () => {
      const res = await uploadGalleryImage(entity, id, index, file);
      if (res.ok) {
        setUrls((prev) => [...prev, res.url]);
      } else {
        setErr(res.error);
      }
      if (fileRef.current) fileRef.current.value = '';
    });
  }

  const serialized = JSON.stringify(urls);

  return (
    <div className="grid gap-2 text-sm">
      <Label className="font-medium text-foreground">{label}</Label>

      {/* Hidden input carries the serialized array into the form submit */}
      <input type="hidden" name={field} value={serialized} />

      {urls.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {urls.map((url, i) => {
            const isAirtable = url.includes(AIRTABLE_HOST);
            return (
              <div key={i} className="group relative overflow-hidden rounded-md border border-border bg-muted/30">
                {isAirtable ? (
                  <div className="flex h-24 flex-col items-center justify-center gap-1 p-1 text-center text-muted-foreground">
                    <ImageIcon className="size-5" />
                    <span className="text-[10px]">Stale — re-upload</span>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt={`${label} ${i + 1}`} className="h-24 w-full object-cover" />
                )}

                {/* Controls overlay */}
                <div className="absolute inset-0 flex flex-col items-end justify-between p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    className="size-5 rounded-sm"
                    onClick={() => remove(i)}
                    title="Remove"
                  >
                    <XIcon className="size-3" />
                  </Button>
                  <div className="flex gap-0.5">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-5 rounded-sm"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                      title="Move left"
                    >
                      <ChevronUpIcon className="size-3 rotate-[-90deg]" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-5 rounded-sm"
                      disabled={i === urls.length - 1}
                      onClick={() => move(i, 1)}
                      title="Move right"
                    >
                      <ChevronDownIcon className="size-3 rotate-[-90deg]" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
          <span className="text-xs">No images yet</span>
        </div>
      )}

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
        className="w-fit"
      >
        <UploadIcon />
        {pending ? 'Uploading…' : 'Add image'}
      </Button>

      {err ? <span className="text-xs text-destructive">{err}</span> : null}
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
