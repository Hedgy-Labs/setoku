#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Boot the REALISTIC multi-system demo as a SECOND isolated instance, alongside
# the clean "sports" demo and production. Thin wrapper over boot.sh.
#
#   ./run-realistic.sh
#   DEMO_PUBLIC_HOST=raw.setoku.com ./run-realistic.sh   # if you add a DNS record
set -euo pipefail
cd "$(dirname "$0")"

export DEMO_DATASET=sports-realistic
export DEMO_PROJECT=setoku-demo-realistic
export DEMO_ENV_FILE=.env.realistic
export DEMO_DB=stags_raw
export DEMO_PORT=8789
export DEMO_PUBLIC_HOST="${DEMO_PUBLIC_HOST:-realistic.51-81-222-176.sslip.io}"
exec ./boot.sh
