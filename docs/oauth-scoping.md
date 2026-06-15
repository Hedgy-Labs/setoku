# OAuth for Setoku — engineering scope

**Status:** scoped, **deferred** (2026-06-15). We're staying on **bearer tokens** for now —
they're the right single model for a small self-hosted pilot, and the token-in-URL cost is
bounded (read-only + propose-only + one-click rotate). This doc is the "when we're ready"
plan.

**When we do build OAuth, it REPLACES bearer — it is not an option alongside it.** Two code
paths / two debug stories / "which mode am I in?" is friction we don't want. There are exactly
two single-model end states (claude.ai's dialog only accepts URL or OAuth, no third path):
*bearer-only* (today) or *OAuth-only* (the swap). Build the swap when we cross a real
threshold — onboarding people we don't fully trust, multi-tenant, or GA. The dual-auth window
below is a **throwaway migration bridge (days, then deleted)**, never a permanent feature.

## Why
Today a teammate connects with a **long-lived bearer token in a URL** (`/mcp/<token>`)
— claude.ai's connector dialog has no header field, so the secret rides in the path.
That leaks easily (history, proxy logs, screenshots) and never expires. OAuth removes
the URL secret and gives **short-lived, refreshable, revocable, per-user** tokens with a
consent screen. It's the expected posture once Setoku serves less-trusted users.

What it does **not** change: the membrane (analyst vs curator), read-only enforcement,
the audit log. Those stay; OAuth just replaces *how the bearer credential is obtained*.

## The model (current MCP spec, 2025-11-25)
The MCP server is an **OAuth 2.1 Resource Server**; token issuance is an **Authorization
Server** (which **may be co-hosted** in the same gateway, or a separate service). claude.ai
+ Claude Desktop do the whole flow from the URL alone — **dynamic client registration +
auth-code + PKCE + refresh** — *if* the server advertises the right metadata.

### What our gateway MUST implement (Resource Server)
- `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728) → `{ resource, authorization_servers:[…], scopes_supported:[…, "offline_access"] }` — **path-aware** (our endpoint is `/mcp`).
- `401` on the MCP endpoint with `WWW-Authenticate: Bearer resource_metadata="https://<domain>/.well-known/oauth-protected-resource/mcp"`.
- Validate the access token's **audience** (RFC 8707) — reject tokens not minted for us; never pass them through.

### What an Authorization Server must provide (co-hosted or external)
- `GET /.well-known/oauth-authorization-server` (RFC 8414) metadata.
- `/authorize` (login + consent) and `/token` (code+PKCE, refresh w/ rotation).
- **PKCE S256** (advertise `code_challenge_methods_supported:["S256"]`).
- **Open Dynamic Client Registration** `/register` (RFC 7591) — *this is why the dialog's Client ID/Secret are optional*; Claude self-registers. (SHOULD in 06-18, MAY in 11-25 — skippable if we use CIMD/Anthropic-held creds instead, but DCR is the smoothest.)
- Advertise **`offline_access`** in `scopes_supported` or Claude won't get a refresh token (→ re-auth loops).

## Build options

### Path A — Self-contained AS in the gateway, reusing our accounts  ★ recommended
The gateway is both RS and AS. **Reuse the existing argon2 accounts + `/admin` login** as
the authn + consent UI; map roles/capabilities to **scopes** (`setoku:analyst`,
`setoku:curator` ↔ `canWrite`/`denyLakeRead`). Generate signing keys at bootstrap.
- **Pro:** fully self-hosted, **no new container**, one identity source (our accounts), per-user OAuth identity = the account, matches Setoku's "one small box" ethos. Co-locating `/authorize`+`/token` is also the *lowest client-compat risk* topology.
- **Con:** you're shipping an OAuth AS — security-critical (PKCE, token signing/validation, refresh rotation, DCR output that satisfies Claude's strict Zod parsing, CORS). Most code of the three.
- **Key unknown (spike first):** the **MCP TypeScript SDK ships OAuth server scaffolding** (`mcpAuthRouter`, an `OAuthServerProvider` interface, DCR + metadata routes). If it covers the metadata/DCR/authorize/token plumbing, Path A shrinks to: wire login/consent to our accounts + issue/validate tokens + scope mapping. **This is the highest-leverage thing to validate before estimating.**

### Path B — Delegate to self-hosted Ory Hydra (+login/consent app +DCR shim)
Gateway = pure RS (smaller change). Add Hydra + Postgres + a login/consent app + a small
DCR-proxy shim (Claude rejects Hydra's empty `client_uri`/`contacts`).
- **Pro:** don't hand-roll the AS crypto.
- **Con:** ~3–4 new containers (~1 GB), you *still* build a login/consent app (wired to our accounts) + a shim, and operate Hydra per tenant box. Heavier infra, against the lightweight ethos.

### Path C — Delegate to Keycloak
Built-in login UI + official MCP guide, but a JVM service (~1.25 GB+) per tiny box. Least
custom code, most operational weight. Not a fit for "one small VPS."

## Migration (single-model swap, bridge-then-delete)
Dual auth is a **temporary bridge, not a feature**: keep `SETOKU_TOKENS`/`/mcp/<token>`
working for the few days OAuth lands so connectors don't break, switch the invite UI to the
OAuth flow, then **delete the bearer path entirely** once everyone's migrated. End state =
exactly one model live. (Note: ingest/poller credentials — `SETOKU_INGEST_TOKEN`, direct DB —
are a separate surface and unaffected; they're not part of this swap.)

## Gotchas to budget for (all from real claude.ai MCP failures)
- **CORS:** OAuth/metadata endpoints must answer preflight `OPTIONS` with `Access-Control-Allow-Origin: *` (else `Failed to fetch`).
- **WAF:** allowlist Anthropic's egress `160.79.104.0/21` (their post-auth server callback has no cookies → Bot-Fight-Mode blocks it; the error is a misleading "Authorization failed").
- **Redirect URIs:** register `https://claude.ai/api/mcp/auth_callback` (+ `claude.com`); Claude Code uses RFC 8252 loopback `http://localhost:<port>/callback`.
- **Path-aware well-known** (`…/oauth-protected-resource/mcp`, not bare).
- **Advertise `offline_access`** or no refresh tokens.

## Effort (rough, Path A)
- RS bits (9728 metadata, 401 `WWW-Authenticate`, JWT validate + audience): ~1–2 days.
- AS bits (8414 metadata, `/authorize` w/ account login + consent, `/token` code+PKCE+refresh+rotation, DCR, key-gen, CORS): **~1–2 weeks** of careful, security-critical work — **materially less if the MCP TS SDK auth router does the plumbing** (the spike).
- Scope↔capability mapping + dual-auth migration: ~2–3 days.
- claude.ai integration hardening (CORS, WAF, redirect URIs, offline_access — iterate against the live client): real, lumpy time.
- **Total: ~2–4 weeks** for a solid self-contained AS; a spike on the SDK could cut the AS portion significantly.

## Spike result — the MCP TS SDK carries the protocol plumbing ✅
We already depend on `@modelcontextprotocol/sdk@1.29.0`, and its `server/auth/*` layer
provides everything protocol-level, so **Path A is "wire up the SDK + our accounts," not
"build an AS."**

**The SDK gives us (no code from us):**
- `mcpAuthRouter({ provider, issuerUrl, resourceServerUrl, … })` — mounts `/authorize`,
  `/token`, `/register` (DCR), `/revoke`, **RFC 8414 AS metadata**, and **RFC 9728
  protected-resource metadata** (path-aware). `mcpAuthMetadataRouter` covers the RS-only
  (delegated) case.
- `requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl })` — the MCP-endpoint
  middleware that does **401 + `WWW-Authenticate: …resource_metadata=…`** and scope checks.
- DCR (register handler + a clients store), **PKCE S256 verification** (router does it using
  our stored challenge), the token endpoint mechanics, metadata helpers, and a
  `ProxyOAuthServerProvider` if we ever delegate.

**We implement only the `OAuthServerProvider` (≈7 well-defined methods) + storage:**
`clientsStore` (DCR clients), `authorize()` (← reuse our existing `/admin` argon2 accounts +
session login + a consent page), `challengeForAuthorizationCode()`, `exchangeAuthorizationCode()`,
`exchangeRefreshToken()` (rotation), `verifyAccessToken()` (→ identity + scopes → our
`canWrite`/`denyLakeRead`), optional `revokeToken()`. Backing storage = a few SQLite tables
(clients / codes / tokens) — we already use `bun:sqlite`.

**The one real surprise:** the SDK auth router is **Express-based**, but our gateway is raw
`node:http`. So the biggest non-OAuth task is **moving the HTTP layer to Express** (mount the
auth router + the StreamableHTTP `/mcp` transport — which supports Express, per the SDK's
`simpleStreamableHttp` example — + our existing `/admin` and `/health`). Moderate, well-trodden.

**Revised estimate (Path A, with the SDK): ~1.5–2.5 weeks**, roughly half the hand-rolled
number, and it removes the riskiest crypto (PKCE, token endpoint, metadata) from our code:
- Express-ify the HTTP layer: ~1–2 d · OAuthServerProvider + SQLite stores: ~2–4 d ·
  authorize()/consent reusing accounts: ~1–2 d · scope↔capability + verify wired into
  `buildServer`: ~1 d · dual-auth migration (keep static tokens): ~1 d · claude.ai hardening
  (CORS, WAF allowlist `160.79.104.0/21`, redirect URIs, `offline_access`, live testing): ~2–4 d.

**Verdict:** Path A is real and not a moonshot. No new external service, reuses our accounts,
self-hosted. Recommend it over Hydra/Keycloak.

## Recommendation
1. **Spike (½–1 day):** confirm what the **MCP TypeScript SDK's OAuth server support** gives us. This determines whether Path A is "wire up the SDK + our accounts" (days) or "build an AS" (weeks).
2. If the SDK carries the plumbing → **Path A** (self-contained, reuse accounts). Best ethos fit, no new infra.
3. If not, and we want to avoid hand-rolling crypto → **Path B (Hydra)**, accepting the extra containers.
4. Ship behind **dual auth** so nothing breaks mid-migration.

## Open decisions for the user
- Is OAuth pilot-blocking, or a pre-GA item? (Today's token-in-URL is read-only/propose-only + rotatable — bounded blast radius.)
- Self-hosted-only requirement? (Yes → Path A or self-hosted Hydra; rules out hosted IdPs.)
- One identity source (reuse our accounts) vs. an external IdP the company already has (Google/Okta)? The latter argues for Path B/C with that IdP as the AS.
