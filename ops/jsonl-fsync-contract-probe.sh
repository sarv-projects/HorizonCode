#!/usr/bin/env bash
#
# ops/jsonl-fsync-contract-probe.sh — Wave 0 / docs/12 F10 contract probe (advisory).
#
# Verifies the fsync-on-append *contract* via unit tests (TypeScript + optional Rust).
# Does NOT measure power-loss durability — never claim "power-loss safe" from this script.
#
# Usage: bash ops/jsonl-fsync-contract-probe.sh
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  printf 'jsonl-fsync-contract-probe: bun not found\n' >&2
  exit 1
fi

printf '== F10 jsonl fsync contract (unit tests) ==\n'
(cd "$ROOT/app" && bun test tests/core/jsonl-append.test.ts)

if command -v cargo >/dev/null 2>&1 && [ -f "$ROOT/kernel/Cargo.toml" ]; then
  printf '== F10 kernel jsonl_append contract (cargo test) ==\n'
  (
    cd "$ROOT/kernel"
    cargo test jsonl_fsync_enabled_matches_ts_contract --quiet
  )
fi

printf '\nF10 HONESTY: append+fsync contract checks passed (process-crash oriented).\n'
printf 'Power-loss durability matrix is NOT measured — do not claim power-loss guarantees.\n'
printf 'Doctor: state.durability; disable fast path: HZ_JSONL_FSYNC=0\n'
exit 0