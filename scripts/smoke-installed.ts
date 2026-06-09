/**
 * Smoke-test an INSTALLED copy of the Setoku plugin (the artifact in Claude
 * Code's plugin cache), exactly as Claude Code launches it.
 *
 *   bun scripts/smoke-installed.ts ~/.claude/plugins/cache/setoku/setoku/<version>
 *
 * Requires the e2e database (created by `bun test`) or any Postgres reachable
 * via SETOKU_E2E_DB_URL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PLUGIN_ROOT = process.argv[2];
if (!PLUGIN_ROOT) {
  console.error(
    "usage: bun scripts/smoke-installed.ts <installed-plugin-root>",
  );
  process.exit(1);
}
const FIXTURES = path.resolve(import.meta.dir, "..", "test", "fixtures");
const DB_URL =
  process.env.SETOKU_E2E_DB_URL ?? "postgresql:///setoku_e2e?host=%2Ftmp";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-smoke-"));
fs.cpSync(path.join(FIXTURES, "setoku"), path.join(tmp, ".setoku"), {
  recursive: true,
});

const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "bun",
    args: [path.join(PLUGIN_ROOT, "gateway", "server.ts")],
    cwd: tmp,
    env: {
      ...(process.env as Record<string, string>),
      SETOKU_PROJECT_DIR: tmp,
      SETOKU_DB_PATH: path.join(tmp, "knowledge.db"),
      SETOKU_E2E_DB_URL: DB_URL,
      SETOKU_USER: "smoke@test",
    },
  }),
);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};
const rq = (await client.callTool({
  name: "run_query",
  arguments: {
    sql: "SELECT SUM(total_cents)/100.0 AS rev FROM orders WHERE status='paid'",
  },
})) as unknown as ToolResult;
const revenueOk = rq.content[0].text.includes("225");
console.log("revenue query correct:", revenueOk);

const fc = (await client.callTool({
  name: "find_context",
  arguments: { question: "how much revenue last month" },
})) as unknown as ToolResult;
const gotchaOk = fc.content[0].text.includes(
  "Refunded orders must be excluded",
);
console.log("find_context surfaces refund gotcha:", gotchaOk);

await client.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (!revenueOk || !gotchaOk) {
  console.error("SMOKE FAIL");
  process.exit(1);
}
console.log("SMOKE PASS — installed plugin artifact serves correctly");
