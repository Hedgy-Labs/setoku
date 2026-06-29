// SPDX-License-Identifier: Apache-2.0
/**
 * Per-app private datastore — an app's OWN state, isolated from every business
 * data source.
 *
 * The key property: an app can read the company's data (governed, read-only,
 * bound params — see lib/params.ts) but it CANNOT write there. The read-only
 * GRANT on the business DB stays absolute (I1). What an app gets instead is a
 * sandbox of its own — a gateway-owned SQLite KV store, keyed by app — where it
 * may freely persist state: annotations, todos, "reviewed" flags, poll votes,
 * draft scenarios. There is no code path from here to the business DB or lake;
 * the isolation is structural, not a policy we enforce by inspecting SQL.
 *
 * Why this keeps every invariant clean:
 *  - I1 untouched: business data sources are never written; this is a separate
 *    Database handle the app owns.
 *  - The membrane (I2/I9) untouched: app state is neither the lake (untrusted
 *    bulk text) nor curated knowledge (authority). Writing it commits nothing
 *    trusted and crosses no trust boundary — worst case an app corrupts its own
 *    state. So unlike curated writes, no per-write human gate is needed; the
 *    only human gate is publishing the app itself.
 *  - I4: app state is durable user data, like the lake — it lives in its OWN db
 *    file (apps.db, sibling to knowledge.db) so its backup/blast-radius story is
 *    independent and obvious.
 *
 * Isolation is enforced by the key shape: every op is scoped by
 * (app_id, scope, owner). `scope` is "app" (shared across everyone who opens the
 * app) or "viewer" (private to one identity) — so app A can't touch app B's
 * state, and one viewer can't read another's. There is no unscoped read.
 *
 * Reached from the no-network frame via the trusted shell (a postMessage bridge
 * → a session-gated state endpoint), never by the sandboxed template fetching
 * directly — same mediation pattern as the read params. This module is just the
 * storage layer; identity, scope policy, and rate limits live above it.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

/** "app" = shared across all viewers; "viewer" = private to one identity. */
export type StateScope = "app" | "viewer";

/** Per-value size ceiling. Keeps one entry from being a blob dump. */
export const MAX_VALUE_CHARS = 100_000;
/** Key length ceiling. */
export const MAX_KEY_CHARS = 256;
/** Distinct keys one owner may hold in one app. */
export const MAX_KEYS_PER_OWNER = 1_000;
/** Total stored chars (keys + values) one owner may hold in one app — the
 *  bounded-resource guard so a hammered app can't fill the disk. */
export const MAX_OWNER_CHARS = 5_000_000;

export class AppStoreQuotaError extends Error {}

export interface StateEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

/** Default location: sibling of knowledge.db, a separate file by design. */
export function defaultAppDbPath(knowledgeDbPath: string): string {
  return path.join(path.dirname(knowledgeDbPath), "apps.db");
}

export class AppStore {
  db: Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.db.run(`CREATE TABLE IF NOT EXISTS app_state (
      app_id TEXT NOT NULL,
      scope  TEXT NOT NULL,
      owner  TEXT NOT NULL,
      key    TEXT NOT NULL,
      value  TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, scope, owner, key)
    )`);
  }

  /** Owner string for an op: the identity for viewer scope, "" for app scope.
   *  Normalizing here means a caller can't accidentally leak across viewers by
   *  passing an identity on an app-scoped op. */
  private owner(scope: StateScope, identity: string | null): string {
    return scope === "viewer" ? (identity ?? "") : "";
  }

  /** Read one entry. Always scoped — there is no cross-app/cross-viewer read. */
  get(
    appId: string,
    scope: StateScope,
    identity: string | null,
    key: string,
  ): StateEntry | null {
    const row = this.db
      .query(
        "SELECT key, value, updated_at AS updatedAt FROM app_state WHERE app_id=? AND scope=? AND owner=? AND key=?",
      )
      .get(appId, scope, this.owner(scope, identity), key) as
      | { key: string; value: string; updatedAt: string }
      | undefined;
    if (!row) return null;
    return { key: row.key, value: JSON.parse(row.value), updatedAt: row.updatedAt };
  }

  /** List every entry this owner holds in this app. */
  list(appId: string, scope: StateScope, identity: string | null): StateEntry[] {
    const rows = this.db
      .query(
        "SELECT key, value, updated_at AS updatedAt FROM app_state WHERE app_id=? AND scope=? AND owner=? ORDER BY key",
      )
      .all(appId, scope, this.owner(scope, identity)) as {
      key: string;
      value: string;
      updatedAt: string;
    }[];
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value), updatedAt: r.updatedAt }));
  }

  /**
   * Upsert one entry. Enforces the per-value, per-key-count, and per-owner-total
   * caps BEFORE writing (an over-quota write throws and changes nothing). `now`
   * is injected so the caller controls the timestamp (and tests are stable).
   */
  set(
    appId: string,
    scope: StateScope,
    identity: string | null,
    key: string,
    value: unknown,
    now: string,
  ): StateEntry {
    if (key.length === 0 || key.length > MAX_KEY_CHARS)
      throw new AppStoreQuotaError(`key length must be 1..${MAX_KEY_CHARS}`);
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_VALUE_CHARS)
      throw new AppStoreQuotaError(`value exceeds ${MAX_VALUE_CHARS} chars`);

    const owner = this.owner(scope, identity);
    const existing = this.db
      .query("SELECT length(value) AS vlen FROM app_state WHERE app_id=? AND scope=? AND owner=? AND key=?")
      .get(appId, scope, owner, key) as { vlen: number } | undefined;

    const agg = this.db
      .query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(length(key)+length(value)),0) AS chars FROM app_state WHERE app_id=? AND scope=? AND owner=?",
      )
      .get(appId, scope, owner) as { n: number; chars: number };

    if (!existing && agg.n + 1 > MAX_KEYS_PER_OWNER)
      throw new AppStoreQuotaError(`too many keys (max ${MAX_KEYS_PER_OWNER})`);
    // Projected total = current − old entry's chars + new entry's chars.
    const oldChars = existing ? key.length + existing.vlen : 0;
    const projected = agg.chars - oldChars + key.length + serialized.length;
    if (projected > MAX_OWNER_CHARS)
      throw new AppStoreQuotaError(`storage quota exceeded (max ${MAX_OWNER_CHARS} chars)`);

    this.db.run(
      `INSERT INTO app_state (app_id, scope, owner, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, scope, owner, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [appId, scope, owner, key, serialized, now],
    );
    return { key, value, updatedAt: now };
  }

  /** Delete one entry. Returns whether a row was removed. */
  delete(
    appId: string,
    scope: StateScope,
    identity: string | null,
    key: string,
  ): boolean {
    const res = this.db.run(
      "DELETE FROM app_state WHERE app_id=? AND scope=? AND owner=? AND key=?",
      [appId, scope, this.owner(scope, identity), key],
    );
    return res.changes > 0;
  }

  /** Current usage for one owner in one app — for the quota UI and tests. */
  usage(
    appId: string,
    scope: StateScope,
    identity: string | null,
  ): { keys: number; chars: number } {
    const r = this.db
      .query(
        "SELECT COUNT(*) AS keys, COALESCE(SUM(length(key)+length(value)),0) AS chars FROM app_state WHERE app_id=? AND scope=? AND owner=?",
      )
      .get(appId, scope, this.owner(scope, identity)) as { keys: number; chars: number };
    return r;
  }
}
