# HorizonCode — Current Run State

> **Read me first.** This is the state-of-repo document: what is implemented, how it was verified, and what remains. Snapshot: **2026-11-07, ~20:05 UTC** (product state incl. the trust-hardening pass, docs pass-5, the NF-072/073/074 waves, the NF-069/052 edit ladder, the B-1 repo-map tool, the CI gate runner and the reference-defect observations). Workspace: `/data/home/forge/HorizonCode`. Repo: `github.com/sarv-projects/HorizonCode` (branch `main`).
>
> **TL;DR — the V1 product mission is complete; V2 adoption is underway; the design corpus is not frozen.** Design corpus (docs 00–30) + v0.1 product + deep test suite + all four V1 features (skills, subagents, Code Mode, preview servers) are implemented, tested and pushed. On 2026-11-07: the trust-hardening pass (chain anchors, final kernel refusals, symlink-resolved scopes, canonical-JSON parity), docs pass-5, the RC-16 corpus ruling wave, and **V2 waves 1–5 — NF-072 parallel tool batches, NF-073 loop safety rails, NF-069/052 edit ladder, NF-074 context-cost contracts, B-1 repo-map** — plus the **CI gate runner** (`ops/gates.sh`, six real gates) and the **reference-repo defect observations** (88 cited rows, `docs/30` §4 item 11). Latest green run: **`bun test` 364 pass / 0 fail (34 files)**, **`cargo test` 17 integration + 3 unit**, **`ops/gates.sh` 6/6**. A deep audit of all twelve reference clones is recorded in `docs/29-final-audit.md`; the RC-15 adoption wave ([`docs/30-steal-list.md`](./docs/30-steal-list.md)) is merged into its owner documents, and its §4 queue is now the build plan — items 1–5 are landed, **item 6 (NF-071 managed runtime) is next**. RC-13 makes `docs/28` the single source of truth for implementation status.

---

## 1. What HorizonCode is (30-second primer)

A **chat-first AI coding agent** for the terminal: a human runs `hzcode`, types natural language into a chat bar, and the agent works in their repo. Ten tools: `read write edit grep glob shell todo` + `agent` (subagent delegation) + `code_mode` (JS program chaining tool calls) + `preview` (dev-server lifecycle).

Two-language trust stack:

```
   terminal                 the human
      |  chat
   app/src/tui  ----------> app/src/core (Bun/TS runtime)
      |                         |  agent loop: provider -> guard -> tools -> receipts
      |                         v
      |                      app/src/tools  (10 tools, guard-aware)
      |                         |
      |                         v
      +-- bin/hzcode       kernel/  (Rust `hz-kernel`)
                               hash-chained event log + receipt chain + guard policy
```

- **`app/src/contracts.ts` is LAW** — canonical-JSON + sha256 rules, event envelope, the 8-method NDJSON kernel protocol, every interface. Rust and TS interop byte-for-byte.
- **Kernel** (Rust): append-only chained event logs per stream, chained receipts, guard decisions (precedence `deny > ask > allow` per `docs/11-authority-safety.md` R1; leases, `policy.json`; shipped divergence tracked in `docs/28` §4).
- **Runtime** (Bun): byte-identical TS fallback when the Rust binary is missing — `kernelMode: trusted | untrusted`.
- **TUI**: chat-first charter — no subcommand menus; every capability reachable by conversation; headless mode for scripts/tests.

---

## 2. What is implemented and verified

Every row below is backed by commands the integrator ran in this workspace (methodology in `docs/28-implementation-status.md`, which matches this table).

