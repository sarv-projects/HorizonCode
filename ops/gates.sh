#!/usr/bin/env bash
#
# ops/gates.sh — HorizonCode's CI gate runner, the runnable half of docs/24 §3.5.
#
# It runs the gates that exist in this repository TODAY, in a fail-fast order,
# prints one `== gate <name> ==` header per gate, and ends with a summary table.
# Exit status 0 means every gate passed. The first failing gate stops the run
# (the gates after it are reported as `skipped`), prints the tail of that gate's
# log, and the script exits 1.
#
#   gate                  what it runs
#   --------------------  ---------------------------------------------------
#   rust-kernel-suite     cargo test --locked in kernel/
#   kernel-selftest       kernel/target/release/hz-kernel --selftest
#                         --state-dir <fresh tmpdir> (release-built first when
#                         the binary is absent)
#   ts-typecheck          bun run typecheck in app/ (tsc --noEmit); runs bun install
#                         in app/ first when @types/bun or @types/node is absent
#   ts-suite              bun test in app/
#   e2e-headless-smoke    printf 'list files' | ./bin/hzcode --workspace <fresh>
#                         -> exit 0, the mock's tool exchange in the output, and
#                         a non-empty receipt chain in the workspace
#   e2e-budget-rail       the same with HZ_MAX_STEPS=1   -> exit 5 + the budget notice
#   e2e-usage-error       ./bin/hzcode --max-steps nope -> exit 2 + the diagnostic
#   startup-latency       median of 5 runs of `hzcode --version` and of one
#                         headless mock turn, each under a generous ceiling
#                         (HZ_LATENCY_VERSION_MS / HZ_LATENCY_TURN_MS override;
#                         numbers and reasoning in ops/gate-catalogue.md)
#
# The other docs/24 §3.5 rows (gate:parity-ratchet, gate:cache-guard,
# gate:layering, gate:frontend-parity, gate:file-size, gate:function-size,
# gate:wire-parity, gate:sensitive-path-coverage, gate:boundary-test,
# gate:tool-declaration, gate:receipt-coverage, gate:no-unknown-retry,
# gate:kernel-pin, gate:cross-plane-abi, gate:doc-status,
# gate:dead-lane-fail-closed, gate:provenance, gate:repolint-debt) are
# design-only: no surface exists to check them against. Each is named once, with
# its reason, in ops/gate-catalogue.md — this runner never pretends to run them.
#
# Every temporary directory lives under a single mktemp -d root that an EXIT
# trap removes, so a failure or an interrupt leaves nothing behind.
#
# Usage:  bash ops/gates.sh        (takes no arguments)
#

set -euo pipefail

# The repo root comes from this script's own location: the runner behaves the
# same from any working directory, and in CI (where the checkout path differs).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ------------------------------------------------------------------ scratch ---

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hz-gates.XXXXXX")"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --------------------------------------------------------------------- time ---

# Milliseconds from an arbitrary origin. EPOCHREALTIME is bash >= 5; whole
# seconds are the honest fallback (bash 3.2, where sub-second timing is moot).
now_ms() {
  local raw="${EPOCHREALTIME:-}"
  if [ -n "$raw" ]; then
    local digits="${raw//./}"
    printf '%s' "${digits%???}"
  else
    printf '%s000' "$SECONDS"
  fi
}

fmt_ms() {
  local ms="${1:-0}"
  if [ "$ms" -ge 10000 ]; then
    printf '%ss' "$((ms / 1000))"
  else
    printf '%sms' "$ms"
  fi
}

# ---------------------------------------------------------------------- bun ---

# CI has bun on PATH; a local machine more often has it at $HOME/.bun/bin/bun.
# Resolve it once, the same way bin/hzcode does.
BUN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN" ] && [ -x "${HOME:-}/.bun/bin/bun" ]; then
  BUN="${HOME}/.bun/bin/bun"
