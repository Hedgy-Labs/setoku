/**
 * Call one Setoku gateway tool against a project, from the shell. Used for the
 * answer-quality pressure test: the human/Claude driving this IS the inference
 * layer (subscription-native — no API keys anywhere).
 *
 *   bun scripts/call.ts <projectDir> <tool> ['{"json":"args"}']
 */
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [projectDir, tool, argsJson] = process.argv.slice(2);
if (!projectDir || !tool) {
  console.error("usage: bun scripts/call.ts <projectDir> <tool> [jsonArgs]");
  process.exit(1);
}
const SERVER = path.resolve(
  import.meta.dir,
  "..",
  "plugin",
  "gateway",
  "server.ts",
);

const client = new Client({ name: "setoku-eval", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "bun",
    args: [SERVER],
    cwd: path.resolve(projectDir),
    env: {
      ...(process.env as Record<string, string>),
      SETOKU_PROJECT_DIR: path.resolve(projectDir),
    },
  }),
);
const res = (await client.callTool({
  name: tool,
  arguments: argsJson ? JSON.parse(argsJson) : {},
})) as unknown as {
  content: { text: string }[];
  isError?: boolean;
};
if (res.isError) console.error("TOOL ERROR");
console.log(res.content.map((c) => c.text).join("\n"));
await client.close();
