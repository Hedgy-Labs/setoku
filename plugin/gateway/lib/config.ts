// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface DataSourceConfig {
  kind?: string;
  urlEnv?: string;
  envFile?: string;
  url?: string;
}

export interface LakeConfig {
  /** Env var holding the lake URL (default SETOKU_LAKE_URL), e.g. http://user:pass@clickhouse:8123/setoku */
  urlEnv?: string;
  url?: string;
}

export interface NotificationsConfig {
  /**
   * Env var holding a Slack-compatible incoming-webhook URL (a POST of
   * `{"text": "…"}`, the same shape deploy/monitor/alert.sh already uses).
   * Default SETOKU_NOTIFY_WEBHOOK. The URL embeds a secret, so — like every
   * other credential — config stores the env-var NAME, never the URL itself, so
   * it never reaches the model.
   */
  slackWebhookEnv?: string;
}

export interface SetokuConfig {
  /**
   * The business database — consumed by ingest/pg-mirror (which reads the
   * source and fills biz.*), NOT by the gateway: the gateway holds no
   * business-DB credential and its only query engine is ClickHouse. The
   * `envFile` here also anchors where the other resolvers look for env vars.
   * Table allow/deny lists live with pg-mirror (what gets mirrored IS the
   * table scope).
   */
  dataSource: DataSourceConfig;
  /** The bundled ClickHouse lake, target of run_query's `clickhouse` dialect (I5). */
  lake?: LakeConfig;
  /** Outbound activity notifications — Slack today, more channels later (issue #63). */
  notifications?: NotificationsConfig;
  rowCap: number;
  statementTimeoutMs: number;
  /** Optional override for the knowledge-store SQLite path (absolute, or relative to the project dir). */
  knowledgeDb?: string;
  /**
   * Short human name for THIS box (e.g. "campsh"), set during /onboard. Drives
   * the Claude Code connector name — `<slug>-setoku` — so a person who already
   * has a `setoku` connector (a demo box, a second deployment) doesn't collide.
   * Unset falls back to the bare `setoku` name.
   */
  name?: string;
}

/**
 * Slugify a box/business name for use in a connector name (a DNS-ish label):
 * lowercase, alnum runs joined by single dashes, edges trimmed. Returns "" for
 * empty/undefined so callers can fall back to a default.
 */
export function slugifyName(raw: string | undefined | null): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The Claude Code connector name for this box: `<slug>-setoku`, from
 * SETOKU_NAME (env) or config.name, else the bare `setoku`. `suffix` appends a
 * role for the operator-only connectors (e.g. "curator" → `<slug>-setoku-curator`).
 * Read live (not cached) so a name chosen during /onboard takes effect without
 * a restart.
 */
export function connectorName(projectDir: string, suffix = ""): string {
  const res = loadConfig(projectDir);
  const raw = process.env.SETOKU_NAME ?? (res.ok ? res.config.name : undefined);
  const slug = slugifyName(raw);
  const base = slug ? `${slug}-setoku` : "setoku";
  return suffix ? `${base}-${suffix}` : base;
}

export const DEFAULTS = {
  rowCap: 200,
  statementTimeoutMs: 15_000,
};

/**
 * Resolve the business-repo root: SETOKU_PROJECT_DIR env var, else walk up
 * from cwd looking for a `.setoku/` directory, else cwd.
 */
export function resolveProjectDir(): string {
  const fromEnv = process.env.SETOKU_PROJECT_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".setoku"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export function setokuDir(projectDir: string): string {
  return path.join(projectDir, ".setoku");
}

/** Minimal .env parser (KEY=value, ignores comments/blank lines, strips quotes). */
export function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export type ConfigResult =
  | { ok: true; config: SetokuConfig }
  | { ok: false; error: string };

/** Load .setoku/config.json. Never throws — the server must start in unconfigured repos (onboarding flow). */
export function loadConfig(projectDir: string): ConfigResult {
  const file = path.join(setokuDir(projectDir), "config.json");
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      error:
        `No Setoku config found (expected ${file}). ` +
        "Run the /setoku:onboard skill to set this repo up.",
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ok: true,
      config: { ...DEFAULTS, ...raw, dataSource: raw.dataSource ?? {} },
    };
  } catch (e) {
    return {
      ok: false,
      error: `Could not parse ${file}: ${(e as Error).message}`,
    };
  }
}

export type UrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Resolve the ClickHouse lake URL (run_query dialect "clickhouse") — the
 * gateway's ONLY data credential (no business-DB URL is ever resolved here).
 * Precedence: lake.url → env[lake.urlEnv|SETOKU_LAKE_URL] → project envFile.
 */
export function resolveLakeUrl(
  projectDir: string,
  config: SetokuConfig,
): UrlResult {
  const lake = config.lake ?? {};
  if (lake.url) return { ok: true, url: lake.url };
  const varName = lake.urlEnv ?? "SETOKU_LAKE_URL";
  if (process.env[varName]) return { ok: true, url: process.env[varName]! };
  const parsed = parseEnvFile(
    path.join(projectDir, config.dataSource?.envFile ?? ".env"),
  );
  if (parsed[varName]) return { ok: true, url: parsed[varName] };
  return {
    ok: false,
    error:
      `No lake configured: set ${varName} (e.g. http://user:pass@clickhouse:8123/setoku) ` +
      "or .setoku/config.json lake.urlEnv. The clickhouse dialect targets the bundled lake.",
  };
}

/**
 * Resolve the Slack incoming-webhook URL for activity notifications, WITHOUT
 * exposing it to the model. Mirrors resolveLakeUrl's precedence: env[varName]
 * (varName from config.notifications.slackWebhookEnv, default
 * SETOKU_NOTIFY_WEBHOOK) → project .env file. Returns null when no webhook is
 * configured — notifications are opt-in, so an unset webhook is not an error,
 * just a silent no-op.
 */
export function resolveNotifyWebhook(
  projectDir: string,
  config: SetokuConfig,
): string | null {
  const varName = config.notifications?.slackWebhookEnv ?? "SETOKU_NOTIFY_WEBHOOK";
  if (process.env[varName]) return process.env[varName]!;
  const parsed = parseEnvFile(
    path.join(projectDir, config.dataSource?.envFile ?? ".env"),
  );
  return parsed[varName] ?? null;
}

/** Identity for audit attribution: SETOKU_USER env → git config user.email → "unknown". */
export function resolveUser(projectDir: string): string {
  if (process.env.SETOKU_USER) return process.env.SETOKU_USER;
  try {
    const email = execSync("git config user.email", {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
      .toString()
      .trim();
    if (email) return email;
  } catch {
    /* not a git repo or git missing */
  }
  return "unknown";
}

