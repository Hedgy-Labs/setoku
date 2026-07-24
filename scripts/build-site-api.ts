#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// Generate the machine-readable half of setoku.com — the files agents fetch
// rather than read:
//
//   site/openapi.json        OpenAPI 3.1 for the Setoku gateway HTTP API
//   site/api/openapi.json    the same document, at the other conventional path
//   site/api/index.json      catalog root: what Setoku is, how to install it
//   site/api/tools.json      the MCP tool surface, with the role each tool needs
//   site/api/connectors.json the sources that land in the lake
//
// These are DERIVED (version from the plugin manifest, tools + their capability
// gating from gateway/app.ts, connectors from ingest/schemas) so they cannot
// drift from the product the way a hand-maintained JSON file would. They are
// committed build artifacts, like the admin bundles: re-run `bun run build:site`
// and commit the result after changing the tool surface or adding a connector.
//
// Usage:  bun run build:site
import { mkdirSync } from "node:fs";

import { DEMO_MCP_URL } from "../demo/connector";

const ROOT = new URL("..", import.meta.url).pathname;
const SITE = "https://setoku.com";
const REPO = "https://github.com/Hedgy-Labs/setoku";

const read = (p: string) => Bun.file(ROOT + p).text();

/* ------------------------------ derived facts ----------------------------- */

const manifest = JSON.parse(await read("plugin/.claude-plugin/plugin.json")) as {
  version: string;
  description: string;
};
const VERSION = manifest.version;

/**
 * The tool surface, read out of `buildServer()`. Capability gating is derived
 * from the `if (canWrite) { … }` / `if (canDraft) …` / `if (canReject) …`
 * blocks rather than restated here — a tool that moves inside or outside one of
 * those blocks changes this output automatically (I2: the membrane is the whole
 * point of publishing which role a tool needs).
 */
async function tools(): Promise<
  { name: string; title: string; role: string; readOnly: boolean }[]
