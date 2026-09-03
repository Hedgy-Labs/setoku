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
//   site/.well-known/mcp.json                    where the MCP server is, how to auth
//   site/.well-known/agent-card.json             A2A-style card: who we are, what we do
//   site/.well-known/agent-skills/index.json     the shipped skills, name + description
//   site/index.md            markdown twin of the homepage (agents fetch this)
//   site/docs.md             markdown twin of /docs (the API reference)
//   site/llms.txt            the prose entry point, sharing one when-to-use source
//
// These are DERIVED (version from the plugin manifest, tools + their capability
// gating from gateway/app.ts, connectors from ingest/schemas) so they cannot
// drift from the product the way a hand-maintained JSON file would. They are
// committed build artifacts, like the admin bundles: re-run `bun run build:site`
// and commit the result after changing the tool surface or adding a connector.
//
// Usage:  bun run build:site
import { mkdirSync } from "node:fs";

import {
  DEMO_BASE_URL,
  DEMO_MCP_URL,
  DEMO_PUBLIC_APPS,
  demoAppUrl,
} from "../demo/connector";

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
  // THROW rather than degrade. These markers are only comments, so a refactor can
  // rename one without any test or typecheck noticing — and a null range used to
  // mean "no gate matched", i.e. every curator/janitor tool silently republished
  // as `analyst`. That would put a false statement of the membrane (I2) on a
  // public URL, which is worse than a failed build.
  const blockRange = (open: string, close: string): [number, number] => {
    const a = src.indexOf(open);
    const b = src.indexOf(close);
    if (a < 0 || b < 0 || b < a) {
      throw new Error(
        `build-site-api: cannot locate the capability block ${open} … ${close} in ` +
          `plugin/gateway/app.ts. Role gating is derived from those markers, so the ` +
          `published tool catalog would misstate which role each tool needs (I2). ` +
          `Restore the marker, or update blockRange() to match the new structure.`,
      );
    }
    return [a, b];
  };
  const gates: [string, [number, number]][] = [
    ["curator", blockRange("if (canWrite) {", "} // end canWrite")],
    ["janitor", blockRange("if (canDraft) {", "} // end canDraft")],
    ["janitor", blockRange("if (canReject) {", "} // end canReject")],
  ];

  const out: { name: string; title: string; role: string; readOnly: boolean }[] = [];
  // Tool names are conventionally lower_snake_case, but the regex must not be
  // NARROWER than what registerTool accepts: a name with a digit (get_metric_v2)
  // silently vanished from the catalog, and the test reused this same pattern so
  // it compared two equally-truncated lists and passed.
  const re = /server\.registerTool\(\s*"([^"]+)"/g;
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

/**
 * Connectors, keyed off the lake schemas that actually exist in ingest/.
 *
 * The prose (name, blurb) is human-written — a schema file can't tell you that
 * Gmail is per-mailbox OAuth. What IS derived is membership, in BOTH directions:
 * an entry with no matching schema is dropped, and a schema matching no entry is
 * a hard error. Without that second direction this was a hardcoded array wearing
 * a derivation costume: adding ingest/schemas/090_stripe_charges.sql would have
 * changed nothing, and /docs tells agents this file "tracks the release".
 */
const CONNECTOR_CATALOG: { id: string; name: string; data: string; match: RegExp }[] = [
  { id: "postgres", name: "PostgreSQL", data: "your app database, mirrored read-only into biz.*", match: /pg_mirror/ },
  { id: "github", name: "GitHub", data: "issues, pull requests, commits, comments", match: /github_/ },
  { id: "vercel", name: "Vercel", data: "deploys and logs", match: /logs_vercel/ },
  { id: "render", name: "Render", data: "deploys and logs", match: /logs_render/ },
  { id: "slack", name: "Slack", data: "messages", match: /slack_messages/ },
  { id: "mercury", name: "Mercury", data: "accounts and transactions", match: /mercury_/ },
  { id: "monarch", name: "Monarch", data: "accounts, transactions, net worth, budgets, holdings", match: /monarch_/ },
  { id: "gmail", name: "Gmail", data: "messages, per-mailbox OAuth", match: /gmail_messages/ },
];

/** Lake plumbing, not a data source — these schemas intentionally have no entry. */
const NON_CONNECTOR_SCHEMAS = /(ingest_raw|app_events|ingest_heartbeats)/;

async function connectors(): Promise<{ id: string; name: string; data: string }[]> {
  const glob = new Bun.Glob("*.sql");
  const schemas: string[] = [];
  for await (const f of glob.scan({ cwd: ROOT + "ingest/schemas" })) schemas.push(f);

  const unclaimed = schemas.filter(
    (s) => !NON_CONNECTOR_SCHEMAS.test(s) && !CONNECTOR_CATALOG.some((c) => c.match.test(s)),
  );
  if (unclaimed.length) {
    throw new Error(
      `build-site-api: ingest schema(s) with no connector-catalog entry: ${unclaimed.join(", ")}. ` +
        `setoku.com/api/connectors.json is advertised as tracking the release, so a new source ` +
        `must be described there. Add an entry to CONNECTOR_CATALOG (or, if this schema is lake ` +
        `plumbing rather than a source, to NON_CONNECTOR_SCHEMAS).`,
    );
  }

  return CONNECTOR_CATALOG.filter((c) => schemas.some((s) => c.match.test(s))).map(
    ({ match: _match, ...c }) => c,
  );
}

