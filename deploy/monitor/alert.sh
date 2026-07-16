#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Minimal alerting (2.6) — cron every 5 minutes (deploy/backup/cron.example).
# Pages SETOKU_ALERT_WEBHOOK when /healthz is unhealthy/unreachable or the data
# disk crosses 75% (disk-full is the #1 predictable incident; /healthz itself
# only degrades at 90%). Alerts on state CHANGE (plus recovery), not every run.
#
# A single failed probe does NOT page: DOWN must be confirmed across
# SETOKU_ALERT_CONFIRM consecutive runs (default 2 = ~10 min) before it fires.
# This rides out the brief /healthz outage during a deploy (docker compose
# up --build restarts the server for ~1 min) without paging, while a genuinely
# dead box still alerts within a couple of probes. Disk alerts are monotonic
# and never flap, so they fire immediately.
#
# This catches sick-box states. A DEAD box can't report itself — also register
# https://<domain>/healthz with an external uptime pinger (healthchecks.io,
# UptimeRobot, a GitHub Actions cron — anything off-box).
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source .env; set +a

URL="${SETOKU_HEALTHZ_URL:-https://${SETOKU_DOMAIN:-localhost}/healthz}"
STATE_FILE="/tmp/setoku-alert.state"
DISK_PCT_ALERT=75
CONFIRM="${SETOKU_ALERT_CONFIRM:-2}"  # consecutive DOWN probes before paging

resp="$(curl -skm 10 "$URL" || true)"
read -r status detail <<< "$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("DOWN healthz unreachable or non-JSON"); raise SystemExit
bad = [k for k, v in d.get("deps", {}).items() if not v.get("ok")]
pct = (d.get("disk") or {}).get("used_pct")
if not d.get("ok"):
    print("DOWN deps failing: " + (", ".join(bad) or "unknown")); raise SystemExit
if pct is not None and pct >= '"$DISK_PCT_ALERT"':
    print(f"DISK data volume {pct}% full"); raise SystemExit
print("OK -")')"

# State file: "<last-alerted-status> <down-streak>". The streak counts
# consecutive DOWN probes so a lone deploy-window blip never reaches CONFIRM.
read -r prev streak <<< "$(cat "$STATE_FILE" 2>/dev/null || echo "OK 0")"
: "${prev:=OK}"; : "${streak:=0}"

if [[ "$status" == DOWN ]]; then
  streak=$((streak + 1))
  # Not yet confirmed: hold the last alerted status, no transition, no page.
  (( streak < CONFIRM )) && status="$prev"
else
  streak=0
fi

echo "$status $streak" > "$STATE_FILE"
[[ "$status" == "$prev" ]] && exit 0  # only alert on transitions

msg="setoku ${status}: ${detail} (${URL})"
[[ "$status" == OK ]] && msg="setoku recovered (${URL})"
echo "$msg"
if [[ -n "${SETOKU_ALERT_WEBHOOK:-}" ]]; then
  curl -sm 10 -X POST -H 'content-type: application/json' \
    -d "{\"text\": \"${msg}\"}" "$SETOKU_ALERT_WEBHOOK" >/dev/null
else
  echo "WARNING: SETOKU_ALERT_WEBHOOK unset — alert printed only" >&2
fi