| Area | Status | Evidence |
|---|---|---|
| Rust trust kernel + protocol | **VERIFIED** | `cd kernel && cargo test` (20 green) + `--selftest` → `SELFTEST OK (14 checks)` |
| Contracts / Rust<->TS hash interop | **VERIFIED** | both directions verify each other's files (`log.verify`/`receipt.verify` → ok) |
| Runtime core (loop, guard gate, sessions, providers, budget rails, output budget) | **VERIFIED** | `bun test tests/core` (104 tests across 11 files, incl. NF-073 rails and NF-074 output budget); live e2e `printf 'list files' \| ./bin/hzcode` → tool card + receipt; `kernelMode=trusted` |
| Providers (Anthropic/OpenAI SSE + mock) | **VERIFIED** | `bun test tests/providers` → 72 pass; two fixes (empty `arguments`) |
| Tools (7 base) | **VERIFIED** | `bun test tests/tools`; `shell.ts` detached process-group + drain fix |
| **Tool batch scheduling** (NF-072) | **VERIFIED** | `bun test tests/core/batch.test.ts` → 6 pass; live: two `sleep 0.6` shell calls in one batch → ~850 ms (sequential ≥ 1.2 s); `docs/28` §1 + ruling 14 |
| **Loop safety rails** (NF-073) | **VERIFIED** | `bun test tests/core/rails.test.ts` → 11 pass; live: `HZ_MAX_STEPS=1` (or `--max-steps 1`) on a mock chat → budget notice + **exit 5**; `--max-steps 0` → exit 0; `--max-steps nope` → exit 2; `docs/28` §1 + ruling 15; acceptance `docs/24` §12.2 #65 |
| **Edit-application ladder** (NF-069/052, A-1…A-5) | **VERIFIED** | `bun test tests/tools/edit-ladder.test.ts` → 12 pass incl. byte-identical error fixtures; fuzzy successes name their rung; `docs/28` §1 + ruling 16 |
| **Context-cost contracts** (NF-074) | **VERIFIED** | 24 new tests (`tests/core/output-budget.test.ts` + `tests/tools/shell-minimiser.test.ts`); live: 20 KB shell output → capped for the model, full text spilled under `.hzcode/spills/<sha256>.txt`, receipt digests the **full** output; `docs/28` §1 + ruling 18; acceptance `docs/24` §12.2 #66 |
| **CI gate runner** (`ops/gates.sh`) | **VERIFIED** | `bash ops/gates.sh` → 6/6 green (~13 s), exit 0; catalogue honest (all 18 `docs/24` §3.5 gates `declared-gap`); hosted wiring: `bash ops/install-ci.sh` (needs a token with `workflow` scope) |
| **Repo-map tool** (`repo_map`, B-1) | **VERIFIED** | `bun test tests/tools/repo-map.test.ts` → 13 pass (personalised PageRank, binary-search budget, byte-stability); live run ranked `app/src/core/loop.ts` first under focus; `docs/28` §1 + ruling 19 |
| Chat TUI (interactive + headless) | **VERIFIED** | `bun test tests/tui` → 48 pass incl. real PTY scenarios |
| **Skills** (discovery, /activation, prompt injection) | **VERIFIED** | `bun test tests/core/skills-agents.test.ts`; live chat `/demo …` → `skill active: demo` |
| **Subagents** (`agent` tool, child session, no recursion) | **VERIFIED** | same suite: nested run through the real kernel, receipts + child stream verify |
| **Code Mode** (Bun JS subprocess, tool bridge) | **VERIFIED** | `bun test tests/core/codemode-preview.test.ts` (14 pass: deny/ask, receipts, log-forgery regression, timeout, abort) |
| **Preview servers** (start/stop/status) | **VERIFIED** | same suite: live URL capture, process-group kill (pid gone) |
| Everything else in docs 00–30 (the tool catalog in `docs/09-tools.md` §4 — authoritative — memory tiers, compaction, sandbox matrix, surfaces, governance, self-improvement, the RC-15 adoption wave) | **DESIGNED ONLY** | sequenced in docs/27 (V0–V7); adoption recorded in `docs/24` §13; queue in `docs/30` §4 |

---

## 3. Git timeline (newest first)

