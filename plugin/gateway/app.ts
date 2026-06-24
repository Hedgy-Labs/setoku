// SPDX-License-Identifier: Apache-2.0
/**
 * Setoku gateway tool surface. One transport: HTTP (http.ts), the deployed box.
 * buildServer() binds an identity + capabilities per request from the token —
 * analyst tokens are propose-only and may read the lake; curator tokens may
 * commit curated knowledge but not read the lake (canWrite / denyLakeRead).
 */
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  loadConfig,
  resolveDatabaseUrl,
  resolveLakeUrl,
  type SetokuConfig,
} from "./lib/config";
import { diagnoseNoTables, introspectSchema } from "./lib/db";
import { runLakeQuery } from "./lib/lake";
import { matchByTokens, matchGotchas, scoreDocs } from "./lib/search";
import { KnowledgeStore, type DashboardPanel, type DocType } from "./lib/store";
import { MAX_PANELS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS, DEFAULT_REFRESH_SECONDS, runPanel } from "./lib/dashboards";
import { lintDashboardTemplate } from "./lib/dashboard-runtime";
import { LAKE_SOURCES } from "./lib/sources";
import { VERSION } from "./lib/version";

export interface GatewayDeps {
  projectDir: string;
  store: KnowledgeStore;
  user: string;
  /**
   * Whether to expose the curated-write tools (upsert_context,
   * resolve_correction). FALSE = propose-only: the agent surface is read
   * tools + report_correction, whose proposals are inert (pending) until a
   * human accepts them. This is the membrane (I2/I9): an agent reading
   * untrusted lake/Slack content is prompt-injectable, so it must not hold a
   * tool that COMMITS curated knowledge — injection attacks the agent's
   * decision, not its credential. Analyst tokens are always propose-only;
   * `canWrite` is granted only to a separate **curator token**, which is in
   * turn forbidden from reading the lake (see `denyLakeRead`). The two
   * capabilities — commit knowledge, read untrusted bulk text — never coexist
   * on one session, by enforcement. The human accept path is the web approval
   * surface; curator tokens drive /setoku:generate and /setoku:curate.
   */
  canWrite: boolean;
  /**
   * Block `run_query` on the `clickhouse` dialect (the lake). Set TRUE for
   * curator sessions: a session that can COMMIT curated knowledge must not be
   * able to READ the bulk, attacker-controlled free text in the lake — that
   * removes the injection vector that could weaponize the write tools. Curator
   * sessions read only the business Postgres (to validate metric SQL) and the
   * agent's own codebase (outside the gateway). Analyst sessions are the
   * inverse: they read the lake but hold no write tool.
   */
  denyLakeRead: boolean;
  /**
   * Expose `draft_correction` — a DRAFT-ONLY capability (curation-cockpit piece
   * B). It writes a drafted doc-edit + advisory flags onto a pending correction
   * but touches NO curated doc: a draft grants zero authority. This is the
   * auto-draft janitor's only write. Crucially it is NOT `upsert_context`: even
   * though the drafting agent reads untrusted pending content, the worst it can
   * do is propose a draft a human must still bless. Granted to the janitor
   * token, never the analyst (no write at all) or the curator (commits directly).
   */
  canDraft?: boolean;
  /**
   * Expose `reject_correction` — a REJECT-ONLY capability (curation-cockpit piece
   * C). It resolves a pending correction to `rejected` and nothing else: removing
   * from the queue grants no authority (unlike accept, which commits knowledge —
   * deliberately NOT an MCP tool). Splitting reject out of the accept-or-reject
   * space is the whole safety argument; the janitor holds this, never accept.
   */
  canReject?: boolean;
}

