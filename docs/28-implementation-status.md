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
| **Runtime core** — config, kernel client (`trusted`) + TS fallback (`untrusted`), SQLite sessions, agent loop (stream → guard → approve → tool → receipt → events) | **TESTED + VERIFIED** | Kernel-client suite 11/11 green; e2e: `printf 'list files' \| ./bin/hzcode` → streamed answer → tool card → receipt; `kernelMode=trusted` checked live | Fallback/both-directions/config/session interop suites: **all landed and green** |
| **Providers** — Anthropic, OpenAI, mock + SSE parser | **VERIFIED** | `cd app && /home/forge/.bun/bin/bun test tests/providers` → 72 pass / 0 fail | Canned localhost servers, byte-level chunk splitting, aborts, 2 parallel tool calls; two real fixes landed (empty `arguments` for no-input tool calls) |
| **Tools** — `read write edit grep glob shell todo` | **TESTED + VERIFIED** | Tool suite green in the full run; e2e glob exercised through guard + receipt | `shell.ts` fix: `detached:true` + drain grace (compound-command timeout bug, 6/10 runs flaky before) |
| **Chat TUI** — chat bar, streaming, tool cards, y/n/a approvals, history, slash sugar; **headless mode** | **VERIFIED** | `bun test tests/tui` → 48 pass / 0 fail incl. real PTY scenarios (`/usr/bin/script`) | Mutation-checked: breaking the prompt glyph trips 6 assertions |
| **`contracts`-driven runner**: `bin/hzcode` launcher | **VERIFIED** | manual e2e runs | Zero-config default = mock provider |
| **Skills** — `.hzcode/skills/*.md` discovery (workspace shadows home), prompt directory (cap 12), `/skill` activation with body injection (cap 8000) | **VERIFIED** | `bun test tests/core/skills-agents.test.ts` → 10 pass; live chat: `/demo …` → `· skill active: demo` + reply, exit 0 | Built direct by the integrator after the subagent handling it died three times (provider JWT / empty-response infra errors) |
| **Subagents** — `agent` tool, child session, nested loop, base-seven tools only (no recursion), steps 12 default / 20 cap, abort inheritance, own receipts | **VERIFIED** | same suite: child session titled `subagent: …`, glob through the guard, receipts chain + child event stream verify | `ToolContext.delegate?: DelegateRunner` (additive); child toolSpecs = base seven exactly |
| **Code Mode** — Bun subprocess JS runner, NDJSON tool bridge, guard/approve/receipt per call, 30s/120s budget | **VERIFIED** (NF-015, NF-051) | `bun test tests/core/codemode-preview.test.ts` → 12 pass (deny, ask/decline, receipts, isolation, timeout, abort, errors) | Only the seven base tools reachable inside a program; logs stream out; killed on timeout/abort |
| **Preview environments** — start/stop/status dev server, URL capture, process-group kill | **VERIFIED** (NF-055) | same suite: live Bun server URL captured, status shows running, stop kills the group (pid gone) | Command from arg or package.json dev/start; guard `shell.exec` + approval; no orphans on failure |
| **Everything else in docs 01–27** — ~60-tool catalog, planner/executor duality, memory tiers, compaction, full sandbox matrix, web/desktop/IDE surfaces, plugins/marketplace, governance loop, execution recorder, ACI windowing, self-improvement | **DESIGNED ONLY** | docs 09/10/11/14/15 and the NF registry in doc 24 | Sequenced in docs/27 (V0–V7). Nothing beyond v0.1 scope has code yet. |

---

## 2. The test matrix (as run at snapshot time)

```bash
# Rust trust kernel (fast)
cd kernel && cargo test

# Full TypeScript suite (~8 s)
cd app && /home/forge/.bun/bin/bun test        # 285 pass / 0 fail / 27 files

# End-to-end, human path
cd /data/home/forge/hzcode && printf 'list files' | ./bin/hzcode
```

