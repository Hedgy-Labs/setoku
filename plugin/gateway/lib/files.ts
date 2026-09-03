// SPDX-License-Identifier: Apache-2.0
/**
 * Files on the box — bytes an agent pushes so a person can open them by link.
 *
 * A published record has two formats. `app` RUNS (a template + live panels,
 * rendered in the sandboxed frame); `file` is VIEWED or DOWNLOADED (a CSV the
 * agent computed locally, a memo, a chart PNG, a PDF). Either format may carry
 * attached files; a standalone shared file is just a `file` row with exactly
 * one attachment. Everything an app has — the share id, team/public
 * visibility, the shared password, lock, archive, the admin list, the Slack
 * notice — keys on `published.id`, so a file gets all of it for free.
 *
 * Files are NOT knowledge. They never enter find_context or the embedding
 * index: an analyst session (which reads untrusted lake text) could otherwise
 * write a memo every other session retrieves as truth, a path around the
 * corrections queue (I2). A file's *meaning* is captured by report_correction
 * and a human approval, same as any other fact.
 *
 * Storage is a SEPARATE SQLite file (files.db, sibling to apps.db). Bytes are
 * BLOBs; the nightly `VACUUM INTO` snapshot of knowledge.db stays small and
 * files.db gets its own line in deploy/backup (I4 — the box may hold the only
 * copy of a file someone shared).
 *
 * Bytes reach the box two ways. Small content rides inline in the MCP call.
 * Anything already on disk goes over a one-time signed `PUT /u/<nonce>` URL the
 * tool hands back: a model re-emitting a 500 KB CSV through a tool call is
 * ~150k output tokens, so on-disk files MUST travel over HTTP. The nonce is the
 * secret (no bearer token in a curl line), and the `published` row is created
 * only when the bytes land, so nothing ever sees a half-published file.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Inline `content` cap on publish_file — bigger than this goes over the upload URL. */
export const MAX_INLINE_BYTES = 1_000_000;
/** Per-file cap on the HTTP upload path. Env-overridable (SETOKU_FILES_MAX_UPLOAD_BYTES)
 *  so a test can exercise the over-cap path without shipping 50 MB. */
export const MAX_UPLOAD_BYTES = ((): number => {
  const n = Number(process.env.SETOKU_FILES_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 50_000_000;
})();
/** How long a minted upload URL stays valid. */
export const UPLOAD_TTL_MS = 10 * 60 * 1000;
/** Attachments one publication (app or file) may carry. */
export const MAX_FILES_PER_PUBLICATION = 20;
/** Bytes one publication may carry across its attachments. */
export const MAX_BYTES_PER_PUBLICATION = 200_000_000;
/** Box-wide ceiling on stored file bytes (backup retention scales with it).
 *  Override with SETOKU_FILES_MAX_BYTES. */
export const DEFAULT_MAX_TOTAL_BYTES = 2_000_000_000;

/** A file NAME as stored and downloaded: one path segment, no leading dot. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export class FileStoreQuotaError extends Error {}

export interface StoredFileMeta {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
}

/** A minted-but-unfulfilled upload. Lives only here until the PUT lands; the
 *  `published` row does not exist yet. */
export interface PendingUpload {
  nonce: string;
  /** The share id minted up front (so the agent gets the final URL in one reply). */
  publishedId: string;
  /** Set when attaching to an existing app; null for a standalone file. */
  appId: string | null;
  name: string;
  mime: string;
  title: string | null;
  createdBy: string;
  expires: number;
  createdAt: string;
  /** Self-reported model id for attribution (null when unknown). */
  model: string | null;
}

/** Default location: sibling of knowledge.db and apps.db, a separate file by design. */
export function defaultFileDbPath(knowledgeDbPath: string): string {
  return path.join(path.dirname(knowledgeDbPath), "files.db");
}

/** Validate a file name. Returns the name unchanged when acceptable, else null.
 *  One path segment, no leading dot, no spaces — it becomes part of a URL and a
 *  Content-Disposition header, so the alphabet is deliberately tiny. */
export function sanitizeFileName(name: string): string | null {
  const n = name.trim();
  return NAME_RE.test(n) ? n : null;
}

/** The mime a file is STORED and SERVED with, by extension. The client never
 *  supplies one: an untrusted mime on the box origin is how "a CSV" becomes a
 *  script. Anything not listed is refused at publish. */
export const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  md: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  sql: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  parquet: "application/vnd.apache.parquet",
  zip: "application/zip",
  gz: "application/gzip",
  xml: "application/xml",
};