/**
 * The shipped skills, read out of each `plugin/skills/<name>/SKILL.md`.
 *
 * These are what an agent can actually be asked to do with Setoku, so they are
 * what the discovery files publish as "capabilities". Derived rather than
 * restated: adding a skill directory publishes it, and a skill whose frontmatter
 * lost its description is a hard error rather than a blank entry on a public URL.
 */
async function skills(): Promise<{ id: string; name: string; description: string }[]> {
  const glob = new Bun.Glob("*/SKILL.md");
  const found: { id: string; name: string; description: string }[] = [];
  for await (const f of glob.scan({ cwd: ROOT + "plugin/skills" })) {
    const dir = f.split("/")[0];
    const src = await read(`plugin/skills/${f}`);
    const fm = src.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name || !description) {
      throw new Error(
        `build-site-api: plugin/skills/${dir}/SKILL.md has no ${name ? "description" : "name"} in ` +
          `its frontmatter. The skill index at ${SITE}/.well-known/agent-skills/index.json is ` +
          `derived from it, and an entry with a missing name or description is worse than no ` +
          `entry — agents parse that file to decide whether to reach for us.`,
      );
    }
    found.push({ id: `setoku:${name}`, name, description });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
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
        "audited view of its operator's own data plus the curated context needed to use it correctly.\n\n" +
        "Every Setoku box exposes this API. There is no multi-tenant setoku.com API: the product " +
        "is single-tenant by design and runs on infrastructure you own, so point `host` at your " +
        "own deployment (or at the public demo box).\n\n" +
        "The primary interface is MCP over Streamable HTTP at `/mcp`, which carries " +
        `${toolNames.length} tools (see https://setoku.com/api/tools.json). The REST endpoints ` +
        "below are the credential-free surface: box health, and published apps.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      contact: { name: "Setoku", url: `${SITE}/docs`, email: "hello@setoku.com" },
    },
    externalDocs: { description: "Setoku API reference", url: `${SITE}/docs` },
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
            "https://setoku.com/docs#auth.",
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
      "/p/{id}/files/{name}": {
        get: {
          tags: ["Apps"],
          operationId: "getAppFile",
          summary: "A shared file, or an app's attachment",
          description:
            "The bytes of a file an agent shared with publish_file (a CSV, a memo, an image, a PDF), " +
            "or of a file attached to an app. Reachable without credentials only once an admin has " +
            "made the record public; a shared password on the link gates this path too. Served with " +
            "the type derived from the file's extension, nosniff, and as an attachment unless the " +
            "type is inert (images, PDF, plain text). Never HTML.",
          security: [],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "name", in: "path", required: true, schema: { type: "string" }, description: "The file name as shared." },
          ],
          responses: {
            "200": { description: "The file's bytes.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
            "304": { description: "Unchanged (strong ETag = the content hash)." },
            "401": { description: "The link has a shared password and this request carries no unlock grant." },
            "404": { description: "No such public record, or no such file on it." },
            "429": { description: "Download budget for this link is spent; retry shortly." },
          },
        },
      },
      "/u/{nonce}": {
        put: {
          tags: ["Apps"],
          operationId: "uploadFile",
          summary: "Upload a file's bytes to a one-time URL",
          description:
            "The second half of publish_file when the content is not passed inline: the tool mints " +
            "this URL (valid ten minutes, single use) and the agent PUTs the raw bytes to it, " +
            "typically `curl -T <file> <url>`. The nonce in the path is the only credential. The " +
            "shared record is created when the upload completes; nothing is visible before that.",
          security: [],
          parameters: [{ name: "nonce", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: {
            "200": {
              description: "Stored. Returns the record id, file name, size, sha256, and the share URL.",
              content: json({
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  id: { type: "string" },
                  name: { type: "string" },
                  size: { type: "integer" },
                  sha256: { type: "string" },
                  url: { type: "string" },
                },
              }),
            },
            "400": { description: "Empty or short upload; the URL stays valid to retry.", content: json({ $ref: "#/components/schemas/Error" }) },
            "404": { description: "Unknown, expired, or already-used URL." },
            "409": { description: "The app this file was to attach to is archived or locked." },
            "413": { description: "Over the per-file cap or the box's file storage quota.", content: json({ $ref: "#/components/schemas/Error" }) },
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

/* ----------------------------- agent discovery ---------------------------- */

type Tool = { name: string; title: string; role: string; readOnly: boolean };
type Skill = { id: string; name: string; description: string };
type Connector = { id: string; name: string; data: string };

/**
 * WHEN TO USE SETOKU — the single most useful paragraph on this whole site for a
 * machine reader, and the one thing marketing copy never says out loud. Every
 * discovery file (llms.txt, the agent card, the skill index, index.md) states
 * the same lists, so an agent gets the same answer wherever it looks.
 *
 * Kept honest in both directions: what Setoku is *wrong* for is published next
 * to what it is right for, because an agent that reaches for us on a question we
 * cannot answer wastes a turn and then distrusts the next answer too. The
 * do-not-use list therefore concedes the static-CSV case outright — that reader
 * is better served by DuckDB, and saying so is what makes the rest credible.
 *
 * `who_its_for` exists because agents evaluating fit pattern-match against a
 * list of subjects, not against prose. Until it was added, every one of these
 * files said "company" and nothing said "person", so an agent asked whether a
 * household should use Setoku correctly answered no — to what we had published,
 * not to what the product does. The homepage h1 had rotated
 * "company data / family data / personal data" for months; it was a JS rotator,
 * so no fetcher ever saw the other two words.
 */
const WHEN_TO_USE = {
  summary:
    "Reach for Setoku when the answer lives in data its operator connected (a company's, a " +
    "household's, or one person's) and depends on their own definitions, not public knowledge.",
  who_its_for: [
    "Companies: give agents team-by-team access to revenue, logs, and deploys, for debugging and analysis. Definitions like “active customer” get written down once.",
    "Families: shared accounts and calendars, so the partner who doesn’t write SQL gets the same answers.",
    "Just you: your own accounts and repos, queryable from your phone and the web as well as your desktop.",
  ],
  use_when: [
    "The question is about the operator's own revenue, deploys, spending, mail, or repos. The data lives in their database, Slack, GitHub, email, or bank.",
    "The data keeps changing (a bank, an inbox, an issue tracker), so an export is stale on arrival.",
    "You need the operator's definition of a term first: what counts as an active customer, which account is the joint one, which charges were reimbursed.",
    "A naive query would be wrong in a way only an insider knows: soft-deleted rows, a test tenant, a transfer between your own accounts counted as income. You want that caveat before you run SQL.",
    "You want a dashboard on a link someone else can open, on live data, not a screenshot.",
    "An agent will read untrusted text (mail, logs, chat) in the same session. That session can't rewrite what Setoku knows, so an injected instruction can't become a remembered fact.",
    "You want the answer to be auditable later: every query and knowledge change is logged on your box.",
  ],
  do_not_use_when: [
    "The question is general knowledge or public data. Setoku only knows the data its operator connected.",
    "The data is a static file on your disk. Query it locally. Setoku is for data that lives in other services and keeps changing.",
    "You need to write to the operator's database. Every data path is read-only, enforced by database role. There is no write tool and no escape hatch.",
    "You want a hosted API to sign up for. There is none. Setoku is self-hosted, and the endpoint you call is the operator's own box.",
    "You want a model to run server-side. Setoku runs no inference.",
  ],
  how_to_call: [
    "Connect to the box's MCP endpoint (Streamable HTTP) at `https://<their-box>/mcp` with the person's bearer token, or paste `https://<their-box>/mcp/<token>` into a connector dialog that has no header field.",
    "Call find_context FIRST, every time. It returns the curated notes for the question, including which tables to trust and which to avoid.",
    "Then get_schema, then run_query.",
    "If the context is wrong, call report_correction. It lands as a proposal for a human to accept. An agent session can't commit knowledge by itself.",
  ],
} as const;

/** Where the MCP server actually is. Advertised at the conventional well-known
 *  path so an agent can find the endpoint without reading an OpenAPI document. */
function mcpManifest(toolList: Tool[]) {
  return {
    // No `$schema`: it used to point at this very URL, so anything that
    // dereferenced it to validate got the instance back instead of a schema.
    // There is no published schema this document conforms to, and naming one we
    // do not follow would be the same lie in the other direction.
    name: "setoku",
    title: "Setoku",
    description:
      "Self-hosted MCP knowledge server: a read-only, audited view of one operator's own data (a " +
      "company's, a household's, or one person's), plus the curated context needed to use it correctly.",
    version: VERSION,
    license: "Apache-2.0",
    repository: { url: REPO, source: "github" },
    documentation: `${SITE}/docs`,
    when_to_use: WHEN_TO_USE,
    // `remotes` follows the MCP registry's server.json shape. There is no
    // setoku.com MCP server to list here: the product is single-tenant, so the
    // endpoint an agent connects to is the operator's own box. The demo box is a
    // real, reachable instance of exactly that.
    remotes: [
      {
        type: "streamable-http",
        url: "https://{host}/mcp",
        description:
          "Your own Setoku box. `host` is the hostname you deployed to; there is no hosted service.",
        headers: [
          {
            name: "Authorization",
            description: "Bearer <your connector token>, issued and revoked from the box's console.",
            is_required: true,
            is_secret: true,
          },
        ],
      },
      {
        type: "streamable-http",
        url: DEMO_MCP_URL,
        description:
          "Public demo box (synthetic pro-sports-club dataset). The token is public on purpose, " +
          "read-only, and carries the analyst role. Callable right now, no signup.",
      },
    ],
    auth: { type: "bearer", oauth2: false, accepted_in: ["authorization-header", "url-path"] },
    tools: toolList,
    tool_catalog: `${SITE}/api/tools.json`,
    openapi: `${SITE}/openapi.json`,
    note: "Generated by scripts/build-site-api.ts from the Setoku source tree — do not edit by hand.",
  };
}

/**
 * An A2A-style agent card. Honest about the transport: the URL below speaks MCP
 * over Streamable HTTP, not the A2A task protocol — we publish the card because
 * it is where agents look for "who is this and what can it do", and a card that
 * quietly implied an A2A task endpoint we never built would be the same kind of
 * lie the OpenAPI spec is tested against (see "does not claim OAuth support we
 * have not built" in test/site-api.test.ts).
 */
function agentCard(skillList: Skill[], toolList: Tool[]) {
  return {
    protocolVersion: "0.3.0",
    name: "Setoku",
    description:
      "Setoku makes an AI agent fluent in one operator's own data: a company's, a household's, " +
      "or one person's. It serves their curated context (metric definitions, gotchas, which table " +
      "to trust) and a governed read-only query path into the data itself, so an agent answers " +
      "from how they actually count things and can publish a live view of the result on a link. " +
      "Self-hosted and single-tenant: it runs on the operator's own box.",
    version: VERSION,
    provider: { organization: "Hedgy Labs", url: SITE },
    documentationUrl: `${SITE}/docs`,
    iconUrl: `${SITE}/assets/setoku-mark.svg`,
    // The endpoint is MCP, so `url` is a real, callable address — but it must not
    // be labelled with an A2A transport. `preferredTransport: "JSONRPC"` would
    // send an A2A client into a `message/send` against a server that answers
    // method-not-found, and it would blame us for being broken rather than for
    // speaking a different protocol; the prose note below is not something any
    // client parses. A transport value outside the A2A enum makes a conforming
    // client skip the card, which is the correct outcome: we do not implement
    // A2A, and being skipped beats being miscalled.
    url: DEMO_MCP_URL,
    preferredTransport: "MCP-STREAMABLE-HTTP",
    additionalInterfaces: [
      { transport: "MCP-STREAMABLE-HTTP", url: DEMO_MCP_URL },
      { transport: "MCP-STREAMABLE-HTTP", url: "https://{host}/mcp" },
    ],
    transportNote:
      "This card describes an MCP server, not an A2A agent. `url` speaks JSON-RPC 2.0 over MCP " +
      "Streamable HTTP (protocol revision 2025-06-18) and implements no A2A method: initialize " +
      "an MCP session against it rather than sending A2A tasks. The URL shown is the public demo " +
      "box — for a real deployment, substitute your own host.",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain", "text/html"],
    securitySchemes: {
      bearerToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Per-person connector token, revocable from the box's console. The public demo token " +
          "above is read-only and intentionally published.",
      },
    },
    security: [{ bearerToken: [] }],
    whenToUse: WHEN_TO_USE,
    skills: [
      ...skillList.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: ["setoku", "mcp", "company-data", "personal-data", "household-data", s.name],
        examples: [`/setoku:${s.name}`],
      })),
      {
        id: "setoku:answer",
        name: "answer",
        description:
          "Answer a question about the operator's own data (a company's, a household's, or one " +
          "person's): retrieve the curated context for it (find_context), read the schema, then " +
          "run a governed read-only query.",
        tags: ["setoku", "mcp", "analytics", "sql", "company-data", "personal-data", "household-data"],
        examples: [
          "What did we bill last month, using our definition of billed revenue?",
          "Which accounts churned in Q2, excluding the test tenant?",
          "What did we spend on groceries last month, not counting the reimbursed work lunches?",
        ],
      },
      {
        id: "setoku:publish-app",
        name: "publish-app",
        description:
          "Build a small live app or dashboard over that data and publish it to a link the " +
          "whole team can open, refreshing against real data.",
        tags: ["setoku", "mcp", "dashboard", "app", "sharing"],
        examples: ["Turn that into a dashboard the sales team can watch."],
      },
    ],
    tools: toolList.map((t) => ({ name: t.name, description: t.title, role: t.role })),
    note: "Generated by scripts/build-site-api.ts from the Setoku source tree — do not edit by hand.",
  };
}

