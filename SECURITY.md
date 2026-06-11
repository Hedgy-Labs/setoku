<!-- SPDX-License-Identifier: Apache-2.0 -->
# Security

Setoku is single-tenant by architecture (I6): one deploy = one org, no tenancy
layer. The core security posture is enforced structurally, not by policy:

- **Databases are never public (I1).** Only Caddy binds a public port (443; SSH
  on the host). Postgres and ClickHouse listen on the compose network only.
- **The corrections queue is the only write path into curated context (I2),**
  and authority changes pass through a human outside the agent loop (I9). Agents
  reading untrusted data (logs, Slack) are prompt-injectable, so the agent-facing
  MCP surface is propose-only; acceptance is a human click on the approval
  surface.
- **No server-side inference; zero AI keys required (I8).** Setoku holds no AI
  API keys and performs no server-side inference.

## Reporting a vulnerability

Please report security issues privately to the maintainers (see
`CONTRIBUTING.md` for the contact channel) rather than opening a public issue.

## Self-provisioning token posture (Phase 4)

The self-provisioning engine accepts scoped provider tokens (Vercel, Render,
Slack) to wire up data sources. The minimum scope per provider, how those tokens
are stored (env / secret mounts only — never in context docs or the
`provisioning_log`), the `redactSecrets()` log-redaction chokepoint, and exactly
what Setoku does with each token are documented in detail in
[`provisioner/SECURITY.md`](./provisioner/SECURITY.md).

Summary of the guarantees:

- Tokens are read from `process.env` at the moment of use and are never
  persisted by the provisioner to any file, doc, or table.
- Everything written to the append-only `provisioning_log` audit trail passes
  through `redactValue()` → `redactSecrets()`; token-shaped material is masked.
- After a full `setoku init`, a grep of logs / DB dumps for provider token
  prefixes (`xoxb-`, `xapp-`, `vercel_`, `rnd_`, `Bearer …`) finds zero hits —
  the test suite asserts this (`test/provisioner.test.ts`).
