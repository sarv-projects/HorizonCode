# 28 — Implementation Status

> **What this file is:** the single map from the design corpus (docs 01–27) to implementation reality. Every status here is backed by a command that was actually run. Snapshot: **2026-11-06, evening** (see `CURRENT_RUN.md` for the live handoff view and exact continuation steps).
>
> Status ladder: **DESIGNED** → **IMPLEMENTED** (code exists and builds) → **TESTED** (automated tests exist and pass) → **VERIFIED** (the integrator ran the evidence command and observed the result; agent reports alone never reach VERIFIED).

---

## 1. Status map

| Area | Status | Evidence (run it yourself) | Notes |
|---|---|---|---|
| **Rust trust kernel** — chained event log, receipt chain, guard (deny > allow > ask, leases, `policy.json`), NDJSON protocol (8 methods) | **VERIFIED** | `cd kernel && cargo test` → 14 integration + 3 unit green; `kernel/target/release/hz-kernel --selftest` → `SELFTEST OK (14 checks)` | Includes tamper detection, 4-process concurrent append lock test, guard matrix, 1MB payloads |
| **Frozen contracts / hashing** (`app/src/contracts.ts`) | **VERIFIED** | Rust↔TS interop: each side verifies the other's files (`log.verify`, `receipt.verify` → `ok:true`) | Canonical JSON + sha256 rules shared byte-for-byte |
| **Runtime core** — config, kernel client (`trusted`) + TS fallback (`untrusted`), SQLite sessions, agent loop (stream → guard → approve → tool → receipt → events) | **TESTED + VERIFIED** | Kernel-client suite 11/11 green; e2e: `printf 'list files' \| ./bin/hzcode` → streamed answer → tool card → receipt; `kernelMode=trusted` checked live | Fallback/both-directions/config/session interop suites in flight (see §4) |
| **Providers** — Anthropic, OpenAI, mock + SSE parser | **VERIFIED** | `cd app && /home/forge/.bun/bin/bun test tests/providers` → 72 pass / 0 fail | Canned localhost servers, byte-level chunk splitting, aborts, 2 parallel tool calls; two real fixes landed (empty `arguments` for no-input tool calls) |
| **Tools** — `read write edit grep glob shell todo` | **TESTED + VERIFIED** | Tool suite on disk (~1190 lines; agent re-verifying after its `shell.ts` fix); e2e glob exercised through guard + receipt | `shell.ts` fix: `detached:true` + drain grace (compound-command timeout bug, 6/10 runs flaky before) |
| **Chat TUI** — chat bar, streaming, tool cards, y/n/a approvals, history, slash sugar; **headless mode** | **VERIFIED** | `bun test tests/tui` → 48 pass / 0 fail incl. real PTY scenarios (`/usr/bin/script`) | Mutation-checked: breaking the prompt glyph trips 6 assertions |
| **`contracts`-driven runner**: `bin/hzcode` launcher | **VERIFIED** | manual e2e runs | Zero-config default = mock provider |
| **Skills** — `.hzcode/skills/*.md` discovery, prompt injection, `/skill` activation | **DESIGNED** (full v1 spec: `CURRENT_RUN.md` Appendix A) | — | Implementation in progress by a subagent; no files yet |
| **Subagents** — `agent` tool, child session, nested loop, no recursion, caps | **DESIGNED** (spec: Appendix A) | — | Same agent as skills |
| **Code Mode** — confined JS subprocess, NDJSON tool bridge | **DESIGNED** (NF-015, NF-051; spec: Appendix B) | — | In progress; agent verified Bun APIs (`detached`, process-group kill, stdin) before writing |
| **Preview environments** — start/stop/status dev server | **DESIGNED** (NF-055; spec: Appendix B) | — | Same agent as Code Mode |
| **Everything else in docs 01–27** — ~60-tool catalog, planner/executor duality, memory tiers, compaction, full sandbox matrix, web/desktop/IDE surfaces, plugins/marketplace, governance loop, execution recorder, ACI windowing, self-improvement | **DESIGNED ONLY** | docs 09/10/11/14/15 and the NF registry in doc 24 | Sequenced in docs/27 (V0–V7). Nothing beyond v0.1 scope has code yet. |

