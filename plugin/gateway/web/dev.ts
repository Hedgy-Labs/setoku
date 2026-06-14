#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Interactive local /admin — runs the REAL gateway (http.ts) against a throwaway
 * store seeded with sample data, so you can actually click: invite teammates,
 * change roles, approve/reject pending knowledge, reset passwords, etc.
 *
 *   bun run dev:admin            # build CSS + seed + serve + open, then watch
 *
 * Unlike preview:admin (static HTML snapshots), this is a live server with a
 * login and working forms. Ctrl-C to stop. Re-run after editing the gateway.
 * State is a fresh temp dir each run — nothing here touches a real box.
 */
import { spawn } from "bun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore } from "../lib/store";
import { hashPassword } from "../lib/accounts";

const ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const HTTP_SERVER = path.join(ROOT, "plugin", "gateway", "http.ts");
const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const USER = "dev";
const PASS = "dev";

// 1. build the stylesheet so the page isn't unstyled
await spawn({
  cmd: ["bun", "x", "tailwindcss", "-i", "plugin/gateway/web/input.css", "-o", "plugin/gateway/web/app.css", "--minify"],
  cwd: ROOT,
  stdout: "ignore",
  stderr: "ignore",
}).exited;

// 2. throwaway project dir + store seeded with representative data
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setoku-dev-admin-"));
fs.cpSync(path.join(ROOT, "deploy", "project-template", ".setoku"), path.join(dir, ".setoku"), {
  recursive: true,
});
const dbPath = path.join(dir, "knowledge.db");
const tokensFile = path.join(dir, "teammates.json");

const store = new KnowledgeStore(dbPath);
await (async () => {
  // dev + viewer both have a matching agent token (seeded below) so they show as
  // "agent connected"; pat has a login but NO token, to demo the Configure-agent
  // flow + the warning banner.
  store.createAccount({ username: USER, pwhash: await hashPassword(PASS), role: "admin" });
  store.createAccount({ username: "viewer", pwhash: await hashPassword("viewer"), role: "member" });
  store.createAccount({ username: "pat", pwhash: await hashPassword("patpass"), role: "member" });
  store.upsertDoc(
    { type: "overview", name: "business", body: "Hedgy is a recruiting marketplace. Revenue is success-fee + subscription.", meta: {} },
    USER,
  );
  store.upsertDoc(
    { type: "gotcha", name: "test-accounts-excluded", body: "Internal test accounts (email ends @hedgy.test) are excluded from active-user counts.", meta: {} },
    USER,
  );
  store.addCorrection({
    user: "alice@hedgy.co",
    kind: "gotcha",
    content: "Contractor placements (placement_type=C2C) are pass-through and excluded from net revenue.",
    relatesTo: "net_revenue",
  });
  store.addCorrection({ user: "bob@hedgy.co", kind: "metric", content: "Define 'activation' as first completed intro within 14 days of signup." });
})();
store.db.close();

// agent tokens, keyed so identities line up with the logins above:
//   dev   → has login (admin) + agent   viewer → has login (member) + agent
//   alice → agent only, no login        pat    → login only, no agent (banner)
fs.writeFileSync(
  tokensFile,
  JSON.stringify({ tok_viewer: "viewer", tok_alice: "alice@hedgy.co" }, null, 2),
);

// 3. run the real gateway
const proc = spawn({
  cmd: ["bun", HTTP_SERVER],
  cwd: ROOT,
  env: {
    ...(process.env as Record<string, string>),
    SETOKU_PROJECT_DIR: dir,
    SETOKU_DB_PATH: dbPath,
    SETOKU_TOKENS: "tok_dev=dev",
    SETOKU_TOKENS_FILE: tokensFile,
    SETOKU_HTTP_PORT: String(PORT),
    SETOKU_PUBLIC_URL: BASE,
    // local http://localhost — browsers drop Secure cookies, so login would loop
    SETOKU_COOKIE_INSECURE: "1",
  },
  stdout: "inherit",
  stderr: "inherit",
});

// 4. wait healthy, then open the browser
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.log(`\n  Setoku admin (live) → ${BASE}/admin`);
console.log(`  login:  ${USER} / ${PASS}   (also: viewer / viewer — a member, view-only)`);
console.log(`  fresh throwaway data in ${dir}`);
console.log(`  Ctrl-C to stop.\n`);
const opener = process.platform === "darwin" ? "open" : "xdg-open";
spawn([opener, `${BASE}/admin`]).exited.catch(() => {});

// 5. clean up on exit
const cleanup = () => {
  proc.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
await proc.exited;
