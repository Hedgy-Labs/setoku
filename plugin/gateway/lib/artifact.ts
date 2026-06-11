// SPDX-License-Identifier: Apache-2.0
/**
 * Markdown interchange format helpers. The live knowledge store is SQLite
 * (see store.ts); `.setoku/context/` markdown files are a seed/interchange
 * format imported on first boot (seedFromFiles).
 */

/** Tiny frontmatter parser: `--- key: value / key: [a, b] ---`. Strings + inline arrays only. */
export function parseFrontmatter(text: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[kv[1]] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else {
      meta[kv[1]] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return { meta, body: text.slice(m[0].length) };
}