> {
  const src = await read("plugin/gateway/app.ts");
  const blockRange = (open: string, close: string): [number, number] | null => {
    const a = src.indexOf(open);
    const b = src.indexOf(close);
    return a < 0 || b < 0 ? null : [a, b];
  };
  const gates: [string, [number, number] | null][] = [
    ["curator", blockRange("if (canWrite) {", "} // end canWrite")],
    ["janitor", blockRange("if (canDraft) {", "} // end canDraft")],
    ["janitor", blockRange("if (canReject) {", "} // end canReject")],
  ];

  const out: { name: string; title: string; role: string; readOnly: boolean }[] = [];
  const re = /server\.registerTool\(\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const at = m.index;
    const chunk = src.slice(at, at + 1200);
    const title = chunk.match(/title:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
    const readOnly = /readOnlyHint:\s*true/.test(chunk.slice(0, 400));
    const gate = gates.find(([, r]) => r && at > r[0] && at < r[1]);
    out.push({
      name: m[1],
      title: title.replace(/\\"/g, '"'),
      role: gate ? gate[0] : "analyst",
      readOnly,
    });
  }
  return out;
}

/** Connectors, keyed off the lake schemas that actually exist in ingest/. */
async function connectors(): Promise<{ id: string; name: string; data: string }[]> {
  const glob = new Bun.Glob("*.sql");
  const schemas = new Set<string>();
  for await (const f of glob.scan({ cwd: ROOT + "ingest/schemas" })) schemas.add(f);
  const has = (frag: string) => [...schemas].some((s) => s.includes(frag));

  const all: { id: string; name: string; data: string; when: boolean }[] = [
    { id: "postgres", name: "PostgreSQL", data: "your app database, mirrored read-only into biz.*", when: has("pg_mirror") },
    { id: "github", name: "GitHub", data: "issues, pull requests, commits, comments", when: has("github_") },
    { id: "vercel", name: "Vercel", data: "deploys and logs", when: has("logs_vercel") },
    { id: "render", name: "Render", data: "deploys and logs", when: has("logs_render") },
    { id: "slack", name: "Slack", data: "messages", when: has("slack_messages") },
    { id: "mercury", name: "Mercury", data: "accounts and transactions", when: has("mercury_") },
    { id: "monarch", name: "Monarch", data: "accounts, transactions, net worth, budgets, holdings", when: has("monarch_") },
    { id: "gmail", name: "Gmail", data: "messages, per-mailbox OAuth", when: has("gmail_messages") },
  ];
  return all.filter((c) => c.when).map(({ when: _when, ...c }) => c);
}

/* --------------------------------- OpenAPI -------------------------------- */

/**
 * The API described here is the one every self-hosted Setoku box exposes, so
 * `servers` is templated on the operator's own hostname rather than pointing at
 * setoku.com (which serves this spec and the marketing site, not a gateway).
 * The public demo box is listed as a concrete, reachable example.
 */
function openapi(toolNames: string[]) {
  const json = (schema: unknown) => ({ "application/json": { schema } });
  return {
    openapi: "3.1.0",
    info: {
      title: "Setoku Gateway API",
      version: VERSION,
      summary: "The HTTP surface of a self-hosted Setoku MCP knowledge server.",
      description:
        "Setoku is an open-source, self-hosted MCP server that gives an AI agent a read-only, " +
        "audited view of a company's data plus the curated context needed to use it correctly.\n\n" +
        "Every Setoku box exposes this API. There is no multi-tenant setoku.com API: the product " +
        "is single-tenant by design and runs on infrastructure you own, so point `host` at your " +
        "own deployment (or at the public demo box).\n\n" +
        "The primary interface is MCP over Streamable HTTP at `/mcp`, which carries " +
        `${toolNames.length} tools (see https://setoku.com/api/tools.json). The REST endpoints ` +
        "below are the credential-free surface: box health, and published apps.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      contact: { name: "Setoku", url: `${SITE}/developers`, email: "hello@setoku.com" },
    },
    externalDocs: { description: "Setoku developer documentation", url: `${SITE}/developers` },
    servers: [
      {
        url: "https://{host}",
        description: "Your Setoku box",
        variables: { host: { default: "demo.setoku.com", description: "Hostname of your Setoku deployment" } },
      },
      { url: "https://demo.setoku.com", description: "Public demo box (synthetic sports-club dataset)" },
    ],
    tags: [
      { name: "MCP", description: "The Model Context Protocol endpoint — the main interface." },
      { name: "Health", description: "Liveness and dependency status." },
      { name: "Apps", description: "Published apps: live, read-only views built by an agent." },
      { name: "Install", description: "One-line installer." },
    ],
    components: {
      securitySchemes: {
        bearerToken: {
          type: "http",
          scheme: "bearer",
          description:
            "A per-person connector token. Send it as `Authorization: Bearer <token>`, or as a " +
            "path segment (`/mcp/<token>`) for MCP clients whose connector dialog has no header " +
            "field. The token identifies one person and is revocable from the box's web console. " +
            "Treat the whole URL as a credential, like a database connection string.\n\n" +
            "OAuth 2.0 is scoped but deliberately not shipped; see " +
            "https://setoku.com/developers#auth.",
        },
      },
      schemas: {
        Health: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            version: { type: "string", examples: [VERSION] },
            docs: { type: "integer", description: "Curated knowledge documents in the store." },
            disk: {
              type: "object",
              properties: { dir: { type: "string" }, used_pct: { type: "integer" } },
            },
            deps: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  ms: { type: "integer" },
                  error: { type: "string" },
                },
              },
            },
            mirror: {
              type: "object",
              description: "Business-DB mirror freshness. Informational; never flips `ok`.",
              properties: {
                asOf: { type: ["string", "null"], format: "date-time" },
                tables: { type: "integer" },
              },
            },
          },
          required: ["ok", "version"],
        },
        AppData: {
          type: "object",
          description:
            "Freshness metadata for a published app. Deliberately exposes no calculations: " +
            "no SQL, no metric definitions, no schema.",
          properties: {
            title: { type: "string" },
            refreshSeconds: { type: ["integer", "null"] },
            updatedAt: { type: ["string", "null"], format: "date-time" },
            mirrorAsOf: { type: ["string", "null"], format: "date-time" },
          },
        },
        AppState: {
          type: "object",
          description:
            "An app's own key/value store. Sandboxed to the app: it can never reach a business source.",
          properties: {
            ok: { type: "boolean" },
            entries: { type: "array", items: { type: "object" } },
          },
        },
        Error: {
          type: "object",
          properties: { ok: { type: "boolean" }, error: { type: "string" } },
        },
      },
    },
    paths: {
      "/mcp": {
        post: {
          tags: ["MCP"],
          operationId: "mcp",
          summary: "Model Context Protocol endpoint (Streamable HTTP)",
          description:
            "Speaks MCP over Streamable HTTP. Point any MCP client at this URL. The server is " +
            "stateless per request: identity is bound from the bearer token, and the tools that " +
            "get registered depend on that identity's role.\n\n" +
            "An analyst token may read the data lake but holds no tool that commits knowledge. A " +
            "curator token may commit knowledge but cannot read the lake. The two never coexist " +
            "on one session, so a prompt-injected session cannot weaponize the write path.",
          security: [{ bearerToken: [] }],
          requestBody: {
            required: true,
            description: "A JSON-RPC 2.0 message, per the MCP specification.",
            content: json({ type: "object", description: "JSON-RPC 2.0 request" }),
          },
          responses: {
            "200": {
              description: "JSON-RPC response, or an SSE stream when the client accepts text/event-stream.",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            "401": { description: "Missing, unknown, or revoked token." },
          },
        },
      },
      "/mcp/{token}": {
        post: {
          tags: ["MCP"],
          operationId: "mcpTokenInPath",
          summary: "MCP endpoint with the token in the path",
          description:
            "Identical to `POST /mcp`, but authenticated by a path segment. This exists because " +
            "some MCP connector dialogs accept only a URL, with nowhere to put a header.",
          parameters: [
            { name: "token", in: "path", required: true, schema: { type: "string" }, description: "Connector token." },
          ],
          requestBody: { required: true, content: json({ type: "object" }) },
          responses: { "200": { description: "JSON-RPC response." }, "401": { description: "Unknown or revoked token." } },
        },
      },
      "/healthz": {
        get: {
          tags: ["Health"],
          operationId: "healthz",
          summary: "Aggregate health",
          description:
            "Knowledge-store size, data-disk usage, dependency pings, and mirror freshness. " +
            "Credential-free, and cached about 5 seconds so polling it amplifies nothing. " +
            "Returns 503 when a dependency fails or the data disk is at least 90% full.",
          security: [],
          responses: {
            "200": { description: "Healthy.", content: json({ $ref: "#/components/schemas/Health" }) },
            "503": { description: "A dependency is down, or the data disk is nearly full.", content: json({ $ref: "#/components/schemas/Health" }) },
          },
        },
      },
      "/health": {
        get: {
          tags: ["Health"],
          operationId: "health",
          summary: "Liveness probe",
          description: "Cheap liveness check used by the reverse proxy during deploys.",
          security: [],
          responses: { "200": { description: "The gateway is listening." } },
        },
      },
      "/p/{id}": {
        get: {
          tags: ["Apps"],
          operationId: "getApp",
          summary: "A published app",
          description:
            "The shell page for an app an agent built and published. Reachable without " +
            "credentials only for apps an admin has explicitly made public; team-visibility and " +
            "archived apps return 404 here.",
          security: [],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "The app shell.", content: { "text/html": { schema: { type: "string" } } } },
            "404": { description: "No such public app." },
          },
        },
      },
      "/p/{id}/data": {
        get: {
          tags: ["Apps"],
          operationId: "getAppData",
          summary: "Freshness metadata for a published app",
          description:
            "Returns when the app's panels were last computed. Reads cached values; it never " +
            "re-runs a query, so this credential-free poll cannot drive load onto your data.",
          security: [],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Freshness metadata.", content: json({ $ref: "#/components/schemas/AppData" }) },
            "404": { description: "No such public app, or the app has no data panels." },
          },
        },
      },
      "/p/{id}/state": {
        get: {
          tags: ["Apps"],
          operationId: "getAppState",
          summary: "Read an app's sandboxed state",
          security: [],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "scope",
              in: "query",
              schema: { type: "string", enum: ["app", "viewer"], default: "app" },
              description: "`app` is shared by everyone with the link; `viewer` is keyed to an anonymous per-browser id.",
            },
            { name: "owner", in: "query", schema: { type: "string" }, description: "Anonymous viewer id. Required when scope=viewer." },
          ],
          responses: {
            "200": { description: "The app's entries.", content: json({ $ref: "#/components/schemas/AppState" }) },
            "400": { description: "Bad scope." },
            "404": { description: "No such public app." },
          },
        },
        post: {
          tags: ["Apps"],
          operationId: "setAppState",
          summary: "Write an app's sandboxed state",
          description:
            "Sets or deletes one key. This store belongs to the app, not to your database: an " +
            "app can only ever mess up its own notes, and it stays inside a size quota.",
          security: [],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "scope", in: "query", schema: { type: "string", enum: ["app", "viewer"], default: "app" } },
          ],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              properties: {
                op: { type: "string", enum: ["set", "delete"] },
                key: { type: "string" },
                value: {},
                owner: { type: "string", description: "Anonymous viewer id. Required when scope=viewer." },
              },
              required: ["op", "key"],
            }),
          },
          responses: {
            "200": { description: "Applied.", content: json({ $ref: "#/components/schemas/AppState" }) },
            "400": { description: "Bad scope or operation.", content: json({ $ref: "#/components/schemas/Error" }) },
            "413": { description: "The app's storage quota is full.", content: json({ $ref: "#/components/schemas/Error" }) },
            "404": { description: "No such public app." },
          },
        },
      },
      "/i/{token}": {
        get: {
          tags: ["Install"],
          operationId: "installer",
          summary: "One-line installer script",
          description:
            "Returns a shell script that configures an MCP client for this box, personalized to " +
            "the token. Intended for `curl -fsSL https://<host>/i/<token> | sh`.",
          security: [],
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "A shell script.", content: { "text/x-shellscript": { schema: { type: "string" } } } },
            "404": { description: "Unknown token." },
          },
        },
      },
    },
  };
}

