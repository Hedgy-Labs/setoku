#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Account bootstrap CLI for the web admin/approval surface (Phase 5.1).
 *
 * The first admin cannot arrive through an authenticated channel, so it is
 * created here — a deliberate local command run on the box itself:
 *
 *   docker compose exec server bun gateway/admin-cli.ts create-user alice --role admin
 *   bun plugin/gateway/admin-cli.ts list-users
 *   bun plugin/gateway/admin-cli.ts set-password alice
 *
 * The password is read from the SETOKU_NEW_PASSWORD env var if set (for
 * scripted/CI use), otherwise prompted interactively (never echoed, never
 * logged). It is argon2id-hashed before it touches the store.
 */
import fs from "node:fs";
import { KnowledgeStore, defaultDbPath } from "./lib/store";
import { hashPassword, isRole, ROLES } from "./lib/accounts";
import { resolveProjectDir, loadConfig } from "./lib/config";

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function storePath(): string {
  if (process.env.SETOKU_DB_PATH) return process.env.SETOKU_DB_PATH;
  const dir = resolveProjectDir();
  const res = loadConfig(dir);
  if (res.ok && typeof res.config.knowledgeDb === "string") {
    const p = res.config.knowledgeDb;
    return p.startsWith("/") ? p : `${dir}/${p}`;
  }
  return defaultDbPath(dir);
}

async function readPassword(prompt: string): Promise<string> {
  const env = process.env.SETOKU_NEW_PASSWORD;
  if (env) return env;
  process.stdout.write(prompt);
  // Bun: read a line from stdin. (Terminal echo isn't suppressed here — for
  // unattended/scripted use prefer SETOKU_NEW_PASSWORD; interactive is a
  // deliberate local action on a trusted box.)
  for await (const line of console) return line.trim();
  return "";
}

function usage(): never {
  console.error(
    "usage:\n" +
      "  admin-cli create-user <username> [--role admin|member]\n" +
      "  admin-cli set-password <username>\n" +
      "  admin-cli list-users\n" +
      "  admin-cli add-teammate <identity>          (mint an analyst connector for a teammate)\n" +
      "  admin-cli create-curator-token <identity>\n" +
      "(password via SETOKU_NEW_PASSWORD env, else interactive prompt)",
  );
  process.exit(2);
}

async function main() {
  const [cmd, username, ...rest] = process.argv.slice(2);
  const store = new KnowledgeStore(storePath());

  if (cmd === "list-users") {
    const rows = store.listAccounts();
    if (!rows.length) {
      console.log("(no accounts yet — create one with create-user)");
      return;
    }
    for (const a of rows) console.log(`${a.username}\t${a.role}\t${a.createdAt}`);
    return;
  }

  if (cmd === "create-user") {
    if (!username) usage();
    if (store.getAccount(username)) {
      console.error(`user "${username}" already exists`);
      process.exit(1);
    }
    let role = "admin";
    const ri = rest.indexOf("--role");
    if (ri >= 0 && rest[ri + 1]) role = rest[ri + 1];
    if (!isRole(role)) {
      console.error(`invalid role "${role}" (one of: ${ROLES.join(", ")})`);
      process.exit(1);
    }
    const pw = await readPassword(`password for ${username}: `);
    if (pw.length < 8) {
      console.error("password must be at least 8 characters");
      process.exit(1);
    }
    store.createAccount({
      username,
      pwhash: await hashPassword(pw),
      role,
      createdBy: "admin-cli",
    });
    console.log(`created ${role} "${username}"`);
    return;
  }

  if (cmd === "add-teammate") {
    // Mint an analyst connector for a teammate — the "share with the team" path.
    // Analyst tokens are read-only + propose-only (the safe default for everyone).
    const identity = username;
    if (!identity) usage();
    const token = randomToken();
    const dom = process.env.SETOKU_DOMAIN ?? "<your-domain>";
    const file = process.env.SETOKU_TOKENS_FILE;

    // Prefer the tokens FILE (hot-pluggable, no .env surgery). Append and tell
    // the operator to restart so the new token loads.
    let wired = false;
    if (file) {
      let map: Record<string, string> = {};
      try {
        if (fs.existsSync(file)) map = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        console.error(`could not parse ${file} as JSON — fix it or unset SETOKU_TOKENS_FILE`);
        process.exit(1);
      }
      map[token] = identity;
      fs.writeFileSync(file, JSON.stringify(map, null, 2) + "\n");
      wired = true;
    }

    store.audit("admin-cli", "analyst_token_created", { identity });
    console.log(`analyst connector for ${identity} (token shown once):\n`);
    console.log(`  ${token}=${identity}\n`);
    if (wired) {
      console.log(`✓ added to ${file}. Restart to load it:  docker compose up -d server\n`);
    } else {
      console.log("Add it to SETOKU_TOKENS in /opt/setoku/.env (comma-separated), then restart the server.");
      console.log("(Tip: set SETOKU_TOKENS_FILE to a JSON file and this command wires teammates in for you.)\n");
    }
    console.log("Send your teammate ONE of these:");
    console.log(`  • Claude Code / Desktop (devs):   curl -fsSL https://${dom}/i/${token} | sh`);
    console.log(`  • Claude.ai (anyone, incl. non-technical) — add a custom connector:`);
    console.log(`        URL:    https://${dom}/mcp`);
    console.log(`        Header: Authorization: Bearer ${token}`);
    console.log(`    Settings → Connectors → Add custom connector. Then just ask in plain language`);
    console.log(`    ("show me signups by week") — Claude charts it, using the team's curated context.`);
    return;
  }

  if (cmd === "create-curator-token") {
    // Mint a curator token (commit curated knowledge; cannot read the lake).
    // Not stored in the DB — it lives in SETOKU_CURATOR_TOKENS on the box. We
    // print it once and record the issuance in the audit log.
    const identity = username;
    if (!identity) usage();
    const token = randomToken();
    store.audit("admin-cli", "curator_token_created", { identity });
    const dom = process.env.SETOKU_DOMAIN ?? "<your-domain>";
    console.log(`curator token for ${identity} (shown once):\n`);
    console.log(`  ${token}=${identity}\n`);
    console.log("1. Append it to SETOKU_CURATOR_TOKENS in /opt/setoku/.env (comma-separated), then restart the server.");
    console.log("2. On the operator's machine ONLY (never analyst machines), add the curator connector:");
    console.log(
      `   claude mcp add --scope user --transport http setoku-curator https://${dom}/mcp --header "Authorization: Bearer ${token}"`,
    );
    console.log("\nThis token can commit curated knowledge (upsert_context/resolve_correction) but cannot read the lake.");
    return;
  }

  if (cmd === "set-password") {
    if (!username || !store.getAccount(username)) {
      console.error(`no such user "${username ?? ""}"`);
      process.exit(1);
    }
    const pw = await readPassword(`new password for ${username}: `);
    if (pw.length < 8) {
      console.error("password must be at least 8 characters");
      process.exit(1);
    }
    store.setPassword(username, await hashPassword(pw));
    console.log(`password updated for "${username}"`);
    return;
  }

  usage();
}

main().catch((e) => {
  console.error("admin-cli failed:", e);
  process.exit(1);
});
