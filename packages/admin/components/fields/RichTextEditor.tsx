'use client';

// =============================================================================
// RichTextEditor — the universal TRUE WYSIWYG editor for ALL rich-text fields
// (community description/amenities, the floor-plan *_rich copy blocks, city venue
// copy, blog content, etc.). Replaces the lightweight markdown RichTextField so the
// sales team gets headings, bullet/numbered lists, bold/italic, links, quotes, and
// inline images everywhere — entered visually, no markdown syntax to learn.
//
// Output: Framer-safe HTML. TipTap's ProseMirror schema (StarterKit + Link + Image)
// CONSTRAINS the output to the tag subset Framer rich text supports
// (h1-h4,p,strong,em,a,ul,ol,li,blockquote,br,img); pasted markup with unknown
// nodes/marks is dropped. saveEntity also sanitizes server-side as a second line.
//
// STORAGE CONTRACT: the value travels via a HIDDEN <input name={field}>, synced to
// editor.getHTML() on every update. Empty doc → '' (saveEntity coerces '' → NULL).
//
// LEGACY LOAD: most existing `*_rich`/description/amenities values are MARKDOWN
// ("- bullet", "**bold**"). toEditorHtml() converts markdown → HTML on load (TipTap
// parses HTML, not markdown) so authors see real formatting. On save the field is
// rewritten as HTML; framer-push's htmlFt passes HTML through and still converts any
// not-yet-migrated markdown — so the swap is backward compatible during the rollout.
//
// INLINE IMAGE UPLOAD requires a record id (R2 key = <entity>/<id>/…). When `id` is
// absent (a few detail screens render fields without it) the image button is hidden;
// all text formatting still works.
// =============================================================================

import { useCallback, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { uploadGalleryImage } from '../../lib/actions';
import { toEditorHtml } from '../../lib/markdown';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  PilcrowIcon,
  ImageIcon,
} from 'lucide-react';

const ACCEPT = 'image/*';

/** A single toolbar toggle button. `active` reflects the editor's current mark/node. */
function TbButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-7', active && 'bg-accent text-accent-foreground')}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function RichTextEditor({
  field,
  label,
  value,
  help,
  entity,
  id,
}: {
  field: string;
  label: string;
  value: string;
  help?: string;
  /** entity segment + record id — needed to key inline-image R2 uploads. When `id`
   *  is empty the image button is hidden (text formatting still works). */
  entity?: string;
  id?: string;
}) {
  // Markdown/plain legacy values → HTML so TipTap shows real formatting (see header).
  const initialHtml = toEditorHtml(value);
  // HTML mirror submitted via the hidden input.
  const [html, setHtml] = useState(initialHtml);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const imgIndex = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const canUpload = Boolean(entity && id);

  const editor = useEditor({
    extensions: [
      // levels [1,2,3,4]: H4 stays in the schema so legacy "####" survives a round-trip,
      // but the toolbar only exposes H1/H2/H3 + Body.
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      }),
      Image.configure({ inline: false }),
    ],
    content: initialHtml,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'prose prose-sm min-h-[12rem] max-w-none px-3 py-2 focus:outline-none ' +
          '[&_a]:text-primary [&_a]:underline',
        'aria-label': label,
      },
    },
    onUpdate: ({ editor }) => {
      setHtml(editor.isEmpty ? '' : editor.getHTML());
    },
  });

  const setLink = useCallback((ed: Editor) => {
    const prev = ed.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      ed.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, []);

  const onPickImage = useCallback(
    async (file: File | undefined | null) => {
      if (!file || !editor || !entity || !id) return;
      setErr(null);
      setUploading(true);
      try {
        const res = await uploadGalleryImage(entity, id, imgIndex.current++, file);
        if (res.ok) editor.chain().focus().setImage({ src: res.url, alt: file.name }).run();
        else setErr(res.error);
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [editor, entity, id]
  );

  return (
    <div className="grid gap-1.5 text-sm">
      <Label className="font-medium text-foreground">{label}</Label>

      <input type="hidden" name={field} value={html} />

      <div className="rounded-lg border border-input bg-background">
        <div className="flex flex-wrap items-center gap-1 border-b border-input bg-muted/40 px-1.5 py-1">
          <TbButton
            label="Body text"
            active={editor?.isActive('paragraph')}
            onClick={() => editor?.chain().focus().setParagraph().run()}
          >
            <PilcrowIcon className="size-4" />
          </TbButton>
          <TbButton
            label="Heading 1"
            active={editor?.isActive('heading', { level: 1 })}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
          >
            <Heading1Icon className="size-4" />
          </TbButton>
          <TbButton
            label="Heading 2"
            active={editor?.isActive('heading', { level: 2 })}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading2Icon className="size-4" />
          </TbButton>
          <TbButton
            label="Heading 3"
            active={editor?.isActive('heading', { level: 3 })}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            <Heading3Icon className="size-4" />
          </TbButton>
          <TbButton
            label="Bold"
            active={editor?.isActive('bold')}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <BoldIcon className="size-4" />
          </TbButton>
          <TbButton
            label="Italic"
            active={editor?.isActive('italic')}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <ItalicIcon className="size-4" />
          </TbButton>
          <TbButton
            label="Bullet list"
            active={editor?.isActive('bulletList')}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <ListIcon className="size-4" />
          </TbButton>
          <TbButton
            label="Numbered list"
            active={editor?.isActive('orderedList')}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <ListOrderedIcon className="size-4" />
          </TbButton>
          <TbButton
            label="Blockquote"
            active={editor?.isActive('blockquote')}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            <QuoteIcon className="size-4" />
          </TbButton>
          <TbButton
            label="Link"
            active={editor?.isActive('link')}
            onClick={() => editor && setLink(editor)}
          >
            <LinkIcon className="size-4" />
          </TbButton>
          {canUpload ? (
            <TbButton
              label="Insert image"
              disabled={uploading || !editor}
              onClick={() => fileRef.current?.click()}
            >
              <ImageIcon className="size-4" />
            </TbButton>
          ) : null}
          {uploading ? (
            <span className="ml-1 text-xs text-muted-foreground">Uploading…</span>
          ) : null}
        </div>

        {canUpload ? (
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => onPickImage(e.target.files?.[0])}
          />
        ) : null}

        <EditorContent editor={editor} />
      </div>

      {err ? <span className="text-xs text-destructive">{err}</span> : null}
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