export function buildServer({
  projectDir,
  store,
  user,
  canWrite,
  denyLakeRead,
  canDraft = false,
  canReject = false,
}: GatewayDeps): McpServer {
const server = new McpServer({ name: "setoku", version: VERSION });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const errorText = (s: string) => ({
  content: [{ type: "text" as const, text: s }],
  isError: true,
});

function requireConfig(): SetokuConfig {
  const res = loadConfig(projectDir);
  if (!res.ok) throw new Error(res.error);
  return res.config;
}

function requireDb(config: SetokuConfig): string {
  const res = resolveDatabaseUrl(projectDir, config);
  if (!res.ok) throw new Error(res.error);
  return res.url;
}

const NO_KNOWLEDGE_HINT =
  "No curated knowledge yet — answers rely on raw schema only and may be wrong " +
  "(test accounts not excluded, etc.); say so. Build context with /setoku:generate " +
  "or report_correction; both work on this (analyst) connector and land as pending " +
  "for a human to approve. (upsert_context commits directly but needs a curator connector.)";

/* ------------------------------ context tools ------------------------------ */

server.registerTool(
  "find_context",
  {
    annotations: { readOnlyHint: true },
    title: "Find business context (verified + unverified)",
    description:
      "ALWAYS call this FIRST — the instant a data/business question arrives, before any planning, " +
      "schema exploration, or reasoning about what a term means. Those are exactly what this returns, " +
      "so deliberating before calling it is wasted effort and the main cause of a slow, 'thinking for " +
      "a long time' feel; call it immediately with the question, THEN reason over what comes back. " +
      "Retrieves verified business context (entity semantics, canonical metric definitions, known-good " +
      "queries, gotchas, and pending unverified team knowledge) for a natural-language question. Trust " +
      "this context over your own inference from table/column names — it encodes how this business " +
      "actually computes things.",
    inputSchema: {
      question: z
        .string()
        .describe("The user's question, verbatim or lightly normalized"),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe("Max docs to return (default 5)"),
    },
  },
  async ({ question, max_results }) => {
    const started = Date.now();
    const allDocs = store.listDocs();
    const docs = allDocs.filter((d) => d.type !== "gotcha");
    const gotchaDocs = allDocs.filter((d) => d.type === "gotcha");
    const gotchas = gotchaDocs.map((d) => d.body || d.name);
    const pending = matchByTokens(
      store.listCorrections("pending"),
      (c) => `${c.fact ?? c.content} ${c.relatesTo ?? ""}`,
      question,
    ).slice(0, 5);
    const out: string[] = [];
    const matchedGotchas = matchGotchas(gotchas, question);
    if (matchedGotchas.length) {
      out.push("## Gotchas (read carefully — these prevent wrong answers)");
      for (const g of matchedGotchas) out.push(`- ${g}`);
      out.push("");
    }
    if (pending.length) {
      out.push(
        "## Unverified team knowledge (pending curation — treat as likely true; attribute it when used)",
      );
      for (const c of pending) {
        // surface the concise fact; the supporting context stays in curation
        out.push(
          `- ${c.fact ?? c.content} (${c.user}, ${c.ts.slice(0, 10)}${c.relatesTo ? `, re: ${c.relatesTo}` : ""})`,
        );
      }
      out.push("");
    }
    const top = scoreDocs(docs, question).slice(0, max_results ?? 5);
    if (docs.length === 0 && !pending.length) {
      store.audit(user, "find_context", {
        question,
        results: 0,
        ms: Date.now() - started,
      });
      return text(NO_KNOWLEDGE_HINT);
    }
    if (top.length === 0) {
      out.push(
        pending.length
          ? // we already surfaced unverified knowledge above — don't then claim there's none
            "No committed context docs yet — rely on the unverified team knowledge above (treat as likely true; attribute it), and capture anything the user clarifies with report_correction."
          : "No matching context docs. Proceed with get_schema, state your assumptions explicitly in the answer, " +
              "and use report_correction to capture anything the user clarifies.",
      );
    }
    for (const { doc } of top) {
      out.push(`## [${doc.type}] ${doc.name}`);
      if (doc.meta.table) out.push(`table: ${doc.meta.table}`);
      if (doc.meta.summary) out.push(String(doc.meta.summary));
      if (doc.body.length <= 1500) {
        out.push("", doc.body, "");
      } else {
        out.push(
          "",
          doc.body.slice(0, 600) + " …",
          `(truncated — call ${doc.type === "metric" ? `get_metric("${doc.name}")` : `describe_entity("${doc.name}")`} for the full doc)`,
          "",
        );
      }
    }
    // record the knowledge actually surfaced (docs + matched gotchas), by name,
    // so per-doc usage can be tallied from the audit log.
    const matchedSet = new Set(matchedGotchas);
    const surfaced = [
      ...top.map((t) => t.doc.name),
      ...gotchaDocs.filter((d) => matchedSet.has(d.body || d.name)).map((d) => d.name),
    ];
    store.audit(user, "find_context", {
      question,
      results: top.length,
      gotchas: matchedGotchas.length,
      unverified: pending.length,
      docs: surfaced,
      ms: Date.now() - started,
    });
    return text(out.join("\n"));
  },
);

server.registerTool(
  "list_entities",
  {
    annotations: { readOnlyHint: true },
    title: "List documented business entities",
    description:
      "Lists every documented entity, metric, and canonical query in the knowledge store " +
      "(name + one-line summary). Cheap index — use it to discover what context exists.",
    inputSchema: {},
  },
  async () => {
    const docs = store.listDocs();
    const pendingCount = store.pendingCount;
    // Only truly empty (no committed docs AND no pending proposals) shows the
    // "nothing here yet" hint. With pending proposals present we fall through so
    // the "# pending corrections" section below actually surfaces them.
    if (docs.length === 0 && pendingCount === 0) return text(NO_KNOWLEDGE_HINT);
    const lines: string[] = [];
    if (docs.length === 0)
      lines.push(
        "No committed knowledge yet — only unverified proposals (below). Curate them to make them count.",
        "",
      );
    const sections: [DocType, string][] = [
      ["overview", "overview"],
      ["entity", "entities"],
      ["metric", "metrics"],
      ["query", "canonical queries"],
    ];
    for (const [type, label] of sections) {
      const ofType = docs.filter((d) => d.type === type);
      if (!ofType.length) continue;
      lines.push(`# ${label}`);
      for (const d of ofType) {
        const summary = d.meta.summary ?? d.meta.question ?? "";
        lines.push(
          `- ${d.name}${d.meta.table ? ` (${d.meta.table})` : ""}${summary ? ` — ${summary}` : ""}`,
        );
      }
    }
    const gotchaCount = docs.filter((d) => d.type === "gotcha").length;
    if (gotchaCount)
      lines.push(
        "# gotchas",
        `${gotchaCount} recorded — surfaced automatically by find_context.`,
      );
    const pending = store.listCorrections("pending").length;
    if (pending)
      lines.push(
        "# pending corrections",
        `${pending} awaiting curation (/setoku:curate).`,
      );
    store.audit(user, "list_entities", {});
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "describe_entity",
  {
    annotations: { readOnlyHint: true },
    title: "Full context doc for one entity",
    description:
      "Returns the complete context document for one entity (or query/overview) by name or table.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const doc = store.getDoc(null, name);
    store.audit(user, "describe_entity", { name, ok: !!doc });
    if (!doc)
      return errorText(
        `No context doc named "${name}". Call list_entities to see what exists.`,
      );
    const head = [`# [${doc.type}] ${doc.name}`];
    for (const [k, v] of Object.entries(doc.meta))
      head.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    if (doc.updatedBy)
      head.push(
        `last updated: ${doc.updatedBy}, ${doc.updatedAt?.slice(0, 10) ?? ""}`,
      );
    return text([...head, "", doc.body].join("\n"));
  },
);

server.registerTool(
  "get_metric",
  {
    annotations: { readOnlyHint: true },
    title: "Canonical metric definition",
    description:
      "Returns the canonical, human-verified definition of a business metric, including the exact SQL. " +
      "If a metric exists for the user's question, USE ITS SQL as the basis for your query instead of inventing logic.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const doc = store.getDoc("metric", name);
    store.audit(user, "get_metric", { name, ok: !!doc });
    if (!doc) {
      const known =
        store
          .listDocs()
          .filter((d) => d.type === "metric")
          .map((m) => m.name)
          .join(", ") || "(none documented yet)";
      return errorText(`No metric "${name}". Known metrics: ${known}`);
    }
    return text(
      `# [metric] ${doc.name}\n${doc.meta.summary ?? ""}\n\n${doc.body}`,
    );
  },
);

server.registerTool(
  "report_correction",
  {
    annotations: { readOnlyHint: false, destructiveHint: false },
    title: "Record a context correction / clarification",
    description:
      "Records a candidate addition or correction to the knowledge store (a new gotcha, a metric " +
      "definition the user clarified, an entity annotation fix). Call this whenever the user corrects you or " +
      "resolves an ambiguity — that's how the whole team's answers improve. The candidate is live immediately " +
      "as unverified knowledge; a curator later promotes or rejects it via /setoku:curate.\n\n" +
      "Split what you record: `fact` is the SINGLE concise claim worth storing (one sentence, no reasoning); " +
      "`context` is the supporting evidence / where you saw it — shown to the curator but NOT stored as the fact. " +
      "Keep the fact tight; put the 'why' in context.\n\n" +
      "ALWAYS set `relates_to` to the entity or metric this is about (e.g. \"revenue\", \"Customer\") — it's how " +
      "the knowledge gets organized by subject and how conflicts with existing facts are detected. Only omit it " +
      "for a genuinely cross-cutting fact that belongs to no single entity/metric.",
    inputSchema: {
      kind: z.enum(["gotcha", "metric", "entity", "query", "other"]),
      fact: z
        .string()
        .describe(
          "The single concise claim to store (one sentence; no reasoning or evidence)",
        ),
      context: z
        .string()
        .optional()
        .describe(
          "Supporting evidence / how you learned it — shown to the curator, not stored as the fact",
        ),
      relates_to: z
        .string()
        .optional()
        .describe(
          "The entity or metric name this fact is about (e.g. \"revenue\", \"Customer\"). Set this whenever the " +
            "fact is about a specific entity/metric — it organizes the knowledge by subject and powers conflict detection.",
        ),
    },
  },
  async ({ kind, fact, context, relates_to }) => {
    const id = store.addCorrection({
      user,
      kind,
      fact,
      context,
      relatesTo: relates_to,
    });
    store.audit(user, "report_correction", { id, kind });
    return text(
      `Recorded as pending correction #${id} (attributed to ${user}). It is live immediately as unverified ` +
        "knowledge in find_context; a curator promotes or rejects it via /setoku:curate.",
    );
  },
);

server.registerTool(
  "list_corrections",
  {
    annotations: { readOnlyHint: true },
    title: "List pending knowledge corrections",
    description:
      "Lists corrections awaiting curation (id, author, kind, content). Used by the /setoku:curate workflow.",
    inputSchema: {
      status: z
        .enum(["pending", "accepted", "rejected"])
        .optional()
        .describe("Default: pending"),
    },
  },
  async ({ status }) => {
    const rows = store.listCorrections(status ?? "pending");
    store.audit(user, "list_corrections", {
      status: status ?? "pending",
      count: rows.length,
    });
    if (!rows.length) return text(`No ${status ?? "pending"} corrections.`);
    return text(
      rows
        .map((c) => {
          const head = `#${c.id} [${c.kind}] ${c.fact ?? c.content} (${c.user}, ${c.ts.slice(0, 10)}${c.relatesTo ? `, re: ${c.relatesTo}` : ""})`;
          // show supporting context only when it adds beyond the fact
          return c.fact && c.content && c.content !== c.fact
            ? `${head}\n    context: ${c.content}`
            : head;
        })
        .join("\n"),
    );
  },
);

// Curated-write tools — the membrane (I2/I9). Registered ONLY in curator
// mode; the propose-only analyst surface (report_correction) is the single
// write path for any agent that reads untrusted data. See GatewayDeps.canWrite.
if (canWrite) {
server.registerTool(
  "resolve_correction",
  {
    annotations: { readOnlyHint: false, destructiveHint: false },
    title: "Resolve a pending correction (curator)",
    description:
      "Marks a pending correction accepted or rejected. Curation workflow: on accept, ALSO fold the knowledge " +
      "into the store via upsert_context (a gotcha bullet, a metric doc, an entity edit) — resolving alone only " +
      "updates the queue status.",
    inputSchema: {
      id: z.number().int(),
      action: z.enum(["accepted", "rejected"]),
    },
  },
  async ({ id, action }) => {
    const ok = store.resolveCorrection(id, action, user);
    store.audit(user, "resolve_correction", { id, action, ok });
    return ok
      ? text(`Correction #${id} ${action}.`)
      : errorText(`No pending correction #${id}.`);
  },
);

server.registerTool(
  "upsert_context",
  {
    annotations: { readOnlyHint: false, destructiveHint: false },
    title: "Create or update a knowledge doc (generate/curate workflows)",
    description:
      "Writes a context document into the knowledge store: entity, metric, query, overview, or gotcha. " +
      "Used by the /setoku:generate and /setoku:curate workflows — do NOT use it mid-analysis to record " +
      "unreviewed beliefs (use report_correction for that). Attribution and a revision history are kept automatically. " +
      "For entities pass meta.table (e.g. public.orders), meta.summary, meta.keywords. For metrics include the " +
      "canonical SQL in the body. For gotchas put the one-liner in body (name can be a short slug).",
    inputSchema: {
      type: z.enum(["entity", "metric", "query", "overview", "gotcha"]),
      name: z
        .string()
        .describe("Doc name (entity/metric name, or a short slug for gotchas)"),
      body: z.string().describe("Markdown body (the full doc content)"),
      meta: z
        .record(z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe(
          "Frontmatter-style fields: table, summary, keywords, question, sources",
        ),
    },
  },
  async ({ type, name, body, meta }) => {
    store.upsertDoc({ type, name, meta: meta ?? {}, body }, user);
    store.audit(user, "upsert_context", { type, name });
    return text(
      `Saved [${type}] ${name} to the knowledge store (attributed to ${user}; revision recorded).`,
    );
  },
);
} // end canWrite

// Draft-only capability (curation-cockpit piece B). Registered ONLY for the
// auto-draft janitor token. It writes a DRAFT onto a pending correction —
// never a curated doc — so even though the drafting agent reads untrusted
// pending content, it holds no tool that commits authority (the membrane).
if (canDraft) {
server.registerTool(
  "draft_correction",
  {
    annotations: { readOnlyHint: false, destructiveHint: false },
    title: "Attach a drafted doc-edit to a pending correction (auto-draft)",
    description:
      "Writes a DRAFT — the exact upsert payload approving the correction would commit — plus advisory FLAGS " +
      "onto a pending correction, so the human curator reviews a finished change instead of a raw note. This " +
      "COMMITS NOTHING to curated knowledge and does not resolve the correction; a draft grants no authority. " +
      "Workflow (the auto-draft job): read the correction + its related doc (get_metric/describe_entity) + " +
      "get_schema, produce the doc-edit, lint the drafted SQL with run_query, then call this with the draft and " +
      "the flags you found (e.g. \"lint\" if the SQL ran clean, \"dupe\"/\"contradiction\" if it clashes with " +
      "existing knowledge). The accept stays a human click on /admin.",
    inputSchema: {
      id: z.number().int().describe("The pending correction id to draft"),
      type: z.enum(["entity", "metric", "query", "overview", "gotcha"]),
      name: z.string().describe("Doc name the draft would upsert (entity/metric name, or gotcha slug)"),
      body: z.string().describe("The full drafted doc body (for a metric, the canonical SQL)"),
      meta: z
        .record(z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe("Frontmatter fields: table, summary, keywords, relates_to, expect, unit"),
      flags: z
        .array(z.string())
        .optional()
        .describe('Advisory flags: "lint" (SQL ran clean), "dupe", "contradiction", "provenance"'),
    },
  },
  async ({ id, type, name, body, meta, flags }) => {
    const corr = store.getCorrection(id);
    if (!corr) return errorText(`No correction #${id}.`);
    if (corr.status !== "pending") return errorText(`#${id} is ${corr.status}, not pending — cannot draft.`);
    const ok = store.draftCorrection(id, { type, name, body, meta: meta ?? {} }, flags ?? [], user);
    store.audit(user, "draft_correction", { id, type, name, flags: flags ?? [] });
    return ok
      ? text(`Drafted [${type}] ${name} onto correction #${id} (flags: ${(flags ?? []).join(", ") || "none"}). Commits nothing — a human approves it on /admin.`)
      : errorText(`Could not draft #${id} (already resolved?).`);
  },
);
} // end canDraft

// Reject-only capability (curation-cockpit piece C). The one load-bearing auth
// addition: it can ONLY move a pending correction to rejected — never accept,
// never commit. The reject is soft (the row is kept), audited, and marked
// rejected_by_bot so the cockpit can surface and reverse it, making a janitor
// that suppresses good proposals detectable and undoable.
if (canReject) {
server.registerTool(
  "reject_correction",
  {
    annotations: { readOnlyHint: false, destructiveHint: false },
    title: "Auto-reject a pending correction (janitor, reject-only)",
    description:
      "Rejects a pending correction — queue status only, grants ZERO knowledge authority. Use ONLY for items " +
      "that fail OBJECTIVE checks: drafted SQL errors, references a denied table, malformed, an exact duplicate " +
      "of existing curated knowledge, or contradicts a TRUSTED source (the code/schema). LEAVE anything " +
      "semantic or uncertain pending for a human. The reject is soft and reversible (a human can un-reject it " +
      "on /admin), and audited — so over-aggressive rejection is visible. Always pass a concrete `reason`.",
    inputSchema: {
      id: z.number().int(),
      reason: z.string().describe("Why it failed an objective check (recorded + shown in the cockpit)"),
    },
  },
  async ({ id, reason }) => {
    const corr = store.getCorrection(id);
    if (!corr) return errorText(`No correction #${id}.`);
    if (corr.status !== "pending") return errorText(`#${id} is ${corr.status}, not pending.`);
    const ok = store.rejectCorrection(id, reason, user, true);
    store.audit(user, "reject_correction", { id, reason, byBot: true });
    return ok
      ? text(`Rejected pending correction #${id} (soft + reversible): ${reason}. A human can un-reject it on /admin.`)
      : errorText(`Could not reject #${id} (already resolved?).`);
  },
);
} // end canReject

/* -------------------------------- data tools ------------------------------- */

server.registerTool(
  "list_sources",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    title: "List connected data sources (capabilities)",
    description:
      "Lists the data Setoku can actually query RIGHT NOW: the business database tables, the data-lake " +
      "tables (logs, product events, finance, chat) with what each holds, and the knowledge store. " +
      "Capabilities are DYNAMIC — what's connected on the box changes — so call this whenever you're " +
      "unsure whether Setoku has data for a question, BEFORE telling the user it isn't available. " +
      'Logs, errors, product events, finance, and chat live in the LAKE (query run_query with ' +
      'dialect:"clickhouse"), not the business Postgres.',
    inputSchema: {},
  },
  async () => {
    const lines: string[] = ["Data sources you can query right now:"];
    let config: SetokuConfig | null = null;
    try {
      config = requireConfig();
    } catch {
      /* no config — sections below report "not configured" */
    }

    // business database (Postgres)
    try {
      const db = config ? resolveDatabaseUrl(projectDir, config) : { ok: false as const, error: "" };
      if (config && db.ok) {
        const tables = await introspectSchema(db.url, config);
        const names = tables.map((t) => `${t.schema}.${t.name}`);
        if (names.length === 0) {
          const denied = await diagnoseNoTables(db.url);
          lines.push(
            "",
            denied
              ? `BUSINESS DATABASE (Postgres): configured but the read-only role can see no tables — ${denied}`
              : "BUSINESS DATABASE (Postgres): configured, but no tables match the allow-list (or the database is empty).",
          );
        } else {
          lines.push(
            "",
            `BUSINESS DATABASE (Postgres) — run_query, default dialect — ${names.length} tables:`,
            "  " + names.slice(0, 40).join(", ") + (names.length > 40 ? ", …" : "") + "  (get_schema for columns)",
          );
        }
      } else {
        lines.push("", "BUSINESS DATABASE: not configured.");
      }
    } catch (e) {
      lines.push("", `BUSINESS DATABASE: configured but unreachable (${String(e).slice(0, 120)}).`);
    }

    // data lake (ClickHouse). Curator sessions can't read the lake (membrane), so
    // we don't probe it there — list the known sources statically with a pointer.
    if (denyLakeRead) {
      lines.push(
        "",
        'DATA LAKE: a curator session can\'t read the lake. Switch to an analyst connector to query it (run_query dialect:"clickhouse"). Known lake sources:',
        ...LAKE_SOURCES.filter((s) => s.table !== "ingest_raw").map((s) => `  - ${s.table} — ${s.blurb}`),
      );
    } else {
      try {
        const lake = config ? resolveLakeUrl(projectDir, config) : { ok: false as const, error: "" };
        if (config && lake.ok) {
          // SHOW TABLES is metadata only (no row content); setoku_ro can run it.
          const res = await runLakeQuery(lake.url, "SHOW TABLES FROM setoku", {
            rowCap: 500,
            statementTimeoutMs: 8000,
          });
          const present = new Set(res.rows.map((r) => String(Object.values(r)[0] ?? "")));
          const known = LAKE_SOURCES.filter((s) => present.has(s.table));
          const extra = [...present].filter((t) => !LAKE_SOURCES.some((s) => s.table === t));
          if (known.length || extra.length) {
            lines.push("", 'DATA LAKE (ClickHouse) — run_query with dialect:"clickhouse" — tables:');
            for (const s of known) lines.push(`  - setoku.${s.table} — ${s.blurb}`);
            for (const t of extra) lines.push(`  - setoku.${t}`);
          } else {
            lines.push("", "DATA LAKE: configured but empty.");
          }
        } else {
          lines.push("", "DATA LAKE: not configured (no logs/events/finance lake on this box).");
        }
      } catch (e) {
        lines.push("", `DATA LAKE: configured but unreachable (${String(e).slice(0, 120)}).`);
      }
    }

    lines.push(
      "",
      `KNOWLEDGE STORE: ${store.docCount} curated docs — call find_context to retrieve what your data MEANS (definitions, gotchas, canonical SQL).`,
      "",
      'Reminder: logs, errors, product events, finance, and chat are in the LAKE — query them with dialect:"clickhouse", not Postgres.',
    );
    store.audit(user, "list_sources", {});
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "get_schema",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    title: "Live database schema (permission-scoped)",
    description:
      "Introspects the live Postgres schema, filtered to the tables this project's Setoku config allows. " +
      "With no arguments: compact list of all tables + column names. With `tables`: full detail " +
      "(types, primary keys, foreign keys) for those tables. Tables not listed here are off-limits — do not query them.",
    inputSchema: {
      tables: z
        .array(z.string())
        .optional()
        .describe(
          'Qualified or bare table names for full detail, e.g. ["public.orders"] or ["orders"]',
        ),
    },
  },
  async ({ tables }) => {
    const started = Date.now();
    try {
      const config = requireConfig();
      const url = requireDb(config);
      const schema = await introspectSchema(url, config, tables);
      const lines: string[] = [];
      if (tables?.length) {
        for (const t of schema) {
          lines.push(
            `# ${t.schema}.${t.name} (${t.type === "VIEW" ? "view" : "table"})`,
          );
          for (const c of t.columns) {
            const pk = t.pk.includes(c.name) ? " PK" : "";
            const fk = t.fks.find((f) => f.column === c.name);
            lines.push(
              `- ${c.name}: ${c.type}${c.nullable ? "" : " not null"}${pk}${fk ? ` → ${fk.references}` : ""}`,
            );
          }
          lines.push("");
        }
        if (!schema.length)
          lines.push(
            "No allowed tables matched. Call get_schema with no arguments to list allowed tables.",
          );
      } else if (schema.length === 0) {
        // 0 tables is ambiguous: empty allow-list vs revoked grants. Probe the
        // catalog so a permission wall reads as one, not as an empty database.
        const denied = await diagnoseNoTables(url);
        lines.push(denied ?? "0 allowed tables (the allow-list matched nothing, or the database is empty).");
      } else {
        lines.push(`${schema.length} allowed tables:`);
        for (const t of schema) {
          lines.push(
            `- ${t.schema}.${t.name}: ${t.columns.map((c) => c.name).join(", ")}`,
          );
        }
      }
      // drift note: knowledge entities vs live tables. Only meaningful against
      // the FULL schema — when `tables` filters the result, the unlisted tables
      // are absent by request, not drift, so skip it (avoids false "no live
      // table" warnings on filtered get_schema calls).
      const documented = new Set(
        store
          .listDocs()
          .filter((d) => d.type === "entity" && d.meta.table)
          .map((d) => String(d.meta.table).toLowerCase()),
      );
      if (documented.size && !tables?.length) {
        const live = new Set(
          schema.map((t) => `${t.schema}.${t.name}`.toLowerCase()),
        );
        const undocumented = [...live].filter((t) => !documented.has(t));
        const stale = [...documented].filter((t) => !live.has(t));
        if (stale.length) {
          lines.push(
            "",
            `⚠ context drift: documented entities with no live table: ${stale.join(", ")} — consider /setoku:generate.`,
          );
        }
        if (undocumented.length) {
          lines.push(
            "",
            `note: ${undocumented.length} live tables have no context doc yet (${undocumented.slice(0, 8).join(", ")}${undocumented.length > 8 ? ", …" : ""}).`,
          );
        }
      }
      store.audit(user, "get_schema", {
        tables: tables ?? null,
        ok: true,
        ms: Date.now() - started,
      });
      return text(lines.join("\n"));
    } catch (e) {
      const msg = (e as Error).message;
      store.audit(user, "get_schema", {
        tables: tables ?? null,
        ok: false,
        error: msg,
        ms: Date.now() - started,
      });
      return errorText(`get_schema failed: ${msg}`);
    }
  },
);

server.registerTool(
  "run_query",
  {
    annotations: { readOnlyHint: true, openWorldHint: true },
    title: "Run a read-only SQL query (capped + audited)",
    description:
      "Executes ONE read-only SQL statement, with a statement timeout and a row cap. Every call is audited " +
      "with your identity. Routes by dialect (metric docs declare theirs): `postgres` (default) runs against " +
      "the business database in a READ ONLY transaction; `clickhouse` runs against the bundled lake " +
      "(logs/events/Slack archive) with engine-enforced readonly. " +
      "Workflow: call find_context first, prefer canonical metric SQL via get_metric, include an explicit LIMIT, " +
      "and never SELECT * on wide tables. Writes/DDL are rejected. " +
      "Lake tables are discoverable with SHOW TABLES / DESCRIBE <table> on the clickhouse dialect.",
    inputSchema: {
      sql: z.string().describe("A single SELECT/WITH/EXPLAIN statement"),
      dialect: z
        .enum(["postgres", "clickhouse"])
        .optional()
        .describe(
          "Where to run it (default postgres = the business DB; clickhouse = the lake). Use the dialect the metric doc declares.",
        ),
      purpose: z
        .string()
        .optional()
        .describe(
          "One line on what business question this answers (goes in the audit log)",
        ),
    },
  },
  async ({ sql, dialect, purpose }) => {
    const started = Date.now();
    const sqlForAudit =
      sql && sql.length > 2000 ? sql.slice(0, 2000) + "…" : sql;
    try {
      const config = requireConfig();
      // Route + enforce the lake membrane (I2/I9) through the SAME helper the
      // dashboard panels use, so there is one gate, not two divergent copies.
      const result = await runPanel(
        projectDir,
        config,
        { key: "run_query", sql, dialect: dialect ?? "postgres" },
        { denyLakeRead },
      );
      store.audit(user, "run_query", {
        purpose: purpose ?? null,
        dialect: dialect ?? "postgres",
        sql: sqlForAudit,
        ok: true,
        rows: result.rowCount,
        truncated: result.truncated,
        ms: result.ms,
      });
      const lines: string[] = [];
      lines.push(result.columns.join(" | ") || "(no columns)");
      for (const row of result.rows) {
        lines.push(
          result.columns
            .map((c) => {
              const v = row[c];
              if (v === null || v === undefined) return "∅";
              const s =
                v instanceof Date
                  ? v.toISOString()
                  : typeof v === "object"
                    ? JSON.stringify(v)
                    : String(v);
              return s.length > 300 ? s.slice(0, 300) + "…" : s;
            })
            .join(" | "),
        );
      }
      lines.push(
        "",
        `${result.rowCount} row(s) in ${result.ms}ms${result.truncated ? ` — TRUNCATED at row cap (${config.rowCap}); add aggregation or LIMIT` : ""}`,
      );
      // No curated context yet → the agent is querying from raw schema, which is
      // exactly when it confidently returns a wrong number (test accounts not
      // excluded, refunds not netted, status-vs-event-log confusion). Make that
      // provisional state visible so the answer carries the caveat to the human.
      if (store.docCount === 0) {
        // Distinguish "nothing here at all" from "knowledge exists but is still
        // unverified" — otherwise the warning tells the agent to report_correction
        // the very gotcha it just filed (the "I did the right thing and nothing
        // changed" footgun).
        lines.unshift(
          store.pendingCount > 0
            ? "⚠ Business context for this data is UNVERIFIED — it exists only as pending proposals awaiting human approval. If your query applied the relevant pending knowledge the number should be right; either way call it provisional until a human approves it (/setoku:curate)."
            : "⚠ No curated business context exists yet, so this is computed from raw schema and may be WRONG (e.g. internal/test accounts not excluded, refunds not netted). Tell the user the number is provisional, and add context via /setoku:generate or report_correction.",
          "",
        );
      }
      return text(lines.join("\n"));
    } catch (e) {
      const msg = (e as Error).message;
      store.audit(user, "run_query", {
        purpose: purpose ?? null,
        dialect: dialect ?? "postgres",
        sql: sqlForAudit,
        ok: false,
        error: msg,
        ms: Date.now() - started,
      });
      return errorText(`run_query failed: ${msg}`);
    }
  },
);

/* ------------------------------ dashboards ----------------------------- */
// The agent publishes a DASHBOARD to the box and gets back a shareable URL. A
// dashboard splits presentation (a frozen, agent-authored template) from data
// (named panels, each a saved read-only query the box RE-RUNS live through the
// governed run_query path). The template reads results off window.__SETOKU__.
// A zero-panel dashboard is just a static report (back-compat).
//
// v0 is TEAM-ONLY: the link (/admin/p/<id>) is session-gated, so only people who
// hold a box login can view it — that's what keeps a (prompt-injectable) analyst
// session from turning publish into a public data-exfiltration channel. Promotion
// to a public /p/<id> link is a human click in /admin, never an agent action.
// The template runs in a sandboxed iframe under a no-network CSP (data is
// injected, not fetched), so it can't reach the admin cookie/API or exfiltrate.
// Available to every session (publishing neither commits curated knowledge nor,
// for the publish itself, is gated by I2/I9 — but a curator session can't author
// a clickhouse-dialect panel, see runPanel's membrane check).

const MAX_REPORT_BYTES = 2_000_000; // ~2 MB of template HTML; keep it self-contained, not an asset bundle

const mintShareId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// Where a published dashboard lives. SETOKU_PUBLIC_URL is the box's public origin
// (also used by the installer links); without it we return the path and tell the
// agent to prefix its box URL.
const publishBase = (process.env.SETOKU_PUBLIC_URL ?? "").replace(/\/+$/, "");
// Team dashboards live in the session-gated SPA (/admin/p/<id>); public ones serve
// credential-free at /p/<id>. The link an agent hands out follows visibility.
const publishUrl = (id: string, visibility: "team" | "public" = "team"): string => {
  const path = visibility === "public" ? `/p/${id}` : `/admin/p/${id}`;
  return publishBase ? `${publishBase}${path}` : path;
};

const PANEL_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

type PanelInput = { key: string; title?: string; sql: string; dialect?: "postgres" | "clickhouse"; metricId?: string };
type PanelSeed = { key: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number };

// Validate + dry-run a panel set through the governed path. Shared by publish and
// update so the rules (keys, caps, the I2/I9 lake membrane via runPanel, "every
// panel must run") can never drift between the two.
async function prepPanels(
  list: PanelInput[],
): Promise<{ ok: true; normalized: DashboardPanel[]; seeds: PanelSeed[] } | { ok: false; error: string }> {
  if (list.length > MAX_PANELS)
    return { ok: false, error: `Too many panels (${list.length} > ${MAX_PANELS}). Aggregate or split the dashboard.` };
  const keys = new Set<string>();
  for (const p of list) {
    if (!PANEL_KEY_RE.test(p.key ?? "")) return { ok: false, error: `Panel key "${p.key}" must be a 1–64 char slug ([A-Za-z0-9_-]).` };
    if (keys.has(p.key)) return { ok: false, error: `Duplicate panel key "${p.key}".` };
    keys.add(p.key);
    if (!p.sql?.trim()) return { ok: false, error: `Panel "${p.key}" has no sql.` };
  }
  const normalized: DashboardPanel[] = list.map((p) => ({
    key: p.key,
    title: p.title,
    sql: p.sql,
    dialect: p.dialect ?? "postgres",
    metricId: p.metricId ?? null,
  }));
  let config;
  try {
    config = requireConfig();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const seeds: PanelSeed[] = [];
  for (const p of normalized) {
    try {
      const r = await runPanel(projectDir, config, p, { denyLakeRead });
      seeds.push({ key: p.key, columns: r.columns, rows: r.rows, rowCount: r.rowCount });
    } catch (e) {
      return { ok: false, error: `Panel "${p.key}" failed to run: ${(e as Error).message}\nFix the query and try again.` };
    }
  }
  return { ok: true, normalized, seeds };
}

const clampRefresh = (refreshSeconds: number | undefined, hasPanels: boolean): number | null =>
  hasPanels
    ? Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(refreshSeconds ?? DEFAULT_REFRESH_SECONDS)))
    : null;

// Non-blocking warnings the agent can't see for itself (it publishes blind):
// missing curated metric links + static render-lint of the template.
function publishNotes(html: string, panels: DashboardPanel[]): string {
  const notes: string[] = [];
  const missing = panels.filter((p) => p.metricId && !store.getDoc("metric", String(p.metricId))).map((p) => p.metricId);
  if (missing.length)
    notes.push(`no curated metric named ${missing.map((m) => `"${m}"`).join(", ")} — that provenance link is dropped (document it with /setoku:generate or upsert_context).`);
  notes.push(...lintDashboardTemplate(html, panels.map((p) => p.key)));
  return notes.length ? `\n\n⚠ Heads up (publishes anyway):\n- ${notes.join("\n- ")}` : "";
}

const PANEL_SCHEMA = z.object({
  key: z.string().describe("Stable slug the template reads: window.__SETOKU__.panels[key]"),
  title: z.string().optional().describe("Human label for the provenance drawer"),
  sql: z.string().describe("A single read-only SELECT/WITH statement (validate with run_query first)"),
  dialect: z.enum(["postgres", "clickhouse"]).optional().describe("postgres (default) = business DB; clickhouse = the lake"),
  metricId: z.string().optional().describe("Name of a curated metric this panel computes — links provenance to the verified definition"),
});

const TEMPLATE_HELP =
  "Pass `html`: the presentation TEMPLATE — a self-contained HTML fragment (inline <style>/<script>, inline SVG; " +
  "NO external/CDN assets and NO network — data is injected, not fetched). A tested helper is preloaded: prefer " +
  "`Setoku.bar(targetElId, panelKey, {label, value, format})`, `Setoku.table`, `Setoku.stat`, `Setoku.line` over " +
  "hand-rolled SVG/CSS — they coerce numeric strings, size correctly, and render empty/error states. Raw data is " +
  "also at `window.__SETOKU__.panels[<key>]` = `{ columns, rows, rowCount, computedAt, error }` (DB numerics arrive " +
  "as STRINGS — wrap in Number() before any math).";

server.registerTool(
  "publish_dashboard",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    title: "Publish a live dashboard to the box (team-shareable URL)",
    description:
      "Publishes a dashboard backed by LIVE data and returns a shareable URL. Use this to SHARE a result with " +
      "the team as a link that stays current — not for answering in-session.\n" +
      TEMPLATE_HELP +
      "\nPass `panels`: the data bindings. Each panel's `sql` is a read-only query the box re-runs live (same path " +
      "as run_query — develop & validate it with run_query first). Set `dialect` to match. Set `metricId` to a " +
      "curated metric name to link its verified definition.\n" +
      "Omit `panels` for a static report. The link is TEAM-ONLY; an admin can later make it public. Every panel is " +
      "dry-run at publish (broken query → rejected). Edit later with update_dashboard (same link); also " +
      "list_dashboards / get_dashboard / unpublish_dashboard.",
    inputSchema: {
      title: z.string().describe("Short human title (shown in the box's Dashboards list)"),
      html: z.string().describe("The presentation template (self-contained HTML fragment; use the Setoku.* helpers)."),
      panels: z.array(PANEL_SCHEMA).optional().describe("Live data bindings. Omit for a static report."),
      refreshSeconds: z
        .number()
        .optional()
        .describe(`How often the box re-runs panels (default ${DEFAULT_REFRESH_SECONDS}, ${MIN_REFRESH_SECONDS}–${MAX_REFRESH_SECONDS})`),
    },
  },
  async ({ title, html, panels, refreshSeconds }) => {
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_REPORT_BYTES)
      return errorText(
        `Template is ${(bytes / 1e6).toFixed(1)} MB — over the ${MAX_REPORT_BYTES / 1e6} MB cap. Keep it a self-contained ` +
          "fragment; the live data arrives via panels, so don't embed bulk data in the template.",
      );
    const prep = await prepPanels(panels ?? []);
    if (!prep.ok) return errorText(prep.error);
    const { normalized, seeds } = prep;

    const id = mintShareId();
    const refresh = clampRefresh(refreshSeconds, normalized.length > 0);
    store.createPublished({
      id,
      title: title.trim() || "Untitled dashboard",
      body: html,
      panels: normalized,
      refreshSeconds: refresh,
      format: normalized.length ? "dashboard" : "html",
      createdBy: user,
    });
    for (const s of seeds)
      store.putPanelCache(id, s.key, { columns: s.columns, rows: s.rows, rowCount: s.rowCount, error: null });
    store.audit(user, "publish_dashboard", { id, title, bytes, panels: normalized.length });

    const noun = normalized.length ? "dashboard" : "report";
    return text(
      `Published "${title}" → ${publishUrl(id)}\n\n` +
        (normalized.length ? `${normalized.length} live panel(s); the box re-runs them every ${refresh}s. ` : "") +
        "This link is TEAM-ONLY: anyone you share it with must sign in to the box to view it. " +
        (publishBase ? "" : "(Prefix the path above with your box URL.) ") +
        `\n\nEdit it with update_dashboard("${id}", …) — same link. Manage: get_dashboard / unpublish_dashboard("${id}"). ` +
        `(An admin can make this ${noun} public from /admin.)` +
        publishNotes(html, normalized),
    );
  },
);