/** Extensions refused outright, with the steer the agent gets. */
export const REFUSED_EXT: Record<string, string> = {
  html: "An .html file would run on the box's origin. Publish it as an app instead (publish_app takes the fragment).",
  htm: "An .htm file would run on the box's origin. Publish it as an app instead (publish_app takes the fragment).",
  js: "Scripts aren't shareable files. If it's an app, publish_app; if it's source to read, rename it .txt.",
  mjs: "Scripts aren't shareable files. If it's an app, publish_app; if it's source to read, rename it .txt.",
};

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Mime for a (validated) name, or null when the extension isn't allowlisted. */
export function mimeForName(name: string): string | null {
  return MIME_BY_EXT[extOf(name)] ?? null;
}

/** Mimes a browser may render INLINE from the box origin. Everything else is
 *  served as an attachment. SVG and XML are never inline (they script). */
const INLINE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "application/json",
]);
export function inlineAllowed(mime: string): boolean {
  return INLINE_MIMES.has(mime);
}

/** How the viewer treats a file. `table` parses into rows for Setoku.table,
 *  `markdown`/`text` render in the sandboxed frame, `image` inlines as a data:
 *  URI (the frame CSP allows it), everything else is a download card. */
export type FileKind = "table" | "markdown" | "text" | "image" | "pdf" | "other";
export function fileKind(mime: string): FileKind {
  if (mime === "text/csv" || mime === "text/tab-separated-values" || mime === "application/json") return "table";
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/plain") return "text";
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp") return "image";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/* ------------------------------- parsing ---------------------------------- */

export interface ParsedTable {
  columns: string[];
  rows: Record<string, string>[];
  /** More rows existed than `maxRows`; the rows are a prefix. */
  truncated: boolean;
}

/**
 * RFC 4180 CSV/TSV → columns + rows. Quoted fields, doubled-quote escapes,
 * newlines inside quotes, CRLF or LF, a leading BOM. The first record is the
 * header; duplicate or empty header cells get a stable suffix so every column
 * has a distinct key (Setoku.table indexes rows by column name). Parsing stops
 * after `maxRows` data rows — a 50 MB CSV is never materialized as objects.
 */
export function parseDelimited(text: string, delim: string, maxRows = 25_000): ParsedTable {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endRecord = (): boolean => {
    record.push(field);
    field = "";
    // A blank line (one empty field) between records is ignored, as is the
    // trailing newline every well-formed file ends with.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    // Stop once we hold header + maxRows + ONE extra record: the extra is how
    // we know the file went on (truncated) without parsing the rest of it.
    return records.length > maxRows + 1;
  };
  let broke = false;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (c === delim) {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      i++;
      if (endRecord()) {
        broke = true;
        break;
      }
      continue;
    }
    field += c;
    i++;
  }
  if (!broke && (field !== "" || record.length)) endRecord(); // no trailing newline
  const truncated = records.length > maxRows + 1;
  if (truncated) records.length = maxRows + 1;
  if (!records.length) return { columns: [], rows: [], truncated: false };
  const seen = new Map<string, number>();
  const columns = records[0].map((h, idx) => {
    let name = h.trim() || `col${idx + 1}`;
    const k = seen.get(name) ?? 0;
    seen.set(name, k + 1);
    if (k) name = `${name}_${k + 1}`;
    return name;
  });
  const rows = records.slice(1).map((r) => {
    const o: Record<string, string> = {};
    columns.forEach((c, idx) => (o[c] = r[idx] ?? ""));
    return o;
  });
  return { columns, rows, truncated };
}

/** A JSON file that is an ARRAY OF FLAT OBJECTS renders as a table; anything
 *  else (an object, nested values) is shown as text. Column order is first
 *  appearance across the rows. */
