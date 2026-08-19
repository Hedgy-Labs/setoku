// SPDX-License-Identifier: Apache-2.0
/**
 * The shared-password gate on a PUBLIC app (issue #112).
 *
 * A public app serves credential-free at /p/<id>. That's the right default for a
 * link you paste in a channel, but not for one that goes to a customer or a
 * board — so an admin can put a single shared password in front of it: the link
 * still needs no account, but it needs the word.
 *
 * This is a VIEWING gate, not an identity: there is no account, no per-person
 * audit trail, and everyone who opens the link shares one secret. It sits
 * ENTIRELY outside the membrane — an unlock grants exactly what the open public
 * link already granted (the rendered app), never a session, never a tool, never
 * a write. Nothing here can grant authority (I9).
 *
 * Mechanics: the viewer POSTs the password to /p/<id>/unlock; on a match the
 * server mints an opaque grant (stored in SQLite, bound to that one app) and
 * hands it back in a path-scoped HttpOnly cookie. Because the grant is
 * server-side, changing or clearing the password revokes every outstanding one
 * immediately — a signed/stateless cookie could not.
 */

/** How long one unlock lasts. Long enough that a person reading a dashboard
 *  daily isn't retyping it constantly, short enough that a borrowed laptop
 *  doesn't keep the link open for a month. */
export const APP_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One cookie NAME for every app — the per-app scoping is the cookie's Path
 *  (/p/<id>), so a browser only ever sends the grant for the app being viewed
 *  and two open apps don't stomp each other. The server still checks the grant
 *  is for THIS app; the path is a convenience, never the authorization. */
const COOKIE = "setoku_app";

// Same rule as the session cookie: Secure everywhere except local http dev
// (browsers drop Secure cookies on http://localhost, which would loop the gate).
const secureAttr = (): string => (process.env.SETOKU_COOKIE_INSECURE === "1" ? "" : " Secure;");

/** Read the unlock grant for the app being served from a Cookie header. A value
 *  that doesn't decode (a corrupted or planted `setoku_app=%`) reads as NO grant:
 *  decodeURIComponent throws on a bad escape, and letting that escape would 500
 *  every request for the app with no way to clear the cookie from the page. */
export function appAccessCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== COOKIE) continue;
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Set-Cookie for a fresh unlock. SameSite=Lax (not Strict): these links are
 * opened from Slack, email, and docs — a Strict cookie is withheld on that
 * cross-site navigation, so an already-unlocked viewer would be re-prompted
 * every single time they clicked the link. Lax still rides the same-site iframe
 * request for /p/<id>/frame, and the gate carries no authority to forge anyway.
 */
export function appAccessSetCookie(appId: string, token: string): string {
  return (
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly;${secureAttr()} SameSite=Lax; ` +
    `Path=/p/${encodeURIComponent(appId)}; Max-Age=${APP_ACCESS_TTL_MS / 1000}`
  );
}

/** Set-Cookie that clears a stale/revoked grant (same Path, or the browser
 *  keeps sending the dead one). */
export function appAccessClearCookie(appId: string): string {
  return `${COOKIE}=; HttpOnly;${secureAttr()} SameSite=Lax; Path=/p/${encodeURIComponent(appId)}; Max-Age=0`;
}

/** An opaque, unguessable grant token. */
export function mintAppAccessToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

/** Password field from an `application/x-www-form-urlencoded` unlock POST. */
export function parseUnlockForm(body: string): string {
  try {
    return new URLSearchParams(body).get("password") ?? "";
  } catch {
    return "";
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The gate page: title, one password field, one button. Deliberately a plain
 * `<form>` POST with NO JavaScript — it works under a CSP with no script-src at
 * all, and there's nothing here for an injected app template to hook (the app
 * itself hasn't been served yet).
 *
 * The title of a protected app is shown (it's the same thing the link's Slack
 * unfurl shows) but nothing else about it — no author, no freshness, no hint
 * about the panels behind it.
 */
export function appPasswordPage(opts: { title: string; actionPath: string; error?: string }): string {
  const title = esc(opts.title || "App");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;
       font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1917;background:#fafaf9}
  .card{width:100%;max-width:22rem;border:1px solid #e7e5e4;background:#fff;border-radius:.75rem;padding:1.5rem;
        box-shadow:0 1px 2px rgba(0,0,0,.04)}
  h1{margin:0;font-size:1.02rem;font-weight:600}
  p.sub{margin:.35rem 0 1.1rem;font-size:.82rem;color:#78716c}
  label{display:block;font-size:.8rem;color:#57534e;margin-bottom:.3rem}
  input{width:100%;font:inherit;color:#1c1917;background:#fff;border:1px solid #d6d3d1;border-radius:.4rem;padding:.45rem .6rem}
  input:focus{outline:none;border-color:#a8a29e;box-shadow:0 0 0 2px #e7e5e4}
  button{margin-top:.9rem;width:100%;font:inherit;font-weight:500;color:#fafaf9;background:#1c1917;border:1px solid #1c1917;
         border-radius:.4rem;padding:.45rem .6rem;cursor:pointer}
  button:hover{background:#292524}
  .err{margin:0 0 .8rem;font-size:.8rem;color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:.4rem;padding:.4rem .6rem}
  .brand{display:block;margin-top:1.1rem;font-size:.72rem;color:#a8a29e;text-decoration:none;text-align:center}
  .brand:hover{color:#78716c;text-decoration:underline}
</style></head><body>
<main class="card">
  <h1>${title}</h1>
  <p class="sub">This app is password-protected. Ask whoever shared the link for the password.</p>
  ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
  <form method="post" action="${esc(opts.actionPath)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Open</button>
  </form>
  <a class="brand" href="https://setoku.com" target="_blank" rel="noopener noreferrer">Made with Setoku</a>
</main>
</body></html>`;
}
