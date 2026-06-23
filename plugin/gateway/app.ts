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
import { diagnoseNoTables, introspectSchema, runReadOnlyQuery } from "./lib/db";
import { runLakeQuery } from "./lib/lake";
import { matchByTokens, matchGotchas, scoreDocs } from "./lib/search";
import { KnowledgeStore, type DocType } from "./lib/store";
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
}

export function buildServer({
  projectDir,
  store,
  user,
  canWrite,
  denyLakeRead,
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
      let result;
      if ((dialect ?? "postgres") === "clickhouse") {
        if (denyLakeRead)
          throw new Error(
            "This is a curator session — reading the lake (clickhouse dialect) is disabled here so a session that can commit curated knowledge can't ingest untrusted bulk text (the I2/I9 membrane). Use an analyst connector to query the lake.",
          );
        const lake = resolveLakeUrl(projectDir, config);
        if (!lake.ok) throw new Error(lake.error);
        result = await runLakeQuery(lake.url, sql, config);
      } else {
        const url = requireDb(config);
        result = await runReadOnlyQuery(url, sql, config);
      }
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


  return server;
}