| Suite | Files | What it pins down |
|---|---|---|
| `kernel/tests/integration.rs` | 1 (1242 lines) | chain append/verify, tamper (byte + middle payload + truncated line), 4-process concurrency, receipts chain, guard matrix + policy.json + lease expiry, protocol malformed/unknown/1MB/unicode edges |
| `app/tests/core` | 8 files (63 tests) | trusted client vs Rust kernel: chained appends with independently recomputed hashes, read windows, tamper, receipts, policy/lease flow; TS fallback + both-direction interop; config precedence; sessions; skills + subagents; code mode + preview |
| `app/tests/tools` | 9 files | per-tool behavior incl. caps, binary refusal, edit occurrence rules, skip-dirs, shell timeout/kill/env-scrub/abort, todo session isolation |
| `app/tests/providers` | 6 files | SSE translation for Anthropic + OpenAI, chunk-boundary torture, aborts, HTTP errors, mock termination |
| `app/tests/tui` | 8 files | headless golden paths, CLI contract, approvals fail-closed, render/banner contracts, PTY scenarios |

All suites complete — the totals above are from the integrator's final green run.

---

## 3. Semantics rulings made during implementation (binding)

1. **Issued leases are honoured by both implementations.** The kernel (`guard.rs`) consults caller-supplied leases (expiry-filtered) ∪ internally held leases; the TS fallback (`kernel.ts:344`) merges the same way. An expired *copy* passed by a caller cannot revoke a held lease — expiry happens by time. Tests assert this ordering deliberately.
2. **`arguments` is always a JSON string.** No-input tool calls produce `{}`, never `""` (both adapters fixed).
3. **`log.read` `limit` is strict** — `limit:0` returns zero events (kernel fix).
4. **Guard defaults** (no `policy.json`): `fs.read`/`fs.write` inside workspace → `allow`; outside → `ask`; `shell.exec`/`net.fetch`/`spawn` → `ask`. Precedence: deny > lease > allow > ask.
5. **Headless approvals fail closed** (auto-deny with a notice). PTY/TUI prompts y/n/a (`a` = session lease).
6. **Zero-config default is the mock provider** — chat must work with no keys. Real providers via `HZ_PROVIDER` + keys or `~/.hzcode/config.json`.
7. **Delegation is an optional capability on the context.** `ToolContext.delegate?: DelegateRunner` — present on parent runs, absent in child runs; a subagent's tools are exactly the seven base tools (children are filtered in both `toolSpecs` and `getTool`).
8. **Skills activate per turn.** `/name rest` injects `## Active skill: name` + body (cap 8000) into the system prompt for that turn only and sends `rest` (falling back to `Apply the <name> skill.` when bare) as the user content; the directory section caps at 12 skills.
9. **Code mode is one bridge, no registry.** Programs see only `tools.call(name, args)`; the parent resolves against the base seven, guards and receipts every executed call; "unknown tool" is an ordinary call result.
10. **Previews are session-scoped process groups.** Spawned detached; stop SIGTERMs then SIGKILLs `-pid`; failures never leave orphans. The registry is in-memory per session.

---

## 4. Known gaps / next work (front of the queue)

1. **Nothing in flight.** Every workstream is integrated, tested and verified (§1). Final full runs: `bun test` 285 pass / 0 fail (27 files); `cargo test` 14 integration + 3 unit green; live chat e2e green (mock + skills).
2. **Real-provider validation** (needs API keys): one live chat each through the Anthropic and OpenAI adapters. The adapters are pinned by the canned-server suites — this is the last mile.
3. **V2+ is the next planning surface** — docs/27 sequences it (planner/executor duality, memory tiers, compaction, sandbox matrix, surfaces, governance). Land additions through the same ladder and update this table in the same commit.
4. **Keep this file honest** — statuses and counts update in the same commit as the code that changes them.

---

*Methodology note: statuses were promoted only on commands the integrator ran in this workspace (`cargo test`, `bun test`, `hz-kernel --selftest`, headless e2e, kernel-mode script). Where an agent reported something not yet re-run, the row says so.*
