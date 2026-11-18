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
import { isTabularMime } from "./table-parse";

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

/** A user's file name as the box stores it: whitespace runs become "-" (so
 *  "Acme Display.ttf" → "Acme-Display.ttf" instead of a refusal), then the
 *  usual sanitize. publish_file reports the rename; a stylesheet's relative
 *  url("Acme Display.ttf") maps the same way (see rewriteCssRefs). */
export function normalizeFileName(name: string): string | null {
  return sanitizeFileName(name.trim().replace(/\s+/g, "-"));
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
  // Fonts: attached to an app and referenced from its template as
  // `setoku-file:<name>` (see inlineAppAssets). Never inline on the box origin.
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  // Audio / video: play in the file viewer, and inline into an app template
  // via `setoku-file:<name>` like a font.
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avif: "image/avif",
  // Stylesheets / scripts: an app template pulls them in with
  // <link href="setoku-file:x.css"> / <script src="setoku-file:x.js"> (expanded
  // inline at render). Downloads always serve them as text/plain (see
  // EXECUTABLE_MIMES), so the box origin never executes uploaded code.
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
};

/** Stored mimes a browser would EXECUTE or apply from the box origin (a
 *  <script src>/<link href> on a 'self'-scripted page). Their bytes are always
 *  served as text/plain; nosniff then makes them inert. */
const EXECUTABLE_MIMES = new Set(["text/javascript", "text/css"]);
export function servedMime(mime: string): string {
  return EXECUTABLE_MIMES.has(mime) ? "text/plain" : mime;
}

