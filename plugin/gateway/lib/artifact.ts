import fs from "node:fs";
import path from "node:path";
import { setokuDir } from "./config";

/**
 * The context artifact lives in <repo>/.setoku/context/:
 *   overview.md          — optional business overview
 *   entities/<Name>.md   — one per table/entity (frontmatter: name, table, summary, keywords)
 *   metrics/<slug>.md    — canonical metric definitions w/ SQL (frontmatter: name, summary, keywords)
 *   queries/<slug>.md    — known-good canonical queries (frontmatter: name, question, keywords)
 *   gotchas.md           — bullet list of non-obvious traps
 */

export type DocType = "entity" | "metric" | "query" | "overview";

export interface ContextDoc {
  type: DocType;
  file: string;
  name: string;
  meta: Record<string, string | string[]>;
  body: string;
}

export interface Artifact {
  docs: ContextDoc[];
  gotchas: string[];
  exists: boolean;
}

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

function readDocsIn(dir: string, type: DocType): ContextDoc[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const { meta, body } = parseFrontmatter(raw);
      return {
        type,
        file: path.join(dir, f),
        name:
          typeof meta.name === "string" && meta.name
            ? meta.name
            : f.replace(/\.md$/, ""),
        meta,
        body: body.trim(),
      };
    });
}

/** Load the whole artifact. Cheap (small files) — re-read per call so curation edits apply live. */
export function loadArtifact(projectDir: string): Artifact {
  const ctx = path.join(setokuDir(projectDir), "context");
  const docs: ContextDoc[] = [
    ...readDocsIn(path.join(ctx, "entities"), "entity"),
    ...readDocsIn(path.join(ctx, "metrics"), "metric"),
    ...readDocsIn(path.join(ctx, "queries"), "query"),
  ];
  const overviewFile = path.join(ctx, "overview.md");
  if (fs.existsSync(overviewFile)) {
    const { meta, body } = parseFrontmatter(
      fs.readFileSync(overviewFile, "utf8"),
    );
    docs.push({
      type: "overview",
      file: overviewFile,
      name: typeof meta.name === "string" && meta.name ? meta.name : "overview",
      meta,
      body: body.trim(),
    });
  }
  const gotchas: string[] = [];
  const gotchasFile = path.join(ctx, "gotchas.md");
  if (fs.existsSync(gotchasFile)) {
    for (const line of fs.readFileSync(gotchasFile, "utf8").split("\n")) {
      const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (m) gotchas.push(m[1]);
    }
  }
  return { docs, gotchas, exists: fs.existsSync(ctx) };
}

export interface CorrectionRecord {
  ts: string;
  user: string;
  kind: string;
  content: string;
  relatesTo?: string;
}

export function appendCorrection(
  projectDir: string,
  record: CorrectionRecord,
): string {
  const dir = setokuDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "corrections.jsonl");
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
  return file;
}
