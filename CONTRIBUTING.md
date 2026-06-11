# Contributing to Setoku

Thanks for your interest! A few ground rules keep the project healthy.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. Every commit must be signed off, certifying you have the right
to submit the code under the project license (Apache-2.0):

```bash
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer. CI rejects
unsigned commits. If you forgot: `git commit --amend -s` (or
`git rebase --signoff @{u}` for a branch).

Sign-off matters here because it preserves the project's ability to relicense
future versions if a hosted product ever requires it — see the licensing
rationale in [README.md](./README.md#phase-1--relicense-to-apache-20).

## Dev setup

Requires [Bun](https://bun.sh) and a local Postgres (for the e2e suite).

```bash
bun install
bun run typecheck
bun test          # uses a unix socket at /tmp by default;
                  # override: SETOKU_E2E_PG_HOST, SETOKU_E2E_DB_URL, SETOKU_E2E_PG_MAINTENANCE_DB
```

## Scope: small PRs to core, please

Setoku deliberately supports a small set of data sources (Vercel, Render, Slack,
first-party events). Each connector is a forever maintenance tax — new connectors
need demonstrated pull and a committed maintainer before they'll be accepted.
Bug fixes, tests, and docs are always welcome. For anything architectural, open
an issue first: the architecture section of the README records decisions and the
reasons behind them, and changes need a written reason.

## Invariants

Read the **Invariants** section of [README.md](./README.md) before touching
auth, ingestion, or the corrections queue. PRs that violate I1–I9 will be asked
to restructure, however good the feature. In particular: no pilot-tenant data
anywhere in the repo (I3) — CI greps for it.

## License

By contributing, you agree your contributions are licensed under
[Apache-2.0](./LICENSE).
