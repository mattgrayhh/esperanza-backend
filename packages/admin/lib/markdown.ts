// =============================================================================
// markdown → HTML for seeding the RichTextEditor (TipTap) from LEGACY values.
//
// Most `*_rich` / description / amenities columns were authored as markdown (e.g.
// "- bullet", "**bold**", "# heading"). TipTap parses HTML, not markdown, so a raw
// markdown value would render its source literally ("- bullet"). On load we convert
// markdown → HTML so the author sees rich formatting; on save the editor stores HTML.
//
// This MIRRORS packages/framer-push/src/markdown.ts so what the author sees in the
// admin equals what Framer renders (formattedText is the same HTML). Kept as a small,
// dependency-free copy rather than wiring a cross-package import.
// =============================================================================

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline spans: links, bold, italic, code. Runs on already-escaped text. */
function inline(text: string): string {
  let out = text;
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`);
  out = out.replace(/&lt;(https?:\/\/[^&\s<>]+)&gt;/g, (_m, url: string) => `<a href="${url}">${url}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

/** True if the value already looks like HTML (has a tag) — then we skip conversion. */
export function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

/** Convert a markdown string to HTML. Returns '' for null/empty. */
export function markdownToHtml(md: string | null | undefined): string {
  if (md == null) return '';
  const src = String(md).replace(/\r\n/g, '\n').trim();
  if (src === '') return '';

  const lines = src.split('\n');
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && heading[1] && heading[2] !== undefined) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul && ul[1] !== undefined) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${inline(escapeHtml(ul[1].trim()))}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol && ol[1] !== undefined) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${inline(escapeHtml(ol[1].trim()))}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  return html.join('');
}

/** Seed value for TipTap: pass HTML through, convert markdown/plain to HTML. */
export function toEditorHtml(value: string | null | undefined): string {
  const v = value ?? '';
  if (v.trim() === '') return '';
  return looksLikeHtml(v) ? v : markdownToHtml(v);
}
