# ops/gate-catalogue.md — the docs/24 §3.5 gate rows, mapped to today

> **What this file is:** the map from the 17 gate rows in `docs/24-feature-catalog.md` §3.5 (the 18 distinct gates counted in its §6.3) to what this repository can actually check. Companion to `ops/gates.sh`, the runner.
>
> **Two states, no third.** `runnable` means `ops/gates.sh` runs it, and the step is named. `declared-gap` means the gate is design-only: no surface exists to check it against, and the reason is stated. A gate is **never** marked runnable because something adjacent passes — a green runner says the six steps in §2 ran, and nothing about the design-only rows.
>
> Row order follows §3.5; `gate:file-size` / `gate:function-size` share one row there and are two gates here.

## 1. The eighteen gates

| Gate (§3.5) | State | Where it runs / why it cannot |
|---|---|---|
| `gate:parity-ratchet` | declared-gap | §12.1 wants every Section A row to round-trip through `CapabilityRecordV1`; no schema, producer or machine-readable matrix exists in the tree (Section A is prose), and there is no second surface whose parity could regress. |
| `gate:cache-guard` | declared-gap | No context compiler and no compiled prefix: the system prompt is assembled per run (`app/src/core/loop.ts`) and nothing hashes it, so there is no prefix to prove byte-stable, and no golden pin (RC-8's `…/golden/prefix/<family>.sha256` has no directory and no family here). |
| `gate:layering` | declared-gap | One TypeScript tree (`app/`) and one Rust crate (`kernel/`): no package/crate ranks are declared, so there is no import to check against the layering law. |
| `gate:frontend-parity` | declared-gap | Two surfaces exist (chat TUI, headless) with no capability-edge inventory and none of the per-surface counting the superseded `tools/repolint` did. |
| `gate:file-size` | declared-gap | No frozen baseline (no `baseline.json`-shaped artefact) and no size checker; a ratchet needs both. |
| `gate:function-size` | declared-gap | Same: no baseline, no function-size checker. |
| `gate:wire-parity` | declared-gap | The duplication it targets is real and hand-managed (`app/src/contracts.ts` ↔ `kernel/src/protocol.rs`, kept aligned by the interop suites), but "one generated owner" presumes a generator; there is none, so neither half of the gate can run. |
| `gate:sensitive-path-coverage` | declared-gap | Nothing in the tree declares a `sensitive:` path (no manifest carries one), so there is no declared set to prove coverage for. |
| `gate:boundary-test` | declared-gap | The one construction primitive exists in reduced form (`runNested`, `app/src/core/subagent.ts`, reached through the `agent` tool's `ctx.delegate`) but no declared caller list exists, so a new caller fails nothing. |
| `gate:tool-declaration` | declared-gap | `Tool` (`app/src/contracts.ts`) declares name, description, parameters and `concurrencyClass`; effect class, capability ID, idempotency and renderers have no field to be missing from. |
| `gate:receipt-coverage` | declared-gap | Every executed tool call is receipted centrally by the loop, but no tool declares an *observation path* — there is no declaration to fail. |
| `gate:no-unknown-retry` | declared-gap | Nothing produces an `UNKNOWN` settlement yet, and nothing retries anything: the RC-7 vocabulary exists (`TerminalState`), but the effect path (and its reconciliation surface) the gate guards does not. |
| `gate:kernel-pin` | declared-gap | The kernel binary is *discovered* (`HZ_KERNEL_BIN`, else the release or debug build under `kernel/target/`) — no digest, manifest or pin exists, so nothing can be stale or unpinned. |
| `gate:cross-plane-abi` | declared-gap | There is no native addon and no ABI to version: the cross-plane is NDJSON over stdio. The closest shipped behaviour is refusal-finality (a kernel refusal is never routed around, `app/src/core/kernel.ts`) — posture evidence, not this gate. |
| `gate:doc-status` | declared-gap | Status levels are maintained by hand (docs/28 §1); nothing parses the tables, and no claimed level names an executable evidence command that CI runs. |
| `gate:dead-lane-fail-closed` | declared-gap | v0.1 has no optional lane with an on/off switch (the kernel-mode fallback is reported honestly with its reason, but it is a transport fallback, not a dead lane), so no disabled lane can be demanded to refuse. |
| `gate:provenance` | declared-gap | No machine-readable provenance register and no `NOTICE`. Upstream commits are pinned as prose in `docs/research/upstream-pins.md` and each design document carries a Provenance section with exact URLs, but nothing parses them and the reference clones live outside the tree (read-only checkouts); no inherited code is registered, so no entry can be missing. |
| `gate:repolint-debt` | declared-gap | No repolint and no debt baseline: nothing to ratchet. |

## 2. What `ops/gates.sh` runs today

Eight gates, fail-fast, each in its own temp-logged step (`bash ops/gates.sh`). Measured 2026-11-10 on branch `docs/handoff` (as root, `bash ops/gates.sh`): all eight gates passed, none skipped (`rust-kernel-suite` about 4 s, `kernel-selftest` 36 ms, `ts-typecheck` 0.3 s, `ts-suite` about 67 s, the three e2e steps about 0.1 to 0.2 s each, `startup-latency` 1.6 s). On 2026-11-09 the run stopped at `ts-suite` as root on 11 permission tests that cannot bind for uid 0; those tests now skip themselves by a behavioural probe (rulings 39 and 51), so the earlier fail-fast stop no longer occurs.

| Step | What it proves | Existing evidence for it |
|---|---|---|
| `rust-kernel-suite` | `cargo test --locked` in `kernel/` (49 unit + 50 integration tests, re-measured 2026-11-10) | docs/28 §1, Rust trust kernel: `VERIFIED` |
| `kernel-selftest` | `hz-kernel --selftest --state-dir <fresh tmpdir>` exits 0 with `SELFTEST OK` (release-built first when absent) | docs/28 §1: `SELFTEST OK (25 checks)` (re-measured 2026-11-10) |
| `ts-typecheck` | `bun run typecheck` (`tsc --noEmit`) in `app/` reports 0 errors; on a clean checkout the gate first runs `bun install` in `app/` (dev type definitions only, the app has no runtime dependencies) and fails with a clear message if that install fails | docs/28 ruling 39 |
| `ts-suite` | `bun test` in `app/` (1800 tests across 148 files on 2026-11-10: 1792 pass, 8 permission tests skip as root, 0 fail) | docs/28 §1, runtime/tools/TUI rows: `TESTED + VERIFIED` |
| `e2e-headless-smoke` | fresh workspace, `printf 'list files' \| ./bin/hzcode --workspace <tmp>` exits 0, the mock's tool exchange appears in the output, and a non-empty `receipts.jsonl` is left behind | docs/28 §1 e2e rows |
| `e2e-budget-rail` | the same with `HZ_MAX_STEPS=1` exits 5 with the budget notice | docs/28 §3 ruling 15 |
| `e2e-usage-error` | `./bin/hzcode --max-steps nope` exits 2 with the diagnostic naming the flag | docs/28 §3 ruling 15; docs/14 §3.2 (exit table) |
| `startup-latency` | the median of 5 timed runs (after one untimed warm-up) of `hzcode --version` is at most 500 ms, and of one headless mock turn (spawn, kernel, glob call, receipt, exit) at most 1000 ms; every run must also exit 0 and print its expected text, so a crash is never "fast". Override with `HZ_LATENCY_VERSION_MS` / `HZ_LATENCY_TURN_MS`. Needs a millisecond clock (bash 5 or GNU date) and fails rather than guess without one. About 2 s of gate time | docs/28 ruling 72; the numbers are below |

None of these eight *is* a §3.5 gate: they are the repository's own suites. The e2e steps run the provider pinned to `mock` under a throwaway `HOME`, so a gate never reaches the network and never spends money.

### Startup-latency numbers

Measured 2026-11-09 on an 8-core x86_64 sandbox container, Bun 1.2.14, running as root, mock provider, 9 runs each after a warm-up (ms, sorted):

| Measurement | Samples | Median | Ceiling | Margin |
|---|---|---|---|---|
| `hzcode --version` | 92 94 95 95 96 96 98 99 100 | 96 | 500 ms | about 5x |
| headless mock turn (`printf 'list files' \| hzcode`) | 193 194 195 197 198 199 199 203 222 | 198 | 1000 ms | about 5x |

The ceilings are deliberately generous. A hosted CI runner is slower and noisier than this machine, and a gate that flakes gets ignored, so the margin is roughly 5x rather than the 3x a quiet machine would justify. The gate still trips on the regressions it exists for (an eager heavy import, a blocking kernel handshake, a synchronous scan at start), which cost far more than 5x on a 96 ms baseline only when they are large; a subtler slowdown is caught by tightening the defaults when new numbers justify it. Re-measure at release and update this table and the two defaults in `ops/gates.sh` together. These are single-machine numbers and exclude model latency.

## 3. Keeping this file honest

- A row moves to `runnable` in the same change that makes it run, naming the `ops/gates.sh` step — never before, and never because a neighbouring check looks related.
- A `declared-gap` reason names the missing surface, so the next change knows what would close it. If a reason stops being true, the row is wrong, not merely stale.
- If a gate's §3.5 definition changes, the row changes here in the same pass. This file has no authority of its own: docs/24 §3.5 owns the gate list.
