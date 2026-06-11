// SPDX-License-Identifier: Apache-2.0
/**
 * Push a local `.setoku/context/` seed to a DEPLOYED gateway over HTTP.
 * The FDE seeding flow: knowledge authored/generated locally, pushed to the
 * shared store via upsert_context (attributed to your token's identity).
 *
 *   SETOKU_REMOTE_TOKEN=<token> bun scripts/seed-remote.ts <projectDir> <gatewayUrl>
 *   e.g. bun scripts/seed-remote.ts ~/hedgy https://setoku-gateway.fly.dev
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseFrontmatter } from "../plugin/gateway/lib/artifact";

const [projectDir, gatewayUrl] = process.argv.slice(2);
const token = process.env.SETOKU_REMOTE_TOKEN;
if (!projectDir || !gatewayUrl || !token) {
  console.error(
    "usage: SETOKU_REMOTE_TOKEN=<token> bun scripts/seed-remote.ts <projectDir> <gatewayUrl>",
  );
  process.exit(1);
}

const ctx = path.join(path.resolve(projectDir), ".setoku", "context");
type Doc = {
  type: string;
  name: string;
  meta: Record<string, unknown>;
  body: string;
};
const docs: Doc[] = [];

function collect(dir: string, type: string) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const { meta, body } = parseFrontmatter(
      fs.readFileSync(path.join(dir, f), "utf8"),
    );
    const name =
      typeof meta.name === "string" && meta.name
        ? meta.name
        : f.replace(/\.md$/, "");
    docs.push({ type, name, meta, body: body.trim() });
  }
}
collect(path.join(ctx, "entities"), "entity");
collect(path.join(ctx, "metrics"), "metric");
collect(path.join(ctx, "queries"), "query");
const overview = path.join(ctx, "overview.md");
if (fs.existsSync(overview)) {
  const { meta, body } = parseFrontmatter(fs.readFileSync(overview, "utf8"));
  docs.push({ type: "overview", name: "overview", meta, body: body.trim() });
}
const gotchasFile = path.join(ctx, "gotchas.md");
if (fs.existsSync(gotchasFile)) {
  let i = 0;
  for (const line of fs.readFileSync(gotchasFile, "utf8").split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (m)
      docs.push({
        type: "gotcha",
        name: `gotcha-${String(++i).padStart(3, "0")}`,
        meta: {},
        body: m[1],
      });
  }
}

if (!docs.length) {
  console.error(`no docs found under ${ctx}`);
  process.exit(1);
}

const client = new Client({ name: "setoku-seed", version: "0.0.1" });
await client.connect(
  new StreamableHTTPClientTransport(
    new URL(`${gatewayUrl.replace(/\/$/, "")}/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    },
  ),
);
for (const doc of docs) {
  const res = (await client.callTool({
    name: "upsert_context",
    arguments: doc,
  })) as unknown as {
    isError?: boolean;
    content: { text: string }[];
  };
  console.log(`${res.isError ? "FAIL" : "ok"}  [${doc.type}] ${doc.name}`);
  if (res.isError) console.error(res.content[0]?.text);
}
await client.close();
console.log(`seeded ${docs.length} docs to ${gatewayUrl}`);
