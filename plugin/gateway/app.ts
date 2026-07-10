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
import { buildLinkGraph, docRef, matchByTokens, retrieve, selectGotchas } from "./lib/search";
import { combineSynonyms, synonymsOf } from "./lib/synonyms";
import type { EmbedIndex } from "./lib/embed-index";
import type { DerivedSynonyms } from "./lib/derived-synonyms";
import { KnowledgeStore, mintShareId, type AppPanel, type DocType } from "./lib/store";
import { MAX_PANELS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS, DEFAULT_REFRESH_SECONDS, MAX_RENDER_ROW_BYTES, RENDER_FETCH_CEILING, runPanel, trimRowsToBytes, compilePanel, isFullDoc } from "./lib/apps";
import { resolveParams, paramsVariant, type AppParam } from "./lib/params";
import { lintAppTemplate } from "./lib/app-runtime";
import { extractSql } from "./lib/lint";
import { queryCaptureNudge, panelCaptureNote, mirrorSteerNote, panelMirrorNote, mirrorHits, type MirrorRef } from "./lib/nudge";
import { mirroredTables, type MirroredTable } from "./lib/mirror";
import { LAKE_SOURCES } from "./lib/sources";
import { notifyActivity } from "./lib/notify";
import { VERSION } from "./lib/version";

/**
 * A token's capability role — the I2/I9 membrane, made a type. A session is
 * EXACTLY one of these; capabilities are derived (capabilitiesFor), never passed
 * as free booleans. This is what makes the dangerous combination — commit
 * knowledge AND read the untrusted lake on one session — *unrepresentable*:
 *
 *   • analyst — reads the lake (untrusted bulk text); propose-only, no write tool.
 *   • curator — commits curated knowledge; CANNOT read the lake.
 *   • janitor — draft + reject only (zero authority); reads untrusted pending text.
 *
 * An agent reading untrusted content is prompt-injectable, so it must never hold a
 * tool that commits knowledge. With a single role there is no way to construct a
 * session that both writes and reads the lake — the boolean soup that previously
 * left that one careless call-site away.
 */
export type TokenRole = "analyst" | "curator" | "janitor";

export interface Capabilities {
  /** Expose curated-write tools (upsert_context, resolve_correction). */
  canWrite: boolean;
  /** Block run_query on the lake (clickhouse) — true exactly when canWrite. */
  denyLakeRead: boolean;
  /** Expose draft_correction (draft-only, zero authority). */
  canDraft: boolean;
  /** Expose reject_correction (reject-only, zero authority). */
  canReject: boolean;
}

/** Derive a role's capabilities. The ONLY place capabilities are decided, so the
 *  membrane is one switch, not a convention spread across call sites. By
 *  construction no role yields `canWrite && !denyLakeRead`. */
export function capabilitiesFor(role: TokenRole): Capabilities {
  switch (role) {
    case "curator":
      return { canWrite: true, denyLakeRead: true, canDraft: false, canReject: false };
    case "janitor":
      return { canWrite: false, denyLakeRead: false, canDraft: true, canReject: true };
    case "analyst":
      return { canWrite: false, denyLakeRead: false, canDraft: false, canReject: false };
  }
}

export interface GatewayDeps {
  projectDir: string;
  store: KnowledgeStore;
  user: string;
  /** The session's capability role (the membrane). Capabilities are derived from
   *  it, so the forbidden write+lake-read combination can't be constructed. */
  role: TokenRole;
  /**
   * The process-wide semantic index (local embeddings). When enabled,
   * `find_context` fuses embedding similarity with keyword retrieval (hybrid).
   * Null/disabled → keyword retrieval only (graceful fallback). Shared across
   * per-request servers, like `store`.
   */
  embedIndex?: EmbedIndex | null;
  /**
   * The process-wide per-tenant DERIVED synonym table (issue #33). Built offline
   * by clustering this tenant's doc vocabulary with the local model, it fuses with
   * the domain-general base table for I8-clean query expansion. Null/inert →
   * base table only. Shared across per-request servers, like `store`.
   */
  derivedSynonyms?: DerivedSynonyms | null;
}

