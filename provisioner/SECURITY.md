<!-- SPDX-License-Identifier: Apache-2.0 -->
# Provisioner token security posture (Phase 4, task 4.7)

Setoku "hooks itself up" by accepting scoped provider tokens and using them to
create log drains, configure log streams, and install a Slack app. This document
states — for a skeptical OSS reader — the **minimum scope** per provider, **how
tokens are stored**, and **exactly what Setoku does with each token**.

The short version: tokens are passed via **environment variables / secret
mounts**, are used only for the one provisioning call each is needed for, and
are **never written to a context doc or to the `provisioning_log`**. A
`redactSecrets()` chokepoint (`provisioner/framework.ts`) masks token-shaped
strings on everything bound for the log, as defence-in-depth behind the simpler
guarantee that we never put tokens in a step's `details` in the first place.

## Minimum scopes per provider

| Provider | Env var | Minimum scope | What Setoku does with it |
|---|---|---|---|
| Vercel | `VERCEL_TOKEN` | A token able to **list projects** (`GET /v9/projects`) and **create log drains** (`POST /v1/log-drains`). Scope it to the team/project, not account-wide. | Enumerate projects, then create one Log Drain per project pointed at `https://<host>/ingest/vercel`. Detects a missing **Pro** plan (402/403) and stops with a human-readable explanation. Nothing else. |
| Render | `RENDER_API_KEY` | A **workspace-owner** API key able to read/configure the workspace **log stream**. | Configure (or print guided steps to configure) the workspace log stream to forward HTTPS-JSON to `https://<host>/ingest/render`. Nothing else. |
| Slack | `SLACK_APP_TOKEN` (`xapp-…`, scope `connections:write`) and `SLACK_BOT_TOKEN` (`xoxb-…`, scopes `channels:history`, `channels:read`, `users:read`) | Exactly the bot scopes in the generated manifest. App creation/install is a **human click** — Setoku only generates the manifest + install URL and consumes the resulting tokens. | Start the Socket Mode listener and the one-time backfill. Read-only against Slack (history + channel/user metadata). Never posts. |
| Ingest bearer | (config) | The bearer token Setoku tells each provider to send back on `/ingest/*`. | Embedded in the drain/stream config so Setoku can authenticate inbound batches at the edge (Caddy). It is a credential the *provider* presents to *us* — still masked in logs. |

## How tokens are stored

- **Env vars / secret mounts only.** Provisioner code reads
  `process.env[...]` at the moment of use. Tokens are not persisted by the
  provisioner to any database, file, or doc.
- **No token in the context layer.** Context docs (entities, metrics, gotchas)
  describe *data*, never credentials. The self-documentation helper
  (`provisioner/document.ts`) writes only column meanings, cadence, and example
  queries.
- **No token in the audit trail.** Every value written to `provisioning_log`
  passes through `redactValue()` → `redactSecrets()`. Even an accidental token
  in an error message is masked (`applySteps` redacts `err.message` before
  logging a failure).

## What `redactSecrets()` masks

`provisioner/framework.ts` `redactSecrets(s)` masks, preserving only a length
hint and (where safe) a prefix:

- Slack tokens — `xoxb-…`, `xoxp-…`, `xapp-…`
- Provider-prefixed secrets — `vercel_…`, `rnd_…`, `render_…`
- `Authorization: Bearer <token>` header values
- Generic long opaque blobs (24+ base64url chars with mixed character classes)

`redactValue()` walks an arbitrary object/array and applies the above to every
string, so structured `details` are covered, not just flat strings.

## Verification (task 4.7 AC)

> grep of logs/DB dumps after a full `init` finds zero token material.

The test suite asserts this directly: it provisions with token-shaped material
in the inputs and confirms nothing token-shaped reaches `provisioning_log`
(`test/provisioner.test.ts`). For a deployed box, dump `provisioning_log` and
grep for the provider token prefixes above — there should be zero hits.

## What still requires a human (not a token problem)

- Confirming the Vercel **Pro** plan.
- Clicking **install** for the Slack app in the workspace.
- Approving any provenance gotcha the provisioner files as a *pending*
  correction (I2) — the initial table doc auto-accepts, the claims about the
  world do not.
