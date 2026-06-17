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

export interface Correction {
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
  status: "pending" | "accepted" | "rejected";
}

/** A local account for the web admin surface (Phase 5.1). */
export interface Account {
  username: string;
  /** argon2id hash (Bun.password) — never the plaintext. */
  pwhash: string;
  role: string;
  createdAt: string;
  createdBy: string | null;
}

/** One row of the append-only audit log (the 5.6 page). */
export interface AuditRow {
  ts: string;
  user: string | null;
  tool: string;
  payload: string;
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
    this.db.run(`CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      user TEXT,
      tool TEXT NOT NULL,
      payload TEXT
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

  listCorrections(status: string = "pending"): Correction[] {
    const rows = this.db
      .query(
        "SELECT id, ts, user, kind, content, fact, relates_to AS relatesTo, status FROM corrections WHERE status = ? ORDER BY id",
      )
      .all(status) as unknown as Correction[];
    return rows;
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

  /** Create a local account (Phase 5.1). pwhash must already be argon2id. */
  createAccount(rec: {
    username: string;
    pwhash: string;
    role: string;
    createdBy?: string;
  }): void {
    this.db.run(
      "INSERT INTO accounts (username, pwhash, role, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
      [
        rec.username,
        rec.pwhash,
        rec.role,
        new Date().toISOString(),
        rec.createdBy ?? null,
      ],
    );
  }

  getAccount(username: string): Account | null {
    return (this.db
      .query(
        "SELECT username, pwhash, role, created_at AS createdAt, created_by AS createdBy FROM accounts WHERE username = ?",
      )
      .get(username) as unknown as Account) ?? null;
  }

  listAccounts(): Omit<Account, "pwhash">[] {
    return this.db
      .query(
        "SELECT username, role, created_at AS createdAt, created_by AS createdBy FROM accounts ORDER BY username",
      )
      .all() as unknown as Omit<Account, "pwhash">[];
  }

  get accountCount(): number {
    return (this.db.query("SELECT count(*) AS n FROM accounts").get() as { n: number }).n;
  }

  setPassword(username: string, pwhash: string): boolean {
    return (
      this.db.run("UPDATE accounts SET pwhash = ? WHERE username = ?", [
        pwhash,
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
    ];
    const ph = MCP_TOOLS.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT DISTINCT user FROM audit WHERE tool IN (${ph})`)
      .all(...MCP_TOOLS) as { user: string }[];
    return new Set(rows.map((r) => r.user));
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

  destroySession(sid: string): void {
    this.db.run("DELETE FROM sessions WHERE sid = ?", [sid]);
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