fi
BUN_DIR=""
E2E_PATH="$PATH"
if [ -n "$BUN" ]; then
  BUN_DIR="$(dirname "$BUN")"
  # The e2e gates run the launcher under a throwaway HOME, which hides
  # $HOME/.bun/bin/bun from the launcher's own fallback — so bun's directory
  # goes on PATH for them, whichever way it was found just now.
  E2E_PATH="$BUN_DIR:$PATH"
fi

# ---------------------------------------------------------------- gate list ---

GATES=(
  rust-kernel-suite
  kernel-selftest
  ts-typecheck
  ts-suite
  e2e-headless-smoke
  e2e-budget-rail
  e2e-usage-error
  startup-latency
)
GATE_STATUS=()
GATE_MS=()

# ------------------------------------------------------------- runner heart ---

# run_gate <index> <name> <function>: one gate, its own log, its own clock.
run_gate() {
  local index="$1" name="$2" fn="$3"
  local log="$WORK_DIR/$name.log"
  local start end status=0

  printf '\n== gate %s ==\n' "$name"
  start="$(now_ms)"
  ( "$fn" ) >"$log" 2>&1 || status=$?
  end="$(now_ms)"
  GATE_MS[$index]=$((end - start))

  if [ "$status" -eq 0 ]; then
    GATE_STATUS[$index]="ok"
    printf 'ok    %s in %s\n' "$name" "$(fmt_ms "${GATE_MS[$index]}")"
    return 0
  fi

  GATE_STATUS[$index]="FAIL"
  printf 'FAIL  %s — exit %s after %s\n' "$name" "$status" "$(fmt_ms "${GATE_MS[$index]}")"
  printf -- '--- last 40 lines of %s ---\n' "$log"
  if [ -s "$log" ]; then
    tail -n 40 "$log"
  else
    printf '(the gate produced no output)\n'
  fi
  return 1
}

# --------------------------------------------------------------------- gates ---

gate_rust_kernel_suite() {
  if ! command -v cargo >/dev/null 2>&1; then
    printf 'cargo is not on PATH — the Rust toolchain is required\n'
    return 1
  fi
  # --locked: a gate must not silently re-resolve the dependency graph.
  ( cd "$ROOT/kernel" && cargo test --locked )
}

gate_kernel_selftest() {
  local bin="$ROOT/kernel/target/release/hz-kernel"
  if ! command -v cargo >/dev/null 2>&1; then
    printf 'cargo is not on PATH — the Rust toolchain is required\n'
    return 1
  fi
  # ALWAYS rebuild the release binary before using it. The TS interop suite
  # resolves this exact path first (tests/core/helpers.ts), so a stale binary
  # silently validates OLD kernel behaviour — observed during ruling 32:
  # the suite passed against a kernel without one-use leases. The build is a
  # no-op when the tree is unchanged.
  ( cd "$ROOT/kernel" && cargo build --release --locked ) || return 1
  local state
  state="$(mktemp -d "$WORK_DIR/selftest.XXXXXX")"
  "$bin" --selftest --state-dir "$state"
}

gate_ts_typecheck() {
  if [ -z "$BUN" ]; then
    printf 'bun not found — looked on PATH and at $HOME/.bun/bin/bun\n'
    return 1
  fi
  # tsconfig.json lists the "bun" and "node" type libraries, which are
  # devDependencies. On a clean checkout they are absent and tsc fails with
  # TS2688, so install them first (dev type definitions only; the app has no
  # runtime dependencies). A failed install, e.g. offline, fails the gate.
  if [ ! -d "$ROOT/app/node_modules/@types/bun" ] || [ ! -d "$ROOT/app/node_modules/@types/node" ]; then
    printf 'app/node_modules/@types/{bun,node} missing — running bun install in app/\n'
    if ! ( cd "$ROOT/app" && "$BUN" install ); then
      printf 'bun install failed in app/ — the type definitions (@types/bun, @types/node, typescript) are required for the typecheck; is the network reachable?\n'
      return 1
    fi
  fi
  # tsc --noEmit (via the app's "typecheck" script): a type error is a gate
  # failure before the suite ever runs, so a RED compile fails fast and cheap.
  ( cd "$ROOT/app" && "$BUN" run typecheck )
}

