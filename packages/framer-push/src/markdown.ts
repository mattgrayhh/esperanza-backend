// =============================================================================
// esperanza-cf framer-push — markdown → HTML for `formattedText` fields.
//
// esperanza-sync used `marked` with { breaks:true, gfm:true } (index.ts:22-29).
// We inline a small, dependency-free converter covering exactly the constructs
// that appear in the Esperanza copy blocks (Amenities, Education, the 8 community
// "*_rich" design/feature/utility blocks, city venue blocks): ATX headings,
// bold/italic, inline links, unordered/ordered lists, paragraphs, and hard line
// breaks (the `breaks:true` behaviour). This avoids pulling a markdown lib into
// the Worker bundle and keeps output deterministic for tests.
//
// formattedText in Framer is an HTML string; null/empty input → '' (the field is
// then dropped by compactFields so we never overwrite with blank).
// =============================================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Inline spans: links, bold, italic, code. Runs on already-escaped text. */
function inline(text: string): string {
  let out = text;
  // [label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `<a href="${url}">${label}</a>`;
  });
  // autolinks: <https://url> — already HTML-escaped by this point, so match &lt;...&gt;
  out = out.replace(/&lt;(https?:\/\/[^&\s<>]+)&gt;/g, (_m, url: string) => {
    return `<a href="${url}">${url}</a>`;
  });
  // **bold** and __bold__
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // *italic* and _italic_
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  // `code`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

/**
 * Convert a markdown string to an HTML string. Returns '' for null/empty so the
 * caller can drop the field (never write blank over existing content).
 */
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
    // breaks:true → single newlines inside a paragraph become <br>.
    const joined = paragraph.map((l) => inline(escapeHtml(l))).join('<br>');
    html.push(`<p>${joined}</p>`);
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

    // blank line → paragraph / list boundary
    if (line.trim() === '') {
      flushParagraph();
      closeList();
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && heading[1] && heading[2] !== undefined) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    // unordered list item
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

    // ordered list item
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

    // plain text → accumulate into the current paragraph
    closeList();
    paragraph.push(line);
  }

  flushParagraph();
  closeList();

  return html.join('');
}