export function parseJsonTable(text: string, maxRows = 25_000): ParsedTable | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || !v.length) return null;
  if (!v.every((r) => r && typeof r === "object" && !Array.isArray(r))) return null;
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];
  const truncated = v.length > maxRows;
  for (const r of v.slice(0, maxRows) as Record<string, unknown>[]) {
    const o: Record<string, string> = {};
    for (const [k, val] of Object.entries(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
      o[k] = val == null ? "" : typeof val === "object" ? JSON.stringify(val) : String(val);
    }
    rows.push(o);
  }
  return { columns, rows, truncated };
}

/* ------------------------------- markdown --------------------------------- */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markdown on ALREADY-ESCAPED text: code, bold, italic, links. A link
 *  href must be http(s)/mailto or it renders as plain text — never javascript:. */
function inline(s: string): string {
  const code: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    code.push(`<code>${c}</code>`);
    return `\u0000${code.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) =>
    /^(https?:\/\/|mailto:)/i.test(href)
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : m,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]);
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

/* -------------------------------- store ----------------------------------- */

type FileRow = { name: string; mime: string; size: number; sha256: string; uploadedBy: string; uploadedAt: string };

export class FileStore {
  db: Database;
  readonly maxTotalBytes: number;

  constructor(dbPath: string, opts: { maxTotalBytes?: number } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.db.run(`CREATE TABLE IF NOT EXISTS published_files (
      published_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      mime         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      sha256       TEXT NOT NULL,
      bytes        BLOB NOT NULL,
      uploaded_by  TEXT NOT NULL,
      uploaded_at  TEXT NOT NULL,
      PRIMARY KEY (published_id, name)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS file_uploads (
      nonce        TEXT PRIMARY KEY,
      published_id TEXT NOT NULL,
      app_id       TEXT,
      name         TEXT NOT NULL,
      mime         TEXT NOT NULL,
      title        TEXT,
      created_by   TEXT NOT NULL,
      model        TEXT,
      expires      INTEGER NOT NULL,
      created_at   TEXT NOT NULL
    )`);
    const env = Number(process.env.SETOKU_FILES_MAX_BYTES);
    this.maxTotalBytes = opts.maxTotalBytes ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_TOTAL_BYTES);
  }

  /**
   * Store (or replace) one attachment. Enforces the per-publication count and
   * byte caps and the box-wide ceiling BEFORE writing — an over-quota put throws
   * and changes nothing. Replacing a same-named file counts its old size out
   * first. Bytes are never versioned (the audit log + uploadedAt record the
   * replacement); see docs/apps.md.
   */
  put(
    publishedId: string,
    file: { name: string; mime: string; bytes: Uint8Array; by: string; now: string; sha256?: string },
  ): StoredFileMeta {
    const size = file.bytes.byteLength;
    const existing = this.db
      .query("SELECT size FROM published_files WHERE published_id = ? AND name = ?")
      .get(publishedId, file.name) as { size: number } | null;
    const agg = this.db
      .query("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM published_files WHERE published_id = ?")
      .get(publishedId) as { n: number; bytes: number };
    if (!existing && agg.n + 1 > MAX_FILES_PER_PUBLICATION)
      throw new FileStoreQuotaError(`too many files on this publication (max ${MAX_FILES_PER_PUBLICATION})`);
    const old = existing?.size ?? 0;
    if (agg.bytes - old + size > MAX_BYTES_PER_PUBLICATION)
      throw new FileStoreQuotaError(`this publication would exceed ${MAX_BYTES_PER_PUBLICATION} bytes of files`);
    const total = this.usage().bytes;
    if (total - old + size > this.maxTotalBytes)
      throw new FileStoreQuotaError(`the box's file storage is full (${this.maxTotalBytes} bytes); archive or replace files first`);
    const sha256 = file.sha256 ?? sha256Hex(file.bytes);
    this.db.run(
      `INSERT INTO published_files (published_id, name, mime, size, sha256, bytes, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(published_id, name) DO UPDATE SET
         mime = excluded.mime, size = excluded.size, sha256 = excluded.sha256, bytes = excluded.bytes,
         uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
      [publishedId, file.name, file.mime, size, sha256, file.bytes, file.by, file.now],
    );
    return { name: file.name, mime: file.mime, size, sha256, uploadedBy: file.by, uploadedAt: file.now };
  }

  /** Metadata for one attachment — no bytes. */
  meta(publishedId: string, name: string): StoredFileMeta | null {
    const row = this.db
      .query(
        "SELECT name, mime, size, sha256, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM published_files WHERE published_id = ? AND name = ?",
      )
      .get(publishedId, name) as FileRow | null;
    return row ?? null;
  }

  /** The bytes of one attachment. */
  bytes(publishedId: string, name: string): Uint8Array | null {
    const row = this.db
      .query("SELECT bytes FROM published_files WHERE published_id = ? AND name = ?")
      .get(publishedId, name) as { bytes: Uint8Array } | null;
    return row?.bytes ?? null;
  }

  /** Every attachment on a publication, by name. */
  list(publishedId: string): StoredFileMeta[] {
    return this.db
      .query(
        "SELECT name, mime, size, sha256, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM published_files WHERE published_id = ? ORDER BY name",
      )
      .all(publishedId) as FileRow[];
  }

  /** Remove every attachment on a publication (a hard delete — used only by
   *  the tests and a future purge; archive keeps bytes). */
  remove(publishedId: string): number {
    return this.db.run("DELETE FROM published_files WHERE published_id = ?", [publishedId]).changes;
  }

  /** One GROUP BY over the whole store: per-publication count, bytes, and the
   *  first attachment's name/mime/size (the thing a `file` row IS). This is the
   *  cross-DB projection the list views join in memory — files.db and
   *  knowledge.db are separate files, so there is no SQL join. */
  summaries(): Map<string, { count: number; bytes: number; first: { name: string; mime: string; size: number } }> {
    const rows = this.db
      .query(
        `SELECT published_id AS id, COUNT(*) AS count, SUM(size) AS bytes,
                MIN(name) AS name FROM published_files GROUP BY published_id`,
      )
      .all() as { id: string; count: number; bytes: number; name: string }[];
    const out = new Map<string, { count: number; bytes: number; first: { name: string; mime: string; size: number } }>();
    for (const r of rows) {
      const first = this.db
        .query("SELECT name, mime, size FROM published_files WHERE published_id = ? AND name = ?")
        .get(r.id, r.name) as { name: string; mime: string; size: number };
      out.set(r.id, { count: r.count, bytes: r.bytes, first });
    }
    return out;
  }

  /** Box-wide usage, for the quota check and the admin footer. */
  usage(): { files: number; bytes: number } {
    return this.db.query("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM published_files").get() as {
      files: number;
      bytes: number;
    };
  }

  /* ------------------------------ uploads -------------------------------- */

  /** Mint a pending upload. Expired rows are swept on the way in (this path is
   *  rare and cheap). */
  createUpload(u: PendingUpload): void {
    this.db.run("DELETE FROM file_uploads WHERE expires <= ?", [Date.now()]);
    this.db.run(
      `INSERT INTO file_uploads (nonce, published_id, app_id, name, mime, title, created_by, model, expires, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.nonce, u.publishedId, u.appId, u.name, u.mime, u.title, u.createdBy, u.model, u.expires, u.createdAt],
    );
  }

  /** Look up a live (unexpired) pending upload. Does NOT consume it — a PUT that
   *  fails mid-stream may be retried until expiry. */
  takeUpload(nonce: string, now = Date.now()): PendingUpload | null {
    if (!nonce) return null;
    const row = this.db
      .query(
        `SELECT nonce, published_id AS publishedId, app_id AS appId, name, mime, title, created_by AS createdBy,
                model, expires, created_at AS createdAt FROM file_uploads WHERE nonce = ? AND expires > ?`,
      )
      .get(nonce, now) as PendingUpload | null;
    return row ?? null;
  }

  /** Burn a nonce (after a successful put, or an over-cap upload). */
  consumeUpload(nonce: string): boolean {
    return this.db.run("DELETE FROM file_uploads WHERE nonce = ?", [nonce]).changes > 0;
  }
}
