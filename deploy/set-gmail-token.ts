#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * Mint a Gmail read-only OAuth refresh token for the gmail-poller connector.
 *
 * Run this ON A MACHINE WITH A BROWSER (your Mac) — the consent step needs one;
 * the box is headless. It prints the SETOKU_GMAIL_* lines to paste into the box's
 * /opt/setoku/.env (or writes them there with --env-file).
 *
 * Run it ONCE PER MAILBOX: one poller serves every family account, so each account
 * grants the SAME OAuth client (add each address as a Test user) and this appends
 * its refresh token to the comma-separated SETOKU_GMAIL_REFRESH_TOKENS list.
 *
 * One-time Google setup (per Google account whose mail you'll ingest):
 *   1. https://console.cloud.google.com → new project.
 *   2. APIs & Services → Enable APIs → enable "Gmail API".
 *   3. OAuth consent screen → User type "External" → app name/email → add YOUR
 *      Google address under "Test users" (Testing mode needs no verification).
 *   4. Credentials → Create credentials → OAuth client ID → type "Desktop app".
 *      Copy the Client ID and Client secret.
 *
 * Then:
 *   bun deploy/set-gmail-token.ts --client-id <ID> --client-secret <SECRET>
 *   # or write straight into an env file:
 *   bun deploy/set-gmail-token.ts --client-id <ID> --client-secret <SECRET> --env-file /opt/setoku/.env
 *
 * A browser opens for consent; the loopback redirect lands back here, the code is
 * exchanged for a refresh token, and the env lines are emitted. Scope is
 * gmail.readonly ONLY.
 */
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const PORT = Number(process.env.GMAIL_OAUTH_PORT ?? 4573);
const REDIRECT = `http://127.0.0.1:${PORT}`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const clientId = arg("client-id") ?? process.env.SETOKU_GMAIL_CLIENT_ID;
const clientSecret = arg("client-secret") ?? process.env.SETOKU_GMAIL_CLIENT_SECRET;
const envFile = arg("env-file");

if (!clientId || !clientSecret) {
  console.error("usage: bun deploy/set-gmail-token.ts --client-id <ID> --client-secret <SECRET> [--env-file <path>]");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // required to receive a refresh_token
    prompt: "consent", // force a refresh_token even if previously granted
  });

// Catch the loopback redirect, resolve with the ?code.
const code: string = await new Promise((resolve, reject) => {
  const server = Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const c = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (err) {
        server.stop();
        reject(new Error(`consent error: ${err}`));
        return new Response("Consent failed — you can close this tab.", { status: 400 });
      }
      if (c) {
        server.stop();
        resolve(c);
        return new Response("Setoku: Gmail authorized. You can close this tab.", {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("waiting for consent…");
    },
  });
  console.error(`\nOpen this URL to authorize (opening your browser)…\n\n${authUrl}\n`);
  // best-effort auto-open on macOS/Linux
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawn([opener, authUrl], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => {});
});

// Exchange the code for tokens.
const r = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code",
  }),
});
if (!r.ok) {
  console.error(`token exchange failed: ${r.status} ${await r.text().catch(() => "")}`);
  process.exit(1);
}
const tok = (await r.json()) as { refresh_token?: string };
if (!tok.refresh_token) {
  console.error("no refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and retry (prompt=consent needs a fresh grant).");
  process.exit(1);
}

// One poller serves every mailbox, so the refresh token is APPENDED to the
// comma-separated SETOKU_GMAIL_REFRESH_TOKENS list — minting a second account's
// token keeps the first. Client id/secret are shared (set once).
const newToken = tok.refresh_token;

if (envFile) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  let existing = "";
  try {
    existing = readFileSync(envFile, "utf8");
  } catch {
    /* new file */
  }
  // pull any current token list so we can append+dedupe
  const cur = existing.match(/^SETOKU_GMAIL_REFRESH_TOKENS=(.*)$/m)?.[1] ?? "";
  const tokens = [...cur.split(",").map((t) => t.trim()).filter(Boolean)];
  if (!tokens.includes(newToken)) tokens.push(newToken);
  const lines = [
    `SETOKU_GMAIL_CLIENT_ID=${clientId}`,
    `SETOKU_GMAIL_CLIENT_SECRET=${clientSecret}`,
    `SETOKU_GMAIL_REFRESH_TOKENS=${tokens.join(",")}`,
  ];
  const kept = existing
    .split("\n")
    .filter((l) => !/^SETOKU_GMAIL_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKENS?)=/.test(l))
    .join("\n")
    .replace(/\n+$/, "");
  writeFileSync(envFile, (kept ? kept + "\n" : "") + lines.join("\n") + "\n", { mode: 0o600 });
  console.error(`\ngmail token appended to ${envFile} (${tokens.length} mailbox(es) now configured)`);
} else {
  console.error(
    "\nAdd to the box's /opt/setoku/.env. Set the client id/secret once; APPEND this\n" +
      "refresh token (comma-separated) to SETOKU_GMAIL_REFRESH_TOKENS — one entry per mailbox:\n",
  );
  console.log(`SETOKU_GMAIL_CLIENT_ID=${clientId}`);
  console.log(`SETOKU_GMAIL_CLIENT_SECRET=${clientSecret}`);
  console.log(`SETOKU_GMAIL_REFRESH_TOKENS=...existing...,${newToken}`);
}
