// SPDX-License-Identifier: Apache-2.0
// A tiny, dependency-free Markdown renderer for the doc shapes the knowledge
// store actually produces: fenced code blocks, ATX headings, unordered lists,
// **bold**, `inline code`, and blank-line-separated paragraphs. It is NOT a
// CommonMark engine — unknown syntax degrades to plain text. Everything renders
// through React elements, so user text is escaped by React (no dangerouslySet…).
import type { ReactNode } from "react";

/** Inline pass: `code` spans and **bold**. Returns escaped React nodes. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // First split out `code` spans (code wins — no bold inside code).
  const codeParts = text.split(/(`[^`]+`)/g);
  codeParts.forEach((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      out.push(
        <code key={`${keyBase}-c${i}`} className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[0.85em] text-stone-700">
          {part.slice(1, -1)}
        </code>,
      );
      return;
    }
    // Then **bold** within the non-code segment.
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    boldParts.forEach((bp, j) => {
      if (!bp) return;
      if (bp.startsWith("**") && bp.endsWith("**") && bp.length >= 4) {
        out.push(
          <strong key={`${keyBase}-b${i}-${j}`} className="font-semibold text-stone-800">
            {bp.slice(2, -2)}
          </strong>,
        );
      } else {
        out.push(bp);
      }
    });
  });
  return out;
}

/** Join lines within a paragraph, inserting <br> for single newlines. */
function paragraphNodes(lines: string[], keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(<br key={`${keyBase}-br${i}`} />);
    nodes.push(...inline(line, `${keyBase}-l${i}`));
  });
  return nodes;
}

export function Markdown({ body, className }: { body: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // blank line — skip (paragraph separator)
    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code block ```lang … ```
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (if present)
      blocks.push(
        <pre
          key={`k${key++}`}
          className="my-2 overflow-x-auto rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-relaxed text-stone-700"
        >
          <code className="font-mono">{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // ATX heading # … ###### (kept small — stone, not huge)
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const depth = heading[1].length;
      const Tag = depth <= 2 ? "h3" : "h4";
      const cls =
        depth <= 2
          ? "mt-3 mb-1 text-sm font-semibold text-stone-800"
          : "mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500";
      blocks.push(
        <Tag key={`k${key++}`} className={cls}>
          {inline(heading[2], `k${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    // unordered list (- or *)
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={`k${key++}`} className="my-2 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-stone-600">
          {items.map((it, idx) => (
            <li key={idx}>{inline(it, `k${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // paragraph: accumulate until a blank line or a block-starting line
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```(\w*)\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`k${key++}`} className="my-2 text-sm leading-relaxed text-stone-600">
        {paragraphNodes(para, `k${key}`)}
      </p>,
    );
  }

  return <div className={className}>{blocks}</div>;
}
