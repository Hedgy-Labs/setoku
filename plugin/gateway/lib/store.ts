// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway-owned knowledge store (SQLite via bun:sqlite — D9).
 *
 * The service owns the knowledge: docs (verified context), corrections
 * (pending/unverified knowledge with lifecycle), revisions (append-only
 * provenance), audit (every tool call). The DB lives OUTSIDE the repo by
 * default (~/.setoku/projects/<slug>/knowledge.db) so it belongs to the
 * service, not the checkout; `.setoku/context/` files, if present, are
 * imported once as a seed (and remain a supported interchange format).
 */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "./artifact";
import { setokuDir } from "./config";
import type { AppParam } from "./params";

export type DocType = "entity" | "metric" | "query" | "overview" | "gotcha";

export interface KnowledgeDoc {
  type: DocType;
  name: string;
  meta: Record<string, string | string[]>;
  body: string;
  verified: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * A drafted doc edit attached to a pending correction (curation cockpit). It is
 * the EXACT `upsert` payload that approving the correction would commit — an
 * advisory artifact only. A draft grants no authority (the membrane: drafting is
 * free; committing is the human `/admin` click). Produced by the auto-draft job
 * (piece B) or hand-typed in the cockpit before approval.
 */
export interface CorrectionDraft {
  type: DocType;
  name: string;
  body: string;
  meta: Record<string, string | string[]>;
}

export type CorrectionStatus = "pending" | "accepted" | "rejected";

/** Fields every correction has, regardless of lifecycle stage. */
interface CorrectionBase {
  id: number;
  ts: string;
  user: string;
  kind: string;
  /** The supporting context shown to a curator (the fuller text). For legacy
   *  proposals this is the whole blob and doubles as the savable text. */
  content: string;
  /** The concise claim to store as knowledge (#10, avenue 1). Null for legacy
   *  proposals, where `content` is used as the savable text instead. */
  fact: string | null;
  relatesTo: string | null;
}

/**
 * A correction is a discriminated union on `status`, so the status-dependent
 * fields can't disagree with the lifecycle stage (#34): a *pending* item may
 * carry a draft + advisory flags; a *rejected* item ALWAYS has a reason; an
 * *accepted* item carries neither. "Rejected with no reason" / "pending with a
 * reject reason" / "accepted still carrying a draft" are unrepresentable. The
 * sole constructor is `rowToCorrection`; the JSON served to the admin UI is
 * flattened back to one shape at the wire boundary, so this is gateway-internal.
 */
export interface PendingCorrection extends CorrectionBase {
  status: "pending";
  /** The drafted doc-edit approving this would commit (cockpit). Null = undrafted. */
  draft?: CorrectionDraft | null;
  /** Advisory flags from the auto-draft/lint pass: dupe, contradiction, lint, provenance. */
  flags?: string[];
  /** Who drafted (the draft-only janitor identity), and when. Null = undrafted. */
  draftedBy?: string | null;
  draftedTs?: string | null;
}
export interface AcceptedCorrection extends CorrectionBase {
  status: "accepted";
}
export interface RejectedCorrection extends CorrectionBase {
  status: "rejected";
  /** Why it was rejected — REQUIRED (a rejected correction always has a reason). */
  rejectReason: string;
  /** True when the auto-reject janitor (not a human) rejected it — soft + reversible. */
  rejectedByBot: boolean;
}
export type Correction = PendingCorrection | AcceptedCorrection | RejectedCorrection;

/** A local account for the web admin surface (Phase 5.1). */
export interface Account {
  username: string;
  /** argon2id hash (Bun.password) — never the plaintext. */
  pwhash: string;
  role: string;
  createdAt: string;
  createdBy: string | null;
  /** Password was minted by an admin — the login flow forces a change (#73). */
  mustChangePassword: boolean;
}

/** One row of the append-only audit log (the 5.6 page). */
export interface AuditRow {
  ts: string;
  user: string | null;
  tool: string;
  payload: string;
}

/**
 * A report an agent published to the box (the "publish" surface). The agent
 * passes self-contained HTML via the publish_report tool; we mint an opaque id
 * and serve it under /apps/<id>, which is session-gated — so v0 sharing is
 * TEAM-ONLY (a viewer must hold a box login). The body is rendered in a
 * sandboxed iframe (opaque origin) so an injected agent's HTML can't reach the
 * admin origin's cookie or API. `body` is omitted from list views (it can be
 * large); fetch a single report to get it.
 */
export type ReportVisibility = "team" | "public";

/** What dialect a panel's saved query runs against (mirrors run_query). */
export type PanelDialect = "postgres" | "clickhouse";

/**
 * One live data binding on an app. `sql` is the executable binding (a
 * validated read-only statement); `metricId` is provenance-only — it links the
 * panel to a curated metric doc so the "how is this calculated" drawer can show
 * the team's verified definition. We never re-parse SQL out of a metric body.
 */
export interface AppPanel {
  key: string;
  title?: string;
  /** One-line, plain-language explanation of what this panel computes — shown in
   *  the "how is this calculated" drawer (the human-readable companion to the
   *  raw SQL, and the only calc explanation public viewers get). */
  description?: string;
  sql: string;
  dialect: PanelDialect;
  metricId?: string | null;
}

export interface PublishedReport {
  id: string;
  title: string;
  /** Render model. Always "app" now (a fragment the runtime wraps); the legacy
   *  raw-served "html" format is gone. Kept as a field for existing rows and the
   *  version-history snapshot. */
  format: "html" | "app";
  body: string;
  /** Live data bindings; null/[] for a static (state-only or presentational) app. */
  panels: AppPanel[] | null;
  /** Declared interactive inputs (date/int/text/bool/enum) a panel's SQL binds
   *  via `:name`. null/[] for a non-interactive app. See lib/params.ts. */
  params: AppParam[] | null;
  /** TTL (seconds) for cached panel data; null on frozen reports. */
  refreshSeconds: number | null;
  /** "team" = session-gated (default); "public" = served credential-free at
   *  /p/<id>. Promotion to public is a human (admin) action — never the agent. */
  visibility: ReportVisibility;
  createdBy: string;
  createdAt: string;
  /** Soft-delete timestamp. Archived reports 404 everywhere but are kept. */
  archivedAt: string | null;
}

export type PublishedMeta = Omit<PublishedReport, "body">;

/** One saved version of an app's content (issue #58 version history). Every
 *  create / content edit / revert appends one, so the newest revision always
 *  mirrors the live `published` row and "history" is just this table read
 *  newest-first. Body-less in the list view; the full snapshot (getAppRevision)
 *  is what a revert restores. */
export interface AppRevisionMeta {
  /** 1-based version number within this app (v1 = the original publish). */
  seq: number;
  /** Identity that produced this version (author on publish/edit; whoever
   *  clicked restore on a revert). */
  editor: string;
  /** Human note for non-linear versions ("Restored version 3"); null on a
   *  normal edit. */
  note: string | null;
  ts: string;
  title: string;
  /** Whether this version carried live panels (a data app vs a static report). */
  hasPanels: boolean;
}
export interface AppRevision extends AppRevisionMeta {
  format: "html" | "app";
  body: string;
  panels: AppPanel[] | null;
  params: AppParam[] | null;
  refreshSeconds: number | null;
}

/** One panel's last-executed result, cached for the app's refresh TTL. */
export interface PanelCacheRow {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /** The cached rows are a PREFIX of a larger result (byte-budget trim). Legacy
   *  rows written before this column read as false. */
  truncated: boolean;
  computedAt: string;
  error: string | null;
  /** Wall-clock ms of the query execution that produced this row (null on
   *  legacy rows written before durations were recorded). */
  durationMs: number | null;
}

/** Parse the stored panels JSON; tolerates null/garbage (legacy rows). */
function parsePanels(json: string | null): AppPanel[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as AppPanel[]) : null;
  } catch {
    return null;
  }
}

/** Parse the stored params JSON; tolerates null/garbage (legacy rows). */
function parseParams(json: string | null): AppParam[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as AppParam[]) : null;
  } catch {
    return null;
  }
}

