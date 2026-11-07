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
| `gate:provenance` | declared-gap | No provenance register, no `NOTICE` and no upstream pins in the tree (the reference clones live outside it, `/data/home/forge/repo-tour/`); no inherited code is registered, so no entry can be missing. |
| `gate:repolint-debt` | declared-gap | No repolint and no debt baseline: nothing to ratchet. |

## 2. What `ops/gates.sh` runs today

Six gates, fail-fast, each in its own temp-logged step (`bash ops/gates.sh`):

| Step | What it proves | Existing evidence for it |
|---|---|---|
| `rust-kernel-suite` | `cargo test --locked` in `kernel/` (20 tests) | docs/28 §1, Rust trust kernel — `VERIFIED` |
| `kernel-selftest` | `hz-kernel --selftest --state-dir <fresh tmpdir>` exits 0 with `SELFTEST OK` (release-built first when absent) | docs/28 §1 — `SELFTEST OK (14 checks)` |
| `ts-suite` | `bun test` in `app/` (364 tests across 34 files) | docs/28 §1, runtime/tools/TUI rows — `TESTED + VERIFIED` |
| `e2e-headless-smoke` | fresh workspace, `printf 'list files' \| ./bin/hzcode --workspace <tmp>` exits 0, the mock's tool exchange appears in the output, and a non-empty `receipts.jsonl` is left behind | docs/28 §1 e2e rows |
| `e2e-budget-rail` | the same with `HZ_MAX_STEPS=1` exits 5 with the budget notice | docs/28 §3 ruling 15 |
| `e2e-usage-error` | `./bin/hzcode --max-steps nope` exits 2 with the diagnostic naming the flag | docs/28 §3 ruling 15; docs/14 §3.2 (exit table) |

None of these six *is* a §3.5 gate: they are the repository's own suites. The e2e steps run the provider pinned to `mock` under a throwaway `HOME`, so a gate never reaches the network and never spends money.

## 3. Keeping this file honest

- A row moves to `runnable` in the same change that makes it run, naming the `ops/gates.sh` step — never before, and never because a neighbouring check looks related.
- A `declared-gap` reason names the missing surface, so the next change knows what would close it. If a reason stops being true, the row is wrong, not merely stale.
- If a gate's §3.5 definition changes, the row changes here in the same pass. This file has no authority of its own: docs/24 §3.5 owns the gate list.