/** The Agent Skills index: the workflows Setoku ships, each with a name and a
 *  description, at the path agents probe for them. */
function agentSkillsIndex(skillList: Skill[]) {
  return {
    name: "Setoku",
    description:
      "Skills for connecting an AI agent to the data one operator owns (a company's, a " +
      "household's, or one person's) and keeping the knowledge behind it correct. They ship in " +
      "the Setoku Claude Code plugin and run against a Setoku box.",
    version: VERSION,
    license: "Apache-2.0",
    homepage: SITE,
    documentation: `${SITE}/docs`,
    when_to_use: WHEN_TO_USE,
    install: ["/plugin marketplace add Hedgy-Labs/setoku", "/plugin install setoku@setoku"],
    skills: skillList.map((s) => ({
      name: s.name,
      id: s.id,
      description: s.description,
      command: `/setoku:${s.name}`,
      source: `${REPO}/blob/main/plugin/skills/${s.name}/SKILL.md`,
    })),
    note: "Generated by scripts/build-site-api.ts from the Setoku source tree — do not edit by hand.",
  };
}

/* ------------------------------ markdown twins ---------------------------- */

/**
 * A shared string, on its way into markdown prose. Two jobs:
 *
 * 1. Curly apostrophes. Site copy uses ’ (see CLAUDE.md) but the JSON artifacts
 *    have always used the ASCII one, and these pages reuse the very same
 *    strings — so the conversion happens here rather than at the source.
 * 2. Escaping `<`. A bare `<their-box>` or `<source>` is a valid raw-HTML tag in
 *    CommonMark: every renderer SWALLOWS it, which silently deleted the host and
 *    token out of the one instruction the page most needs to get right
 *    (`https://<their-box>/mcp/<token>` rendered as `https:///mcp/`). Skill
 *    descriptions come from SKILL.md frontmatter, so escaping is the only fix
 *    that covers text this file does not own.
 *
 * Backtick spans are left alone in both cases: inside a code span `<` is already
 * literal, and the shell quoting in the code samples (`-d '{"jsonrpc":…}'`) must
 * survive untouched.
 */
