#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Local preview for the /admin surface — no server, DB, or box needed.
 *
 * Renders every admin page with sample data, inlines the compiled stylesheet
 * (web/app.css), writes them to a temp dir, and opens an index in your browser.
 *
 *   bun run preview:admin        # build CSS + render + open
 *
 * Iterate by editing lib/approval.ts (and web/input.css), then re-running.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderLoginPage,
  renderApprovalPage,
  renderKnowledgePage,
  renderSourcesPage,
  renderTeamPage,
  renderAuditPage,
  type Session,
} from "../lib/approval";
import { KnowledgeStore } from "../lib/store";

const cssPath = path.join(import.meta.dir, "app.css");
if (!fs.existsSync(cssPath)) {
  console.error("web/app.css not found — run `bun run build:admin-css` first.");
  process.exit(1);
}
const css = fs.readFileSync(cssPath, "utf8");
const inline = (html: string): string =>
  html.replace('<link rel="stylesheet" href="/admin/app.css">', `<style>${css}</style>`);

const session: Session = {
  identity: "peter",
  role: "admin",
  csrf: "preview-csrf",
  expires: Date.now() + 1e6,
};

// A throwaway in-memory-ish store seeded with representative knowledge.
const dbPath = path.join(os.tmpdir(), `setoku-preview-${process.pid}.db`);
const store = new KnowledgeStore(dbPath);
store.upsertDoc(
  {
    type: "overview",
    name: "business",
    body: "Hedgy is a recruiting marketplace connecting companies with vetted candidates. Revenue is success-fee + subscription.",
    meta: {},
  },
  "peter",
);
store.upsertDoc(
  {
    type: "entity",
    name: "company",
    body: "A hiring company. Paying if it has an active subscription OR has paid a success fee in the period.",
    meta: {},
  },
  "peter",
);
store.upsertDoc(
  {
    type: "metric",
    name: "net_revenue",
    body: "Sum of success fees and subscription payments, excluding refunds and gift-card top-ups.",
    meta: { relates_to: "payments" },
  },
  "peter",
);
store.upsertDoc(
  {
    type: "gotcha",
    name: "gift-card-topups-excluded",
    body: "Gift-card top-ups post to ledger_entries with type=GC and are excluded from net revenue.",
    meta: {},
  },
  "peter",
);
store.addCorrection({
  user: "alice@hedgy.co",
  kind: "gotcha",
  content:
    "Contractor placements (placement_type=C2C) should not count toward net revenue — they're pass-through.",
  relatesTo: "net_revenue",
});

const sources = {
  postgres: {
    configured: true,
    ok: true,
    envVar: "SETOKU_DATABASE_URL",
    tableCount: 38,
    allow: ["public.*"],
  },
  lake: {
    configured: true,
    ok: true,
    tables: [
      { source: "Vercel logs", rows: 19685, last: "2026-06-12 19:25:52" },
      { source: "Render logs", rows: 28411, last: "2026-06-12 19:27:25" },
      { source: "Slack", rows: 10, last: "2026-06-12 06:12:52" },
      { source: "Mercury · accounts", rows: 12, last: "2026-06-12 19:24:09" },
      { source: "Mercury · transactions", rows: 280, last: "2026-06-10 12:35:36" },
      { source: "Mercury · webhooks", rows: 0, last: null },
    ],
  },
  knowledge: { docs: 21, byType: { entity: 5, gotcha: 11, metric: 4, overview: 1 } },
};

const pages: [string, string][] = [
  ["login", renderLoginPage()],
  ["pending", renderApprovalPage(store, session)],
  ["knowledge", renderKnowledgePage(store, session)],
  ["sources", renderSourcesPage(session, sources)],
  [
    "team",
    renderTeamPage(session, {
      people: [
        { identity: "peter", hasToken: true, role: "admin" },
        { identity: "alice@hedgy.co", hasToken: true, role: "admin" },
        { identity: "steven@hedgy.works", hasToken: true, role: "member" },
        { identity: "dana@hedgy.co", hasToken: false, role: "member" },
        { identity: "newhire@hedgy.co", hasToken: true },
      ],
      invite: {
        identity: "newhire@hedgy.co",
        token: "0123456789abcdef0123456789abcdef0123456789abcdef",
        installerUrl: "https://hedgy.setoku.com/i/0123456789abcdef0123456789abcdef0123456789abcdef",
        mcpUrl: "https://hedgy.setoku.com/mcp",
        persisted: true,
      },
    }),
  ],
  ["audit", renderAuditPage(store, session)],
];

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-admin-preview-"));
for (const [name, html] of pages) {
  fs.writeFileSync(path.join(outDir, `${name}.html`), inline(html));
}
const index = `<!doctype html><meta charset="utf-8"><title>Setoku admin preview</title>
<body style="font:15px system-ui;background:#09090b;color:#e4e4e7;padding:2rem">
<h1>Setoku admin preview</h1><ul>${pages
  .map(([n]) => `<li><a style="color:#34d399" href="./${n}.html">${n}</a></li>`)
  .join("")}</ul></body>`;
fs.writeFileSync(path.join(outDir, "index.html"), index);
fs.rmSync(dbPath, { force: true });

const indexPath = path.join(outDir, "index.html");
console.log(`Preview written to ${outDir}`);
console.log(`Open: file://${indexPath}`);
// best-effort auto-open (macOS `open`, Linux `xdg-open`)
const opener = process.platform === "darwin" ? "open" : "xdg-open";
Bun.spawn([opener, indexPath]).exited.catch(() => {});
