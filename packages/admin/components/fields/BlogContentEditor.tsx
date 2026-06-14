'use client';

// =============================================================================
// BlogContentEditor — a TRUE WYSIWYG editor for the BLOG `content` field, replacing
// the lightweight markdown textarea (RichTextField) for this one field only.
//
// Output: HTML stored in D1 `blogs.content`. The editor's schema (TipTap StarterKit +
// Link + Image) is what CONSTRAINS the output to the tag subset Framer rich text
// supports — h2,h3,h4,p,strong,em,a,ul,ol,li,blockquote,br,img. Authors cannot paste
// arbitrary markup that introduces unsupported tags: TipTap's ProseMirror schema parses
// any pasted HTML and DROPS unknown nodes/marks. (A belt-and-suspenders server-side
// sanitize in saveEntity strips <script>/<style>/<iframe>/on*= as a second line.)
//
// STORAGE CONTRACT (identical to RichTextField): the value travels through a HIDDEN
// <input type="hidden" name="content">, kept in sync with editor.getHTML() on every
// update. The parent <form action={saveEntity}> picks up `content` as a TEXT string and
// writes it to the column unchanged. Empty doc → '' (saveEntity coerces '' → NULL).
//
// INLINE IMAGE UPLOAD: the Image button → file picker → uploadGalleryImage('blogs', id,
// index, file) server action. That action stores the file in R2 and returns the STABLE
// public URL WITHOUT writing any column (unlike uploadImage, which would clobber the
// `content` column). The returned URL is inserted as an <img> node at the cursor.
//
// The record `id` (recXXXX / admXXXX) is threaded in from EntityEditForm (which already
// has `segment` + `id` for ImageUploader/ImageGalleryEditor) → GenericField → here.
// =============================================================================

import { useCallback, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { uploadGalleryImage } from '../../lib/actions';
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
  Heading2Icon,
  Heading3Icon,
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

export function BlogContentEditor({
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
  /** entity segment (e.g. 'blogs') + record id — needed to key the R2 upload. */
  entity: string;
  id: string;
}) {
  // HTML mirror of the document, submitted via the hidden input. Seeded from the incoming
  // value (existing HTML, or legacy plain/markdown text — TipTap loads it as content).
  const [html, setHtml] = useState(value ?? '');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Monotonic counter so each inline image gets a distinct R2 key (gallery-<n>-<file>).
  const imgIndex = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      // StarterKit: paragraph, headings, bold, italic, bulletList, orderedList,
      // listItem, blockquote, hardBreak (br). These are the only nodes/marks the schema
      // accepts → output is restricted to the Framer-supported subset.
      StarterKit.configure({
        heading: { levels: [2, 3, 4] }, // h2/h3/h4 only (no h1 — that's the page title)
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      }),
      Image.configure({ inline: false }),
    ],
    content: value || '',
    // Avoid an SSR hydration mismatch under Next App Router.
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
      // Empty doc → '' so saveEntity coerces to NULL (matches RichTextField's '' contract).
      setHtml(editor.isEmpty ? '' : editor.getHTML());
    },
  });

  const setLink = useCallback(
    (ed: Editor) => {
      const prev = ed.getAttributes('link').href as string | undefined;
      const url = window.prompt('Link URL', prev ?? 'https://');
      if (url === null) return; // cancelled
      if (url === '') {
        ed.chain().focus().extendMarkRange('link').unsetLink().run();
        return;
      }
      ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    },
    []
  );

  const onPickImage = useCallback(
    async (file: File | undefined | null) => {
      if (!file || !editor) return;
      setErr(null);
      setUploading(true);
      try {
        const res = await uploadGalleryImage(entity, id, imgIndex.current++, file);
        if (res.ok) {
          editor.chain().focus().setImage({ src: res.url, alt: file.name }).run();
        } else {
          setErr(res.error);
        }
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

      {/* Storage contract: the HTML travels via this hidden input as `content`, exactly
          like the old RichTextField's name={field} markdown string. */}
      <input type="hidden" name={field} value={html} />

      <div className="rounded-lg border border-input bg-background">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1 border-b border-input bg-muted/40 px-1.5 py-1">
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
          <TbButton
            label="Insert image"
            disabled={uploading || !editor}
            onClick={() => fileRef.current?.click()}
          >
            <ImageIcon className="size-4" />
          </TbButton>
          {uploading ? (
            <span className="ml-1 text-xs text-muted-foreground">Uploading…</span>
          ) : null}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => onPickImage(e.target.files?.[0])}
        />

        {/* The editable surface. */}
        <EditorContent editor={editor} />
      </div>

      {err ? <span className="text-xs text-destructive">{err}</span> : null}
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );
}