const prose = (s: string): string =>
  s
    .split("`")
    .map((seg, i) =>
      i % 2 === 1 ? seg : seg.replace(/(\w)'(\w)/g, "$1’$2").replace(/</g, "\\<"),
    )
    .join("`");

const bullets = (xs: readonly string[]) => xs.map((x) => `- ${prose(x)}`).join("\n");
const steps = (xs: readonly string[]) => xs.map((x, i) => `${i + 1}. ${prose(x)}`).join("\n");

/**
 * `/index.md` — the homepage, as one canonical markdown document.
 *
 * Not a scrape of index.html: it is generated from the same derived facts the
 * JSON artifacts are (version, tools, connectors, demo connector), so the two
 * can disagree in tone but never in fact.
 */
function indexMarkdown(toolList: Tool[], connectorList: Connector[], skillList: Skill[]) {
  return `# Setoku

> Make any AI fluent in your data.

Setoku is an open-source, self-hosted MCP (Model Context Protocol) knowledge server. It gives an AI agent a read-only, audited view of the data you own (a company’s, a household’s, or your own), plus the curated context needed to use it correctly: the metric definitions, the gotchas, the reasons a naive query is wrong.

Version ${VERSION} · Apache-2.0 · <${REPO}>

This is the markdown twin of <${SITE}/>. The API reference is <${SITE}/docs> (markdown: <${SITE}/docs.md>).

## When to use Setoku

${prose(WHEN_TO_USE.summary)}

Who it’s for:

${bullets(WHEN_TO_USE.who_its_for)}

Use it when:

${bullets(WHEN_TO_USE.use_when)}

Do not use it when:

${bullets(WHEN_TO_USE.do_not_use_when)}

## How an agent calls it

${steps(WHEN_TO_USE.how_to_call)}

## Try it without installing anything

The demo box is wired to a synthetic pro-sports-club dataset (ticketing, sponsorship, concessions, payroll, broadcast rights) for a fictional club, the Bonita Bulldogs. Add this as a custom MCP connector:

    ${DEMO_MCP_URL}

The token is public on purpose: read-only, analyst role, synthetic data.

${DEMO_PUBLIC_APPS.map((a) => `- [${a.title}](${demoAppUrl(a.id)}) — ${a.blurb}, published by an agent and running on live demo data.`).join("\n")}
- [Demo box health](${DEMO_BASE_URL}/healthz) — a credential-free REST endpoint, if you want to see the shape of the API before you connect.

## Install

Claude Code plugin, from your project directory:

    /plugin marketplace add Hedgy-Labs/setoku
    /plugin install setoku@setoku
    /setoku:onboard

Server, by hand, on a fresh Ubuntu VPS (about $5–12/month):

    git clone ${REPO} /opt/setoku
    cd /opt/setoku
    SETOKU_ADMIN_USER=you ./deploy/bootstrap.sh

## The tool surface

${toolList.length} MCP tools. Which ones a session sees depends on its token’s role. That split is the security model.

| Tool | What it does | Role |
| --- | --- | --- |
${toolList.map((t) => `| \`${t.name}\` | ${prose(t.title)} | ${t.role} |`).join("\n")}

