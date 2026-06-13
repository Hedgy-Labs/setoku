// SPDX-License-Identifier: Apache-2.0
/**
 * Shared test harness for the HTTP gateway: spawn the real http.ts the box
 * runs, wait for health, and connect MCP clients over Streamable-HTTP. Used by
 * e2e / lake / http test suites so the boilerplate lives in one place.
 */
import { spawn, type Subprocess } from "bun";
import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const ROOT = path.resolve(import.meta.dir, "..", "..");
export const HTTP_SERVER = path.join(ROOT, "plugin", "gateway", "http.ts");
export const FIXTURES = path.join(ROOT, "test", "fixtures");

/** Spawn http.ts with the given env merged over the current process env. */
export function spawnGateway(env: Record<string, string>): Subprocess {
  return spawn({
    cmd: ["bun", HTTP_SERVER],
    env: { ...(process.env as Record<string, string>), ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
}

/** Poll <base>/health until it answers, or throw after ~5s. */
export async function waitHealthy(base: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("gateway did not become healthy");
}

/** Connect an MCP client to <base>/mcp, optionally with a bearer token. */
export async function connect(
  base: string,
  token: string | null,
  name = "test",
): Promise<McpClient> {
  const client = new McpClient({ name, version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    }),
  );
  return client;
}

export interface CallResult {
  text: string;
  isError: boolean;
}

/** Call a tool and flatten the text content + error flag. */
export async function call(
  client: McpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallResult> {
  const res = (await client.callTool({ name, arguments: args })) as unknown as {
    content?: { text: string }[];
    isError?: boolean;
  };
  return {
    text: (res.content ?? []).map((c) => c.text).join("\n"),
    isError: !!res.isError,
  };
}