gate_ts_suite() {
  if [ -z "$BUN" ]; then
    printf 'bun not found — looked on PATH and at $HOME/.bun/bin/bun\n'
    return 1
  fi
  ( cd "$ROOT/app" && HZ_NO_COMMITTED_SNAPSHOT=1 "$BUN" test --timeout 30000 )
}

# --------------------------------------------------------------- e2e helpers ---

# A fresh workspace and a throwaway HOME for one headless run. The HOME is not
# cosmetic: it keeps a developer's user config (~/.config/horizon/config.json, or a
# legacy ~/.hzcode/config.json) — and any real provider key inside it — out of the gate, so the exit code is the only variable left.
# E2E_EXPECT_TEXT is reset here so every gate declares its own evidence below.
e2e_begin() {
  E2E_WS="$(mktemp -d "$WORK_DIR/e2e-ws.XXXXXX")"
  E2E_HOME="$(mktemp -d "$WORK_DIR/e2e-home.XXXXXX")"
  E2E_EXPECT_TEXT=""
}

# e2e_run <label> <expected-exit> <stdin-line or ""> <extra-env or -> <command...>
#
# The provider is pinned to `mock` and every credential and budget variable is
# stripped from the environment first: a gate must never reach the network, and
# a stray HZ_MAX_STEPS in the developer's shell must not decide the outcome.
# The declared <extra-env> (if any) is applied after those unsets, so a gate can
# set exactly the one variable it is about.
#
# When E2E_EXPECT_TEXT is non-empty the captured output must contain it: an exit
# code on its own cannot tell "the turn ran" from "the process bailed out early
# with the code I was hoping for".
e2e_run() {
  local label="$1" expected="$2" line="$3" extra_env="$4"
  shift 4
  local out="$WORK_DIR/$label.out" status=0
  local -a envv=(
    env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY -u GOOGLE_API_KEY -u HZ_API_KEY -u HZ_MODEL -u HZ_BASE_URL
    -u HZ_MAX_STEPS -u HZ_MAX_TOKENS -u HZ_MAX_WALL_MS
    HOME="$E2E_HOME" PATH="$E2E_PATH" HZ_PROVIDER=mock
  )
  if [ "$extra_env" != "-" ]; then envv+=("$extra_env"); fi

  if [ -z "$line" ]; then
    "${envv[@]}" "$@" </dev/null >"$out" 2>&1 || status=$?
  else
    printf '%s\n' "$line" | "${envv[@]}" "$@" >"$out" 2>&1 || status=$?
  fi

  printf -- '--- %s output ---\n' "$label"
  cat "$out"
  printf -- '--- %s expected exit %s, observed %s ---\n' "$label" "$expected" "$status"
  if [ "$status" -ne "$expected" ]; then
    printf 'e2e mismatch: %s\n' "$label"
    return 1
  fi
  if [ -n "${E2E_EXPECT_TEXT:-}" ]; then
    case "$(cat "$out")" in
      *"$E2E_EXPECT_TEXT"*) : ;;
      *)
        printf 'e2e evidence missing: %s\n' "$E2E_EXPECT_TEXT"
        return 1
        ;;
    esac
  fi
  return 0
}

gate_e2e_headless_smoke() {
  e2e_begin
  # 'list files' is the mock's one scripted exchange (app/src/core/providers/mock.ts):
  # provider -> glob tool call -> guard -> receipt -> summary. Requiring that
  # summary in the output makes this gate prove the pipeline ran, not just that
  # the process exited 0.
  E2E_EXPECT_TEXT='Mock mode: the glob tool returned'
  e2e_run headless-smoke 0 'list files' - "$ROOT/bin/hzcode" --workspace "$E2E_WS"

  # And the run must have left a non-empty receipt chain in the fresh workspace:
  # the durable proof that something actually executed. Layout-agnostic on purpose
  # (the state-dir name has an open rename, docs/28 §4 gap 6).
  local receipts
  receipts="$(find "$E2E_WS" -name 'receipts.jsonl' -size +0 -print -quit 2>/dev/null || true)"
  if [ -z "$receipts" ]; then
    printf 'no non-empty receipts.jsonl under %s — nothing was receipted\n' "$E2E_WS"
    return 1
  fi
  printf 'receipt chain: %s\n' "${receipts#"$E2E_WS"/}"
}