server.registerTool(
  "update_dashboard",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    title: "Edit a dashboard you published (in place, same link)",
    description:
      "Updates a dashboard you created — keeping its id and shareable link. Pass only what changes: `title`, `html` " +
      "(new template), `panels` (REPLACES the whole panel set — re-validated + dry-run), and/or `refreshSeconds`. " +
      "Only the dashboard's AUTHOR can edit it. " +
      "Note: changing `panels` on a dashboard that's currently public reverts it to team-only — an admin must " +
      "re-approve it for the public link, since the data it exposes changed. " +
      TEMPLATE_HELP,
    inputSchema: {
      id: z.string().describe("The dashboard id (from publish_dashboard / list_dashboards)"),
      title: z.string().optional().describe("New title"),
      html: z.string().optional().describe("New presentation template (replaces the current one)"),
      panels: z.array(PANEL_SCHEMA).optional().describe("New panel set — REPLACES all panels. Pass [] to make it a static report."),
      refreshSeconds: z.number().optional().describe(`New refresh interval (${MIN_REFRESH_SECONDS}–${MAX_REFRESH_SECONDS})`),
    },
  },
  async ({ id, title, html, panels, refreshSeconds }) => {
    const tid = id.trim();
    const meta = store.getPublishedMeta(tid);
    if (!meta || meta.archivedAt)
      return errorText(`No active dashboard "${id}" (archived or unknown). Call list_dashboards.`);
    if (meta.createdBy !== user)
      return errorText(`Only the author (${meta.createdBy}) can edit this dashboard. Publish your own with publish_dashboard.`);
    if (title === undefined && html === undefined && panels === undefined && refreshSeconds === undefined)
      return errorText("Nothing to update — pass at least one of title, html, panels, refreshSeconds.");
    if (html !== undefined) {
      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > MAX_REPORT_BYTES)
        return errorText(`Template is ${(bytes / 1e6).toFixed(1)} MB — over the ${MAX_REPORT_BYTES / 1e6} MB cap.`);
    }

    let normalized: DashboardPanel[] | undefined;
    let seeds: PanelSeed[] | undefined;
    if (panels !== undefined) {
      const prep = await prepPanels(panels);
      if (!prep.ok) return errorText(prep.error);
      normalized = prep.normalized;
      seeds = prep.seeds;
    }

    const willHavePanels = normalized ? normalized.length > 0 : (meta.panels?.length ?? 0) > 0;
    let refresh: number | null | undefined;
    if (refreshSeconds !== undefined) refresh = clampRefresh(refreshSeconds, willHavePanels);
    else if (panels !== undefined) refresh = willHavePanels ? (meta.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) : null;

    const ok = store.updatePublished(tid, {
      title: title?.trim() || undefined,
      body: html,
      panels: normalized, // undefined → unchanged; [] → becomes a static report (cache cleared)
      refreshSeconds: refresh,
    });
    if (!ok) return errorText(`Update failed — no active dashboard "${id}".`);
    // Re-seed the cache for the new panels (updatePublished cleared the old rows).
    if (seeds) for (const s of seeds) store.putPanelCache(tid, s.key, { columns: s.columns, rows: s.rows, rowCount: s.rowCount, error: null });

    // A panel change alters what the dashboard exposes — if it was public, revert
    // to team so an admin re-approves (the human public-promotion gate, I9).
    let reverted = false;
    if (panels !== undefined && meta.visibility === "public") {
      store.setReportVisibility(tid, "team");
      reverted = true;
    }
    store.audit(user, "update_dashboard", {
      id: tid,
      changed: [title !== undefined && "title", html !== undefined && "html", panels !== undefined && "panels", refreshSeconds !== undefined && "refreshSeconds"].filter(Boolean),
      reverted,
    });

    const finalHtml = html ?? store.getPublished(tid)?.body ?? "";
    const finalPanels = normalized ?? meta.panels ?? [];
    return text(
      `Updated "${meta.title}" → ${publishUrl(tid, reverted ? "team" : meta.visibility)} (same link).` +
        (reverted ? "\n\n⚠ Panels changed on a PUBLIC dashboard — reverted to team-only; an admin must re-publish it publicly from /admin." : "") +
        publishNotes(finalHtml, finalPanels),
    );
  },
);

