# SPDX-License-Identifier: Apache-2.0
# Compose CLI shim — source this, then call `dc` instead of docker-compose.
# The runbooks provision boxes via get.docker.com, which installs ONLY the v2
# plugin (`docker compose`); developer machines may have either.
if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  echo "error: neither 'docker compose' (v2 plugin) nor 'docker-compose' found" >&2
  exit 1
fi
