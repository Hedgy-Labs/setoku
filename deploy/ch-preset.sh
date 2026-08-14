#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Pick the ClickHouse memory/concurrency preset for this box's RAM.
#
#   source deploy/ch-preset.sh && ch_preset_for_ram_mb 3000   # → tiny
#   bash deploy/ch-preset.sh 3000                             # → tiny
#   bash deploy/ch-preset.sh                                  # → this box
#
# Thresholds are MemTotal MiB as `free -m` reports it, which runs a few percent
# under the advertised size (a "4 GB" VPS reports ~3800). They come from
# measured high-water marks on the running boxes, not from the sticker size:
#
#   - the gateway holds ~570 MB and does NOT shrink on a smaller box (that's
#     the onnxruntime embedding arena), vector peaks ~350 MB, and caddy +
#     postgres + the pollers add ~300 MB. That ~1.2 GB is the floor ClickHouse
#     has to fit around, before the host's own ~300 MB.
#   - a 4 GB box carrying exactly that load has run for weeks on `small` with
#     zero OOM kills, so 4 GB stays on `small`. `tiny` is for the 3 GB class and
#     below, where small's 0.7×RAM would hand ClickHouse memory the rest of the
#     stack has already committed.
#
# Unknown/unparseable RAM falls back to `small`, which was the fixed default
# before this file existed: a bad reading should never silently downgrade a box.

ch_preset_for_ram_mb() {
  local mb="${1:-}"
  case "$mb" in
    '' | *[!0-9]*) echo small; return 0 ;;
  esac
  if [ "$mb" -lt 3300 ]; then
    echo tiny
  elif [ "$mb" -lt 12000 ]; then
    echo small
  else
    echo roomy
  fi
}

ch_host_ram_mb() { free -m 2>/dev/null | awk '/^Mem:/{print $2}'; }

# Executed directly (not sourced): print the preset for the given size, or this box's.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  ch_preset_for_ram_mb "${1:-$(ch_host_ram_mb)}"
fi