| Commit | What |
|---|---|
| `0616584` | **V2 wave 5: B-1 `repo_map` tool** (8 files, +617; 13 tests; `docs/28` ruling 19) |
| `1fd05fa` | CURRENT_RUN refresh — NF-074 wave handoff |
| `3088223` | CI payload: workflow shipped as `ops/ci/github-actions.yml` + `ops/install-ci.sh` (automation token has no `workflow` scope) |
| `5cbb4f3` | **V2 wave 4: NF-074 context-cost contracts** (10 files, +683; 24 tests; `docs/28` ruling 18) |
| `d6fbb69` | Reference-repo defect observations — 88 cited rows; closes `docs/30` §4 item 11 |
| `b2e5595` | **CI gate runner + ops tree** (pass-5 C.3): `ops/gates.sh`, honest catalogue, 6 real gates |
| `b8e7f81` | **V2 wave 3: NF-069/052 edit-application ladder** (12 tests; `docs/28` ruling 16) |
| `033b878` | CURRENT_RUN refresh — NF-073 wave handoff |
| `da48282` | **V2 wave 2: NF-073 loop safety rails** (13 files, +721; 12 tests; `docs/28` ruling 15) |
| `e35a2f0` | RC-16 ruling wave: the eight cross-document contradictions resolved across docs 03–30 |
| `0bb177a` | CURRENT_RUN refresh — NF-072 wave handoff |
| `660cf01` | Docs pass-5 record + corpus-wide repo-root path sweep (32 files) |
| `91192f3` | Docs defects: the six live audit findings fixed (11 files) |
| `7c528db` | Trust hardening: chain anchors, final kernel refusals, symlink scopes, canon parity (20 files, +843; 12 tests) |
| `f182894` | Reaudit stage-2 fix wave: 222 findings applied across docs 00–30 |
| `4d7eb89` | **V1: code mode + preview tools** (7 files, +1073; 12 tests) |
| `8005e5f` | **V1: skills + subagent delegation** (8 files, +701; 10 tests) |
| `6b86de0` | Parity: fallback `sanitizeStream` + guard `scope` default byte-identical to the Rust kernel |
| `72c12cf` / `9698361` | Core interop suites (fallback, both-direction interop, config, session); `log.read limit:0` fix |
| `ddfb261` | README status + `docs/28` status map |
| `fed0811` / `569c48a` | Handoff doc + core-suite green fixes |
| `821e8e0` | Repo hygiene: 1.5 GB `repo-tour/` moved back out; gitignore guard |
| `b11cb76` / `060eef3` | TUI suite (48) / provider suite (72) |
| `dce5287` | **v0.1 vertical slice** — kernel + runtime + tools + TUI (known-green reference) |
| `aff1352` / `10aed5c` | Design corpus 01–27 + learning synthesis |

---

## 4. Verify it yourself (copy-paste)

```bash
cd /data/home/forge/HorizonCode

# TypeScript suite (351 tests / 33 files)
cd app && /home/forge/.bun/bin/bun test && cd ..

# The six CI gates, one entry point (Rust + selftest + TS + 3 e2e)
bash ops/gates.sh

# Budget rails: a hard stop at 1 model step, canonical exit code 5
printf 'list files\n' | HZ_MAX_STEPS=1 ./bin/hzcode; echo "exit: $?"
printf 'list files\n' | ./bin/hzcode --max-steps 0   # 0 = unlimited, exit 0

# Rust suite (20 tests) + kernel selftest
cd kernel && cargo test && ./target/release/hz-kernel --selftest --state-dir /tmp/hz-k && cd ..

# Human path: chat works zero-config (mock provider)
printf 'hello\n' | ./bin/hzcode

# Tool loop through the real Rust kernel, with receipts
printf 'list files\n' | ./bin/hzcode
```

**Skills smoke (30 seconds):**
```bash
WS=$(mktemp -d); mkdir -p "$WS/.hzcode/skills"
printf -- '---\nname: demo\ndescription: demo skill\n---\nSay hi warmly.\n' > "$WS/.hzcode/skills/demo.md"
printf '/demo please greet me\n' | ./bin/hzcode --workspace "$WS"
# → · skill active: demo  / reply / exit 0
```

**Real providers** (the only untested-in-anger path):
```bash
export HZ_PROVIDER=anthropic HZ_API_KEY=...   # or OPENAI_API_KEY; or ~/.hzcode/config.json
./bin/hzcode
```

