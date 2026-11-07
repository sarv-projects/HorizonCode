# HorizonCode — Current Run State

> **Read me first.** This is the state-of-repo document: what is implemented, how it was verified, and what remains. Snapshot: **2026-11-06, ~17:40 UTC** (product state) · **2026-11-07** (design corpus: RC-15 adoption wave, `docs/30`). Workspace: `/data/home/forge/HorizonCode`. Repo: `github.com/sarv-projects/HorizonCode` (branch `main`).
>
> **TL;DR — the V1 product mission is complete; the design corpus is not frozen.** Design corpus (docs 00–30) + v0.1 product + deep test suite + all four V1 features (skills, subagents, Code Mode, preview servers) are implemented, tested and pushed. Final green run: **`bun test` 297 pass / 0 fail (28 files)** and **`cargo test` 17 integration + 3 unit**. Nothing is in flight in the product. A deep audit of all twelve reference clones — completeness pass, merged/unique findings, optimization analysis, and a docs-staleness reconciliation across the whole spec set — is recorded in `docs/29-final-audit.md`; the 2026-11-07 adoption wave (RC-15, [`docs/30-steal-list.md`](./docs/30-steal-list.md)) is merged into the owner documents it names (docs 05–12, 14–16, 24) plus `_conventions.md` RC-15, but not yet into code — adoption recorded in `docs/24` §13, queue in `docs/30` §4. RC-13 makes `docs/28` the single source of truth for implementation status.

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
| Runtime core (loop, guard gate, sessions, providers) | **VERIFIED** | `bun test tests/core` (75 tests); live e2e `printf 'list files' \| ./bin/hzcode` → tool card + receipt; `kernelMode=trusted` |
| Providers (Anthropic/OpenAI SSE + mock) | **VERIFIED** | `bun test tests/providers` → 72 pass; two fixes (empty `arguments`) |
| Tools (7 base) | **VERIFIED** | `bun test tests/tools`; `shell.ts` detached process-group + drain fix |
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

# TypeScript suite (297 tests / 28 files)
cd app && /home/forge/.bun/bin/bun test && cd ..

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
2. **V2+ features** — docs/27 is the plan (V0–V7: planner/executor duality, memory tiers, compaction, sandbox matrix, web/desktop/IDE surfaces, governance loop, self-improvement). Land additions through the same status ladder and update `docs/28` in the same commit.
3. **Nothing else is in flight — do not look for unfinished agent work.**

---

## 6. Environment facts (hard-won — trust these)

| Fact | Detail |
|---|---|
| **bun is NOT on PATH** | Always `/home/forge/.bun/bin/bun` (v1.4.4). `bin/hzcode` handles it. |
| cargo | On PATH (1.99.1); crates.io works. Kernel binary: `kernel/target/release/hz-kernel` (rebuild: `cd kernel && cargo build --release`). |
| git push | Works (https, credential helper). Identity is set automatically — **never** override author/committer or git config. No force-push. |
| Runtime state | `<workspace>/.hzcode/` = event log + receipts + sqlite + history + skills. Gitignored; deleting resets the workspace's session/trust state. |
| Mock provider quirks | Emits exactly ONE `glob` tool call for /list files\|what.*here\|ls\|-type messages; it does not call other tools (use the scratch suites for those). |
| Guard defaults | fs.read/write **inside workspace = allow**; outside = ask; shell.exec/net.fetch/spawn = ask. Headless approvals auto-deny with a notice. |
| `repo-tour/` | Reference clones of studied projects live at **/data/home/forge/repo-tour — OUTSIDE this repo** (a 1.5 GB copy once appeared inside; `.gitignore` now blocks it). |
| Sub-agent infra (historical) | Was flaky all day (provider JWT / empty-responses). If you dispatch sub-agents: clean single-escape JSON prompts, one task list per call, and treat deaths as normal — resume with a short continue message. Two feature workstreams were ultimately built directly by the integrator after repeated agent deaths; the code and its tests are the record. |

---

## 7. Rules of engagement (non-negotiable)

1. **`app/src/contracts.ts` is law.** Changes are design decisions — document them (docs + `_conventions.md`) before code. The last change was additive: `ToolContext.delegate?: DelegateRunner` for the `agent` tool.
2. **"Verified" means you ran it and saw the result.** Agent reports are evidence candidates, never proof.
3. **Parallel work: one writer per file**; fence `tools/index.ts` and `core/loop.ts` to the integrator.
4. **Commit style:** concise imperative subject; body = what/why; never force-push; never touch git identity; never commit `.hzcode/`, `node_modules/`, `kernel/target/`.
5. **Chat-first is the product charter:** no subcommand menus; flags are optional conveniences; headless is for scripts/tests only.
6. **Update `docs/28` in the same commit** as any code that changes a status or count.

---

*End of state document. If you are starting the next phase: begin at docs/27 (V2+) and `docs/28` §4. If you are auditing: everything claimed VERIFIED above has a copy-pasteable command in section 4 or in `docs/28`.*