## Skills

${skillList.map((s) => `- \`/setoku:${s.name}\` — ${prose(s.description)}`).join("\n")}

## Connectors

${connectorList.map((c) => `- **${c.name}** — ${c.data}`).join("\n")}

No connector for yours? \`/setoku:connect\` gives a coding agent the patterns to wire one up.

## Security model

- **Two identities, one membrane.** An analyst token may query the lake but holds no tool that commits knowledge. A curator token may commit knowledge but cannot read the lake. They never coexist on one session, so a prompt-injected session can’t reach the write path.
- **Accepting knowledge is a human click** on the box’s admin page, outside the agent loop. No MCP tool creates users, grants access, or commits knowledge on its own.
- **Reads are governed by database roles**, not by parsing SQL in our code. The engine enforces it.
- **The credential never reaches the model.** Config names an environment variable; the gateway resolves it.
- **No model runs on the server**, so there is no inference cost and no AI API key on the box.

## Machine-readable index

- [OpenAPI 3.1](${SITE}/openapi.json) — the gateway HTTP API
- [MCP manifest](${SITE}/.well-known/mcp.json) — endpoint, transport, auth
- [Agent card](${SITE}/.well-known/agent-card.json) — who we are, what we do
- [Agent skills index](${SITE}/.well-known/agent-skills/index.json)
- [Catalog root](${SITE}/api/index.json) · [tools](${SITE}/api/tools.json) · [connectors](${SITE}/api/connectors.json)
- [llms.txt](${SITE}/llms.txt)

Contact: hello@setoku.com · Issues: <${REPO}/issues>
`;
}