gate_e2e_budget_rail() {
  e2e_begin
  # Exit 5 with the budget notice: the stop must be the budget, not an accident
  # that happens to exit 5.
  E2E_EXPECT_TEXT='budget: steps exhausted'
  e2e_run budget-rail 5 'list files' 'HZ_MAX_STEPS=1' "$ROOT/bin/hzcode" --workspace "$E2E_WS"
}

gate_e2e_usage_error() {
  e2e_begin
  # Bad input is a usage error: exit 2, with the diagnostic that names the flag.
  E2E_EXPECT_TEXT='--max-steps needs a number'
  e2e_run usage-error 2 '' - "$ROOT/bin/hzcode" --max-steps nope
}

# ----------------------------------------------------------- startup latency ---

# Ceilings in milliseconds, for the MEDIAN of 5 timed runs (after one untimed
# warm-up). Measured 2026-11-09 on an 8-core x86_64 sandbox, Bun 1.2.14, running
# as root: `--version` median 96 ms (range 92-100), one headless mock turn
# (spawn, kernel, glob call, receipt, exit) median 198 ms (range 193-222). The
# ceilings are about 5x those medians so a slower or noisier hosted runner does
# not flake, while a real regression (an eager heavy import, a kernel handshake
# that blocks, a synchronous scan at start) still trips. Override per machine
# with the environment variables; tighten the defaults only with new numbers.
LATENCY_VERSION_MS="${HZ_LATENCY_VERSION_MS:-500}"
LATENCY_TURN_MS="${HZ_LATENCY_TURN_MS:-1000}"
# WSL2 on Windows often pays a high first-spawn cost; override still wins via HZ_LATENCY_*_MS.
if [ -z "${HZ_LATENCY_VERSION_MS:-}" ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  LATENCY_VERSION_MS=5000
fi
if [ -z "${HZ_LATENCY_TURN_MS:-}" ] && grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  LATENCY_TURN_MS=5000
fi
LATENCY_RUNS=5

# A millisecond clock fine enough to time a 100 ms process. bash 5 has
# EPOCHREALTIME; GNU date has %N. Anything else cannot measure, and a gate that
# cannot measure must fail rather than pass on whole seconds.
precise_now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local digits="${EPOCHREALTIME//./}"
    printf '%s' "${digits%???}"
    return 0
  fi
  local ns
  ns="$(date +%s%N 2>/dev/null || true)"
  case "$ns" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s' "${ns%??????}"
}