server.registerTool(
  "list_dashboards",
  {
    annotations: { readOnlyHint: true },
    title: "List dashboards published to the box",
    description:
      "Lists dashboards/reports published to this box (active first), with their shareable URLs, panel counts, " +
      "and who published them. Use it to find a link again, or an id to inspect (get_dashboard) or revoke.",
    inputSchema: {},
  },
  async () => {
    const rows = store.listPublished();
    store.audit(user, "list_dashboards", { count: rows.length });
    if (!rows.length) return text("Nothing published yet. Create one with publish_dashboard.");
    const active = rows.filter((r) => !r.archivedAt);
    const archived = rows.filter((r) => r.archivedAt);
    const lines: string[] = [];
    if (active.length) {
      lines.push("# active");
      for (const r of active) {
        const n = r.panels?.length ?? 0;
        const kind = n ? `${n} panel${n === 1 ? "" : "s"}` : "static";
        lines.push(
          `- ${r.title} [${r.visibility}, ${kind}] — ${publishUrl(r.id, r.visibility)}  (${r.createdBy}, ${r.createdAt.slice(0, 10)}, id ${r.id})`,
        );
      }
    } else {
      lines.push("No active dashboards (all archived).");
    }
    if (archived.length) {
      lines.push("", "# archived", ...archived.map((r) => `- ${r.title} (id ${r.id})`));
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "get_dashboard",
  {
    annotations: { readOnlyHint: true },
    title: "Inspect a dashboard's panels (how it's calculated)",
    description:
      "Returns a published dashboard's panel definitions — each panel's SQL, dialect, linked metric, and " +
      "when it last ran — so you can audit or iterate how a number is computed. Read-only.",
    inputSchema: { id: z.string().describe("The dashboard id from publish_dashboard / list_dashboards") },
  },
  async ({ id }) => {
    const dash = store.getPublishedMeta(id.trim());
    store.audit(user, "get_dashboard", { id, ok: !!dash });
    if (!dash || dash.archivedAt)
      return errorText(`No active dashboard "${id}" (archived or unknown). Call list_dashboards.`);
    const lines: string[] = [
      `# ${dash.title} [${dash.format}] — ${publishUrl(dash.id, dash.visibility)}`,
      `by ${dash.createdBy} · ${dash.createdAt.slice(0, 16)} · visibility ${dash.visibility}` +
        (dash.refreshSeconds ? ` · refresh ${dash.refreshSeconds}s` : ""),
      "",
    ];
    const ps = dash.panels ?? [];
    if (!ps.length) {
      lines.push("(no live panels — a static report.)");
    }
    for (const p of ps) {
      const cache = store.getPanelCache(dash.id, p.key);
      lines.push(
        `## panel ${p.key}${p.title ? ` — ${p.title}` : ""} [${p.dialect}]${p.metricId ? ` · metric:${p.metricId}` : ""}`,
      );
      if (cache)
        lines.push(
          `last run ${cache.computedAt.slice(0, 16)} — ${cache.error ? `ERROR: ${cache.error}` : `${cache.rowCount} row(s)`}`,
        );
      lines.push("```sql", p.sql.trim(), "```", "");
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "unpublish_dashboard",
  {
    annotations: { readOnlyHint: false, destructiveHint: true },
    title: "Archive a published dashboard",
    description:
      "Archives a published dashboard/report by its id (from list_dashboards). The link stops working " +
      "immediately and its cached data is dropped; the record is kept for the audit trail.",
    inputSchema: { id: z.string().describe("The dashboard id from publish_dashboard / list_dashboards") },
  },
  async ({ id }) => {
    const ok = store.archivePublished(id.trim());
    store.audit(user, "unpublish_dashboard", { id, ok });
    return ok
      ? text(`Archived ${id} — its link no longer works.`)
      : errorText(`No active dashboard with id "${id}" (already archived, or unknown id). Call list_dashboards to check.`);
  },
);


  return server;
}
