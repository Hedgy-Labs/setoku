// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway's version, read from the plugin manifest so there's ONE source of
 * truth (plugin/.claude-plugin/plugin.json). Covers local dev and the container,
 * where the Dockerfile copies the manifest to /app/plugin.json. Surfaced in the
 * MCP serverInfo and on /health so a deploy can be verified from a session.
 */
import fs from "node:fs";
import path from "node:path";

function read(): string {
  const dir = import.meta.dir; // plugin/gateway/lib  (or /app/gateway/lib in the container)
  const candidates = [
    path.join(dir, "..", "..", "plugin.json"), // container: /app/plugin.json
    path.join(dir, "..", "..", ".claude-plugin", "plugin.json"), // local dev
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
        if (typeof v === "string" && v) return v;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return "unknown";
}

export const VERSION = read();
