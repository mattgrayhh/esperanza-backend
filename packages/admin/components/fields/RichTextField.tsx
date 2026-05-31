'use client';

// =============================================================================
// RichTextField — edits MARKDOWN (the existing `*_rich` columns are markdown) with a
// lightweight bold / italic / link toolbar and a preview toggle. Satisfies feedback [19].
//
// Design choices:
//   * NO heavy WYSIWYG dependency. The editor IS a <textarea> over the raw markdown; the
//     toolbar buttons wrap/insert markdown around the current selection (execCommand-free,
//     just string splicing on the textarea's selectionStart/End). This keeps the bundle
//     tiny and the stored value plain, round-trippable markdown.
//   * STORAGE CONTRACT IS UNCHANGED. The submitted value travels through a HIDDEN
//     <input name={field}> carrying the markdown string — identical to the old
//     GenericField('richtext') textarea (which submitted name={field} directly). saveEntity
//     coerces '' → NULL exactly as before; no write-path change.
//   * The preview renders a SMALL, SAFE markdown subset (bold/italic/links/line breaks)
//     with escaping so a content author can sanity-check formatting. It is a preview only;
//     the canonical stored value is always the raw markdown.
// =============================================================================

import { useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { BoldIcon, ItalicIcon, LinkIcon, EyeIcon, PencilIcon } from 'lucide-react';

/** Escape HTML so author text can't inject markup; the preview only adds OUR tags. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render a SMALL safe markdown subset → HTML for the preview pane:
 *   **bold**  *italic*  [text](https://url)  and paragraph/line breaks.
 * Inputs are escaped first, then only our recognized constructs become tags. Links are
 * restricted to http(s)/mailto so the preview can't emit a javascript: URL.
 */
function renderMarkdown(md: string): string {
  const escaped = escapeHtml(md);
  let html = escaped
    // links: [label](url) — only safe schemes
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, label, url) => {
      return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    })
    // bold then italic (bold first so **x** isn't eaten by the italic rule)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // paragraphs on blank lines, single newlines → <br>
  html = html
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br/>')}</p>`)
    .join('');
  return html;
}

/** Wrap the current textarea selection with `before`/`after`; if nothing is selected,
 *  insert the markers with a sensible placeholder and re-select it. Returns the new value
 *  and the next selection range so we can restore the caret. */
function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string
): { next: string; selStart: number; selEnd: number } {
  const selected = value.slice(start, end) || placeholder;
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  const selStart = start + before.length;
  const selEnd = selStart + selected.length;
  return { next, selStart, selEnd };
}

export function RichTextField({
  field,
  label,
  value,
  help,
}: {
  field: string;
  label: string;
  value: string;
  help?: string;
}) {
  const [md, setMd] = useState(value ?? '');
  const [preview, setPreview] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  function applyWrap(before: string, after: string, placeholder: string) {
    const el = ref.current;
    if (!el) return;
    const { selectionStart, selectionEnd } = el;
    const { next, selStart, selEnd } = wrapSelection(
      md,
      selectionStart ?? md.length,
      selectionEnd ?? md.length,
      before,
      after,
      placeholder
    );
    setMd(next);
    // Restore focus + selection after React re-renders the controlled value.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  }

  function applyLink() {
    const el = ref.current;
    if (!el) return;
    const { selectionStart, selectionEnd } = el;
    const sel = md.slice(selectionStart ?? 0, selectionEnd ?? 0);
    const linkText = sel || 'link text';
    const md2 =
      md.slice(0, selectionStart ?? 0) +
      `[${linkText}](https://)` +
      md.slice(selectionEnd ?? 0);
    setMd(md2);
    // Place the caret inside the (https://) so the author types the URL.
    const urlStart = (selectionStart ?? 0) + `[${linkText}](https://`.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(urlStart, urlStart);
    });
  }

  return (
    <div className="grid gap-1.5 text-sm">
      <Label className="font-medium text-foreground">{label}</Label>

      {/* The column value travels via this hidden input as a markdown string — exactly
          like the old textarea's name={field}. */}
      <input type="hidden" name={field} value={md} />

      {/* Toolbar */}
      <div className="flex items-center gap-1 rounded-t-lg border border-b-0 border-input bg-muted/40 px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Bold"
          disabled={preview}
          onClick={() => applyWrap('**', '**', 'bold text')}
        >
          <BoldIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Italic"
          disabled={preview}
          onClick={() => applyWrap('*', '*', 'italic text')}
        >
          <ItalicIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Link"
          disabled={preview}
          onClick={applyLink}
        >
          <LinkIcon className="size-4" />
        </Button>
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5"
            aria-pressed={preview}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? (
              <>
                <PencilIcon className="size-4" /> Edit
              </>
            ) : (
              <>
                <EyeIcon className="size-4" /> Preview
              </>
            )}
          </Button>
        </div>
      </div>

      {preview ? (
        <div
          className="prose prose-sm min-h-[8rem] max-w-none rounded-b-lg border border-input bg-background px-3 py-2 [&_a]:text-primary [&_a]:underline"
          // The preview HTML is built from escaped author text plus our own safe tags.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }}
        />
      ) : (
        <Textarea
          ref={ref}
          value={md}
          onChange={(e) => setMd(e.target.value)}
          rows={6}
          placeholder="markdown"
          className="rounded-t-none"
          aria-label={label}
        />
      )}

      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
