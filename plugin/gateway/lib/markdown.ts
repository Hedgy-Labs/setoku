// SPDX-License-Identifier: Apache-2.0
/**
 * The small markdown → HTML renderer, with no Node or Bun dependency. Used by
 * the shared-file viewer (server-side) AND embedded into the app frame runtime
 * (lib/app-runtime.ts, via Function#toString) for Setoku.markdown — so these
 * three functions must stay self-contained: no imports, no module-level state.
 */

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markdown on ALREADY-ESCAPED text: code, bold, italic, links. A link
 *  href must be http(s)/mailto or it renders as plain text — never javascript:. */
export function inline(s: string): string {
  // Code spans and links are lifted out FIRST and put back LAST: their markup
  // (`target="_blank"`, a URL's underscores) must never be seen by the emphasis
  // pass. The NUL sentinel can't occur in the escaped source.
  const held: string[] = [];
  const hold = (html: string): string => {
    held.push(html);
    return `\u0000${held.length - 1}\u0000`;
  };
  s = s.replace(/`([^`]+)`/g, (_, c: string) => hold(`<code>${c}</code>`));
  // The whole source was escaped up front, so `href` already reads &amp; / &quot;
  // — it goes into the attribute verbatim (re-escaping would double it).
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) =>
    /^(https?:\/\/|mailto:)/i.test(href) ? hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`) : m,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]);
}

/**
 * A small, dependency-free markdown subset → HTML: headings, paragraphs,
 * bullet and numbered lists, blockquotes, fenced code, horizontal rules, GFM
 * pipe tables, and the inline forms above. Every character of the source is
 * HTML-escaped BEFORE any markup is applied, so the output can't smuggle a
 * tag; it renders inside the sandboxed frame regardless (same threat model as
 * an app body). Good enough for the memos and reports agents write; not a
 * CommonMark implementation.
 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*```/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const cells = (l: string): string[] =>
        l
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => inline(esc(c.trim())));
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) body.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>` +
          body.map((r) => `<tr>${head.map((_, k) => `<td>${r[k] ?? ""}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>",
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        let item = m[2];
        i++;
        // continuation lines (indented) belong to the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]))
          item += " " + lines[i++].trim();
        items.push(`<li>${inline(esc(item))}</li>`);
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    // paragraph: run of non-blank, non-block lines
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]))
    )
      buf.push(lines[i++]);
    out.push(`<p>${inline(esc(buf.join("\n")))}</p>`);
  }
  return out.join("\n");
}
