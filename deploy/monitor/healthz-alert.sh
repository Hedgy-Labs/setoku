#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Off-box /healthz poller for the Setoku boxes. Runs on an operator machine
# (Peter's Mac) via launchd every ~5 min — NOT on the box (Peter's rule is NO
# cron on the box, and an off-box pinger also catches a fully DEAD box, which
# on-box alert.sh cannot). Pages SETOKU_ALERT_WEBHOOK when a box's /healthz is
# 503/unreachable (a failed dep like clickhouse/vector) or the data disk crosses
# 75%. Alerts only on state CHANGE (and recovery), per box, so a lingering
# problem pings once.
#
# A single failed probe does NOT page: DOWN must be confirmed across
# SETOKU_ALERT_CONFIRM consecutive runs (default 2 = ~10 min at a 5-min
# interval) before it fires — this rides out the brief /healthz outage during a
# deploy (server/caddy container swap) without paging, while a genuinely dead
# box still alerts within a couple of probes. DISK alerts are monotonic and
# never flap, so they fire immediately.
#
# This is the OFF-BOX sibling of deploy/monitor/alert.sh (which runs ON one box
# for a single domain). Tracked in the repo so the two can't silently drift — a
# monitor fix must land in both. Point the operator launchd job at THIS file
# (directly, or via a symlink) so a `git pull` updates the pager; keeping the
# real script only under ~/.setoku is what let #92's confirm-fix miss the pager.
#
# Config (env, or the sourced env file; defaults shown):
#   SETOKU_ALERT_WEBHOOK    Slack incoming webhook (required to actually page)
#   SETOKU_ALERT_BOXES      "hedgy.setoku.com setoku.campsh.com"  (space/comma sep)
#   SETOKU_ALERT_CONFIRM    2   consecutive DOWN probes before paging
#   SETOKU_ALERT_ENV        ~/.setoku/healthz-alert.env  (sourced if present —
#                           holds the webhook secret, deliberately NOT in the repo)
#   SETOKU_ALERT_STATE_DIR  ~/.setoku/state
set -euo pipefail

ENV_FILE="${SETOKU_ALERT_ENV:-$HOME/.setoku/healthz-alert.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && source "$ENV_FILE"   # SETOKU_ALERT_WEBHOOK (secret, off-repo)

DISK_PCT_ALERT=75
CONFIRM="${SETOKU_ALERT_CONFIRM:-2}"           # consecutive DOWN probes before paging
STATE_DIR="${SETOKU_ALERT_STATE_DIR:-$HOME/.setoku/state}"
mkdir -p "$STATE_DIR"
# space- or comma-separated domain list (commas normalized to spaces first)
read -ra BOXES <<< "${SETOKU_ALERT_BOXES:-hedgy.setoku.com setoku.campsh.com}"
BOXES=("${BOXES[@]//,/ }")

for domain in "${BOXES[@]}"; do
  [ -z "$domain" ] && continue
  url="https://${domain}/healthz"
  state_file="${STATE_DIR}/healthz-${domain}.state"
  resp="$(curl -skm 12 "$url" || true)"
  status_detail="$(printf '%s' "$resp" | DISK="$DISK_PCT_ALERT" python3 -c '
import json, sys, os
try:
    d = json.load(sys.stdin)
except Exception:
    print("DOWN unreachable or non-JSON"); raise SystemExit
bad = [k for k, v in d.get("deps", {}).items() if not v.get("ok")]
pct = (d.get("disk") or {}).get("used_pct")
if not d.get("ok"):
    print("DOWN deps failing: " + (", ".join(bad) or "unknown")); raise SystemExit
if pct is not None and pct >= int(os.environ["DISK"]):
    print(f"DISK data volume {pct}% full"); raise SystemExit
print("OK -")')"
  status="${status_detail%% *}"
  detail="${status_detail#* }"

  # State format: "<last-alerted-status> <down-streak>". Old single-token files
  # read back as streak=0 (backward-compatible). The streak counts consecutive
  # DOWN probes so a lone deploy-window blip never reaches CONFIRM.
  read -r prev streak <<< "$(cat "$state_file" 2>/dev/null || echo "OK 0")"
  : "${prev:=OK}"; : "${streak:=0}"

  if [[ "$status" == DOWN ]]; then
    streak=$((streak + 1))
    # Not yet confirmed: hold the last alerted status, no transition, no page.
    if (( streak < CONFIRM )); then status="$prev"; fi
  else
    streak=0   # OK or DISK (monotonic) — reset; DISK pages immediately
  fi

  echo "$status $streak" > "$state_file"
  [[ "$status" == "$prev" ]] && continue   # only alert on transitions

  if [[ "$status" == OK ]]; then
    msg="✅ setoku ${domain} recovered"
  else
    msg="🚨 setoku ${domain} ${status}: ${detail} (${url})"
  fi
  echo "$(date '+%F %T') $msg"
  if [[ -n "${SETOKU_ALERT_WEBHOOK:-}" ]]; then
    curl -sm 10 -X POST -H 'content-type: application/json' \
      -d "{\"text\": \"${msg}\"}" "$SETOKU_ALERT_WEBHOOK" >/dev/null || true
  else
    echo "WARNING: SETOKU_ALERT_WEBHOOK unset — alert printed only" >&2
  fi
done
