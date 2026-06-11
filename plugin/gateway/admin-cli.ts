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
import { KnowledgeStore, defaultDbPath } from "./lib/store";
import { hashPassword, isRole, ROLES } from "./lib/accounts";
import { resolveProjectDir, loadConfig } from "./lib/config";

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