/** Extensions refused outright, with the steer the agent gets. */
export const REFUSED_EXT: Record<string, string> = {
  html: "An .html file would run on the box's origin. Publish it as an app instead (publish_app takes the fragment).",
  htm: "An .htm file would run on the box's origin. Publish it as an app instead (publish_app takes the fragment).",
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

/** How the viewer treats a file. A `table` is parsed IN THE BROWSER by the grid
 *  (web/app/grid/, from the raw bytes), `markdown`/`text` render in the sandboxed
 *  frame, `image` inlines as a data: URI (the frame CSP allows it), everything
 *  else is a download card. */
export type FileKind = "table" | "markdown" | "text" | "image" | "audio" | "video" | "pdf" | "other";
export function fileKind(mime: string): FileKind {
  if (isTabularMime(mime)) return "table";
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/plain" || mime === "text/css" || mime === "text/javascript") return "text";
  if (mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp" || mime === "image/avif") return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** How much of a text-like file the viewer decodes and inlines. Past this the
 *  frame shows a prefix plus a "download for the rest" note — a 50 MB log must
 *  never be escaped and shipped as one HTML document. */
export const MAX_VIEW_TEXT_BYTES = 4_000_000;

/** Strict base64 → bytes, or null when the input isn't base64. Buffer.from()
 *  never throws — it silently decodes garbage (a `data:` URL prefix, stray
 *  text) into a few bytes with a perfectly valid sha256 — so publish_file
 *  validates here first. Whitespace is tolerated (line-wrapped output). */
export function decodeBase64Strict(input: string): Buffer | null {
  const s = input.replace(/\s+/g, "");
  if (!s.length || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return buf.length === (s.length / 4) * 3 - pad ? buf : null;
}

/* ------------------------------- parsing ---------------------------------- */

// Tabular parsing lives in table-parse.ts (no Node deps) so the browser viewer
// runs the same code; re-exported here for server callers and the tests.
export { parseDelimited, parseJsonTable, type ParsedTable } from "./table-parse";

/* ------------------------------- markdown --------------------------------- */

// Lives in markdown.ts (no deps) so the app frame runtime can embed the same
// renderer for Setoku.markdown; re-exported here for server callers and tests.
export { renderMarkdown } from "./markdown";

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
      // Archiving keeps bytes (an archived record can be restored), so the only
      // ways down are replacing big files with smaller ones or raising the cap.
      throw new FileStoreQuotaError(
        `the box's file storage is full (${this.maxTotalBytes} bytes); replace large files with smaller ones, or raise SETOKU_FILES_MAX_BYTES`,
      );
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
        `SELECT f.published_id AS id, s.count, s.bytes, f.name, f.mime, f.size
           FROM published_files f
           JOIN (SELECT published_id, COUNT(*) AS count, SUM(size) AS bytes, MIN(name) AS first
                   FROM published_files GROUP BY published_id) s
             ON s.published_id = f.published_id AND s.first = f.name`,
      )
      .all() as { id: string; count: number; bytes: number; name: string; mime: string; size: number }[];
    const out = new Map<string, { count: number; bytes: number; first: { name: string; mime: string; size: number } }>();
    for (const r of rows) out.set(r.id, { count: r.count, bytes: r.bytes, first: { name: r.name, mime: r.mime, size: r.size } });
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

  /** Atomically CLAIM a live upload: the row is deleted and returned in one
   *  statement, so two overlapping PUTs with the same nonce can't both pass —
   *  the second finds nothing. A benign failure (empty body) re-inserts via
   *  createUpload so the agent can retry. */
  claimUpload(nonce: string, now = Date.now()): PendingUpload | null {
    if (!nonce) return null;
    const row = this.db
      .query(
        `DELETE FROM file_uploads WHERE nonce = ? AND expires > ?
         RETURNING nonce, published_id AS publishedId, app_id AS appId, name, mime, title, created_by AS createdBy,
                   model, expires, created_at AS createdAt`,
      )
      .get(nonce, now) as PendingUpload | null;
    return row ?? null;
  }

  /** Burn a nonce (after a successful put, or an over-cap upload). */
  consumeUpload(nonce: string): boolean {
    return this.db.run("DELETE FROM file_uploads WHERE nonce = ?", [nonce]).changes > 0;
  }
}

// ---- app assets: `setoku-file:<name>` in an app template ----
// The app frame has NO network (its CSP is default-src 'none' with only
// `img-src data:` / `font-src data:`), so a template can't link a font or logo
// the usual way. Instead the template names an attachment with the token
// `setoku-file:<name>` (in CSS url(), an <img src>, a JS string…) and the box
// swaps each token for that attachment's bytes as a data: URL when it renders
// the frame. The frame stays fetch-free; the bytes live on the box like any
// other attachment.

/** Matches a `setoku-file:<name>` reference; group 1 is the (candidate) name. */
export const ASSET_REF_RE = /setoku-file:([A-Za-z0-9][A-Za-z0-9._-]{0,119})/g;
/** `<script …src="setoku-file:x.js"…></script>` → pre-attrs, name, post-attrs. */
const SCRIPT_TAG_RE = /<script\b([^>]*?)\s+src\s*=\s*["']?setoku-file:([A-Za-z0-9][A-Za-z0-9._-]{0,119})["']?([^>]*)>\s*<\/script\s*>/gi;
/** `<link …href="setoku-file:x.css"…>` → name (rel=stylesheet checked by the caller). */
const LINK_TAG_RE = /<link\b[^>]*?\bhref\s*=\s*["']?setoku-file:([A-Za-z0-9][A-Za-z0-9._-]{0,119})["']?[^>]*>/gi;

/** Text attachments a template reads with Setoku.text / json / markdown (the
 *  runtime decodes the inlined data: URL). */
const TEXT_ASSET_MIMES = new Set([
  "text/markdown",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/x-ndjson",
  "application/xml",
]);

/** What a template can inline: fonts, images, audio/video, and text. Office
 *  docs, PDFs and archives stay downloads under the app (the sandboxed frame
 *  can't open them). SVG is fine: as a data: image it renders in an image
 *  context (no script), and the frame CSP blocks it from loading as a document. */
export type AssetClass = "font" | "image" | "media" | "text" | "style" | "script";
export function assetClass(mime: string): AssetClass | null {
  if (mime === "text/css") return "style";
  if (mime === "text/javascript") return "script";
  if (mime.startsWith("font/")) return "font";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "media";
  if (TEXT_ASSET_MIMES.has(mime)) return "text";
  return null;
}
export function isAppAssetMime(mime: string): boolean {
  return assetClass(mime) !== null;
}

/** Per-asset and per-frame inline caps: every view re-sends the frame, and a
 *  data: URL is ~4/3 the raw size. A web font is ~20–150 KB; the caps are sized
 *  for a short clip or a few minutes of compressed audio, not a film. */
export const MAX_ASSET_BYTES = 8_000_000;
export const MAX_ASSET_BYTES_PER_FRAME = 16_000_000;

/** The distinct attachment names a template references (trailing dots trimmed,
 *  so a reference that ends a sentence still resolves). */
export function assetRefs(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(ASSET_REF_RE)) out.add(m[1].replace(/\.+$/, ""));
  return [...out];
}

/** `url(...)` in CSS; group 2 is the raw value (quotes stripped). */
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+?)\1\s*\)/gi;
/** The attachment name a stylesheet's RELATIVE url() means — its last path
 *  segment, normalized like an upload ("fonts/Acme Display.ttf" →
 *  "Acme-Display.ttf") — or null for data:/http(s):/setoku-file:/#/absolute. */
function cssRelativeName(value: string): string | null {
  const v = value.trim();
  if (/^(data:|https?:|setoku-file:|#|\/\/|blob:)/i.test(v)) return null;
  let base = v.split(/[?#]/)[0].split("/").pop() ?? "";
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep it raw */
  }
  return base ? normalizeFileName(base) : null;
}

/**
 * A design team's stylesheet points at its fonts/images by RELATIVE path
 * (url("../fonts/Brand.woff2")). Map each such url() whose file name is an
 * attachment to `setoku-file:<name>`, so stock CSS works unmodified once its
 * files are attached alongside it. Returns the rewritten CSS and the relative
 * names that matched no attachment (for the publish-time notes).
 */
export function rewriteCssRefs(css: string, attached: Set<string>): { css: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const out = css.replace(CSS_URL_RE, (whole, _q: string, value: string) => {
    const name = cssRelativeName(value);
    if (!name) return whole;
    if (attached.has(name)) return `url(setoku-file:${name})`;
    unresolved.add(value.trim());
    return whole;
  });
  return { css: out, unresolved: [...unresolved] };
}

/** Why a referenced name won't inline, or null when it will. */
export function assetProblem(file: StoredFileMeta | undefined): string | null {
  if (!file) return "not attached";
  if (!isAppAssetMime(file.mime)) return `${file.mime} can't be used in a template (fonts, images, audio/video, css/js, and text/md/csv/json only)`;
  if (file.size > MAX_ASSET_BYTES) return `over the ${MAX_ASSET_BYTES / 1e6} MB per-asset cap`;
  return null;
}

// data: URLs keyed by content hash, so a popular app doesn't re-base64 its font
// on every view. Bounded by total characters held (oldest evicted first), so
// a few big audio clips can't pin hundreds of MB on a small box.
const dataUrlCache = new Map<string, string>();
const DATA_URL_CACHE_CHARS = 48_000_000;
let dataUrlCacheChars = 0;
function cacheDataUrl(key: string, url: string): void {
  if (url.length > DATA_URL_CACHE_CHARS / 4) return; // too big to be worth holding
  dataUrlCache.set(key, url);
  dataUrlCacheChars += url.length;
  for (const [k, v] of dataUrlCache) {
    if (dataUrlCacheChars <= DATA_URL_CACHE_CHARS) break;
    dataUrlCache.delete(k);
    dataUrlCacheChars -= v.length;
  }
}

/**
 * Replace each `setoku-file:<name>` in an app template with the attachment's
 * data: URL. A token that doesn't resolve (not attached, wrong type, over a cap)
 * is left as-is: it fails to load in the browser, harmlessly, and publish_app /
 * update_app / publish_file already told the author why.
 */
export function inlineAppAssets(
  body: string,
  files: StoredFileMeta[],
  bytesOf: (name: string) => Uint8Array | null,
): string {
  if (!body.includes("setoku-file:")) return body;
  const byName = new Map(files.map((f) => [f.name, f]));
  // Charged against the same per-frame budget as the data: URLs below.
  let budget = MAX_ASSET_BYTES_PER_FRAME;
  const sourceOf = (raw: string, cls: AssetClass): string | null => {
    const name = raw.replace(/\.+$/, "");
    const f = byName.get(name);
    if (assetProblem(f) || assetClass(f!.mime) !== cls || f!.size > budget) return null;
    const bytes = bytesOf(name);
    if (!bytes) return null;
    budget -= f!.size;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  };
  // A stylesheet / script can't ride a data: URL (the frame CSP allows only
  // inline <style>/<script>), so its TAG is expanded into an inline block —
  // exactly what the author could have pasted into the template. The closing
  // tag is escaped so file content can't end the block early. Runs first, so
  // `setoku-file:` references INSIDE the css/js (a font url()) resolve below.
  body = body.replace(SCRIPT_TAG_RE, (whole, pre: string, raw: string, post: string) => {
    const js = sourceOf(raw, "script");
    return js == null ? whole : `<script${pre}${post}>${js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--")}</script>`;
  });
  body = body.replace(LINK_TAG_RE, (whole, raw: string) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(whole)) return whole;
    const src = sourceOf(raw, "style");
    if (src == null) return whole;
    const css = rewriteCssRefs(src, new Set(byName.keys())).css;
    return `<style>${css.replace(/<\/(style)/gi, "<\\/$1")}</style>`;
  });
  const resolved = new Map<string, string | null>();
  const resolve = (name: string): string | null => {
    if (resolved.has(name)) return resolved.get(name)!;
    const f = byName.get(name);
    let url: string | null = null;
    if (!assetProblem(f) && f!.size <= budget) {
      url = dataUrlCache.get(f!.sha256) ?? null;
      if (!url) {
        const bytes = bytesOf(name);
        if (bytes) {
          url = `data:${f!.mime};base64,${Buffer.from(bytes).toString("base64")}`;
          cacheDataUrl(f!.sha256, url);
        }
      }
      if (url) budget -= f!.size;
    }
    resolved.set(name, url);
    return url;
  };
  return body.replace(ASSET_REF_RE, (whole, raw: string) => {
    const name = raw.replace(/\.+$/, "");
    const url = resolve(name);
    return url ? url + raw.slice(name.length) : whole;
  });
}
