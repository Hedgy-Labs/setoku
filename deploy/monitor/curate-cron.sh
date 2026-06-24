#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Periodic curation driver (curation-cockpit-spec) — the MODEL-DRIVEN half of the
# loop, as ONE scheduled command but TWO isolated Claude sessions, one per token.
#
# Why two sessions and not one: the jobs live in different trust domains, and
# merging them would break the membrane (I2/I9):
#
#   • generate — CURATOR token: reads the company's own CODE/schema (trusted) and
#       commits refreshed context directly. Safe to auto-commit; never reads the lake.
#   • triage   — JANITOR token: reads untrusted pending corrections and only DRAFTS
#       finished changes + auto-rejects objective junk. Commits NOTHING; a human
#       blesses on /admin.
#
# HOW TWO TOKENS LIVE IN ONE SCRIPT: each step writes a throwaway MCP config
# carrying just its own bearer token, and runs `claude -p ... --mcp-config <that>
# --strict-mcp-config`. --strict-mcp-config means ONLY that connector loads, so a
# session literally never holds the other token. The membrane is enforced at the
# tooling layer (which connector) on top of the server's capability gating (which
# tools that token unlocks). The deterministic drift canary is separate
# (knowledge-canary.sh); this is the part that needs a model.
#
# Runs ANYWHERE that has Claude Code authenticated (a claude.ai subscription
# login persisted, or ANTHROPIC_API_KEY in env) — a workstation cron, GitHub
# Actions, an always-on box. NOT the VPS (it runs only containers, no Claude).
# generate also needs a CHECKOUT of the business repo (it reads the code), so
# point SETOKU_REPO_DIR at one.
#
# Env (set in the cron environment or a sourced, uncommitted .env):
#   SETOKU_MCP_URL        https://setoku.yourco.com/mcp        (required)
#   SETOKU_CURATOR_TOKEN  curator bearer token                 (required unless SKIP_GENERATE)
#   SETOKU_JANITOR_TOKEN  janitor bearer token                 (required)
#   SETOKU_REPO_DIR       business repo checkout (generate reads code; default: cwd)
#   SETOKU_CLAUDE_MODEL   pin a model (optional)
#   SETOKU_MAX_TURNS      per-session turn cap (default 60)
#   SETOKU_SKIP_GENERATE  set to 1 to run triage only
#   SETOKU_GENERATE_BRANCH  branch generate is allowed to commit from (default main)
#   SETOKU_GENERATE_PULL    set to 1 to `git pull --ff-only` the checkout before checking
#   SETOKU_GENERATE_STATE   marker file for the last-generated commit
#                           (default <repo>/.git/setoku-generate.sha)
#
# generate is GATED on the code: it runs only when SETOKU_REPO_DIR is on `main`
# AND HEAD has advanced since the last successful generate. Two reasons —
# generate only has new info when the code changes (running it on unchanged code
# just churns), and auto-committing context is only appropriate from the trusted,
# reviewed main line (a feature branch shouldn't rewrite curated knowledge). The
# marker advances only on a SUCCESSFUL generate, so a failure retries next run.
#
# Cadence: drive this from a post-deploy / CI hook on main (the checkout is fresh,
# HEAD is the merge) and/or a time cron (with SETOKU_GENERATE_PULL=1 so it sees
# new commits). The triage pass runs every time; generate self-skips when there's
# nothing new.
set -euo pipefail

URL="${SETOKU_MCP_URL:?set SETOKU_MCP_URL (https://<host>/mcp)}"
REPO_DIR="${SETOKU_REPO_DIR:-$PWD}"
MAX_TURNS="${SETOKU_MAX_TURNS:-60}"
MODEL_ARGS=(); [ -n "${SETOKU_CLAUDE_MODEL:-}" ] && MODEL_ARGS=(--model "$SETOKU_CLAUDE_MODEL")
GEN_BRANCH="${SETOKU_GENERATE_BRANCH:-main}"
STATE_FILE="${SETOKU_GENERATE_STATE:-$REPO_DIR/.git/setoku-generate.sha}"