/** Parse a stored JSON array column, defaulting to []. */
function parseJsonArray(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Which self-provisioning source a log row came from (task 4.1). */
export type ProvisioningSource = "vercel" | "render" | "slack" | "events";

/** Lifecycle status of a single provisioning step (task 4.1). */
export type ProvisioningStatus = "planned" | "applied" | "skipped" | "failed";

export interface ProvisioningLogEntry {
  id: number;
  ts: string;
  source: ProvisioningSource;
  stepKind: string;
  idempotencyKey: string;
  status: ProvisioningStatus;
  /** Parsed JSON detail (secret-redacted before it was written — task 4.7). */
  detail: Record<string, unknown>;
  actor: string;
}

export function defaultDbPath(projectDir: string): string {
  if (process.env.SETOKU_DB_PATH) return process.env.SETOKU_DB_PATH;
  const slug = path
    .basename(projectDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");
  const hash = crypto
    .createHash("sha256")
    .update(projectDir)
    .digest("hex")
    .slice(0, 8);
  return path.join(
    os.homedir(),
    ".setoku",
    "projects",
    `${slug}-${hash}`,
    "knowledge.db",
  );
}

/** Cap on cached panel/param-variant rows per app. Bounds app_cache so an
 *  open-domain param on a public link can't grow it without limit (a few panels
 *  × many variants stays well under this in normal use). */
const MAX_CACHE_ROWS_PER_APP = 256;

/** Cap on retained version snapshots per app (#58). Each snapshot is a full body
 *  copy (up to ~2MB) and lands in the backed-up knowledge.db (I4), so history is
 *  pruned to the newest N. 100 genuine edits is already a heavily-worked app. */
const MAX_APP_REVISIONS = 100;

/** Mint an opaque share id for a published app/report (24 hex chars). Lives
 *  with the store because `published.id` is its only consumer — publish_app
 *  and the built-in-app seeder both mint through here. */
export const mintShareId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export class KnowledgeStore {
  db: Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.db.run(`CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      body TEXT NOT NULL DEFAULT '',
      verified INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT,
      updated_at TEXT,
      UNIQUE(type, name)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY,
      doc_type TEXT NOT NULL,
      doc_name TEXT NOT NULL,
      op TEXT NOT NULL,
      meta TEXT,
      body TEXT,
      user TEXT,
      ts TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      user TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      relates_to TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by TEXT,
      resolved_ts TEXT
    )`);
    // Structured proposal (#10, avenue 1): split out the concise FACT to store
    // from its supporting context. We only add `fact`; the existing `content`
    // column becomes the "context" (the fuller text a curator reads but which
    // is not itself the stored knowledge). Added idempotently so existing
    // stores migrate in place; legacy rows keep `fact` NULL and fall back to
    // `content` as the savable text.
    this.ensureColumn("corrections", "fact", "TEXT");
    // Curation cockpit (curation-cockpit-spec, piece A/B/C). A pending correction
    // can carry a DRAFT — the exact upsert payload approving it would commit —
    // plus advisory FLAGS (dupe/contradiction/lint/provenance) produced by the
    // auto-draft job. These are advisory only: a draft grants no authority, so
    // they migrate in idempotently and never change who can commit. `rejected_by_bot`
    // marks an auto-rejected (janitor) item so a suppression attack is auditable
    // and the cockpit can un-reject it.
    this.ensureColumn("corrections", "draft_type", "TEXT");
    this.ensureColumn("corrections", "draft_name", "TEXT");
    this.ensureColumn("corrections", "draft_body", "TEXT");
    this.ensureColumn("corrections", "draft_meta", "TEXT");
    this.ensureColumn("corrections", "flags", "TEXT");
    this.ensureColumn("corrections", "drafted_by", "TEXT");
    this.ensureColumn("corrections", "drafted_ts", "TEXT");
    this.ensureColumn("corrections", "rejected_by_bot", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("corrections", "reject_reason", "TEXT");
    this.db.run(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      user TEXT,
      tool TEXT NOT NULL,
      payload TEXT
    )`);
    // Small persistent key/value scratch for gateway-internal bookkeeping that
    // must survive a restart but isn't knowledge — e.g. the last VERSION we sent
    // a "deployed" notification for, so an ordinary restart doesn't re-announce
    // (issue #63). Not for anything user-facing or secret.
    this.db.run(`CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    // Provisioning audit trail (Phase 4, task 4.1) — append-only. Every planned,
    // applied, skipped, or failed provisioning step lands here so a `setoku init`
    // run is fully reconstructable, and so re-runs can skip already-applied steps
    // (idempotency keys, task 4.1). NOTE (task 4.7): callers MUST redact token-
    // shaped material from `detail` before logging — see redactSecrets() in
    // provisioner/framework.ts. No secret ever belongs in this table.
    this.db.run(`CREATE TABLE IF NOT EXISTS provisioning_log (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      step_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      actor TEXT NOT NULL
    )`);
    // Local accounts for the web admin/approval surface (Phase 5.1). These are
    // HUMAN credentials, deliberately SEPARATE from the MCP bearer tokens: an
    // agent holds a (propose-only) token but never a password, so it cannot
    // authenticate to the approval surface even with shell access (I9). pwhash
    // is argon2id (Bun.password); the plaintext never touches disk or logs.
    this.db.run(`CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY,
      pwhash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL,
      created_by TEXT
    )`);
    // Temp passwords must actually be temporary (#73): every WEB path that
    // mints a password for someone else (invite, users create/reset) arms this
    // flag, and the SPA forces a self-service change before anything else.
    // Cleared by the web change and by admin-cli set-password — the CLI paths
    // are deliberate operator actions on the box and stay unflagged by design.
    this.ensureColumn("accounts", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
    // Web admin sessions (Phase 5.1). Persisted here — NOT in process memory — so
    // a server restart/redeploy doesn't sign everyone out. Lives on the same
    // durable volume as the store. The cookie carries only the opaque `sid`; the
    // row holds identity/role/csrf and an absolute `expires` (epoch ms).
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      role TEXT NOT NULL,
      csrf TEXT NOT NULL,
      expires INTEGER NOT NULL
    )`);
    // Teammate ANALYST connectors (read-only + propose-only). Stored here — on the
    // shared durable volume — instead of a boot-time env/file so `add-teammate`
    // and the web "Invite" both take effect IMMEDIATELY, no restart (the running
    // server reads this table per request; same SQLite file, same process). Only
    // analyst tokens live here: curator/janitor authority stays env-pinned and
    // operator-controlled (I2/I9 — the membrane never depends on a DB row).
    this.db.run(`CREATE TABLE IF NOT EXISTS analyst_tokens (
      token TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`);
    // Per-identity source DENIES (the Team page "Data access…" dialog, I9).
    // Deny-list semantics on purpose: NO rows = full access, forever, including
    // families that don't exist yet — a new connector is opted-in by default
    // and a restriction is an explicit act. `family` is the slug from
    // lib/sources.ts familySlug(); slugs for removed connectors are kept (a
    // denied family must not silently re-open because its poller was retired).
    // Written only by the admin web surface — no MCP tool touches this table.
    this.db.run(`CREATE TABLE IF NOT EXISTS source_denies (
      identity TEXT NOT NULL,
      family TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      PRIMARY KEY (identity, family)
    )`);
    // Published reports (the "Reports" surface). An agent calls publish_report
    // with self-contained HTML; we store it under an opaque id. A "team" report
    // serves session-gated at /apps/<id>; a "public" one (an admin promotes
    // it) serves credential-free at /p/<id>. `archived_at` is a soft delete — an
    // archived link 404s everywhere but the row (and its audit trail) stays.
    this.db.run(`CREATE TABLE IF NOT EXISTS published (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'app',
      body TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'team',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )`);
    // Brought the table forward in-place for boxes created before visibility /
    // the revoked→archived rename / live apps landed (idempotent).
    this.ensureColumn("published", "visibility", "TEXT NOT NULL DEFAULT 'team'");
    this.ensureColumn("published", "archived_at", "TEXT");
    this.ensureColumn("published", "panels", "TEXT");
    this.ensureColumn("published", "params", "TEXT");
    this.ensureColumn("published", "refresh_seconds", "INTEGER");
    // Every app now renders through the runtime shell, so the format column is
    // effectively always 'app'. Boxes that published before the Dashboards→Apps
    // rename hold format='dashboard'; backfill those to 'app' (a no-op on a fresh
    // box). The legacy raw-served 'html' value is retired: no new rows mint it, and
    // it was already absent from every live box at removal (issue #62) — so a
    // straggler is not migrated (a full-doc body can't render inside the shell) but
    // simply falls through the runtime path like any other app.
    this.db.run("UPDATE published SET format = 'app' WHERE format = 'dashboard'");
    // Append-only version history for published apps (issue #58). One snapshot
    // per create / content edit / revert; the newest seq mirrors the live
    // `published` row, so the header's version drawer + revert read straight
    // from here. Snapshots the full content (body/panels/params) so a revert is
    // a pure restore with no re-derivation.
    this.db.run(`CREATE TABLE IF NOT EXISTS app_revisions (
      rev_id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      format TEXT NOT NULL,
      body TEXT NOT NULL,
      panels TEXT,
      params TEXT,
      refresh_seconds INTEGER,
      editor TEXT NOT NULL,
      note TEXT,
      ts TEXT NOT NULL
    )`);
    // UNIQUE enforces the "one row per (app, seq)" invariant that "newest seq ==
    // live state" rests on (safe: the table is new, so no pre-existing dupes).
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS app_revisions_app ON app_revisions (app_id, seq)");
    // Backfill a v1 for every app published before history landed, from its
    // current row — so an existing app opens with a non-empty history (its
    // current state) instead of a blank drawer. Idempotent (NOT EXISTS), and
    // attributed to the original author at the original publish time.
    this.db.run(
      `INSERT INTO app_revisions (app_id, seq, title, format, body, panels, params, refresh_seconds, editor, note, ts)
       SELECT p.id, 1, p.title, p.format, p.body, p.panels, p.params, p.refresh_seconds, p.created_by, NULL, p.created_at
       FROM published p
       WHERE NOT EXISTS (SELECT 1 FROM app_revisions r WHERE r.app_id = p.id)`,
    );
    // Per-panel result cache. A app view serves cached rows within the
    // app's refresh TTL and re-runs the query when stale — bounding DB load
    // on a hammered public link and giving an honest "updated N ago" stamp.
    this.db.run(`CREATE TABLE IF NOT EXISTS app_cache (
      app_id TEXT NOT NULL,
      panel_key TEXT NOT NULL,
      columns TEXT NOT NULL DEFAULT '[]',
      rows TEXT NOT NULL DEFAULT '[]',
      row_count INTEGER NOT NULL DEFAULT 0,
      computed_at TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER,
      PRIMARY KEY (app_id, panel_key)
    )`);
    this.ensureColumn("app_cache", "duration_ms", "INTEGER");
    this.ensureColumn("app_cache", "truncated", "INTEGER");
    // Carry the pre-rename cache forward (dashboard_cache → app_cache, same shape
    // but for the renamed key column). Without this an upgraded box cold-starts
    // every app's cache — the first view of each re-runs all its panels against
    // prod (the stampede the cache exists to prevent) and the "updated N ago"
    // stamp is blank until then. Columns are mapped EXPLICITLY (not SELECT *) so a
    // future column add/reorder can't silently land values in the wrong column.
    const hasOldCache = this.db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dashboard_cache'")
      .get();
    if (hasOldCache) {
      this.db.run(
        `INSERT OR IGNORE INTO app_cache (app_id, panel_key, columns, rows, row_count, computed_at, error)
         SELECT dashboard_id, panel_key, columns, rows, row_count, computed_at, error FROM dashboard_cache`,
      );
      this.db.run("DROP TABLE dashboard_cache");
    }
    // Persisted doc embeddings (I8 opt-in hybrid retrieval). Lets a restart LOAD
    // vectors instead of re-embedding every doc, so startup is O(changed docs) not
    // O(corpus) — the thing that otherwise breaks at ~1000s of docs. Keyed by
    // (type,name) + a content hash + model id: only docs whose text or the model
    // changed are re-embedded. Cheap (a 384-d vector is ~1.5KB).
    this.db.run(`CREATE TABLE IF NOT EXISTS doc_embeddings (
      doc_type TEXT NOT NULL,
      doc_name TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      hash TEXT NOT NULL,
      vec BLOB NOT NULL,
      PRIMARY KEY (doc_type, doc_name)
    )`);
  }

  /* ------------------------------- docs ------------------------------- */

  /** Add a column if it isn't already present — idempotent in-place migration. */
  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db
      .query(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === column))
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  listDocs(): KnowledgeDoc[] {
    const rows = this.db
      .query("SELECT * FROM docs ORDER BY type, name")
      .all() as Record<string, unknown>[];
    return rows.map(rowToDoc);
  }

  /** Doc count without materializing bodies (health endpoints poll this). */
  get docCount(): number {
    const row = this.db.query("SELECT count(*) AS n FROM docs").get() as {
      n: number;
    };
    return row.n;
  }

  /**
   * Count of pending (proposed, not-yet-approved) corrections. Cheap — the
   * empty-store hints gate on this alongside docCount so a box that has *only*
   * unverified knowledge doesn't claim to be empty right after an agent files a
   * correction (the "I did the right thing and nothing changed" footgun).
   */
  get pendingCount(): number {
    const row = this.db
      .query("SELECT count(*) AS n FROM corrections WHERE status = 'pending'")
      .get() as { n: number };
    return row.n;
  }

  getDoc(type: DocType | null, name: string): KnowledgeDoc | null {
    const needle = name.toLowerCase();
    const all = this.listDocs().filter((d) => (type ? d.type === type : true));
    return (
      all.find((d) => d.name.toLowerCase() === needle) ??
      all.find((d) => String(d.meta.table ?? "").toLowerCase() === needle) ??
      all.find((d) => d.name.toLowerCase().includes(needle)) ??
      null
    );
  }

  upsertDoc(
    doc: {
      type: DocType;
      name: string;
      meta?: Record<string, unknown>;
      body?: string;
    },
    user: string,
  ): void {
    const ts = new Date().toISOString();
    const meta = JSON.stringify(doc.meta ?? {});
    const body = doc.body ?? "";
    this.db.run(
      `INSERT INTO docs (type, name, meta, body, verified, updated_by, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(type, name) DO UPDATE SET meta = excluded.meta, body = excluded.body,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [doc.type, doc.name, meta, body, user, ts],
    );
    this.db.run(
      "INSERT INTO revisions (doc_type, doc_name, op, meta, body, user, ts) VALUES (?, ?, 'upsert', ?, ?, ?, ?)",
      [doc.type, doc.name, meta, body, user, ts],
    );
  }

  deleteDoc(type: DocType, name: string, user: string): boolean {
    const existing = this.getDoc(type, name);
    if (!existing || existing.name !== name) return false;
    this.db.run("DELETE FROM docs WHERE type = ? AND name = ?", [type, name]);
    this.db.run(
      "INSERT INTO revisions (doc_type, doc_name, op, user, ts) VALUES (?, ?, 'delete', ?, ?)",
      [type, name, user, new Date().toISOString()],
    );
    return true;
  }

  gotchas(): string[] {
    return this.listDocs()
      .filter((d) => d.type === "gotcha")
      .map((d) => d.body || d.name);
  }

  /* --------------------------- doc embeddings -------------------------- */

  /** All persisted embeddings for a model, each tagged with its (type, name) so
   *  the caller keys by canonical DocRef and can prune rows for docs that no
   *  longer exist. The hash lets it skip re-embedding unchanged docs. */
  getDocEmbeddings(
    model: string,
  ): { type: DocType; name: string; hash: string; vec: number[] }[] {
    const rows = this.db
      .query("SELECT doc_type, doc_name, hash, dim, vec FROM doc_embeddings WHERE model = ?")
      .all(model) as {
      doc_type: string;
      doc_name: string;
      hash: string;
      dim: number;
      vec: Uint8Array;
    }[];
    return rows.map((r) => {
      // copy into a fresh, 4-byte-aligned buffer before viewing as Float32
      const f = new Float32Array(new Uint8Array(r.vec).buffer, 0, r.dim);
      return { type: r.doc_type as DocType, name: r.doc_name, hash: r.hash, vec: Array.from(f) };
    });
  }

  /** Upsert one doc's embedding (vector stored as a compact Float32 BLOB). */
  putDocEmbedding(
    type: DocType,
    name: string,
    model: string,
    hash: string,
    vec: number[],
  ): void {
    const buf = Buffer.from(new Float32Array(vec).buffer);
    this.db.run(
      `INSERT INTO doc_embeddings (doc_type, doc_name, model, dim, hash, vec)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_type, doc_name) DO UPDATE SET
         model = excluded.model, dim = excluded.dim, hash = excluded.hash, vec = excluded.vec`,
      [type, name, model, vec.length, hash, buf],
    );
  }

  /** Drop a doc's embedding (on delete). */
  deleteDocEmbedding(type: DocType, name: string): void {
    this.db.run("DELETE FROM doc_embeddings WHERE doc_type = ? AND doc_name = ?", [type, name]);
  }

  /** Drop every embedding NOT from the current model tag — so the table only ever
   *  holds vectors from the model in use. A model/dimension change then leaves no
   *  stale, wrong-space vectors that could be cosined against new query embeddings. */
  clearDocEmbeddingsExcept(model: string): void {
    this.db.run("DELETE FROM doc_embeddings WHERE model != ?", [model]);
  }

  /* ---------------------------- corrections ---------------------------- */

  /**
   * Record a pending proposal. Two fields (#10 avenue 1): `fact` is the concise
   * claim to store; `context` is the supporting text shown to a curator. They
   * map to the `fact` and `content` columns respectively — `content` keeps its
   * legacy role as the curator-facing text. A legacy single-blob caller can
   * still pass `content` directly (fact stays NULL).
   */
  addCorrection(rec: {
    user: string;
    kind: string;
    fact?: string;
    context?: string;
    content?: string;
    relatesTo?: string;
  }): number {
    const fact = rec.fact?.trim() || null;
    // the curator-facing text: the supplied context, else the legacy blob,
    // else fall back to the fact so the column is never empty.
    const content = (rec.context?.trim() || rec.content?.trim() || fact || "").trim();
    this.db.run(
      "INSERT INTO corrections (ts, user, kind, content, fact, relates_to) VALUES (?, ?, ?, ?, ?, ?)",
      [new Date().toISOString(), rec.user, rec.kind, content, fact, rec.relatesTo ?? null],
    );
    return Number(
      this.db.query("SELECT last_insert_rowid() AS id").get()!["id" as never],
    );
  }

  // Overloads narrow the result to the variant matching the requested status, so
  // callers get e.g. PendingCorrection[] (with `draft`) without re-narrowing.
  listCorrections(status: "pending"): PendingCorrection[];
  listCorrections(status: "accepted"): AcceptedCorrection[];
  listCorrections(status: "rejected"): RejectedCorrection[];
  listCorrections(status?: string): Correction[];
  listCorrections(status: string = "pending"): Correction[] {
    const rows = this.db
      .query(
        "SELECT * FROM corrections WHERE status = ? ORDER BY id",
      )
      .all(status) as Record<string, unknown>[];
    return rows.map(rowToCorrection);
  }

  /** A single correction by id, regardless of status (cockpit / capability tools). */
  getCorrection(id: number): Correction | null {
    const row = this.db
      .query("SELECT * FROM corrections WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    return row ? rowToCorrection(row) : null;
  }

  resolveCorrection(
    id: number,
    action: "accepted" | "rejected",
    user: string,
  ): boolean {
    const res = this.db.run(
      "UPDATE corrections SET status = ?, resolved_by = ?, resolved_ts = ? WHERE id = ? AND status = 'pending'",
      [action, user, new Date().toISOString(), id],
    );
    return res.changes > 0;
  }

  /**
   * Attach (or replace) a DRAFT + advisory FLAGS on a pending correction — the
   * cockpit/auto-draft path (curation-cockpit-spec piece B). Writes NO curated
   * doc and never changes the correction's status: a draft grants no authority.
   * Only pending corrections can be drafted. Returns false if not pending.
   */
  draftCorrection(
    id: number,
    draft: CorrectionDraft,
    flags: string[],
    user: string,
  ): boolean {
    const res = this.db.run(
      `UPDATE corrections
         SET draft_type = ?, draft_name = ?, draft_body = ?, draft_meta = ?,
             flags = ?, drafted_by = ?, drafted_ts = ?
       WHERE id = ? AND status = 'pending'`,
      [
        draft.type,
        draft.name,
        draft.body,
        JSON.stringify(draft.meta ?? {}),
        JSON.stringify(flags ?? []),
        user,
        new Date().toISOString(),
        id,
      ],
    );
    return res.changes > 0;
  }

  /**
   * Reject a pending correction — queue status only, grants zero authority
   * (curation-cockpit-spec piece C). `byBot` marks an auto-reject (janitor) so a
   * suppression attack is auditable and the cockpit can surface + reverse it.
   * Soft: the row is kept (status='rejected'), recoverable via unrejectCorrection.
   */
  rejectCorrection(
    id: number,
    reason: string,
    user: string,
    byBot = false,
  ): boolean {
    const res = this.db.run(
      `UPDATE corrections
         SET status = 'rejected', resolved_by = ?, resolved_ts = ?,
             reject_reason = ?, rejected_by_bot = ?
       WHERE id = ? AND status = 'pending'`,
      [user, new Date().toISOString(), reason, byBot ? 1 : 0, id],
    );
    return res.changes > 0;
  }

  /** Reverse a rejection back to pending (un-reject in the cockpit). Reversible
   *  by design so a bot suppressing good proposals is undoable. */
  unrejectCorrection(id: number, user: string): boolean {
    const res = this.db.run(
      `UPDATE corrections
         SET status = 'pending', resolved_by = NULL, resolved_ts = NULL,
             reject_reason = NULL, rejected_by_bot = 0
       WHERE id = ? AND status = 'rejected'`,
      [id],
    );
    if (res.changes > 0) this.audit(user, "unreject_correction", { id });
    return res.changes > 0;
  }

  /* --------------------------------- kv --------------------------------- */

  /** Read a gateway-internal bookkeeping value (see the `kv` table). */
  getKv(key: string): string | null {
    const row = this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Upsert a gateway-internal bookkeeping value. */
  setKv(key: string, value: string): void {
    this.db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }

  /* -------------------------------- audit ------------------------------- */

  audit(user: string, tool: string, payload: Record<string, unknown>): void {
    try {
      this.db.run(
        "INSERT INTO audit (ts, user, tool, payload) VALUES (?, ?, ?, ?)",
        [new Date().toISOString(), user, tool, JSON.stringify(payload)],
      );
    } catch {
      // auditing must never take the gateway down
    }
  }

  /**
   * How often each curated doc has been surfaced, tallied from the audit log:
   * names that find_context returned (payload.docs[]) plus direct
   * describe_entity / get_metric lookups. Keyed by doc name. Aggregated in SQL
   * (json1) so it doesn't materialize the whole audit table.
   */
  knowledgeUsage(): Record<string, number> {
    const counts: Record<string, number> = {};
    const add = (name: unknown, n: number) => {
      if (typeof name === "string" && name)
        counts[name] = (counts[name] ?? 0) + n;
    };
    for (const r of this.db
      .query(
        `SELECT je.value AS name, count(*) AS n
         FROM audit, json_each(json_extract(audit.payload, '$.docs')) je
         WHERE audit.tool = 'find_context'
           AND json_extract(audit.payload, '$.docs') IS NOT NULL
         GROUP BY je.value`,
      )
      .all() as { name: string; n: number }[])
      add(r.name, r.n);
    for (const r of this.db
      .query(
        `SELECT json_extract(payload, '$.name') AS name, count(*) AS n
         FROM audit
         WHERE tool IN ('describe_entity', 'get_metric')
           AND json_extract(payload, '$.ok') = 1
         GROUP BY name`,
      )
      .all() as { name: string; n: number }[])
      add(r.name, r.n);
    return counts;
  }

  /** Most-recent audit rows, newest first (the 5.6 audit-log page). */
  listAudit(limit = 100): AuditRow[] {
    return this.db
      .query(
        "SELECT ts, user, tool, payload FROM audit ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as unknown as AuditRow[];
  }

  /* -------------------------------- accounts ---------------------------- */

  /** Create a local account (Phase 5.1). pwhash must already be argon2id.
   *  `mustChangePassword` marks an admin-minted (temp) password (#73). */
  createAccount(rec: {
    username: string;
    pwhash: string;
    role: string;
    createdBy?: string;
    mustChangePassword?: boolean;
  }): void {
    this.db.run(
      "INSERT INTO accounts (username, pwhash, role, created_at, created_by, must_change_password) VALUES (?, ?, ?, ?, ?, ?)",
      [
        rec.username,
        rec.pwhash,
        rec.role,
        new Date().toISOString(),
        rec.createdBy ?? null,
        rec.mustChangePassword ? 1 : 0,
      ],
    );
  }

  getAccount(username: string): Account | null {
    const row = this.db
      .query(
        "SELECT username, pwhash, role, created_at AS createdAt, created_by AS createdBy, must_change_password AS mustChangePassword FROM accounts WHERE username = ?",
      )
      .get(username) as unknown as (Omit<Account, "mustChangePassword"> & { mustChangePassword: number }) | null;
    return row ? { ...row, mustChangePassword: !!row.mustChangePassword } : null;
  }

  listAccounts(): Omit<Account, "pwhash">[] {
    const rows = this.db
      .query(
        "SELECT username, role, created_at AS createdAt, created_by AS createdBy, must_change_password AS mustChangePassword FROM accounts ORDER BY username",
      )
      .all() as unknown as (Omit<Account, "pwhash" | "mustChangePassword"> & { mustChangePassword: number })[];
    return rows.map((r) => ({ ...r, mustChangePassword: !!r.mustChangePassword }));
  }

  get accountCount(): number {
    return (this.db.query("SELECT count(*) AS n FROM accounts").get() as { n: number }).n;
  }

  /** Replace a password. `mustChange` arms the forced-change gate — true for an
   *  admin RESET (a temp password), false when the owner sets it themselves. */
  setPassword(username: string, pwhash: string, mustChange = false): boolean {
    return (
      this.db.run("UPDATE accounts SET pwhash = ?, must_change_password = ? WHERE username = ?", [
        pwhash,
        mustChange ? 1 : 0,
        username,
      ]).changes > 0
    );
  }

  /** Change a web account's role (member ↔ admin). */
  setRole(username: string, role: string): boolean {
    return (
      this.db.run("UPDATE accounts SET role = ? WHERE username = ?", [role, username]).changes > 0
    );
  }

  /** Remove a web account. */
  deleteAccount(username: string): boolean {
    return this.db.run("DELETE FROM accounts WHERE username = ?", [username]).changes > 0;
  }

  /** How many accounts hold a given role — used to guard the last admin. */
  countRole(role: string): number {
    return (
      this.db.query("SELECT count(*) AS n FROM accounts WHERE role = ?").get(role) as { n: number }
    ).n;
  }

  /**
   * Identities that have actually used an agent connector — i.e. made at least
   * one MCP tool call (audited under the token's identity). Lets the Team page
   * say "connected" only once someone has really used their agent, vs "invited".
   */
  activeIdentities(): Set<string> {
    const MCP_TOOLS = [
      "find_context", "get_schema", "run_query", "list_entities", "describe_entity",
      "get_metric", "list_corrections", "report_correction", "upsert_context", "resolve_correction",
      "draft_correction", "reject_correction",
    ];
    const ph = MCP_TOOLS.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT DISTINCT user FROM audit WHERE tool IN (${ph})`)
      .all(...MCP_TOOLS) as { user: string }[];
    return new Set(rows.map((r) => r.user));
  }

  /* ---------------------------- analyst tokens -------------------------- */

  /** Provision (or overwrite) a teammate analyst token — live on the next request. */
  addAnalystToken(token: string, identity: string, createdBy?: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO analyst_tokens (token, identity, created_at, created_by) VALUES (?, ?, ?, ?)",
      [token, identity, new Date().toISOString(), createdBy ?? null],
    );
  }

  /** Identity for a bearer token, or null if it isn't a known analyst token. */
  analystTokenIdentity(token: string): string | null {
    const row = this.db
      .query("SELECT identity FROM analyst_tokens WHERE token = ?")
      .get(token) as { identity: string } | null;
    return row?.identity ?? null;
  }

  /** Revoke every analyst token for an identity; returns how many were removed. */
  removeAnalystTokensFor(identity: string): number {
    return this.db.run("DELETE FROM analyst_tokens WHERE identity = ?", [identity]).changes;
  }

  /** Distinct identities that hold a teammate analyst token (for the Team page). */
  analystIdentities(): string[] {
    return (
      this.db
        .query("SELECT DISTINCT identity FROM analyst_tokens ORDER BY identity")
        .all() as { identity: string }[]
    ).map((r) => r.identity);
  }

  /* --------------------------- source access (I9) ----------------------- */

  /** The source families this identity is denied (slugs). [] = full access. */
  sourceDenies(identity: string): string[] {
    return (
      this.db
        .query("SELECT family FROM source_denies WHERE identity = ? ORDER BY family")
        .all(identity) as { family: string }[]
    ).map((r) => r.family);
  }

  /** Replace an identity's denied families wholesale (the dialog's Save is a
   *  full snapshot of the checkboxes). Slugs not in the current catalog are
   *  stored as-is — a deny outlives its connector. Empty = restore full access. */
  setSourceDenies(identity: string, families: string[], by: string): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction((fams: string[]) => {
      this.db.run("DELETE FROM source_denies WHERE identity = ?", [identity]);
      for (const family of fams) {
        this.db.run(
          "INSERT OR REPLACE INTO source_denies (identity, family, created_at, created_by) VALUES (?, ?, ?, ?)",
          [identity, family, now, by],
        );
      }
    });
    tx([...new Set(families)]);
  }

  /** Every identity's denies in one query (the Team page join). */
  allSourceDenies(): Record<string, string[]> {
    const rows = this.db
      .query("SELECT identity, family FROM source_denies ORDER BY identity, family")
      .all() as { identity: string; family: string }[];
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.identity] ??= []).push(r.family);
    return out;
  }

  /** Drop an identity's denies (person removed — a fresh re-invite starts at
   *  the default: full access). Returns how many rows were cleared. */
  clearSourceDenies(identity: string): number {
    return this.db.run("DELETE FROM source_denies WHERE identity = ?", [identity]).changes;
  }

  /* -------------------------------- sessions ---------------------------- */

  /** Persist a web-admin session (Phase 5.1). Persisted so a restart/redeploy
   *  doesn't sign everyone out. Opportunistically prunes expired rows. */
  createSession(rec: {
    sid: string;
    identity: string;
    role: string;
    csrf: string;
    expires: number;
  }): void {
    this.pruneSessions();
    this.db.run(
      "INSERT OR REPLACE INTO sessions (sid, identity, role, csrf, expires) VALUES (?, ?, ?, ?, ?)",
      [rec.sid, rec.identity, rec.role, rec.csrf, rec.expires],
    );
  }

  /** Fetch a live session by id; an expired row is deleted and returns null. */
  getSession(
    sid: string,
  ): { identity: string; role: string; csrf: string; expires: number } | null {
    const row = this.db
      .query("SELECT identity, role, csrf, expires FROM sessions WHERE sid = ?")
      .get(sid) as
      | { identity: string; role: string; csrf: string; expires: number }
      | null;
    if (!row) return null;
    if (row.expires < Date.now()) {
      this.destroySession(sid);
      return null;
    }
    return row;
  }

  /** Slide a session's expiry forward (sliding-window renewal on activity). */
  touchSession(sid: string, expires: number): void {
    this.db.run("UPDATE sessions SET expires = ? WHERE sid = ?", [expires, sid]);
  }

  destroySession(sid: string): void {
    this.db.run("DELETE FROM sessions WHERE sid = ?", [sid]);
  }

  /** Kill an identity's live sessions — on person removal, role change, or a
   *  password change/reset, so a stale session can't keep the old authority
   *  (or a shared temp password) for the 14-day lifetime. Pass `exceptSid` to
   *  spare the caller's own session (self password change / self-reset). */
  destroySessionsFor(identity: string, exceptSid?: string): number {
    return this.db.run("DELETE FROM sessions WHERE identity = ? AND sid <> ?", [
      identity,
      exceptSid ?? "",
    ]).changes;
  }

  pruneSessions(): void {
    this.db.run("DELETE FROM sessions WHERE expires < ?", [Date.now()]);
  }

  /* --------------------------- provisioning ---------------------------- */

  /**
   * Append one provisioning action to the audit trail (task 4.1).
   *
   * `detail` is stored as-is — the caller is responsible for redacting any
   * token-shaped material first (task 4.7; the provisioner pipes everything
   * through redactSecrets() before it reaches here). Returns the new row id.
   */
  logProvisioning(entry: {
    source: ProvisioningSource;
    stepKind: string;
    idempotencyKey: string;
    status: ProvisioningStatus;
    detail?: Record<string, unknown>;
    actor: string;
  }): number {
    this.db.run(
      `INSERT INTO provisioning_log (ts, source, step_kind, idempotency_key, status, detail, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        entry.source,
        entry.stepKind,
        entry.idempotencyKey,
        entry.status,
        JSON.stringify(entry.detail ?? {}),
        entry.actor,
      ],
    );
    return Number(
      this.db.query("SELECT last_insert_rowid() AS id").get()!["id" as never],
    );
  }

  /** Provisioning history, newest first; optionally filtered to one source. */
  listProvisioning(source?: ProvisioningSource): ProvisioningLogEntry[] {
    const rows = (
      source
        ? this.db
            .query(
              "SELECT * FROM provisioning_log WHERE source = ? ORDER BY id DESC",
            )
            .all(source)
        : this.db.query("SELECT * FROM provisioning_log ORDER BY id DESC").all()
    ) as Record<string, unknown>[];
    return rows.map(rowToProvisioning);
  }

  /**
   * Has a step with this idempotency key ever reached the `applied` state?
   * The provisioner consults this before each step so re-runs are safe (4.1):
   * an already-applied step is skipped, never re-created.
   */
  wasApplied(idempotencyKey: string): boolean {
    const row = this.db
      .query(
        "SELECT count(*) AS n FROM provisioning_log WHERE idempotency_key = ? AND status = 'applied'",
      )
      .get(idempotencyKey) as { n: number };
    return row.n > 0;
  }

  /* ------------------------------- published ---------------------------- */

  /** Store a published report or app. `id` must already be a minted opaque
   *  token. Visibility defaults to "team" — the agent never publishes public. */
  createPublished(rec: {
    id: string;
    title: string;
    body: string;
    panels?: AppPanel[] | null;
    params?: AppParam[] | null;
    refreshSeconds?: number | null;
    visibility?: ReportVisibility;
    createdBy: string;
  }): void {
    const panels = rec.panels && rec.panels.length ? JSON.stringify(rec.panels) : null;
    const params = rec.params && rec.params.length ? JSON.stringify(rec.params) : null;
    const createdAt = new Date().toISOString();
    this.db.run(
      "INSERT INTO published (id, title, format, body, panels, params, refresh_seconds, visibility, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        rec.id,
        rec.title,
        // Every published app is a fragment the runtime wraps — the legacy raw-served
        // "html" format is gone, so the stored format is always "app". The column
        // stays for existing rows / the version-history snapshot.
        "app",
        rec.body,
        panels,
        params,
        rec.refreshSeconds ?? null,
        rec.visibility ?? "team",
        rec.createdBy,
        createdAt,
      ],
    );
    // v1 of the version history — the original publish, attributed to the author.
    this.snapshotAppVersion(rec.id, rec.createdBy, createdAt);
  }

  /** Append the app's CURRENT `published` row as its next version. Reads the
   *  stored row straight back (already-serialized panels/params) so a snapshot
   *  is byte-identical to what a revert would restore, with no re-serialization
   *  drift. Called on create, every content edit, and revert. */
  private snapshotAppVersion(id: string, editor: string, ts: string, note?: string | null): void {
    const cols = "title, format, body, panels, params, refresh_seconds AS rs";
    type Row = { title: string; format: string; body: string; panels: string | null; params: string | null; rs: number | null };
    const row = this.db.query(`SELECT ${cols} FROM published WHERE id = ?`).get(id) as Row | null;
    if (!row) return;
    // Only append when the content actually differs from the newest version.
    // SQLite counts an UPDATE that writes identical values as a "change", so
    // without this guard a rename-to-same-title or an idempotent update_app
    // re-run would snapshot the whole (up-to-2MB) body again; a revert whose
    // target already equals the live content is likewise a no-op.
    const prev = this.db
      .query(`SELECT ${cols} FROM app_revisions WHERE app_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(id) as Row | null;
    if (
      prev &&
      prev.title === row.title &&
      prev.format === row.format &&
      prev.body === row.body &&
      prev.panels === row.panels &&
      prev.params === row.params &&
      prev.rs === row.rs
    )
      return;
    const seq =
      ((this.db.query("SELECT MAX(seq) AS m FROM app_revisions WHERE app_id = ?").get(id) as { m: number | null }).m ?? 0) + 1;
    this.db.run(
      "INSERT INTO app_revisions (app_id, seq, title, format, body, panels, params, refresh_seconds, editor, note, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, seq, row.title, row.format, row.body, row.panels, row.params, row.rs, editor, note ?? null, ts],
    );
    // Bound history growth: keep the newest MAX_APP_REVISIONS, prune older seqs.
    // Gaps at the bottom are fine — reverting to a pruned version just 404s. Only
    // run the DELETE once actually over the cap — the count is a cheap PK-prefix
    // scan, so the common (well-under-cap) write skips the prune entirely.
    const revCount = (this.db.query("SELECT COUNT(*) AS n FROM app_revisions WHERE app_id = ?").get(id) as { n: number }).n;
    if (revCount > MAX_APP_REVISIONS)
      this.db.run(
        `DELETE FROM app_revisions WHERE app_id = ? AND seq NOT IN (
           SELECT seq FROM app_revisions WHERE app_id = ? ORDER BY seq DESC LIMIT ?)`,
        [id, id, MAX_APP_REVISIONS],
      );
  }

  /** Version history for the header drawer, newest first, WITHOUT bodies — each
   *  revision tagged with which fields differ from the CURRENT live app, so a
   *  restore isn't blind ("restoring changes: content, data"). The diff is done
   *  in SQL against the live `published` row (`IS NOT` = null-safe), so no ~2MB
   *  bodies are materialized. The newest revision equals the live row (diff-gate
   *  invariant), so its `changes` is always empty. */
  listAppHistory(id: string): (AppRevisionMeta & { changes: string[] })[] {
    const rows = this.db
      .query(
        `SELECT r.seq AS seq, r.editor AS editor, r.note AS note, r.ts AS ts, r.title AS title,
                (r.panels IS NOT NULL) AS hasPanels,
                (r.title IS NOT p.title) AS titleChanged,
                (r.body IS NOT p.body) AS bodyChanged,
                (r.panels IS NOT p.panels) AS panelsChanged,
                (r.params IS NOT p.params) AS paramsChanged,
                (r.refresh_seconds IS NOT p.refresh_seconds) AS refreshChanged
         FROM app_revisions r JOIN published p ON p.id = r.app_id
         WHERE r.app_id = ? ORDER BY r.seq DESC`,
      )
      .all(id) as {
      seq: number; editor: string; note: string | null; ts: string; title: string; hasPanels: number;
      titleChanged: number; bodyChanged: number; panelsChanged: number; paramsChanged: number; refreshChanged: number;
    }[];
    return rows.map((r) => {
      const changes: string[] = [];
      if (r.titleChanged) changes.push("title");
      if (r.bodyChanged) changes.push("content");
      if (r.panelsChanged) changes.push("data");
      if (r.paramsChanged) changes.push("inputs");
      if (r.refreshChanged) changes.push("refresh");
      return { seq: r.seq, editor: r.editor, note: r.note, ts: r.ts, title: r.title, hasPanels: !!r.hasPanels, changes };
    });
  }

  /** The newest version's editor + timestamp and the total version count — for
   *  the header's "edited by X · Ns ago" (shown only once an app has been edited,
   *  i.e. versions > 1). Null for an app with no history. */
  latestAppEdit(id: string): { editor: string; ts: string; versions: number } | null {
    return (
      (this.db
        .query(
          "SELECT editor, ts, (SELECT COUNT(*) FROM app_revisions WHERE app_id = ?) AS versions FROM app_revisions WHERE app_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(id, id) as { editor: string; ts: string; versions: number } | null) ?? null
    );
  }

  /** One full version snapshot (incl. body/panels/params) — what a revert
   *  restores. Null if the app or version is unknown. */
  getAppRevision(id: string, seq: number): AppRevision | null {
    const row = this.db
      .query(
        "SELECT seq, editor, note, ts, title, format, body, panels, params, refresh_seconds AS refreshSeconds FROM app_revisions WHERE app_id = ? AND seq = ?",
      )
      .get(id, seq) as
      | (Omit<AppRevision, "panels" | "params" | "hasPanels"> & { panels: string | null; params: string | null })
      | null;
    if (!row) return null;
    return { ...row, hasPanels: row.panels != null, panels: parsePanels(row.panels), params: parseParams(row.params) };
  }

  /** Fetch one published report/app (incl. body + panels). Returns archived
   *  rows too — the caller decides how to treat `archivedAt` (the viewer 404s). */
  getPublished(id: string): PublishedReport | null {
    const row = this.db
      .query(
        "SELECT id, title, format, body, panels, params, refresh_seconds AS refreshSeconds, visibility, created_by AS createdBy, created_at AS createdAt, archived_at AS archivedAt FROM published WHERE id = ?",
      )
      .get(id) as (Omit<PublishedReport, "panels" | "params"> & { panels: string | null; params: string | null }) | null;
    return row ? { ...row, panels: parsePanels(row.panels), params: parseParams(row.params) } : null;
  }

  /** One report's metadata WITHOUT its (up-to-2MB) body — for cheap 404/policy
   *  gating on hot or credential-free paths before deciding to serve the body. */
  getPublishedMeta(id: string): PublishedMeta | null {
    const row = this.db
      .query(
        "SELECT id, title, format, panels, params, refresh_seconds AS refreshSeconds, visibility, created_by AS createdBy, created_at AS createdAt, archived_at AS archivedAt FROM published WHERE id = ?",
      )
      .get(id) as (Omit<PublishedMeta, "panels" | "params"> & { panels: string | null; params: string | null }) | null;
    return row ? { ...row, panels: parsePanels(row.panels), params: parseParams(row.params) } : null;
  }

  /** Published reports/apps without bodies, newest first (admin list). */
  listPublished(): PublishedMeta[] {
    const rows = this.db
      .query(
        "SELECT id, title, format, panels, params, refresh_seconds AS refreshSeconds, visibility, created_by AS createdBy, created_at AS createdAt, archived_at AS archivedAt FROM published ORDER BY created_at DESC",
      )
      .all() as unknown as (Omit<PublishedMeta, "panels" | "params"> & { panels: string | null; params: string | null })[];
    return rows.map((r) => ({ ...r, panels: parsePanels(r.panels), params: parseParams(r.params) }));
  }

  /** Soft-delete (archive) a published report/app. Returns false if already
   *  archived or unknown. The row + audit trail survive; cached panel data is
   *  dropped (an archived link must stop serving live data immediately). */
  archivePublished(id: string): boolean {
    const archived =
      this.db.run("UPDATE published SET archived_at = ? WHERE id = ? AND archived_at IS NULL", [
        new Date().toISOString(),
        id,
      ]).changes > 0;
    if (archived) this.db.run("DELETE FROM app_cache WHERE app_id = ?", [id]);
    return archived;
  }

  /* ------------------------- app panel cache ---------------------- */

  /** Cached result for one panel, or null if never computed. */
  getPanelCache(appId: string, panelKey: string): PanelCacheRow | null {
    const row = this.db
      .query(
        "SELECT columns, rows, row_count AS rowCount, truncated, computed_at AS computedAt, error, duration_ms AS durationMs FROM app_cache WHERE app_id = ? AND panel_key = ?",
      )
      .get(appId, panelKey) as
      | { columns: string; rows: string; rowCount: number; truncated: number | null; computedAt: string; error: string | null; durationMs: number | null }
      | null;
    if (!row) return null;
    return {
      columns: parseJsonArray(row.columns) as string[],
      rows: parseJsonArray(row.rows) as Record<string, unknown>[],
      rowCount: row.rowCount,
      truncated: !!row.truncated,
      computedAt: row.computedAt,
      error: row.error,
      durationMs: row.durationMs,
    };
  }

  /** Upsert one panel's cached result (success or error), stamped now. */
  putPanelCache(
    appId: string,
    panelKey: string,
    data: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated?: boolean; error?: string | null; durationMs?: number | null },
  ): string {
    const computedAt = new Date().toISOString();
    this.db.run(
      `INSERT INTO app_cache (app_id, panel_key, columns, rows, row_count, truncated, computed_at, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, panel_key) DO UPDATE SET
         columns = excluded.columns, rows = excluded.rows, row_count = excluded.row_count,
         truncated = excluded.truncated, computed_at = excluded.computed_at,
         error = excluded.error, duration_ms = excluded.duration_ms`,
      [
        appId,
        panelKey,
        JSON.stringify(data.columns ?? []),
        JSON.stringify(data.rows ?? []),
        data.rowCount ?? 0,
        data.truncated ? 1 : 0,
        computedAt,
        data.error ?? null,
        data.durationMs ?? null,
      ],
    );
    // Bound the cache per app: each panel/param VARIANT is a distinct panel_key,
    // so an open-domain param on a public link (?p.note=<random>) could otherwise
    // grow this table without limit. Keep the newest MAX_CACHE_ROWS_PER_APP rows
    // (by last write) and evict the rest. A re-view of an evicted variant just
    // recomputes; the default-params variant stays warm because viewing the app
    // re-stamps it. Only RUN the eviction sort when actually over the cap — the
    // count is a cheap PK-prefix scan, so the common (under-cap) write skips the
    // ORDER BY entirely instead of paying it on every single panel write.
    const cacheRows = (
      this.db.query("SELECT COUNT(*) AS n FROM app_cache WHERE app_id = ?").get(appId) as { n: number }
    ).n;
    if (cacheRows > MAX_CACHE_ROWS_PER_APP)
      this.db.run(
        `DELETE FROM app_cache WHERE app_id = ? AND panel_key NOT IN (
           SELECT panel_key FROM app_cache WHERE app_id = ? ORDER BY computed_at DESC LIMIT ?)`,
        [appId, appId, MAX_CACHE_ROWS_PER_APP],
      );
    return computedAt;
  }

  /** Edit a published app/report in place (same id/link) — author-gated
   *  upstream. Only provided fields change; id/createdBy/createdAt/visibility are
   *  preserved. Passing `panels` (incl. []) rewrites the panel set AND clears the
   *  panel cache (the old rows no longer apply). Returns false if the row is
   *  unknown or archived. */
  updatePublished(
    id: string,
    fields: {
      title?: string;
      body?: string;
      panels?: AppPanel[];
      params?: AppParam[];
      refreshSeconds?: number | null;
    },
    // Who is editing (for the version-history attribution), and an optional note
    // for non-linear versions (a revert records "Restored version N"). A
    // content change appends a new version snapshot.
    by: { editor: string; note?: string | null },
  ): boolean {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (fields.title !== undefined) {
      sets.push("title = ?");
      vals.push(fields.title);
    }
    if (fields.body !== undefined) {
      sets.push("body = ?");
      vals.push(fields.body);
    }
    if (fields.panels !== undefined) {
      const json = fields.panels.length ? JSON.stringify(fields.panels) : null;
      sets.push("panels = ?");
      vals.push(json);
    }
    if (fields.params !== undefined) {
      sets.push("params = ?");
      vals.push(fields.params.length ? JSON.stringify(fields.params) : null);
    }
    if (fields.refreshSeconds !== undefined) {
      sets.push("refresh_seconds = ?");
      vals.push(fields.refreshSeconds);
    }
    if (!sets.length) return true;
    vals.push(id);
    const changed =
      this.db.run(`UPDATE published SET ${sets.join(", ")} WHERE id = ? AND archived_at IS NULL`, vals).changes > 0;
    if (changed && fields.panels !== undefined)
      this.db.run("DELETE FROM app_cache WHERE app_id = ?", [id]);
    // Record the resulting state as a new version (append-only history, #58).
    if (changed) this.snapshotAppVersion(id, by.editor, new Date().toISOString(), by.note);
    return changed;
  }

  /** Restore an archived report/app (clear the soft-delete) — and reset it to
   *  team-only. A previously-PUBLIC app must NOT silently come back on its
   *  credential-free link; re-going-public is a fresh admin action (I9). Returns
   *  false if unknown or not currently archived. */
  unarchivePublished(id: string): boolean {
    return (
      this.db.run(
        "UPDATE published SET archived_at = NULL, visibility = 'team' WHERE id = ? AND archived_at IS NOT NULL",
        [id],
      ).changes > 0
    );
  }

  /** Newest cached panel computed_at for an app (the "data updated" stamp), read
   *  straight from the cache WITHOUT re-running any query. Counts only SUCCESSFUL
   *  panels — an errored row is stamped with the (now) failure time, which would
   *  otherwise read as "updated just now" while the data is actually stale/broken. */
  newestPanelComputedAt(id: string): string | null {
    const row = this.db
      .query("SELECT MAX(computed_at) AS t FROM app_cache WHERE app_id = ? AND error IS NULL")
      .get(id) as { t: string | null } | null;
    return row?.t ?? null;
  }

  /** Set a report's visibility (team ↔ public). Returns false for an unknown or
   *  archived report. Promoting to public is an admin action (enforced upstream). */
  setReportVisibility(id: string, visibility: ReportVisibility): boolean {
    return (
      this.db.run("UPDATE published SET visibility = ? WHERE id = ? AND archived_at IS NULL", [
        visibility,
        id,
      ]).changes > 0
    );
  }

  get empty(): boolean {
    const row = this.db.query("SELECT count(*) AS n FROM docs").get() as {
      n: number;
    };
    return row.n === 0;
  }
}

/**
 * One-time seed: import `.setoku/context/` markdown files (and any legacy
 * corrections.jsonl) into the store. Files remain untouched — they're an
 * interchange/seed format; the DB is the live store.
 */
export function seedFromFiles(
  store: KnowledgeStore,
  projectDir: string,
): number {
  const ctx = path.join(setokuDir(projectDir), "context");
  let imported = 0;
  const importDir = (dir: string, type: DocType) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const { meta, body } = parseFrontmatter(
        fs.readFileSync(path.join(dir, f), "utf8"),
      );
      const name =
        typeof meta.name === "string" && meta.name
          ? meta.name
          : f.replace(/\.md$/, "");
      store.upsertDoc({ type, name, meta, body: body.trim() }, "import");
      imported++;
    }
  };
  importDir(path.join(ctx, "entities"), "entity");
  importDir(path.join(ctx, "metrics"), "metric");
  importDir(path.join(ctx, "queries"), "query");
  const overview = path.join(ctx, "overview.md");
  if (fs.existsSync(overview)) {
    const { meta, body } = parseFrontmatter(fs.readFileSync(overview, "utf8"));
    store.upsertDoc(
      { type: "overview", name: "overview", meta, body: body.trim() },
      "import",
    );
    imported++;
  }
  const gotchasFile = path.join(ctx, "gotchas.md");
  if (fs.existsSync(gotchasFile)) {
    let i = 0;
    for (const line of fs.readFileSync(gotchasFile, "utf8").split("\n")) {
      const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (m) {
        store.upsertDoc(
          {
            type: "gotcha",
            name: `gotcha-${String(++i).padStart(3, "0")}`,
            body: m[1],
          },
          "import",
        );
        imported++;
      }
    }
  }
  const legacyCorrections = path.join(
    setokuDir(projectDir),
    "corrections.jsonl",
  );
  if (fs.existsSync(legacyCorrections)) {
    for (const line of fs.readFileSync(legacyCorrections, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        store.addCorrection({
          user: r.user ?? "import",
          kind: r.kind ?? "other",
          content: r.content ?? "",
          relatesTo: r.relatesTo,
        });
      } catch {
        /* skip malformed */
      }
    }
  }
  return imported;
}

function rowToProvisioning(
  row: Record<string, unknown>,
): ProvisioningLogEntry {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(String(row.detail ?? "{}"));
  } catch {
    /* tolerate */
  }
  return {
    id: Number(row.id),
    ts: String(row.ts),
    source: row.source as ProvisioningSource,
    stepKind: String(row.step_kind),
    idempotencyKey: String(row.idempotency_key),
    status: row.status as ProvisioningStatus,
    detail,
    actor: String(row.actor),
  };
}

function rowToCorrection(row: Record<string, unknown>): Correction {
  const parse = <T>(raw: unknown, fallback: T): T => {
    if (typeof raw !== "string" || !raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  const base: CorrectionBase = {
    id: Number(row.id),
    ts: String(row.ts),
    user: String(row.user),
    kind: String(row.kind),
    content: String(row.content ?? ""),
    fact: (row.fact as string) ?? null,
    relatesTo: (row.relates_to as string) ?? null,
  };
  const status = row.status as CorrectionStatus;
  if (status === "rejected")
    return {
      ...base,
      status,
      // rejectCorrection always sets a reason; default keeps the type honest.
      rejectReason: (row.reject_reason as string) ?? "",
      rejectedByBot: !!row.rejected_by_bot,
    };
  if (status === "accepted") return { ...base, status };
  const draftName = row.draft_name as string | null;
  const draft: CorrectionDraft | null =
    row.draft_type && draftName
      ? {
          type: row.draft_type as DocType,
          name: String(draftName),
          body: String(row.draft_body ?? ""),
          meta: parse<Record<string, string | string[]>>(row.draft_meta, {}),
        }
      : null;
  return {
    ...base,
    status: "pending",
    draft,
    flags: parse<string[]>(row.flags, []),
    draftedBy: (row.drafted_by as string) ?? null,
    draftedTs: (row.drafted_ts as string) ?? null,
  };
}

function rowToDoc(row: Record<string, unknown>): KnowledgeDoc {
  let meta: Record<string, string | string[]> = {};
  try {
    meta = JSON.parse(String(row.meta ?? "{}"));
  } catch {
    /* tolerate */
  }
  return {
    type: row.type as DocType,
    name: String(row.name),
    meta,
    body: String(row.body ?? ""),
    verified: !!row.verified,
    updatedBy: (row.updated_by as string) ?? null,
    updatedAt: (row.updated_at as string) ?? null,
  };
}