/**
 * `/llms.txt` — the prose entry point, generated for the same reason the rest of
 * this file is.
 *
 * It used to be hand-written, with the when-to-use guidance retyped by hand from
 * `WHEN_TO_USE` and pinned by a single sentence fragment in the tests. That is
 * the drift shape this whole script exists to prevent: edit the constant, run
 * the build, and llms.txt would keep publishing the old rule while every test
 * stayed green — so the file an agent reads FIRST would be the one document
 * disagreeing with the rest.
 */
function llmsTxt(skillList: Skill[]) {
  return `# Setoku

> Setoku is an open-source, self-hosted MCP (Model Context Protocol) knowledge server. It gives any AI agent a read-only, audited view of the data you own (a company’s, a household’s, or your own), plus the curated context needed to use it correctly: the metric definitions, the gotchas, the reasons a naive query is wrong.

Setoku is single-tenant on purpose. There is no hosted Setoku service and no multi-tenant API: you run it on a box you own (one small VPS), and your data and your context stay there. That is the point of the product, not a gap in it. So the API described below is the API that *your* deployment exposes, not one hosted at setoku.com.

The primary interface is MCP over Streamable HTTP at \`/mcp\` on your box. Any MCP client can use it: Claude, Claude Code, Codex, or your own. Authentication is a per-person bearer token, revocable from the box’s web console. No AI model runs on the server, so there is no inference cost and no AI API key.

Two identities share one server and never overlap. An **analyst** token may query the data lake but holds no tool that commits knowledge. A **curator** token may commit knowledge but cannot read the lake. Accepting proposed knowledge is a human click on the admin page, outside the agent loop, so a prompt-injected session cannot rewrite what Setoku knows.

## When to use Setoku

${prose(WHEN_TO_USE.summary)}

Who it’s for:

${bullets(WHEN_TO_USE.who_its_for)}

Use it when:

${bullets(WHEN_TO_USE.use_when)}

Do not use it when:

${bullets(WHEN_TO_USE.do_not_use_when)}

How an agent should call it:

${steps(WHEN_TO_USE.how_to_call)}

The same guidance, machine-readable, is in [/.well-known/mcp.json](${SITE}/.well-known/mcp.json), [/.well-known/agent-card.json](${SITE}/.well-known/agent-card.json), and [/.well-known/agent-skills/index.json](${SITE}/.well-known/agent-skills/index.json).

## Setoku developer resources

- [Setoku API reference](${SITE}/docs): the HTTP API, authentication, the MCP tool surface, quickstart, and the security model. Markdown twin: [/docs.md](${SITE}/docs.md).
- [Setoku homepage in markdown](${SITE}/index.md): the whole product page as one canonical markdown document, no HTML to parse. Both content pages — this one and /docs — also answer \`?mode=agent\` with their markdown twin; the JSON documents below answer as themselves.
- [Setoku MCP manifest](${SITE}/.well-known/mcp.json): where the MCP server is, which transport it speaks, and how to authenticate.
- [Setoku agent card](${SITE}/.well-known/agent-card.json): what Setoku is for, its skills, and the endpoint to call.
- [Setoku agent skills index](${SITE}/.well-known/agent-skills/index.json): the shipped skills, each with a name and a description.
- [Setoku OpenAPI specification](${SITE}/openapi.json): OpenAPI 3.1 for the Setoku gateway HTTP API, covering the MCP endpoint, health, published apps, and the installer. Mirrored at [/api/openapi.json](${SITE}/api/openapi.json).
- [Setoku catalog API](${SITE}/api/index.json): machine-readable product metadata — version, install commands, every document this site publishes, and how to reach the MCP endpoint.
- [Setoku MCP tool catalog](${SITE}/api/tools.json): every MCP tool, with the role each one requires.
- [Setoku connector catalog](${SITE}/api/connectors.json): the data sources Setoku ingests.
- [Setoku source repository](${REPO}): Apache-2.0, the full server, skills, and deploy scripts.

## Try Setoku without installing it

- [Setoku public demo](${SITE}/#demo): a live box wired to a synthetic pro-sports-club dataset (ticketing, sponsorship, concessions, payroll, broadcast rights). Add \`${DEMO_MCP_URL}\` as a custom MCP connector. The token is public on purpose and read-only.
${DEMO_PUBLIC_APPS.map((a) => `- [Setoku demo app: ${prose(a.title)}](${demoAppUrl(a.id)}): ${prose(a.blurb)}, built and published by an agent on live demo data.`).join("\n")}
- [Setoku demo box health](${DEMO_BASE_URL}/healthz): a real, credential-free REST endpoint you can call right now to see the shape of the API.

## Install Setoku

- [Setoku quickstart](${SITE}/#quickstart): add the Claude Code plugin (\`/plugin marketplace add Hedgy-Labs/setoku\`), then run \`/setoku:onboard\` from your project directory.
- [Setoku manual server setup](${SITE}/docs#install): clone the repo onto a fresh Ubuntu VPS and run \`deploy/bootstrap.sh\`.

## Setoku skills

${skillList.map((s) => `- \`/setoku:${s.name}\`: ${prose(s.description)}`).join("\n")}