/* --------------------------------- emit ----------------------------------- */

const toolList = await tools();
const connectorList = await connectors();
const spec = openapi(toolList.map((t) => t.name));

const NOTE =
  "Generated by scripts/build-site-api.ts from the Setoku source tree — do not edit by hand.";

const index = {
  $schema: `${SITE}/api/index.json`,
  name: "Setoku",
  tagline: "Make any AI fluent in your company data.",
  description: manifest.description,
  version: VERSION,
  license: "Apache-2.0",
  self_hosted: true,
  hosted_service: false,
  links: {
    homepage: `${SITE}/`,
    developers: `${SITE}/developers`,
    openapi: `${SITE}/openapi.json`,
    llms_txt: `${SITE}/llms.txt`,
    tools: `${SITE}/api/tools.json`,
    connectors: `${SITE}/api/connectors.json`,
    repository: REPO,
    issues: `${REPO}/issues`,
    contact: "mailto:hello@setoku.com",
  },
  mcp: {
    transport: "streamable-http",
    path: "/mcp",
    tool_count: toolList.length,
    auth: {
      type: "bearer",
      accepted_in: ["authorization-header", "url-path"],
      oauth2: false,
      note:
        "Per-person, revocable connector tokens. OAuth 2.0 is scoped but not shipped; " +
        `see ${SITE}/developers#auth.`,
    },
    public_demo: {
      url: DEMO_MCP_URL,
      description:
        "A live, credential-free demo box wired to a synthetic pro-sports-club dataset. " +
        "The token is public on purpose. Read-only.",
    },
  },
  install: {
    claude_code_plugin: [
      "/plugin marketplace add Hedgy-Labs/setoku",
      "/plugin install setoku@setoku",
      "/setoku:onboard",
    ],
    server_by_hand: [
      `git clone ${REPO} /opt/setoku`,
      "cd /opt/setoku",
      "SETOKU_ADMIN_USER=you ./deploy/bootstrap.sh",
    ],
    requirements: "One small VPS (about $5–12/month). No AI model runs on the server.",
  },
  note: NOTE,
};

