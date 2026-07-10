#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Account bootstrap CLI for the web admin/approval surface (Phase 5.1).
 *
 * The first admin cannot arrive through an authenticated channel, so it is
 * created here — a deliberate local command run on the box itself:
 *
 *   docker compose exec server bun gateway/admin-cli.ts add-person alice@co.com --role admin
 *   bun plugin/gateway/admin-cli.ts list-users
 *   bun plugin/gateway/admin-cli.ts set-password alice@co.com
 *
 * add-person is the default way to add ANYONE: one identity = a web login +
 * a read-only analyst connector, created together (users ↔ connectors 1:1).
 *
 * The password is read from the SETOKU_NEW_PASSWORD env var if set (for
 * scripted/CI use), otherwise prompted interactively (never echoed, never
 * logged). It is argon2id-hashed before it touches the store.
 */
import { KnowledgeStore, defaultDbPath } from "./lib/store";
import { hashPassword, isRole, ROLES } from "./lib/accounts";
import { resolveProjectDir, loadConfig, connectorName } from "./lib/config";

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * This box's public origin for the URLs we print. Prefer SETOKU_PUBLIC_URL (a
 * full origin, and what the server itself uses), fall back to SETOKU_DOMAIN,
 * else a visible placeholder. The server container has SETOKU_PUBLIC_URL but not
 * always SETOKU_DOMAIN, which is why the CLI used to print "<your-domain>".
 */
function boxOrigin(): string {
  const pub = process.env.SETOKU_PUBLIC_URL;
  if (pub) return pub.replace(/\/+$/, "");
  const dom = process.env.SETOKU_DOMAIN;
  return dom ? `https://${dom}` : "https://<your-domain>";
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
      "  admin-cli add-person <identity> [--role admin|member]   (login + analyst connector, one identity — the default way to add anyone)\n" +
      "  admin-cli add-teammate <identity>          (alias: add-person --role member)\n" +
      "  admin-cli create-user <username> [--role admin|member]  (login only — repair/escape hatch)\n" +
      "  admin-cli set-password <username>\n" +
      "  admin-cli list-users\n" +
      "  admin-cli create-curator-token <identity>\n" +
      "  admin-cli create-janitor-token <identity>  (mint an auto-draft/reject token for the curation cron)\n" +
      "(password via SETOKU_NEW_PASSWORD env, else interactive prompt)",
  );
  process.exit(2);
}

/** The connector hand-off instructions, shared by add-person / add-teammate. */
function printConnectorInstructions(token: string): void {
  const origin = boxOrigin();
  console.log(`✓ connector live now — no restart needed.\n`);
  console.log("Send them ONE of these:");
  console.log(`  • Claude Code (CLI):   curl -fsSL ${origin}/i/${token} | sh`);
  console.log(`  • Claude.ai / Desktop app (anyone, incl. non-technical) — Settings → Connectors →`);
  console.log(`    Add custom connector. The dialog has NO header field, so paste the token-in-URL as`);
  console.log(`    the "Remote MCP server URL" (leave OAuth blank):`);
  console.log(`        ${origin}/mcp/${token}`);
  console.log(`    (this URL carries the access token — treat it like a password). Then just ask in`);
  console.log(`    plain language ("show me signups by week").`);
}

/**
 * One person = one login + one analyst connector under the SAME identity.
 * Creates the account if missing (password from SETOKU_NEW_PASSWORD, else
 * prompted) and mints a DB-backed analyst token — live immediately.
 *
 * OUTPUT CONTRACT with deploy/bootstrap.sh: exactly one line of the form
 * `token=<48 hex>` (parsed with `sed -n 's/^token=//p'`) — keep it stable.
 *
 * Membrane (I2/I9): this mints ANALYST capability only (read + propose). The
 * account's approve power is role-gated server-side per request; curator and
 * janitor tokens stay env-pinned via their own deliberate commands below.
 */