## Optional

- [Setoku architecture](${SITE}/#architecture): how the gateway, the ClickHouse lake, and the knowledge store fit together on one box.
- [Setoku security model](${SITE}/#security): what the token is, why reads are governed by database roles rather than by parsing SQL, and why writes pass through a person.
- [Setoku issue tracker](${REPO}/issues): bugs and feature requests.
- Contact: hello@setoku.com
`;
}

/** `/docs.md` — the API reference, as markdown. Same derivation. */
function docsMarkdown(toolList: Tool[], spec: ReturnType<typeof openapi>) {
  const byRole = (role: string) => toolList.filter((t) => t.role === role);
  const paths = Object.entries(spec.paths).flatMap(([p, ops]) =>
    Object.entries(ops as Record<string, { summary?: string; security?: unknown[] }>).map(
      ([method, op]) => ({
        route: `${method.toUpperCase()} ${p}`,
        summary: op.summary ?? "",
        auth: op.security && (op.security as unknown[]).length === 0 ? "none" : "bearer",
      }),
    ),
  );
  return `# Setoku API reference

The HTTP API, authentication, and the MCP tool surface for Setoku ${VERSION}. This is the markdown twin of <${SITE}/docs>.

Setoku is single-tenant and self-hosted: **there is no setoku.com API**. Everything below describes the API *your own box* exposes once you deploy it, and the public demo box (\`${DEMO_BASE_URL}\`) is a real instance of it.

## When to reach for Setoku

${prose(WHEN_TO_USE.summary)}

Who it’s for:

${bullets(WHEN_TO_USE.who_its_for)}

Reach for it when:

${bullets(WHEN_TO_USE.use_when)}

Not a fit when:

${bullets(WHEN_TO_USE.do_not_use_when)}

## MCP endpoint

Transport: **Streamable HTTP**, at \`POST /mcp\`. Protocol revision 2025-06-18. Any MCP client works: Claude, Claude Code, Codex, or your own.

    curl -sS -X POST https://<your-box>/mcp \\
      -H "Authorization: Bearer <token>" \\
      -H "Content-Type: application/json" \\
      -H "Accept: application/json, text/event-stream" \\
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

Callable right now against the demo box:

    ${DEMO_MCP_URL}

## Authentication

- A per-person **bearer token**, sent as \`Authorization: Bearer <token>\` — or as a path segment (\`/mcp/<token>\`) for connector dialogs with nowhere to put a header. Treat the whole URL as a credential.
- Tokens are issued and revoked from the box’s web console. Every call is attributed to one person in the audit log.
- **OAuth 2.0 is not shipped.** It is scoped; it does not exist yet. Do not build against it.
- A missing, unknown, or revoked token is a \`401\`, before any tool runs. See [Errors](#errors) for the shapes.

## Tool surface

${steps(WHEN_TO_USE.how_to_call)}

**Every session** — the analyst surface. Reads data and curated context, and may only *propose* knowledge changes:

${byRole("analyst").map((t) => `- \`${t.name}\`${t.readOnly ? "" : " (writes)"} — ${prose(t.title)}`).join("\n")}

**Curator sessions only.** Commits curated knowledge:

${byRole("curator").map((t) => `- \`${t.name}\` — ${prose(t.title)}`).join("\n")}

**Janitor sessions only.** Drafts and auto-rejects pending corrections, commits nothing:

${byRole("janitor").map((t) => `- \`${t.name}\` — ${prose(t.title)}`).join("\n")}

A session has exactly one role, and the two role-scoped groups are *registered* only for that role: a session without it does not get a refusal, the tool is simply absent from its \`tools/list\`.

The analyst tools are registered on every session, including a curator one — the membrane’s other half is enforced at call time instead. A curator session can commit knowledge but cannot read the data lake: \`run_query\` refuses lake queries and \`list_sources\` tells you to switch connectors. So the session that can rewrite what Setoku knows is never the session that has read untrusted bulk text (I2).

## REST surface

Credential-free unless marked. Full spec: <${SITE}/openapi.json>.

| Endpoint | What it returns | Auth |
| --- | --- | --- |
${paths.map((p) => `| \`${p.route}\` | ${prose(p.summary)} | ${p.auth} |`).join("\n")}

## Errors

Three different surfaces, three shapes. Branch on the HTTP status; do not expect one envelope everywhere.