---

## 5. What remains

1. **Real-provider last mile** — one live chat through each adapter (needs API keys). The adapters are pinned by canned-server tests.
2. **V2 adoption continues from `docs/30` §4** — items 1–5 landed 2026-11-07 (NF-073 rails, NF-072 batches, NF-069/052 edit ladder, NF-074 context-cost contracts, B-1 repo-map; `docs/28` rulings 14–19). Next: **item 6 (NF-071 managed runtime)**, then item 7 (NF-075 growth loop), item 8 (verification wave). docs/27 remains the coarse V0–V7 map. Land additions through the same status ladder and update `docs/28` in the same commit.
3. **Hosted CI needs one manual step** — `.github/workflows/ci.yml` cannot be committed by the automation identity (no `workflow` token scope). `bash ops/install-ci.sh` installs the tracked payload; commit + push it from a token that has the scope.
4. **Nothing else is in flight — do not look for unfinished agent work.**

---

## 6. Environment facts (hard-won — trust these)

| Fact | Detail |
|---|---|
| **bun is NOT on PATH** | Always `/home/forge/.bun/bin/bun` (v1.4.4). `bin/hzcode` handles it. |
| cargo | On PATH (1.99.1); crates.io works. Kernel binary: `kernel/target/release/hz-kernel` (rebuild: `cd kernel && cargo build --release`). |
| git push | Works (https, credential helper). Identity is set automatically — **never** override author/committer or git config. No force-push. The token has **no `workflow` scope**: never commit anything under `.github/workflows/` (push is rejected); ship workflows as payloads + installers instead (`ops/install-ci.sh` is the pattern). |
| Spills | Capped tool output spills its full text to `<workspace>/.hzcode/spills/<sha256>.txt` (NF-074); the model sees a truncation marker with the path, receipts digest the full output. |
| Runtime state | `<workspace>/.hzcode/` = event log + receipts + sqlite + history + skills. Gitignored; deleting resets the workspace's session/trust state. |
| Mock provider quirks | Emits exactly ONE `glob` tool call for /list files\|what.*here\|ls\|-type messages; it does not call other tools (use the scratch suites for those). |
| Guard defaults | fs.read/write **inside workspace = allow**; outside = ask; shell.exec/net.fetch/spawn = ask. Headless approvals auto-deny with a notice. |
| `repo-tour/` | Reference clones of studied projects live at **/data/home/forge/repo-tour — OUTSIDE this repo** (a 1.5 GB copy once appeared inside; `.gitignore` now blocks it). |
| Sub-agent infra (historical) | Was flaky all day (provider JWT / empty-responses). If you dispatch sub-agents: clean single-escape JSON prompts, one task list per call, and treat deaths as normal — resume with a short continue message. Two feature workstreams were ultimately built directly by the integrator after repeated agent deaths; the code and its tests are the record. |

---

## 7. Rules of engagement (non-negotiable)

1. **`app/src/contracts.ts` is law.** Changes are design decisions — document them (docs + `_conventions.md`) before code. The last contract additions were additive: `Tool.concurrencyClass` (NF-072) and `RunBudget`/`RunExit` + `RuntimeOptions.budget` + `send().exit?` (NF-073); NF-074 added none (it fits the existing `ProviderRequest.maxTokens`).
2. **"Verified" means you ran it and saw the result.** Agent reports are evidence candidates, never proof.
3. **Parallel work: one writer per file**; fence `tools/index.ts` and `core/loop.ts` to the integrator.
4. **Commit style:** concise imperative subject; body = what/why; never force-push; never touch git identity; never commit `.hzcode/`, `node_modules/`, `kernel/target/`.
5. **Chat-first is the product charter:** no subcommand menus; flags are optional conveniences; headless is for scripts/tests only.
6. **Update `docs/28` in the same commit** as any code that changes a status or count.

---

*End of state document. If you are starting the next phase: begin at docs/27 (V2+) and `docs/28` §4. If you are auditing: everything claimed VERIFIED above has a copy-pasteable command in section 4 or in `docs/28`.*