async function addPerson(
  store: KnowledgeStore,
  identity: string,
  role: string,
  opts: { generatePassword?: boolean } = {},
): Promise<void> {
  if (!isRole(role)) {
    console.error(`invalid role "${role}" (one of: ${ROLES.join(", ")})`);
    process.exit(1);
  }
  if (store.getAccount(identity)) {
    console.log(`account "${identity}" already exists — keeping it (reset with set-password)`);
  } else {
    let pw: string;
    let generated = false;
    if (opts.generatePassword && !process.env.SETOKU_NEW_PASSWORD) {
      // add-teammate: the admin doesn't know the teammate's password — mint a
      // temp one (same as the web invite) and print it once.
      pw = randomToken().slice(0, 16);
      generated = true;
    } else {
      pw = await readPassword(`password for ${identity}: `);
      if (pw.length < 8) {
        console.error("password must be at least 8 characters");
        process.exit(1);
      }
    }
    store.createAccount({
      username: identity,
      pwhash: await hashPassword(pw),
      role,
      createdBy: "admin-cli",
    });
    console.log(
      `created ${role} login "${identity}"${generated ? ` — password (share once): ${pw}` : ""}`,
    );
  }
  const token = randomToken();
  store.addAnalystToken(token, identity, "admin-cli");
  store.audit("admin-cli", "person_added", { identity, role });
  console.log(`analyst connector for ${identity} (shown once):\n`);
  console.log(`token=${token}\n`);
  printConnectorInstructions(token);
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

  if (cmd === "add-person") {
    // One person = login + analyst connector, same identity (see addPerson).
    if (!username) usage();
    let role = "member";
    const ri = rest.indexOf("--role");
    if (ri >= 0 && rest[ri + 1]) role = rest[ri + 1];
    await addPerson(store, username, role);
    return;
  }

  if (cmd === "add-teammate") {
    // The "share with the team" path — now a full person, not just a token:
    // a member login (temp password printed once) + a read-only, propose-only
    // analyst connector, so users and connectors stay 1:1.
    if (!username) usage();
    await addPerson(store, username, "member", { generatePassword: true });
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
    const origin = boxOrigin();
    const name = connectorName(resolveProjectDir(), "curator");
    console.log(`curator token for ${identity} (shown once):\n`);
    console.log(`  ${token}=${identity}\n`);
    console.log("1. Append it to SETOKU_CURATOR_TOKENS in /opt/setoku/.env (comma-separated), then restart the server.");
    console.log("2. On the operator's machine ONLY (never analyst machines), add the curator connector:");
    console.log(
      `   claude mcp add --scope user --transport http ${name} ${origin}/mcp --header "Authorization: Bearer ${token}"`,
    );
    console.log("\nThis token can commit curated knowledge (upsert_context/resolve_correction) but cannot read the lake.");
    return;
  }

  if (cmd === "create-janitor-token") {
    // Mint a janitor token (auto-draft + auto-reject the corrections queue).
    // Draft + reject ONLY — both grant zero authority — so it can never commit
    // or accept. Lives in SETOKU_JANITOR_TOKENS on the box; printed once.
    const identity = username;
    if (!identity) usage();
    const token = randomToken();
    store.audit("admin-cli", "janitor_token_created", { identity });
    const origin = boxOrigin();
    const name = connectorName(resolveProjectDir(), "janitor");
    console.log(`janitor token for ${identity} (shown once):\n`);
    console.log(`  ${token}=${identity}\n`);
    console.log("1. Append it to SETOKU_JANITOR_TOKENS in /opt/setoku/.env (comma-separated), then restart the server.");
    console.log("2. On the curation runner ONLY (where the cron / curate-cron.sh runs), use it for the janitor connector:");
    console.log(
      `   claude mcp add --scope user --transport http ${name} ${origin}/mcp --header "Authorization: Bearer ${token}"`,
    );
    console.log("\nThis token can only draft (draft_correction) and reject (reject_correction) — it can never commit or accept knowledge.");
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
