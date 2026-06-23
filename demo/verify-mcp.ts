// SPDX-License-Identifier: Apache-2.0
// Throwaway end-to-end check: connect to the running demo gateway over MCP
// (streamable HTTP), list tools, and run find_context + a real query.
//   MCP_URL=http://127.0.0.1:8787/mcp/<token> bun verify-mcp.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL!;
const client = new Client({ name: "demo-verify", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "), "\n");

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

const fc = await client.callTool({
  name: "find_context",
  arguments: { question: "ticket revenue and sell-through by game" },
});
console.log("=== find_context ===\n" + text(fc).slice(0, 1400) + "\n");

const q = await client.callTool({
  name: "run_query",
  arguments: {
    sql: "SELECT SUM(sold_price_cents)/100.0 AS ticket_revenue_dollars, COUNT(*) FILTER (WHERE status IN ('sold','scanned')) AS seats_sold FROM tickets WHERE ticket_type <> 'comp'",
    purpose: "demo verify — total ticket revenue",
  },
});
console.log("=== run_query (ticket revenue) ===\n" + text(q).slice(0, 800) + "\n");

const q2 = await client.callTool({
  name: "run_query",
  arguments: {
    sql: "SELECT g.opponent, g.game_date, g.is_promo, COUNT(*) FILTER (WHERE t.status IN ('sold','scanned'))::numeric/COUNT(*) AS sell_through FROM tickets t JOIN games g USING (game_id) GROUP BY g.game_id, g.opponent, g.game_date, g.is_promo ORDER BY sell_through DESC LIMIT 5",
    purpose: "demo verify — top games by sell-through",
  },
});
console.log("=== run_query (top sell-through) ===\n" + text(q2).slice(0, 900));

await client.close();