---

## 2. The test matrix (as run at snapshot time)

```bash
# Rust trust kernel (fast)
cd kernel && cargo test

# Full TypeScript suite (~8 s)
cd app && /home/forge/.bun/bin/bun test        # 233 pass / 0 fail / 21 files at snapshot

# End-to-end, human path
cd /data/home/forge/hzcode && printf 'list files' | ./bin/hzcode
```

| Suite | Files | What it pins down |
|---|---|---|
| `kernel/tests/integration.rs` | 1 (1242 lines) | chain append/verify, tamper (byte + middle payload + truncated line), 4-process concurrency, receipts chain, guard matrix + policy.json + lease expiry, protocol malformed/unknown/1MB/unicode edges |
| `app/tests/core` | kernel-trusted (11 tests) | trusted client vs Rust kernel: mode, ping, chained appends with independently recomputed hashes, read windows, tamper, receipts, default policy, lease flow, policy.json override |
| `app/tests/tools` | 9 files | per-tool behavior incl. caps, binary refusal, edit occurrence rules, skip-dirs, shell timeout/kill/env-scrub/abort, todo session isolation |
| `app/tests/providers` | 6 files | SSE translation for Anthropic + OpenAI, chunk-boundary torture, aborts, HTTP errors, mock termination |
| `app/tests/tui` | 8 files | headless golden paths, CLI contract, approvals fail-closed, render/banner contracts, PTY scenarios |

In flight at snapshot (will raise counts): `app/tests/core/{fallback,interop,config,session}.test.ts`.

---

## 3. Semantics rulings made during implementation (binding)

1. **Issued leases are honoured by both implementations.** The kernel (`guard.rs`) consults caller-supplied leases (expiry-filtered) ∪ internally held leases; the TS fallback (`kernel.ts:344`) merges the same way. An expired *copy* passed by a caller cannot revoke a held lease — expiry happens by time. Tests assert this ordering deliberately.
2. **`arguments` is always a JSON string.** No-input tool calls produce `{}`, never `""` (both adapters fixed).
3. **`log.read` `limit` is strict** — `limit:0` returns zero events (kernel fix).
4. **Guard defaults** (no `policy.json`): `fs.read`/`fs.write` inside workspace → `allow`; outside → `ask`; `shell.exec`/`net.fetch`/`spawn` → `ask`. Precedence: deny > lease > allow > ask.
5. **Headless approvals fail closed** (auto-deny with a notice). PTY/TUI prompts y/n/a (`a` = session lease).
6. **Zero-config default is the mock provider** — chat must work with no keys. Real providers via `HZ_PROVIDER` + keys or `~/.hzcode/config.json`.

---

## 4. Known gaps / next work (front of the queue)

1. **Finish core test files** in flight (`fallback`, `interop` both directions, `config`, `session`) — then re-run the full suite and update the counts here.
2. **Integrate the three V1 feature tools** once their agents deliver: register `agent`, `code_mode`, `preview` in `app/src/tools/index.ts` (the single fenced-off integration edit; exact shape in `CURRENT_RUN.md` §8 Step 2).
3. **Re-verify the tools suite** after the tools agent's final report.
4. **Feature smoke checks** (skills activation, nested subagent run, code-mode RPC round-trip, preview start/stop) per `CURRENT_RUN.md` §8 Step 6.
5. **Then**: keep this file honest — update statuses and counts in the same commit that changes them.

---

*Methodology note: statuses were promoted only on commands the integrator ran in this workspace (`cargo test`, `bun test`, `hz-kernel --selftest`, headless e2e, kernel-mode script). Where an agent reported something not yet re-run, the row says so.*
