#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Phase 1.2: every TypeScript source carries an SPDX header in its first two lines.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
while IFS= read -r f; do
  if ! head -2 "$f" | grep -q "SPDX-License-Identifier: Apache-2.0"; then
    echo "missing SPDX header: $f"
    fail=1
  fi
done < <(find plugin test scripts seed -name '*.ts' -not -path '*/node_modules/*' -not -path '*/out/*' 2>/dev/null)

if [[ "$fail" -ne 0 ]]; then
  echo "check-spdx: FAILED." >&2
  exit 1
fi
echo "check-spdx: all TypeScript sources carry the Apache-2.0 SPDX header."