# latency_median <label> <ceiling-ms> <expected-text> <stdin-line or ""> <command...>
# One untimed warm-up, then LATENCY_RUNS timed runs. Every run must exit 0 and
# print the expected text: a process that dies instantly is not fast, it is broken.
latency_median() {
  local label="$1" ceiling="$2" expect="$3" line="$4"
  shift 4
  local -a samples=()
  local run out status start end ws
  local -a envv=(
    env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GEMINI_API_KEY -u GOOGLE_API_KEY -u HZ_API_KEY -u HZ_MODEL -u HZ_BASE_URL
    -u HZ_MAX_STEPS -u HZ_MAX_TOKENS -u HZ_MAX_WALL_MS
    HOME="$E2E_HOME" PATH="$E2E_PATH" HZ_PROVIDER=mock
  )
  for run in 0 1 2 3 4 5; do
    out="$WORK_DIR/latency-$label.out"
    status=0
    ws="$(mktemp -d "$WORK_DIR/latency-ws.XXXXXX")"
    start="$(precise_now_ms)" || { printf 'no millisecond clock (needs bash >= 5 or GNU date); cannot measure latency\n'; return 1; }
    if [ -z "$line" ]; then
      "${envv[@]}" "$@" --workspace "$ws" </dev/null >"$out" 2>&1 || status=$?
    else
      printf '%s\n' "$line" | "${envv[@]}" "$@" --workspace "$ws" >"$out" 2>&1 || status=$?
    fi
    end="$(precise_now_ms)"
    if [ "$status" -ne 0 ]; then
      printf '%s: run %s exited %s\n' "$label" "$run" "$status"
      cat "$out"
      return 1
    fi
    case "$(cat "$out")" in
      *"$expect"*) : ;;
      *)
        printf '%s: run %s did not print the expected text %s\n' "$label" "$run" "$expect"
        cat "$out"
        return 1
        ;;
    esac
    if [ "$run" -gt 0 ]; then samples+=("$((end - start))"); fi
  done
  local sorted median
  sorted="$(printf '%s\n' "${samples[@]}" | sort -n | tr '\n' ' ')"
  median="$(printf '%s\n' "${samples[@]}" | sort -n | sed -n '3p')"
  printf '%s: median %s ms (ceiling %s ms); samples %s\n' "$label" "$median" "$ceiling" "$sorted"
  if [ "$median" -gt "$ceiling" ]; then
    printf 'startup-latency: %s median %s ms exceeds the %s ms ceiling\n' "$label" "$median" "$ceiling"
    return 1
  fi
  return 0
}

gate_startup_latency() {
  e2e_begin
  # --version is parsed before any workspace work, so the extra flag is harmless;
  # it keeps the helper uniform with the turn measurement.
  latency_median version "$LATENCY_VERSION_MS" 'hzcode ' "" "$ROOT/bin/hzcode" --version || return 1
  latency_median mock-turn "$LATENCY_TURN_MS" 'Mock mode: the glob tool returned' 'list files' "$ROOT/bin/hzcode"
}

# ------------------------------------------------------------------ summary ---

print_summary() {
  local i=0
  printf '\n== gate summary ==\n'
  printf '%-18s %-8s %s\n' gate status time
  while [ "$i" -lt "${#GATES[@]}" ]; do
    printf '%-18s %-8s %s\n' "${GATES[$i]}" "${GATE_STATUS[$i]:-skipped}" "$(fmt_ms "${GATE_MS[$i]:-0}")"
    i=$((i + 1))
  done
}

# --------------------------------------------------------------------- main ---

main() {
  local i=0 failed=0 gate fn

  if [ "$#" -gt 0 ]; then
    printf 'usage: bash ops/gates.sh   (the runner takes no arguments)\n' >&2
    return 2
  fi

  printf 'HorizonCode gates — repo %s\n' "$ROOT"
  printf 'bun %s\n' "${BUN:-(not found)}"

  for gate in "${GATES[@]}"; do
    fn="gate_${gate//-/_}"
    if run_gate "$i" "$gate" "$fn"; then
      i=$((i + 1))
      continue
    fi
    failed=1
    i=$((i + 1))
    break
  done

  while [ "$i" -lt "${#GATES[@]}" ]; do
    GATE_STATUS[$i]="skipped"
    GATE_MS[$i]=0
    i=$((i + 1))
  done

  print_summary

  if [ "$failed" -ne 0 ]; then
    printf '\nFAILED — the first failing gate is above; the rest did not run (fail-fast).\n'
    printf 'The other docs/24 §3.5 rows are design-only: see ops/gate-catalogue.md.\n'
    return 1
  fi

  printf '\nall %s gates passed.\n' "${#GATES[@]}"
  printf 'The other docs/24 §3.5 rows are design-only: see ops/gate-catalogue.md.\n'
  return 0
}

# main returns 0 when every gate passed, 1 on the first failing gate, 2 on a
# usage error; the EXIT trap above removes the scratch directory either way.
# Sourcing the file (the gate tests do) defines the functions and runs nothing.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  STATUS=0
  main "$@" || STATUS=$?
  exit "$STATUS"
fi