if ! command -v claude >/dev/null 2>&1; then
  echo "curate-cron: claude (Claude Code) not on PATH — install it on the runner." >&2
  exit 2
fi

# Run one isolated headless session pinned to a single connector/token.
#   $1 connector name (→ tool prefix mcp__<name>__*)   $2 bearer token
#   $3 prompt                                          $4.. extra non-MCP tools to allow
run_step() {
  local connector="$1" token="$2" prompt="$3"; shift 3
  local dir cfg rc
  dir="$(mktemp -d)"                       # mktemp dir is 0700 — the token file isn't world-readable
  cfg="$dir/mcp.json"
  cat > "$cfg" <<JSON
{ "mcpServers": { "$connector": { "type": "http", "url": "$URL", "headers": { "Authorization": "Bearer $token" } } } }
JSON
  # allow the connector's whole (capability-bounded) toolset + any extra local tools
  local allowed=("mcp__$connector" "$@")
  set +e
  ( cd "$REPO_DIR" && claude -p "$prompt" \
      --mcp-config "$cfg" --strict-mcp-config \
      --allowedTools "${allowed[@]}" \
      --max-turns "$MAX_TURNS" "${MODEL_ARGS[@]}" )
  rc=$?
  set -e
  rm -rf "$dir"
  return $rc
}

GENERATE_PROMPT='/setoku:generate Refresh Setokus business context from THIS repositorys code, ORM schema, and migrations. Update docs that have drifted from the code; do not churn unchanged ones. Commit improvements with upsert_context (this is the curator connector — trusted source, safe to commit directly).'

TRIAGE_PROMPT='/setoku:curate Run the auto-draft + janitor pass over the pending corrections queue. For each UNDRAFTED pending item: read it and its related doc, draft the exact doc-edit, lint the drafted SQL with run_query, set flags (lint/dupe/contradiction/provenance), and save it with draft_correction. Auto-reject with reject_correction ONLY objective failures (SQL errors, denied table, malformed, exact duplicate, contradicts the trusted code/schema); leave anything semantic or uncertain pending. Commit NOTHING — the human blesses on /admin.'

# generate, gated: on `main` AND HEAD advanced since the last successful run.
run_generate_if_due() {
  [ "${SETOKU_SKIP_GENERATE:-}" = "1" ] && { echo "   (skip generate: SETOKU_SKIP_GENERATE=1)"; return; }
  if ! git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    echo "   (skip generate: $REPO_DIR is not a git checkout)"; return
  fi
  [ "${SETOKU_GENERATE_PULL:-}" = "1" ] && git -C "$REPO_DIR" pull --ff-only --quiet || true
  local branch head last
  branch="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [ "$branch" != "$GEN_BRANCH" ]; then
    echo "   (skip generate: on '$branch', not '$GEN_BRANCH' — context auto-commits only from the trusted main line)"; return
  fi
  head="$(git -C "$REPO_DIR" rev-parse HEAD)"
  last="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [ "$head" = "$last" ]; then
    echo "   (skip generate: HEAD ${head:0:12} unchanged since last successful run)"; return
  fi
  echo "→ generate (curator connector — $GEN_BRANCH @ ${head:0:12} is new; commits trusted, code-derived context)…"
  if run_step setoku-curator "${SETOKU_CURATOR_TOKEN:?set SETOKU_CURATOR_TOKEN or SETOKU_SKIP_GENERATE=1}" \
       "$GENERATE_PROMPT" Read Grep Glob; then
    printf '%s\n' "$head" > "$STATE_FILE"   # advance the marker only on SUCCESS → a failure retries
  else
    echo "   (generate failed — marker not advanced; will retry next run)"
  fi
}

run_generate_if_due

echo "→ triage (janitor connector — drafts + objective auto-rejects only)…"
run_step setoku-janitor "${SETOKU_JANITOR_TOKEN:?set SETOKU_JANITOR_TOKEN}" "$TRIAGE_PROMPT" \
  || echo "   (triage failed)"

echo "✓ curation pass done — review finished cards at ${URL%/mcp}/admin"
