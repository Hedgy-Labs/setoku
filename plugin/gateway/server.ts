#!/usr/bin/env bun
/**
 * Setoku MCP gateway (v0, stdio, run with Bun).
 *
 * Governed access for a Claude Code/Cowork session to:
 *   - the business's verified context artifact (.setoku/context/)   [context tools]
 *   - the business's Postgres database, read-only + capped + audited [data tools]
 *
 * This process never calls an LLM and never reveals database credentials.
 */
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  loadConfig,
  resolveDatabaseUrl,
  resolveProjectDir,
  resolveUser,
  type SetokuConfig,
} from "./lib/config";
import { closePools, introspectSchema, runReadOnlyQuery } from "./lib/db";
import { appendCorrection, loadArtifact } from "./lib/artifact";
import { matchGotchas, scoreDocs } from "./lib/search";
import { auditLog } from "./lib/audit";

const projectDir = resolveProjectDir();
const user = resolveUser(projectDir);

const server = new McpServer({ name: "setoku", version: "0.1.0" });

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

const NO_ARTIFACT_HINT =
  "No context artifact found at .setoku/context/. Answers will rely on raw schema only — " +
  "run the /setoku:generate skill to derive verified business context from the codebase.";

/* ------------------------------ context tools ------------------------------ */

server.registerTool(
  "find_context",
  {
    title: "Find verified business context",
    description:
      "ALWAYS call this FIRST, before writing any SQL. Retrieves verified business context " +
      "(entity semantics, canonical metric definitions, known-good queries, gotchas) relevant " +
      "to a natural-language question. Trust this context over your own inference from table/column names — " +
      "it encodes how this business actually computes things.",
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
    const { docs, gotchas, exists } = loadArtifact(projectDir);
    if (!exists || docs.length === 0) {
      auditLog(projectDir, {
        user,
        tool: "find_context",
        question,
        ok: true,
        results: 0,
        ms: Date.now() - started,
      });
      return text(NO_ARTIFACT_HINT);
    }
    const out: string[] = [];
    const top = scoreDocs(docs, question).slice(0, max_results ?? 5);
    const matchedGotchas = matchGotchas(gotchas, question);
    if (matchedGotchas.length) {
      out.push("## Gotchas (read carefully — these prevent wrong answers)");
      for (const g of matchedGotchas) out.push(`- ${g}`);
      out.push("");
    }
    if (top.length === 0) {
      out.push(
        "No matching context docs. Proceed with get_schema, state your assumptions explicitly in the answer, " +
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
    auditLog(projectDir, {
      user,
      tool: "find_context",
      question,
      ok: true,
      results: top.length,
      gotchas: matchedGotchas.length,
      ms: Date.now() - started,
    });
    return text(out.join("\n"));
  },
);

server.registerTool(
  "list_entities",
  {
    title: "List documented business entities",
    description:
      "Lists every documented entity, metric, and canonical query in the verified context artifact " +
      "(name + one-line summary). Cheap index — use it to discover what context exists.",
    inputSchema: {},
  },
  async () => {
    const { docs, gotchas, exists } = loadArtifact(projectDir);
    if (!exists || docs.length === 0) return text(NO_ARTIFACT_HINT);
    const lines: string[] = [];
    const sections: [string, string][] = [
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
    if (gotchas.length) {
      lines.push(
        "# gotchas",
        `${gotchas.length} recorded — surfaced automatically by find_context.`,
      );
    }
    auditLog(projectDir, { user, tool: "list_entities", ok: true });
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "describe_entity",
  {
    title: "Full context doc for one entity",
    description:
      "Returns the complete verified context document for one entity (or query/overview) by name.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const { docs } = loadArtifact(projectDir);
    const needle = name.toLowerCase();
    const doc =
      docs.find((d) => d.name.toLowerCase() === needle) ??
      docs.find((d) => String(d.meta.table ?? "").toLowerCase() === needle) ??
      docs.find((d) => d.name.toLowerCase().includes(needle));
    auditLog(projectDir, { user, tool: "describe_entity", name, ok: !!doc });
    if (!doc)
      return errorText(
        `No context doc named "${name}". Call list_entities to see what exists.`,
      );
    const head = [`# [${doc.type}] ${doc.name}`];
    for (const [k, v] of Object.entries(doc.meta))
      head.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    return text([...head, "", doc.body].join("\n"));
  },
);

server.registerTool(
  "get_metric",
  {
    title: "Canonical metric definition",
    description:
      "Returns the canonical, human-verified definition of a business metric, including the exact SQL. " +
      "If a metric exists for the user's question, USE ITS SQL as the basis for your query instead of inventing logic.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const { docs } = loadArtifact(projectDir);
    const metrics = docs.filter((d) => d.type === "metric");
    const needle = name.toLowerCase();
    const doc =
      metrics.find((d) => d.name.toLowerCase() === needle) ??
      metrics.find((d) => d.name.toLowerCase().includes(needle));
    auditLog(projectDir, { user, tool: "get_metric", name, ok: !!doc });
    if (!doc) {
      const known =
        metrics.map((m) => m.name).join(", ") || "(none documented yet)";
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
    title: "Record a context correction / clarification",
    description:
      "Records a candidate addition or correction to the business-context artifact (a new gotcha, a metric " +
      "definition the user clarified, an entity annotation fix). Call this whenever the user corrects you or " +
      "resolves an ambiguity — that's how the whole team's answers improve. Candidates are reviewed by a human " +
      "before becoming ground truth; never edit .setoku/context/ files directly during analysis.",
    inputSchema: {
      kind: z.enum(["gotcha", "metric", "entity", "query", "other"]),
      content: z
        .string()
        .describe(
          "The correction/clarification, written so a reviewer can apply it",
        ),
      relates_to: z
        .string()
        .optional()
        .describe("Entity/metric name this relates to, if any"),
    },
  },
  async ({ kind, content, relates_to }) => {
    const file = appendCorrection(projectDir, {
      ts: new Date().toISOString(),
      user,
      kind,
      content,
      relatesTo: relates_to,
    });
    auditLog(projectDir, { user, tool: "report_correction", kind, ok: true });
    return text(
      `Recorded as a candidate ${kind} in ${path.relative(projectDir, file)} (attributed to ${user}). ` +
        "A human reviews corrections and folds accepted ones into .setoku/context/ — typically via /setoku:generate or a manual edit.",
    );
  },
);

/* -------------------------------- data tools ------------------------------- */

server.registerTool(
  "get_schema",
  {
    title: "Live database schema (permission-scoped)",
    description:
      "Introspects the live Postgres schema, filtered to the tables this repo's Setoku config allows. " +
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
      } else {
        lines.push(`${schema.length} allowed tables:`);
        for (const t of schema) {
          lines.push(
            `- ${t.schema}.${t.name}: ${t.columns.map((c) => c.name).join(", ")}`,
          );
        }
      }
      // drift note: artifact entities vs live tables
      const { docs } = loadArtifact(projectDir);
      const documented = new Set(
        docs
          .filter((d) => d.type === "entity" && d.meta.table)
          .map((d) => String(d.meta.table).toLowerCase()),
      );
      if (documented.size) {
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
        if (undocumented.length && tables === undefined) {
          lines.push(
            "",
            `note: ${undocumented.length} live tables have no context doc yet (${undocumented.slice(0, 8).join(", ")}${undocumented.length > 8 ? ", …" : ""}).`,
          );
        }
      }
      auditLog(projectDir, {
        user,
        tool: "get_schema",
        tables: tables ?? null,
        ok: true,
        ms: Date.now() - started,
      });
      return text(lines.join("\n"));
    } catch (e) {
      const msg = (e as Error).message;
      auditLog(projectDir, {
        user,
        tool: "get_schema",
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
    title: "Run a read-only SQL query (capped + audited)",
    description:
      "Executes ONE read-only SQL statement against the business database inside a READ ONLY transaction, " +
      "with a statement timeout and a row cap. Every call is audited with your identity. " +
      "Workflow: call find_context first, prefer canonical metric SQL via get_metric, include an explicit LIMIT, " +
      "and never SELECT * on wide tables. Writes/DDL are rejected.",
    inputSchema: {
      sql: z.string().describe("A single SELECT/WITH/EXPLAIN statement"),
      purpose: z
        .string()
        .optional()
        .describe(
          "One line on what business question this answers (goes in the audit log)",
        ),
    },
  },
  async ({ sql, purpose }) => {
    const started = Date.now();
    const sqlForAudit =
      sql && sql.length > 2000 ? sql.slice(0, 2000) + "…" : sql;
    try {
      const config = requireConfig();
      const url = requireDb(config);
      const result = await runReadOnlyQuery(url, sql, config);
      auditLog(projectDir, {
        user,
        tool: "run_query",
        purpose: purpose ?? null,
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
      return text(lines.join("\n"));
    } catch (e) {
      const msg = (e as Error).message;
      auditLog(projectDir, {
        user,
        tool: "run_query",
        purpose: purpose ?? null,
        sql: sqlForAudit,
        ok: false,
        error: msg,
        ms: Date.now() - started,
      });
      return errorText(`run_query failed: ${msg}`);
    }
  },
);

/* --------------------------------- startup --------------------------------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("SIGTERM", async () => {
    await closePools();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("setoku gateway failed to start:", e);
  process.exit(1);
});