export function buildServer({
  projectDir,
  store,
  user,
  role,
  embedIndex = null,
  derivedSynonyms = null,
}: GatewayDeps): McpServer {
const { canWrite, denyLakeRead, canDraft, canReject } = capabilitiesFor(role);
const server = new McpServer({ name: "setoku", version: VERSION });

// Query expansion seam: the domain-general base table, fused with this tenant's
// offline-derived table when it's live (issue #33). Pure lookup either way (I8).
const synonyms = derivedSynonyms
  ? combineSynonyms(synonymsOf, derivedSynonyms.neighbors)
  : synonymsOf;

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

/** The ```sql fences of METRIC/QUERY docs — what "already covered" means for
 *  the success-path capture nudges (lib/nudge). Scoped to the doc types that
 *  define numbers: an illustrative fence in an entity/gotcha doc is context,
 *  not a metric, and must not suppress the capture hint. Passed as a thunk so
 *  the nudge helpers only scan the store once their cheap gates pass. */
function curatedSqls(): string[] {
  return store
    .listDocs()
    .filter((d) => d.type === "metric" || d.type === "query")
    .flatMap((d) => extractSql(d.body));
}

/** Tables currently mirrored into biz.* (issue #47) — feeds the run_query
 *  steering/gate and the list_sources mirror section. Cached in lib/mirror.
 *
 *  `forGate` matters on CURATOR sessions: steering surfaces return [] there
 *  (the membrane keeps lake reads off write-capable sessions, and a curator
 *  can't run clickhouse anyway, so a nudge is noise) — but the publish GATE
 *  must see the mirror regardless of role, or curators become the one session
 *  type that can plant durable postgres panels over mirrored tables. The gate
 *  read is a server-side metadata fetch (pg-catalog identifiers the curator
 *  can already see via get_schema), not lake content reaching the session.
 *  `forGate` also awaits a real refresh instead of trusting a cold/negative
 *  cache — a lake blip must not silently disable a durable-artifact gate. */
async function mirrorRefs(opts: { forGate?: boolean } = {}): Promise<MirroredTable[]> {
  if (denyLakeRead && !opts.forGate) return [];
  try {
    const config = requireConfig();
    const lake = resolveLakeUrl(projectDir, config);
    if (!lake.ok) return [];
    return await mirroredTables(lake.url, { fresh: opts.forGate });
  } catch {
    return [];
  }
}

/** The mirror-required rejection (issue #47, hardened): with a mirror present,
 *  the mirror IS the read path for mirrored tables — postgres against them is
 *  refused with the rewrite, not nudged. Returns null when allowed. NB the
 *  gate can't see mirror metadata on a curator session (the membrane keeps all
 *  lake reads off write-capable sessions), but a curator can't run clickhouse
 *  panels either — analysts are who author and query. */
function mirrorRequiredError(hits: MirrorRef[], what: "query" | "panel"): string | null {
  if (!hits.length) return null;
  const map = hits.map((m) => `${m.source} → biz.${m.target}`).join(", ");
  return (
    `This box mirrors the business DB — mirrored tables are read via ClickHouse, not prod postgres ` +
    `(${map}). Re-write the ${what} with dialect:"clickhouse" against the biz.* names (same rows, ` +
    `reloaded on a cron; list_sources shows each table's "data as of").` +
    (what === "query"
      ? ` If you specifically need the LIVE source rows — verifying the mirror against prod, or a ` +
        `row that changed in the last few minutes — re-run with force_postgres:true (audited).`
      : "")
  );
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
      "ALWAYS call FIRST, the instant a data/business question arrives — before any planning, schema " +
      "exploration, or reasoning about what a term means; call it with the question, THEN reason over " +
      "what it returns. Retrieves verified business context (entity semantics, canonical metric " +
      "definitions, known-good queries, gotchas, and pending unverified team knowledge) for a " +
      "natural-language question. Trust it over your own inference from table/column names — it encodes " +
      "how this business actually computes things.",
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
    const pending = matchByTokens(
      store.listCorrections("pending"),
      (c) => `${c.fact ?? c.content} ${c.relatesTo ?? ""}`,
      question,
    ).slice(0, 5);
    const out: string[] = [];

    // Map-first retrieval: the proven keyword top-k, PLUS 1-hop neighbors of
    // those hits in the curated link graph. The direct hits are unchanged (so
    // precision is preserved); linked neighbors add the related context a flat
    // ranker misses — the metric/gotcha/entity that belong together (#wiki).
    const k = max_results ?? 5;
    // Hybrid: when the local embed index is live, fuse embedding similarity with
    // keyword retrieval. Disabled/unavailable → embedScores is undefined and this
    // is exactly the keyword(+synonym+map-first) path (I8 graceful fallback).
    const embedScores = embedIndex
      ? ((await embedIndex.scores(question)) ?? undefined)
      : undefined;
    const retrieved = retrieve(docs, question, {
      k,
      expandLinks: true,
      maxLinked: k,
      synonyms, // I8-clean semantic expansion: base + per-tenant derived (no inference)
      embedScores,
    });
    const top = retrieved.filter((r) => r.via === "direct");
    const linked = retrieved.filter((r) => r.via === "linked");

    // Gotchas: surface those ATTACHED to the direct hits first (relevant by
    // construction — their metric/entity is what was asked about), then fill the
    // budget with the most query-relevant, capped. Beats dumping every gotcha
    // that shares one word with the question (which floods context — measured by
    // eval:value's context-cost metric).
    const selectedGotchas = selectGotchas(
      gotchaDocs,
      top.map((t) => t.doc),
      question,
    );
    if (selectedGotchas.length) {
      out.push("## Gotchas (read carefully — these prevent wrong answers)");
      for (const g of selectedGotchas) out.push(`- ${g.body || g.name}`);
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
    // Related context: docs the top hits LINK to but that didn't rank on their
    // own. Shown compact (one line + a pointer) so they cost little context but
    // tell the agent what else it should read before answering.
    if (linked.length) {
      out.push("## Related context (linked from the above — read if relevant)");
      for (const { doc } of linked) {
        const summary = doc.meta.summary ?? doc.meta.question ?? "";
        const fetch = doc.type === "metric" ? `get_metric("${doc.name}")` : `describe_entity("${doc.name}")`;
        out.push(`- [${doc.type}] ${doc.name}${summary ? ` — ${summary}` : ""} (${fetch})`);
      }
      out.push("");
    }
    // record the knowledge actually surfaced (direct + linked docs + selected
    // gotchas), by name, so per-doc usage can be tallied from the audit log.
    const surfaced = [
      ...top.map((t) => t.doc.name),
      ...linked.map((t) => t.doc.name),
      ...selectedGotchas.map((d) => d.name),
    ];
    store.audit(user, "find_context", {
      question,
      results: top.length,
      linked: linked.length,
      gotchas: selectedGotchas.length,
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
      "Records a candidate correction/addition to the knowledge store (a gotcha, a clarified metric " +
      "definition, an entity-annotation fix). Call this whenever the user corrects you or resolves an " +
      "ambiguity — it's how the whole team's answers improve. Live immediately as unverified knowledge; a " +
      "curator later promotes or rejects it via /setoku:curate. Keep `fact` to one concise claim, put the " +
      "evidence in `context`, and set `relates_to` to the entity/metric it's about (see the field notes).",
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
      "canonical SQL in the body. For gotchas put the one-liner in body (name can be a short slug). " +
      "Set meta.links (array of exact doc names) to interlink related docs — join targets, the metrics an " +
      "entity feeds, the entities a metric reads. Links must resolve to existing docs or the save is rejected.",
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
          "Frontmatter-style fields: table, summary, keywords, question, sources, links (array of doc names this doc references)",
        ),
    },
  },
  async ({ type, name, body, meta }) => {
    // Links must resolve to exactly one existing doc, validated HERE so a dangling
    // or ambiguous link can never enter the store (bad data unrepresentable, not
    // checked-for after the fact). Build the graph over the prospective doc set
    // (existing docs with this one applied) and reject if this doc has any
    // unresolved link.
    const incoming = {
      type,
      name,
      meta: meta ?? {},
      body: body ?? "",
      verified: true,
      updatedBy: user,
      updatedAt: new Date().toISOString(),
    };
    const prospective = [
      ...store.listDocs().filter((d) => !(d.type === type && d.name === name)),
      incoming,
    ];
    const bad = buildLinkGraph(prospective).unresolved.filter(
      (u) => u.fromRef === docRef(incoming),
    );
    if (bad.length)
      return errorText(
        `Won't save: ${bad.length} link(s) don't resolve to a doc — ${bad.map((b) => `"${b.ref}"`).join(", ")}. ` +
          "Use an exact doc name (or type:name if the name is shared across types). Fix or drop them in meta.links.",
      );
    store.upsertDoc({ type, name, meta: meta ?? {}, body }, user);
    store.audit(user, "upsert_context", { type, name });
    // keep the semantic index fresh (no-op if embeddings disabled)
    await embedIndex?.upsert(incoming);
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
        .describe(
          "Frontmatter fields: table, summary, keywords, relates_to, expect, unit, links (array of existing doc names the drafted doc references)",
        ),
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
      reason: z.string().describe("Why it failed an objective check (recorded + shown in the /admin review queue)"),
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
      "Lists what Setoku can query RIGHT NOW: business database tables, data-lake tables (logs, product " +
      "events, finance, chat) with what each holds, and the knowledge store. Capabilities are DYNAMIC, so " +
      "call this whenever unsure whether Setoku has data for a question, BEFORE telling the user it isn't " +
      'available. Logs/errors/events/finance/chat live in the LAKE (run_query dialect:"clickhouse"), not Postgres.',
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
    // With a mirror present, postgres is just the mirror's SOURCE — the section
    // must not present it as the query path (those queries get rejected).
    const mirrored = await mirrorRefs();
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
        } else if (mirrored.length) {
          const require = (config?.mirrorPolicy ?? "require") === "require";
          lines.push(
            "",
            `BUSINESS DATABASE (Postgres) — the mirror's source, ${names.length} tables. Query these via the`,
            require
              ? "BUSINESS-DB MIRROR below (clickhouse dialect); direct postgres queries on mirrored tables are"
              : "BUSINESS-DB MIRROR below (clickhouse dialect) — strongly preferred for scans/aggregations;",
            require
              ? "rejected (run_query force_postgres:true only to verify the mirror or read the last few minutes):"
              : "postgres still runs them (this box sets mirrorPolicy \"prefer\"):",
            "  " + names.slice(0, 40).join(", ") + (names.length > 40 ? ", …" : "") + "  (get_schema for columns)",
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
          // plumbing tables (connector liveness beats) aren't a queryable source
          const extra = [...present].filter(
            (t) => t !== "ingest_heartbeats" && !LAKE_SOURCES.some((s) => s.table === t),
          );
          if (known.length || extra.length) {
            lines.push("", 'DATA LAKE (ClickHouse) — run_query with dialect:"clickhouse" — tables:');
            for (const s of known) lines.push(`  - setoku.${s.table} — ${s.blurb}`);
            for (const t of extra) lines.push(`  - setoku.${t}`);
          } else {
            lines.push("", "DATA LAKE: configured but empty.");
          }
          // Business-DB mirror (issue #47) — the DEFAULT read path for heavy
          // scans/aggregations over business tables.
          const mirror = mirrored;
          if (mirror.length) {
            const require = (config?.mirrorPolicy ?? "require") === "require";
            lines.push(
              "",
              'BUSINESS-DB MIRROR (ClickHouse, biz.*) — run_query with dialect:"clickhouse". Full copies of',
              require
                ? "allowlisted business tables, reloaded on a cron. These are THE read path: postgres queries"
                : "allowlisted business tables, reloaded on a cron — PREFER these over postgres for scans, GROUP BY,",
              require
                ? 'against mirrored tables are rejected (force_postgres:true for source verification only). Each shows its "data as of":'
                : "and app panels; keep postgres for point lookups. Each shows its \"data as of\":",
              ...mirror.map((m) => `  - biz.${m.target} ← ${m.source} (as of ${m.asOf})`),
            );
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
      'Reminder: logs, errors, product events, finance, chat — and mirrored business tables (biz.*) — all live in the LAKE. Query with dialect:"clickhouse"; Postgres is for tables the mirror doesn\'t carry.',
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
      "The structure applies to the biz.* mirror too (query <schema>.<table> as biz.<schema>_<table>, " +
      "public.<table> as biz.<table>, clickhouse dialect). " +
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
      "Executes ONE read-only SQL statement (statement timeout + row cap; audited with your identity). " +
      "Routes by dialect (metric docs declare theirs): `postgres` (default) = the business DB in a READ ONLY " +
      "transaction; `clickhouse` = the bundled lake (logs/events/Slack archive) plus the biz.* business-DB " +
      "mirror when enabled. Mirrored tables are read through the MIRROR — postgres queries against them are " +
      "rejected (force_postgres:true reads the live source, for verification/freshness only). list_sources " +
      "shows what's mirrored. Engine-enforced readonly either way. " +
      "Workflow: find_context first, prefer canonical metric SQL via get_metric, always include an explicit " +
      "LIMIT, never SELECT * on wide tables. Writes/DDL are rejected. Discover lake tables with " +
      "SHOW TABLES / DESCRIBE <table> on the clickhouse dialect.",
    inputSchema: {
      sql: z.string().describe("A single SELECT/WITH/EXPLAIN statement"),
      dialect: z
        .enum(["postgres", "clickhouse"])
        .optional()
        .describe(
          "Where to run it. clickhouse = the lake + the biz.* business-DB mirror (the read path for mirrored " +
            "tables); postgres (default) = the live business DB, rejected for mirrored tables. Use the dialect " +
            "the metric doc declares (meta.dialect).",
        ),
      purpose: z
        .string()
        .optional()
        .describe(
          "One line on what business question this answers (goes in the audit log)",
        ),
      force_postgres: z
        .boolean()
        .optional()
        .describe(
          "Boxes with a business-DB mirror refuse postgres queries on mirrored tables (run them on " +
            'clickhouse against biz.* instead). Pass true ONLY to read the live source — verifying the ' +
            "mirror, or row-level freshness the reload interval can't give. Audited.",
        ),
    },
  },
  async ({ sql, dialect, purpose, force_postgres }) => {
    const started = Date.now();
    const sqlForAudit =
      sql && sql.length > 2000 ? sql.slice(0, 2000) + "…" : sql;
    try {
      const config = requireConfig();
      // Mirror-required gate (issue #47): mirrored tables read via the mirror,
      // full stop — unless the caller explicitly asked for the live source.
      if ((dialect ?? "postgres") === "postgres" && (config.mirrorPolicy ?? "require") === "require" && !force_postgres) {
        const blocked = mirrorRequiredError(mirrorHits(sql, await mirrorRefs()), "query");
        if (blocked) {
          store.audit(user, "run_query", {
            purpose: purpose ?? null,
            dialect: "postgres",
            sql: sqlForAudit,
            ok: false,
            error: "mirror-required",
            ms: Date.now() - started,
            totalMs: Date.now() - started,
          });
          return errorText(blocked);
        }
      }
      // Route + enforce the lake membrane (I2/I9) through the SAME helper the
      // app panels use, so there is one gate, not two divergent copies.
      const result = await runPanel(
        projectDir,
        config,
        { key: "run_query", sql, dialect: dialect ?? "postgres" },
        { text: sql, referenced: [] }, // a direct query — no bound params
        { denyLakeRead },
      );
      store.audit(user, "run_query", {
        purpose: purpose ?? null,
        dialect: dialect ?? "postgres",
        ...(force_postgres ? { force_postgres: true } : {}),
        sql: sqlForAudit,
        ok: true,
        rows: result.rowCount,
        truncated: result.truncated,
        ms: result.ms, // SQL-transaction time only (db.ts) — kept for back-compat trends
        totalMs: Date.now() - started, // full handler wall-clock: connect + SQL + serialize
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
        `${result.rowCount} row(s) in ${result.ms}ms${result.truncated ? ` — TRUNCATED at the model-context row cap (${config.rowCap}); this caps rows entering the model, NOT what an app renders. To see more: aggregate, add LIMIT/OFFSET to page, or build a panel (published panels render the full result set up to a ~3.5MB payload).` : ""}`,
      );
      // Success-path capture nudge: the query worked AND computed an aggregate
      // no curated metric covers — the one moment the definition is fresh and
      // validated. (The empty-store warning below owns docCount === 0; nudging
      // on failed or zero-row queries would just coach retries.)
      if (store.docCount > 0 && result.rowCount > 0) {
        const nudge = queryCaptureNudge(sql, curatedSqls);
        if (nudge) lines.push("", nudge);
      }
      // Mirror steering nudge — reaches this point only under mirrorPolicy
      // "prefer" (the default "require" already rejected above) or when the
      // caller forced the live source (no nudge then; they chose deliberately).
      if ((dialect ?? "postgres") === "postgres" && !force_postgres) {
        const steer = mirrorSteerNote(sql, await mirrorRefs());
        if (steer) lines.push("", steer);
      }
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
        ...(force_postgres ? { force_postgres: true } : {}),
        sql: sqlForAudit,
        ok: false,
        error: msg,
        ms: Date.now() - started, // no SQL completed — wall-clock is all we have
        totalMs: Date.now() - started,
      });
      return errorText(`run_query failed: ${msg}`);
    }
  },
);

/* ------------------------------ apps ----------------------------- */
// The agent publishes a APP to the box and gets back a shareable URL. A
// app splits presentation (a frozen, agent-authored template) from data
// (named panels, each a saved read-only query the box RE-RUNS live through the
// governed run_query path). The template reads results off window.__SETOKU__.
// A zero-panel app is a static / state-only fragment (a todo, a poll, a
// presentational summary); it still renders through the runtime shell.
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
// A one-line changelog note for an update, shown in version history and the
// activity notification (issue #63). A sentence, not a document.
const MAX_UPDATE_MESSAGE_CHARS = 500;

// Where a published app lives. SETOKU_PUBLIC_URL is the box's public origin
// (also used by the installer links); without it we return the path and tell the
// agent to prefix its box URL.
const publishBase = (process.env.SETOKU_PUBLIC_URL ?? "").replace(/\/+$/, "");
// Team apps live in the session-gated SPA (/admin/p/<id>); public ones serve
// credential-free at /p/<id>. The link an agent hands out follows visibility.
const publishUrl = (id: string, visibility: "team" | "public" = "team"): string => {
  const path = visibility === "public" ? `/p/${id}` : `/admin/p/${id}`;
  return publishBase ? `${publishBase}${path}` : path;
};

const PANEL_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

type PanelInput = { key: string; title?: string; description?: string; sql: string; dialect?: "postgres" | "clickhouse"; metricId?: string };
type PanelSeed = { key: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean };

// Validate + dry-run a panel set through the governed path. Shared by publish and
// update so the rules (keys, caps, the I2/I9 lake membrane via runPanel, "every
// panel must run") can never drift between the two.
async function prepPanels(
  list: PanelInput[],
  declared: AppParam[] = [],
  // seed=true (default) DRY-RUNS each panel and returns cache seeds — needed when
  // the SQL is new/changed. seed=false only validates + compiles (param defaults
  // coerce, every :token is declared) WITHOUT executing: used by a params-only
  // edit, so adjusting a param can't be blocked by an unrelated transiently-broken
  // panel and doesn't pay full query latency for a metadata-shaped change.
  opts: { seed?: boolean } = {},
): Promise<{ ok: true; normalized: AppPanel[]; seeds: PanelSeed[] } | { ok: false; error: string }> {
  const seed = opts.seed ?? true;
  if (list.length > MAX_PANELS)
    return { ok: false, error: `Too many panels (${list.length} > ${MAX_PANELS}). Aggregate or split the app.` };
  const keys = new Set<string>();
  for (const p of list) {
    if (!PANEL_KEY_RE.test(p.key ?? "")) return { ok: false, error: `Panel key "${p.key}" must be a 1–64 char slug ([A-Za-z0-9_-]).` };
    if (keys.has(p.key)) return { ok: false, error: `Duplicate panel key "${p.key}".` };
    keys.add(p.key);
    if (!p.sql?.trim()) return { ok: false, error: `Panel "${p.key}" has no sql.` };
  }
  const normalized: AppPanel[] = list.map((p) => ({
    key: p.key,
    title: p.title,
    description: p.description,
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
  // Mirror-required gate (issue #47): a postgres panel over a mirrored table is
  // a repeating prod scan — with a mirror present it must be authored in
  // clickhouse against biz.* (no force escape here; panels are durable). Only
  // when the SQL itself is changing (seed): a params-only edit re-validates
  // EXISTING panels, and blocking it would freeze every pre-mirror app's
  // metadata until its whole panel set is re-authored.
  if (seed && (config.mirrorPolicy ?? "require") === "require") {
    const mirrored = await mirrorRefs({ forGate: true });
    for (const p of normalized) {
      if (p.dialect !== "postgres") continue;
      const blocked = mirrorRequiredError(mirrorHits(p.sql, mirrored), "panel");
      if (blocked) return { ok: false, error: `Panel "${p.key}": ${blocked}` };
    }
  }
  // Resolve the declared inputs to their DEFAULTS to dry-run the panels (no viewer
  // yet) — this also validates every :token is declared and every default coerces.
  let resolved;
  try {
    resolved = resolveParams(declared, {});
  } catch (e) {
    return { ok: false, error: `Bad param default: ${(e as Error).message}` };
  }
  const seeds: PanelSeed[] = [];
  for (const p of normalized) {
    let compiled;
    try {
      compiled = compilePanel(p, declared, resolved); // throws on an undeclared :param
    } catch (e) {
      return { ok: false, error: `Panel "${p.key}": ${(e as Error).message}\nDeclare it in params, or fix the token.` };
    }
    if (!seed) continue; // validate/compile only — don't execute
    const variant = paramsVariant(compiled.referenced, resolved);
    const cacheKey = variant ? `${p.key}::${variant}` : p.key; // seed the default-params variant
    try {
      // Seed the RENDER cache, not the model context: use the render fetch ceiling
      // (not config.rowCap) and trim to the payload budget, exactly like a live
      // render — otherwise the first views right after publish/update would serve a
      // silent 200-row prefix (truncated=false) for the whole refresh TTL, breaking
      // the "panels render the full result set" contract precisely when the author
      // is validating the app.
      const r = await runPanel(projectDir, config, p, compiled, { denyLakeRead, rowCap: RENDER_FETCH_CEILING });
      const fit = trimRowsToBytes(r.rows, MAX_RENDER_ROW_BYTES);
      seeds.push({ key: cacheKey, columns: r.columns, rows: fit.rows, rowCount: fit.rows.length, truncated: r.truncated || fit.truncated });
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
// missing curated metric links + mirror steering + static render-lint of the
// template. Async only for the (cached, best-effort) mirror lookup.
async function publishNotes(html: string, panels: AppPanel[]): Promise<string> {
  const notes: string[] = [];
  const missing = panels.filter((p) => p.metricId && !store.getDoc("metric", String(p.metricId))).map((p) => p.metricId);
  if (missing.length)
    notes.push(`no curated metric named ${missing.map((m) => `"${m}"`).join(", ")} — that provenance link is dropped (document it with /setoku:generate or upsert_context).`);
  // A panel without a title shows its raw slug in the "how is this calculated"
  // drawer; without a description, viewers get no plain-language explanation.
  const noTitle = panels.filter((p) => !p.title?.trim()).map((p) => p.key);
  if (noTitle.length)
    notes.push(`panel(s) ${noTitle.map((k) => `"${k}"`).join(", ")} have no \`title\` — viewers see the raw slug. Give each a human title.`);
  const noDesc = panels.filter((p) => !p.description?.trim()).map((p) => p.key);
  if (noDesc.length)
    notes.push(`panel(s) ${noDesc.map((k) => `"${k}"`).join(", ")} have no \`description\` — the drawer can't explain what they compute. Add a one-line description.`);
  const capture = panelCaptureNote(panels, curatedSqls);
  if (capture) notes.push(capture);
  // Heavy postgres panels over mirrored tables belong on the biz.* mirror
  // (issue #47) — flag them so the agent re-authors before the app calcifies.
  const mirror = panelMirrorNote(panels, await mirrorRefs());
  if (mirror) notes.push(mirror);
  notes.push(...lintAppTemplate(html, panels.map((p) => p.key)));
  return notes.length ? `\n\n⚠ Heads up (publishes anyway):\n- ${notes.join("\n- ")}` : "";
}

const PANEL_SCHEMA = z.object({
  key: z.string().describe("Stable slug the template reads (window.__SETOKU__.panels[key])"),
  title: z.string().optional().describe("Recommended — label shown in the calc drawer (see app_guide)"),
  description: z.string().optional().describe("Recommended — one-line calc explanation; the only one public viewers get"),
  sql: z.string().describe("A single read-only SELECT/WITH (validate with run_query first)"),
  dialect: z.enum(["postgres", "clickhouse"]).optional().describe("postgres (default) = business DB; clickhouse = lake + biz.* mirror. Mirrored tables REQUIRE clickhouse (see app_guide)"),
  metricId: z.string().optional().describe("Curated metric name this panel computes — links provenance"),
});

// A declared interactive input. A panel's SQL references it as `:name`; the
// viewer's value is type-coerced and ENGINE-BOUND (never string-interpolated),
// so it's injection-safe and can't name a table/column or drive a write.
const PARAM_SCHEMA = z.object({
  name: z.string().describe("Identifier a panel's SQL binds as :name"),
  label: z.string().optional().describe("Human label for the shell-rendered control"),
  type: z.enum(["date", "int", "text", "bool", "enum"]),
  default: z.union([z.string(), z.number(), z.boolean()]).describe("REQUIRED — the app must render with no viewer input"),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })).optional().describe("enum only: the closed set of accepted values"),
  min: z.number().optional().describe("int: inclusive minimum"),
  max: z.number().optional().describe("int: inclusive maximum"),
  maxLength: z.number().optional().describe("text: max length"),
});

// The full app-authoring contract. Served on demand by the app_guide tool rather
// than carried in the publish_app/update_app definitions — so it costs context
// only in conversations that actually build an app (like find_context, pulled
// in-loop), not on every turn of every session that holds the connector. Being
// lazy-loaded, it can afford to be richer than a crammed `.describe()` string.
const APP_GUIDE = [
  "# Building a Setoku app",
  "",
  "An app splits PRESENTATION (an HTML template you author) from DATA (named panels — saved",
  "read-only queries the box re-runs live and injects). Validate every panel's SQL with run_query",
  "FIRST, then publish_app; edit later with update_app (same link).",
  "",
  "## Editing an existing app — get_app FIRST, don't rebuild",
  "To change an app you (or anyone) already published, call get_app(id): it returns the EXACT current",
  "`html` template, its `params`, and every panel's SQL. Edit that template and pass it back to",
  "update_app — never reconstruct the presentation layer from inference (you'd drop custom tabs, layout,",
  "and state-keyed overrides). update_app REPLACES what you pass, so carry back the html/panels/params you",
  "aren't intentionally changing. You never need a browser to read an app's current markup — get_app has it.",
  "",
  "## The template (`html`)",
  "A self-contained HTML FRAGMENT: inline <style>/<script>, inline SVG. NO external/CDN assets and NO",
  "network — data is injected, not fetched (the iframe runs under a no-network CSP).",
  "Pass just the inner markup — NOT a full <!doctype>/<html>/<head>/<body> document (the runtime supplies",
  "that skeleton and wraps your fragment; a whole document is REJECTED by publish_app / update_app).",
  "",
  "## Preloaded helpers — prefer these over hand-rolled SVG/CSS",
  "`Setoku.stat(elId, panelKey, {label, value, format})` — `value` is the COLUMN NAME to read from the",
  "panel's first row. Also `Setoku.bar` / `Setoku.line` (`value` = the numeric column) and",
  "`Setoku.table(elId, panelKey, {format:{col:fmt}, labels:{col:'Label'}})`. They coerce numeric",
  "strings, size correctly, and render empty/error states.",
  "`format` is one of: money | int | num (default) | pct | raw — an unknown token renders unformatted.",
  "",
  "## Raw panel data",
  "`window.__SETOKU__.panels[<key>]` = `{ columns, rows, rowCount, truncated, computedAt, error }`.",
  "DB numerics arrive as STRINGS — wrap in Number() before any math.",
  "",
  "## Row limits",
  "A panel renders its FULL result set — no 200-row cap. The only bound is a ~3.5MB payload; past it the",
  "heaviest panel is trimmed to the rows that fit, `panels[key].truncated` is set, and the built-in",
  "Setoku.table appends a 'showing first N rows' note. If a panel could return an unbounded table,",
  "aggregate or add a page param rather than leaning on the byte trim. (Note: run_query itself still caps",
  "at ~200 rows — that's the model-context cap for the agent, NOT the app render cap.)",
  "",
  "## Panels (the `panels` arg)",
  "Each panel: `{ key, sql, dialect?, title?, description?, metricId? }`.",
  "- `key` — stable slug the template reads (window.__SETOKU__.panels[key]).",
  "- `sql` — ONE read-only SELECT/WITH; validate with run_query first.",
  "- `dialect` — `postgres` (default, business DB) or `clickhouse` (the lake + the biz.* business-DB mirror).",
  "- `title` / `description` — STRONGLY RECOMMENDED: shown in the 'how is this calculated' drawer; the",
  "  description is the ONLY calc explanation public viewers get. Without them viewers see the raw slug.",
  "- `metricId` — name of a curated metric this panel computes; links provenance to the verified def.",
  "Omit `panels` entirely for a static report.",
  "",
  "## Choosing a dialect — mirrored tables are clickhouse-ONLY",
  "When the box mirrors the business DB (list_sources shows a BUSINESS-DB MIRROR section), panels that",
  "touch a mirrored table MUST use `clickhouse` dialect against `biz.<table>` — publish/update REJECT",
  "postgres panels over mirrored tables (the mirror is the read path; full copies, reloaded on a cron).",
  "Param-driven panels especially benefit: every input combo is a cold run, and the mirror makes cold",
  "runs interactive. `postgres` remains only for tables the mirror doesn't carry. Metric SQL is",
  "canonical in exactly ONE dialect (I5) — define metrics over mirrored tables in clickhouse. The app",
  'chrome shows the mirror\'s "data as of" beside the cache stamp, so freshness stays legible to viewers.',
  "",
  "## Interactive inputs (the `params` arg)",
  "Declared inputs the viewer can change. A panel's SQL references one as `:name` (e.g.",
  "`WHERE region = :region`); the value is type-coerced and ENGINE-BOUND (never string-interpolated, so",
  "injection-safe — it can't name a table/column or drive a write). Each param:",
  "`{ name, type, default, label?, options?, min?, max?, maxLength? }` — `type` is date/int/text/bool/enum,",
  "`default` is REQUIRED (the app must render with no viewer input), `options` is the closed set for enum.",
  "",
  "## App state (interactive apps)",
  "The app has its OWN private datastore — it can persist state but CANNOT write your data sources:",
  "`Setoku.state.get(scope, key)` / `set(scope, key, value)` / `list(scope)` / `del(scope, key)` — all Promises.",
  "`scope` is \"app\" (shared by everyone who opens it — a team list, a poll tally) or \"viewer\" (private per user).",
  "Read state on load and re-render after each change. Use it for todos, votes, notes, or an annotation",
  "OVERLAY keyed by a business row id (mark rows reviewed without writing the source).",
  "",
  "## Minimal example",
  'panels: [{ key: "rev", title: "Revenue (2025)", description: "Sum of paid ticket prices, test excluded",',
  '          sql: "SELECT sum(amount_cents)/100.0 AS dollars FROM ..." }]',
  "html:   `<div id=\"rev\"></div><script>Setoku.stat('rev','rev',{label:'Revenue',value:'dollars',format:'money'})</script>`",
].join("\n");

server.registerTool(
  "app_guide",
  {
    annotations: { readOnlyHint: true },
    title: "How to build a Setoku app (read before publish_app / update_app)",
    description:
      "Call this FIRST whenever you're about to author or edit an app — the same way you call find_context " +
      "before querying. Returns the full template + Setoku.* helper + panels/params/state contract you need " +
      "to write a working template on the first try. Cheap; skipping it tends to produce a broken app.",
    inputSchema: {},
  },
  async () => {
    store.audit(user, "app_guide", {});
    return text(APP_GUIDE);
  },
);

server.registerTool(
  "publish_app",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    title: "Publish a live app to the box (team-shareable URL)",
    description:
      "Publishes an app backed by LIVE data and returns a shareable URL. Use this to SHARE a result with " +
      "the team as a link that stays current — not for answering in-session. " +
      "If you haven't already, call app_guide FIRST for the template + Setoku.* helper + panels/params contract. " +
      "`panels` are the live data bindings (each `sql` is a read-only query the box re-runs — validate with " +
      "run_query first); omit them for a static report. The link is TEAM-ONLY; an admin can later make it public. " +
      "Every panel is dry-run at publish (broken query → rejected). Edit later with update_app (same link); " +
      "also list_apps / get_app / unpublish_app.",
    inputSchema: {
      title: z.string().describe("Short human title (shown in the box's Apps list)"),
      html: z.string().describe("The presentation template (self-contained HTML fragment; use the Setoku.* helpers)."),
      panels: z.array(PANEL_SCHEMA).optional().describe("Live data bindings. Omit for a static report."),
      params: z
        .array(PARAM_SCHEMA)
        .optional()
        .describe(
          "Interactive viewer inputs; a panel's SQL references each as `:name`. Each needs a `default` so the app renders with no input. See app_guide.",
        ),
      refreshSeconds: z
        .number()
        .optional()
        .describe(`How often the box re-runs panels (default ${DEFAULT_REFRESH_SECONDS}, ${MIN_REFRESH_SECONDS}–${MAX_REFRESH_SECONDS})`),
    },
  },
  async ({ title, html, panels, params, refreshSeconds }) => {
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_REPORT_BYTES)
      return errorText(
        `Template is ${(bytes / 1e6).toFixed(1)} MB — over the ${MAX_REPORT_BYTES / 1e6} MB cap. Keep it a self-contained ` +
          "fragment; the live data arrives via panels, so don't embed bulk data in the template.",
      );
    // Every published app is a FRAGMENT — the runtime nests the body inside its
    // own document skeleton, so a full <!doctype>/<html> document renders wrong.
    // Reject one up front with a clear steer (the legacy raw-served "html" format
    // is gone; app_guide documents the fragment contract).
    if (isFullDoc(html))
      return errorText(
        "Publish a fragment, not a full HTML document. The app runtime wraps your template in its own " +
          "<!doctype>…<body> skeleton, so a whole <!doctype>/<html> document nests wrong. Drop the doctype/" +
          "<html>/<head>/<body> wrapper and pass just the inner markup (styles in a <style> tag are fine). See app_guide.",
      );
    const declaredParams = (params ?? []) as AppParam[];
    const prep = await prepPanels(panels ?? [], declaredParams);
    if (!prep.ok) return errorText(prep.error);
    const { normalized, seeds } = prep;

    const id = mintShareId();
    const refresh = clampRefresh(refreshSeconds, normalized.length > 0);
    store.createPublished({
      id,
      title: title.trim() || "Untitled app",
      body: html,
      panels: normalized,
      params: declaredParams.length ? declaredParams : null,
      refreshSeconds: refresh,
      createdBy: user,
    });
    for (const s of seeds)
      store.putPanelCache(id, s.key, { columns: s.columns, rows: s.rows, rowCount: s.rowCount, truncated: s.truncated, error: null });
    store.audit(user, "publish_app", { id, title, bytes, panels: normalized.length });
    // Announce it to the team channel (issue #63) — detached and best-effort, so
    // a slow/absent webhook never delays the publish response.
    void notifyActivity(projectDir, {
      kind: "app_published",
      title: title.trim() || "Untitled app",
      url: publishUrl(id),
      by: user,
      panels: normalized.length,
    });

    return text(
      `Published "${title}" → ${publishUrl(id)}\n\n` +
        (normalized.length ? `${normalized.length} live panel(s); the box re-runs them every ${refresh}s. ` : "") +
        "This link is TEAM-ONLY: anyone you share it with must sign in to the box to view it. " +
        (publishBase ? "" : "(Prefix the path above with your box URL.) ") +
        `\n\nEdit it with update_app("${id}", …) — same link. Manage: get_app / unpublish_app("${id}"). ` +
        "(An admin can make this app public from /admin.)" +
        (await publishNotes(html, normalized)),
    );
  },
);

server.registerTool(
  "update_app",
  {
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    title: "Edit an app you published (in place, same link)",
    description:
      "Updates an app you created — keeping its id and shareable link. Pass only what changes: `title`, `html` " +
      "(new template), `panels` (REPLACES the whole panel set), `params` (REPLACES all inputs), and/or `refreshSeconds`. " +
      "Changing `panels` or `params` re-validates and dry-runs every panel against the new params. " +
      "Only the app's AUTHOR can edit it. " +
      "Note: changing `panels` or `params` on an app that's currently public reverts it to team-only — an admin " +
      "must re-approve it for the public link, since the data it exposes changed. " +
      "Pass a `message` describing WHAT changed — it shows in the app's version history and the team's activity " +
      "notification. " +
      "The `html` template + `Setoku.*` helper + panels/params contract is documented by app_guide — call it if you haven't.",
    inputSchema: {
      id: z.string().describe("The app id (from publish_app / list_apps)"),
      title: z.string().optional().describe("New title"),
      html: z.string().optional().describe("New presentation template (replaces the current one)"),
      panels: z.array(PANEL_SCHEMA).optional().describe("New panel set — REPLACES all panels. Pass [] for a state-only or static app."),
      params: z.array(PARAM_SCHEMA).optional().describe("New interactive inputs — REPLACES all params (pass [] to remove). See publish_app."),
      refreshSeconds: z.number().optional().describe(`New refresh interval (${MIN_REFRESH_SECONDS}–${MAX_REFRESH_SECONDS})`),
      message: z
        .string()
        .optional()
        .describe('A short note on WHAT changed, shown in version history and the activity notification (e.g. "Added a weekly revenue panel").'),
    },
  },
  async ({ id, title, html, panels, params, refreshSeconds, message }) => {
    const tid = id.trim();
    const meta = store.getPublishedMeta(tid);
    if (!meta || meta.archivedAt)
      return errorText(`No active app "${id}" (archived or unknown). Call list_apps.`);
    if (meta.createdBy !== user)
      return errorText(`Only the author (${meta.createdBy}) can edit this app. Publish your own with publish_app.`);
    const newTitle = title?.trim() || undefined; // whitespace-only title is a no-op, not a change
    if (newTitle === undefined && html === undefined && panels === undefined && params === undefined && refreshSeconds === undefined)
      return errorText("Nothing to update — pass a non-empty title, or html / panels / params / refreshSeconds.");
    if (html !== undefined) {
      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > MAX_REPORT_BYTES)
        return errorText(`Template is ${(bytes / 1e6).toFixed(1)} MB — over the ${MAX_REPORT_BYTES / 1e6} MB cap.`);
      // Same one-model rule as publish_app: a published app is a FRAGMENT the
      // runtime wraps, so a full <!doctype>/<html> document can't replace it.
      if (isFullDoc(html))
        return errorText(
          "Update with a fragment, not a full HTML document. The app runtime wraps your template in its own " +
            "<!doctype>…<body> skeleton. Drop the doctype/<html>/<head>/<body> wrapper and pass just the inner markup. See app_guide.",
        );
    }
    // Whitespace-only message is a no-op (same as an unset one); a real note is
    // capped to a sentence — it's a changelog line, not a document.
    const note = message?.trim() || undefined;
    if (note && note.length > MAX_UPDATE_MESSAGE_CHARS)
      return errorText(`message is ${note.length} chars — keep it under ${MAX_UPDATE_MESSAGE_CHARS} (a one-line summary of what changed).`);

    // Panels AND params both determine what the panels compute (params bind into
    // the SQL), so a change to EITHER must be validated and re-seeded — and, on a
    // public app, re-gated (I9). Re-run the shared prep over the EFFECTIVE panel
    // set against the EFFECTIVE params whenever either changes: this validates the
    // new param defaults/names, re-checks every existing panel still compiles
    // against the new params (a removed/renamed param would otherwise 500 the app
    // at render), and re-seeds the default-variant cache.
    const panelsChanged = panels !== undefined;
    const paramsChanged = params !== undefined;
    const dataChanged = panelsChanged || paramsChanged;
    const declaredParams = paramsChanged ? (params as AppParam[]) : (meta.params ?? []);
    let normalized: AppPanel[] | undefined;
    let seeds: PanelSeed[] | undefined;
    if (dataChanged) {
      const basePanels: PanelInput[] = panelsChanged
        ? panels
        : (meta.panels ?? []).map((p) => ({ key: p.key, title: p.title, description: p.description, sql: p.sql, dialect: p.dialect, metricId: p.metricId ?? undefined }));
      // Only DRY-RUN (execute) when the SQL itself changed; a params-only edit just
      // validates + recompiles existing panels against the new params (no prod hit,
      // not blocked by an unrelated broken panel).
      const prep = await prepPanels(basePanels, declaredParams, { seed: panelsChanged });
      if (!prep.ok) return errorText(prep.error);
      normalized = prep.normalized;
      seeds = prep.seeds;
    }

    const willHavePanels = normalized ? normalized.length > 0 : (meta.panels?.length ?? 0) > 0;
    let refresh: number | null | undefined;
    if (refreshSeconds !== undefined) refresh = clampRefresh(refreshSeconds, willHavePanels);
    else if (panelsChanged) refresh = willHavePanels ? (meta.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) : null;

    const ok = store.updatePublished(tid, {
      title: newTitle,
      body: html,
      // Only rewrite panels (which clears the cache) when the SQL actually changed.
      // A params-only edit leaves the cache intact: each panel/param VARIANT is a
      // distinct cache key (the resolved values are hashed in), so the new default
      // simply maps to a fresh key and recomputes lazily — no cold-start stampede,
      // and untouched variants stay warm.
      panels: panelsChanged ? normalized : undefined,
      params: paramsChanged ? (params as AppParam[]) : undefined,
      refreshSeconds: refresh,
    }, { editor: user, note });
    if (!ok) return errorText(`Update failed — no active app "${id}".`);
    // Re-seed the cache for the re-derived panels (updatePublished cleared the old rows).
    if (seeds) for (const s of seeds) store.putPanelCache(tid, s.key, { columns: s.columns, rows: s.rows, rowCount: s.rowCount, truncated: s.truncated, error: null });

    // Panels OR params alter what the public link exposes — if it was public,
    // revert to team so an admin re-approves (the human promotion gate, I9).
    let reverted = false;
    if (dataChanged && meta.visibility === "public") {
      store.setReportVisibility(tid, "team");
      reverted = true;
    }
    store.audit(user, "update_app", {
      id: tid,
      changed: [newTitle !== undefined && "title", html !== undefined && "html", panelsChanged && "panels", paramsChanged && "params", refreshSeconds !== undefined && "refreshSeconds"].filter(Boolean),
      reverted,
    });
    // Announce it to the team channel (issue #63). The changed-facet vocabulary
    // matches the version-history drawer (content/data/inputs) so the note and
    // the UI read the same way. Detached + best-effort — never blocks the reply.
    const changedFacets = [
      newTitle !== undefined && "title",
      html !== undefined && "content",
      panelsChanged && "data",
      paramsChanged && "inputs",
      refreshSeconds !== undefined && "refresh",
    ].filter(Boolean) as string[];
    void notifyActivity(projectDir, {
      kind: "app_updated",
      title: newTitle ?? meta.title,
      url: publishUrl(tid, reverted ? "team" : meta.visibility),
      by: user,
      changed: changedFacets,
      message: note,
    });

    const finalHtml = html ?? store.getPublished(tid)?.body ?? "";
    const finalPanels = normalized ?? meta.panels ?? [];
    return text(
      `Updated "${meta.title}" → ${publishUrl(tid, reverted ? "team" : meta.visibility)} (same link).` +
        (reverted ? "\n\n⚠ Panels or params changed on a PUBLIC app — reverted to team-only; an admin must re-publish it publicly from /admin." : "") +
        (await publishNotes(finalHtml, finalPanels)),
    );
  },
);

server.registerTool(
  "list_apps",
  {
    annotations: { readOnlyHint: true },
    title: "List apps published to the box",
    description:
      "Lists apps/reports published to this box (active first), with their shareable URLs, panel counts, " +
      "and who published them. Use it to find a link again, or an id to inspect (get_app) or revoke.",
    inputSchema: {},
  },
  async () => {
    const rows = store.listPublished();
    store.audit(user, "list_apps", { count: rows.length });
    if (!rows.length) return text("Nothing published yet. Create one with publish_app.");
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
      lines.push("No active apps (all archived).");
    }
    if (archived.length) {
      lines.push("", "# archived", ...archived.map((r) => `- ${r.title} (id ${r.id})`));
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "get_app",
  {
    annotations: { readOnlyHint: true },
    title: "Inspect an app — its full template + panels (how it's built)",
    description:
      "Returns everything needed to edit a published app in place: the full presentation TEMPLATE " +
      "(the exact `html`/JS you'd pass back to update_app), its interactive `params`, and each panel's " +
      "SQL, dialect, linked metric, and when it last ran. Read this FIRST when iterating on an app so " +
      "you edit the existing template rather than rebuilding it from scratch (update_app REPLACES what " +
      "you pass). Read-only.",
    inputSchema: { id: z.string().describe("The app id from publish_app / list_apps") },
  },
  async ({ id }) => {
    // Full record (incl. the up-to-2MB template body) — get_app is the low-rate
    // read-before-edit path, so we serve the whole template, not the body-less
    // meta the hot viewer/gating paths use.
    const dash = store.getPublished(id.trim());
    store.audit(user, "get_app", { id, ok: !!dash });
    if (!dash || dash.archivedAt)
      return errorText(`No active app "${id}" (archived or unknown). Call list_apps.`);
    const lines: string[] = [
      `# ${dash.title} [${dash.format}] — ${publishUrl(dash.id, dash.visibility)}`,
      `by ${dash.createdBy} · ${dash.createdAt.slice(0, 16)} · visibility ${dash.visibility}` +
        (dash.refreshSeconds ? ` · refresh ${dash.refreshSeconds}s` : ""),
      "",
    ];
    // Params first — update_app REPLACES the whole param set, so a round-trip
    // must carry them back VERBATIM. Emit them as the exact `params` arg JSON
    // (labels, options, min/max/maxLength and all) rather than a lossy human
    // summary — same fidelity the body/SQL get from their fenced blocks.
    const params = dash.params ?? [];
    if (params.length) {
      lines.push(
        "## params (interactive inputs, bound in panel SQL as `:name` — pass this array straight back to update_app)",
        "```json",
        JSON.stringify(params, null, 2),
        "```",
        "",
      );
    }
    const ps = dash.panels ?? [];
    if (!ps.length) {
      lines.push("(no live panels — a static report.)", "");
    }
    for (const p of ps) {
      const cache = store.getPanelCache(dash.id, p.key);
      lines.push(
        `## panel ${p.key}${p.title ? ` — ${p.title}` : ""} [${p.dialect}]${p.metricId ? ` · metric:${p.metricId}` : ""}`,
      );
      // Surface description so a read-before-edit (get_app → update_app)
      // round-trip can preserve it — update_app REPLACES the whole panel set.
      if (p.description) lines.push(`description: ${p.description}`);
      if (cache) {
        // Duration is the "which panel is slow" signal for an iterating agent —
        // a multi-second panel is the one to rewrite (or point at the lake).
        const took = cache.durationMs == null ? "" : ` in ${cache.durationMs >= 1000 ? `${(cache.durationMs / 1000).toFixed(1)}s` : `${cache.durationMs}ms`}`;
        lines.push(
          `last run ${cache.computedAt.slice(0, 16)}${took} — ${cache.error ? `ERROR: ${cache.error}` : `${cache.rowCount} row(s)`}`,
        );
      }
      lines.push("```sql", p.sql.trim(), "```", "");
    }
    // The presentation template last — it's the biggest section, and the exact
    // `html` an agent edits and passes straight back to update_app.
    lines.push("## template (the `html` — edit this and pass it back to update_app)", "```html", dash.body, "```");
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "unpublish_app",
  {
    annotations: { readOnlyHint: false, destructiveHint: true },
    title: "Archive a published app",
    description:
      "Archives a published app/report by its id (from list_apps). The link stops working " +
      "immediately and its cached data is dropped; the record is kept for the audit trail.",
    inputSchema: { id: z.string().describe("The app id from publish_app / list_apps") },
  },
  async ({ id }) => {
    const ok = store.archivePublished(id.trim());
    store.audit(user, "unpublish_app", { id, ok });
    return ok
      ? text(`Archived ${id} — its link no longer works.`)
      : errorText(`No active app with id "${id}" (already archived, or unknown id). Call list_apps to check.`);
  },
);


  return server;
}
