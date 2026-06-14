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
//   · "Add images" button at the end opens a multi-select file picker.
//   · Drag one or more image files anywhere onto the widget to bulk-upload
//     them in drop order.
//   · Re-order: arrow-up / arrow-down buttons per image.
// =============================================================================

import { useRef, useState, useTransition } from 'react';
import { uploadGalleryImage } from '../../lib/actions';
import { filterAcceptedFiles } from '../../lib/dropped-files';
import { parseGalleryUrls } from '../../lib/gallery-urls';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { UploadIcon, XIcon, ChevronUpIcon, ChevronDownIcon, ImageIcon } from 'lucide-react';

const ACCEPT = 'image/*';

const AIRTABLE_HOST = 'airtableusercontent.com';

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
  const [urls, setUrls] = useState<string[]>(() => parseGalleryUrls(initialValue));
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
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

  function addFiles(picked: Iterable<File> | null | undefined) {
    if (!picked) return;
    const files = filterAcceptedFiles(picked, ACCEPT);
    if (files.length === 0) {
      setErr('Only image files can be added to the gallery.');
      return;
    }
    setErr(null);
    let index = urls.length; // slot for the first new image
    startTransition(async () => {
      // Sequential on purpose: keeps the gallery in drop/pick order.
      const errors: string[] = [];
      for (const file of files) {
        const res = await uploadGalleryImage(entity, id, index, file);
        if (res.ok) {
          setUrls((prev) => [...prev, res.url]);
          index += 1;
        } else {
          errors.push(res.error);
        }
      }
      if (errors.length > 0) {
        setErr(errors.length === 1 ? errors[0]! : `${errors.length} uploads failed: ${errors[0]}`);
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

      {/* Everything inside is a dropzone — drag image files anywhere onto the
          widget to bulk-upload them in drop order. */}
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
          if (!pending) addFiles(e.dataTransfer.files);
        }}
        className={cn(
          'grid gap-2 rounded-lg transition-colors',
          dragOver && 'outline-2 outline-dashed outline-primary bg-primary/5'
        )}
      >
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
          <span className="text-xs">No images yet — drag photos here or use Add images</span>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        multiple
        disabled={pending}
        onChange={(e) => addFiles(e.target.files)}
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
        {pending ? 'Uploading…' : 'Add images'}
      </Button>
      </div>

      {err ? <span className="text-xs text-destructive">{err}</span> : null}
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