**The box’s REST endpoints** answer with \`ok: false\` and a human-readable string. There is no error code to switch on — the status line is the machine-readable part:

    { "ok": false, "error": "app not found or archived" }

**MCP tools** return their failure as the tool result, per the MCP specification, not as an HTTP error: the call is \`200\` and the content carries the message. \`run_query\` failures are written to be actionable — they name the table or column that did not resolve and what to call instead. A missing, unknown, or revoked token is the exception: that is a plain \`401\` before any tool runs.

**setoku.com itself** (this site, not your box) answers non-HTML requests with a structured document, so an agent probing the docs surface gets something it can parse:

    {
      "ok": false,
      "error": {
        "code": "not_found",
        "status": 404,
        "message": "No document at that path on setoku.com.",
        "hint": "…",
        "docs": "https://setoku.com/docs",
        "index": "https://setoku.com/api/index.json"
      }
    }

## Install a box

    git clone ${REPO} /opt/setoku
    cd /opt/setoku
    SETOKU_ADMIN_USER=you ./deploy/bootstrap.sh

One small VPS. Docker Compose brings up the gateway, Caddy (HTTPS), and a local ClickHouse lake. No model runs on the server.

## More

- [OpenAPI 3.1](${SITE}/openapi.json) · [MCP manifest](${SITE}/.well-known/mcp.json) · [agent card](${SITE}/.well-known/agent-card.json) · [skills index](${SITE}/.well-known/agent-skills/index.json)
- [Tool catalog](${SITE}/api/tools.json) · [connector catalog](${SITE}/api/connectors.json) · [catalog root](${SITE}/api/index.json)
- [Source](${REPO}) · [issues](${REPO}/issues) · hello@setoku.com
`;
}

/* --------------------------------- emit ----------------------------------- */

/**
 * Derive every artifact from the source tree, WITHOUT writing anything.
 *
 * Split out so test/site-api.test.ts can regenerate and diff against the
 * committed files. The tests used to read the artifacts and spot-check a few
 * fields, which meant a stale artifact passed: only the names were compared to
 * app.ts, so an edited title, a moved capability block, or a new connector all
 * shipped stale while the suite stayed green.
 */
export async function buildArtifacts(): Promise<[string, unknown][]> {
const toolList = await tools();
const connectorList = await connectors();
const skillList = await skills();
const spec = openapi(toolList.map((t) => t.name));

const NOTE =
  "Generated by scripts/build-site-api.ts from the Setoku source tree — do not edit by hand.";

const index = {
  name: "Setoku",
  tagline: "Make any AI fluent in your data.",
  description: manifest.description,
  version: VERSION,
  license: "Apache-2.0",
  self_hosted: true,
  hosted_service: false,
  links: {
    homepage: `${SITE}/`,
    homepage_markdown: `${SITE}/index.md`,
    docs: `${SITE}/docs`,
    docs_markdown: `${SITE}/docs.md`,
    openapi: `${SITE}/openapi.json`,
    llms_txt: `${SITE}/llms.txt`,
    tools: `${SITE}/api/tools.json`,
    connectors: `${SITE}/api/connectors.json`,
    mcp_manifest: `${SITE}/.well-known/mcp.json`,
    agent_card: `${SITE}/.well-known/agent-card.json`,
    agent_skills: `${SITE}/.well-known/agent-skills/index.json`,
    repository: REPO,
    issues: `${REPO}/issues`,
    contact: "mailto:hello@setoku.com",
  },
  /**
   * Every document setoku.com serves. The site's 404 body and its 404 page both
   * tell readers this file is the complete index, so it is filled in below from
   * the artifact list itself rather than typed out — the five discovery
   * documents were added to the build without reaching this object, which left
   * an agent following that hint concluding we publish no MCP manifest at all.
   */
  publishes: [] as string[],
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
        `see ${SITE}/docs#auth.`,
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
  // Agent discovery. Conventional paths first, because that is where an agent
  // probes before it ever reads a page.
  ["site/.well-known/mcp.json", mcpManifest(toolList)],
  ["site/.well-known/agent-card.json", agentCard(skillList, toolList)],
  ["site/.well-known/agent-skills/index.json", agentSkillsIndex(skillList)],
  // Markdown twins: one canonical URL per page that is text, not HTML.
  ["site/index.md", indexMarkdown(toolList, connectorList, skillList)],
  ["site/docs.md", docsMarkdown(toolList, spec)],
  ["site/llms.txt", llmsTxt(skillList)],
];

// The documents this generator does not own. site/404.html is deliberately not
// listed: it is what you get instead of a document, not one.
const HAND_WRITTEN = [`${SITE}/`, `${SITE}/docs`, `${SITE}/robots.txt`, `${SITE}/sitemap.xml`];
const CATALOG = "site/api/index.json";
index.publishes = [
  ...HAND_WRITTEN,
  ...[...out.map(([p]) => p), CATALOG].map((p) => SITE + p.slice("site".length)),
].sort();
out.push([CATALOG, index]);

  return out;
}

/** Exactly how an artifact is serialized on disk — shared so the drift test
 *  compares bytes rather than re-guessing the formatting. Markdown artifacts are
 *  already text and are written through unchanged. */
export const serialize = (body: unknown): string =>
  typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n";

if (import.meta.main) {
  const out = await buildArtifacts();
  for (const [p] of out) mkdirSync(ROOT + p.replace(/\/[^/]+$/, ""), { recursive: true });
  for (const [p, body] of out) {
    await Bun.write(ROOT + p, serialize(body));
    console.log(`  ${p}`);
  }
  const toolCount = (await tools()).length;
  const connectorCount = (await connectors()).length;
  console.log(`✓ site API built — v${VERSION}, ${toolCount} tools, ${connectorCount} connectors`);
}
