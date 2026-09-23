#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Run the Vector transform golden tests (deploy/vector/tests.yaml, invariant
# 3.1) — the CI step, also runnable locally.
#
# `vector test` has a rare harness race on CI runners: a check reports
# "no events received" for a transform that works — ~1.5% of runs, a different
# test each time (vercel_parse, render_parse, mercury_events_parse so far), and
# never reproduced locally in 300 runs, 16-way parallel. So a run whose ONLY
# failures are that signature is retried, up to 3 attempts. Anything else — a
# failed assertion, a config error — fails at once, and a genuinely
# disconnected transform is deterministic, so it still fails every attempt.
#
#   bash scripts/vector-golden-tests.sh             # docker, the pinned image
#   VECTOR_BIN=/path/to/vector bash scripts/...     # a local vector binary
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE="timberio/vector:0.49.0-alpine@sha256:2a31648e67280953aaf6b219c1b04729ac5ed12820ec2bfb698630b2d989d135" # = docker-compose.yml
ATTEMPTS=3

run_once() {
  if [ -n "${VECTOR_BIN:-}" ]; then
    CLICKHOUSE_USER=x CLICKHOUSE_PASSWORD=x "$VECTOR_BIN" test deploy/vector/vector.yaml deploy/vector/tests.yaml
  else
    docker run --rm -v "$PWD/deploy/vector:/etc/vector:ro" \
      -e CLICKHOUSE_USER=x -e CLICKHOUSE_PASSWORD=x \
      "$IMAGE" test /etc/vector/vector.yaml /etc/vector/tests.yaml
  fi
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  out="$(run_once 2>&1)"
  status=$?
  echo "$out"
  if [ "$status" -eq 0 ]; then
    if [ "$attempt" -gt 1 ]; then
      # surfaced as a CI annotation so the flake rate stays visible
      echo "::warning::vector golden tests passed on attempt ${attempt} after a harness flake (no events received)"
    fi
    exit 0
  fi
  failed="$(grep -cE '\.\.\. failed$' <<<"$out" || true)"
  flaky="$(grep -c 'failed: no events received' <<<"$out" || true)"
  if [ "$failed" -eq 0 ] || [ "$failed" -ne "$flaky" ]; then
    echo "vector golden tests: real failure (${failed} failed, ${flaky} of them 'no events received') — not retrying" >&2
    exit "$status"
  fi
  echo "vector golden tests: attempt ${attempt}/${ATTEMPTS} failed only with the harness flake (${flaky} test(s): no events received)" >&2
done
echo "vector golden tests: 'no events received' on all ${ATTEMPTS} attempts — a real disconnected transform, not the flake" >&2
exit 1