const out: [string, unknown][] = [
  ["site/openapi.json", spec],
  ["site/api/openapi.json", spec],
  ["site/api/index.json", index],
  [
    "site/api/tools.json",
    {
      name: "Setoku MCP tools",
      description:
        "The tool surface of a Setoku box. Which tools a session actually sees depends on its " +
        "token's role: an analyst may read the lake but cannot commit knowledge; a curator may " +
        "commit knowledge but cannot read the lake.",
      version: VERSION,
      roles: {
        analyst: "Reads data and curated context. May only propose knowledge changes.",
        curator: "Commits curated knowledge. Cannot read the data lake.",
        janitor: "Drafts and auto-rejects pending corrections. Commits nothing.",
      },
      tools: toolList,
      note: NOTE,
    },
  ],
  [
    "site/api/connectors.json",
    {
      name: "Setoku connectors",
      description:
        "Sources Setoku ingests into its local ClickHouse lake. No connector for yours? The " +
        "/setoku:connect skill gives a coding agent the patterns to wire one up.",
      version: VERSION,
      connectors: connectorList,
      note: NOTE,
    },
  ],
];

mkdirSync(ROOT + "site/api", { recursive: true });
for (const [p, body] of out) {
  await Bun.write(ROOT + p, JSON.stringify(body, null, 2) + "\n");
  console.log(`  ${p}`);
}
console.log(`✓ site API built — v${VERSION}, ${toolList.length} tools, ${connectorList.length} connectors`);
