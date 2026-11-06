# HorizonCode — Current Run State

> Snapshot taken **2026-11-06 16:02 UTC**. Written because the session stopped for the day while deep-test and V1-feature subagents were still running. This file is the map of what is done, what is in flight, where everything stopped, and exactly how to continue.

---

## 1. Session in one paragraph

Starting from the finished design corpus (docs 01–27), this session built and shipped the **v0.1 vertical slice** of HorizonCode — a chat-first AI coding agent: Rust trust kernel + Bun runtime core + seven tools + a chat-bar TUI — verified end-to-end and pushed as commit `dce5287`. It then launched the **deep test suite** (kernel, core interop, tools, SSE providers, TUI) and the **V1 features** (skills + subagents, code mode + preview) as parallel subagents. Those agents were still working when the session ended; their partial outputs were committed as a WIP snapshot alongside this file.

---

## 2. DONE — design corpus (pushed)

| Artifact | Commit | Contents |
|---|---|---|
| docs 01–25 + README + conventions | `aff1352` | Full design specification: vision, ADRs, HLD/LLD, domain model, events, APIs, runtime, tools, cognition, sessions, TUI, surfaces, extensibility, operations, feature catalog (NF-001…050), roadmap, glossary |
| docs 26 + 27, NF-051…062, RC-12 | `10aed5c` | Learning synthesis II (10 repos deep-dived: wshobson/agents, OpenHands, SWE-agent, OpenCode V2, Code Mode ×2, …) and the implementation plan with verified runtime viability |

## 3. DONE — v0.1 implementation (pushed, `dce5287`)

| Piece | Files | Evidence |
|---|---|---|
| **Rust trust kernel** `hz-kernel` | `kernel/src/{canon,eventlog,receipts,guard,protocol,time,main}.rs` | selftest `OK (14 checks)`; hash interop with TS verified both ways; `cargo build --release` clean |
| **Bun runtime core** | `app/src/core/{config,canon,kernel,session,loop,index}.ts`, `providers/{anthropic,openai,mock,sse,index}.ts` | `kernelMode=trusted` live check; e2e chat works; mock provider = zero-config default |
| **Tools** | `app/src/tools/{read,write,edit,grep,glob,shell,todo,helpers,index}.ts` | interface matches `contracts.ts` exactly; build clean |
| **Chat UI + entry** | `app/src/tui/{interactive,headless,render,approval,banner,style,index}.ts`, `app/src/main.ts`, `bin/hzcode` | full app builds (29 modules); headless e2e: `printf 'list files' | ./bin/hzcode` → tool card → receipt; exit 0 |
| **Contracts (law)** | `app/src/contracts.ts` | canonical-JSON/hashing rules, kernel NDJSON protocol, all interfaces |

**Verified end-to-end (independently, not just agent reports):** event chains `log.verify ok`, receipts `receipt.verify ok` (both count-verified by the Rust kernel on data produced by the full app).

How to run right now:
```bash
cd /data/home/forge/hzcode && ./bin/hzcode          # chat bar (mock, zero-config)
printf 'list files' | ./bin/hzcode                  # scriptable headless
```

---

## 4. IN FLIGHT — subagents that were still running at snapshot time

They were not stopped (they cannot be interrupted); their completion notices will arrive in the main conversation (`conversation://f93c2c33-49f7-4bda-862e-75311727e427`). Their writes are additive; nothing imports the new feature files yet, so builds are not broken by the WIP.

| # | Subagent | Session (resume via this URL if dead) | Task | On-disk state at 16:02 |
|---|---|---|---|---|
| 1 | Kernel tests (Rust) | `conversation://5d563f9f-23dc-4e13-9c20-c5e890651706` | `kernel/tests/integration.rs` | **1242 lines written**; also fixed `kernel/src/eventlog.rs` (log.read `limit:0` off-by-one). Prompt arrived with literal `\n` artifacts but is readable. |
| 2 | Core interop tests | `conversation://1a7da929-d4dd-4223-869c-2314484d501c` | `app/tests/core/` | `helpers.ts` (246), `kernel-trusted.test.ts` (274) written; more pending. Fixed `app/src/core/kernel.ts` (tail cache now invalidates on external writes via size+mtime stamp; HZ_KERNEL_BIN empty-string handling). |
| 3 | Tools tests | `conversation://784186a8-6b13-4c28-8c64-e2d4d9b5989d` | `app/tests/tools/` | Complete-looking set (~1190 lines: read/write/edit/grep/glob/shell/todo/utils/helpers). Fixed `app/src/tools/shell.ts` (process-group kill via `detached:true`; output-drain grace after child exit). |
| 4 | SSE provider tests | `conversation://ab1a47ff-330c-44e5-8ba4-ee1bc6aabab4` | `app/tests/providers/` | `helpers.ts` (277), `sse.test.ts` (190) written; `anthropic.test.ts` just started (0 bytes at snapshot). |
| 5 | TUI tests | `conversation://9d8baf26-8429-4737-a7f6-6aef6a42f1ea` | `app/tests/tui/` | Full set written (~825 lines incl. `harness.ts`, `pty.test.ts`, `headless.test.ts`, `cli.test.ts`). |
| 6 | Skills + subagents | `conversation://46cb212a-ff99-4c63-93dc-a19fe7fd9efb` | `app/src/core/skills.ts`, `app/src/core/subagent.ts`, `app/src/tools/agent.ts`, additive patch to `core/loop.ts` | **No files yet** at snapshot. This agent had one infra death and was resumed; it is working. |
| 7 | Code mode + preview | `conversation://4172abd7-1fdd-4e30-a810-80f402162968` | `app/src/tools/codemode.ts`, `codemode-child.ts`, `preview.ts` | **No files yet** at snapshot; working. |
| — | *Stray junk agent* | `conversation://eb929075-da59-4d78-9324-4cf711e56756` | (garbage prompt from a malformed dispatch) | **Ignore its report.** No repo changes observed. |

**Agent-proposed fixes now in the working tree (committed as WIP, NOT yet suite-verified):**
- `app/src/core/kernel.ts` — LocalKernel tail cache keyed by file size+mtime (two windows, one workspace); `kernelBinOverride` helper.
- `app/src/tools/shell.ts` — `detached:true` so timeout/abort kill the whole process tree; 500 ms drain grace for lingering pipe output.
- `kernel/src/eventlog.rs` — `log.read` limit checked before push so `limit:0` returns zero events.

---

## 5. LEFT — what remains (the continuation checklist)

### Step 1 — collect agent results
Watch the main conversation for completion notices (or `read_conversation` any session above). If one died: **resume it via its session URL with a short `continue` message** — that pattern recovered three agents today. New expected files after they finish: `app/tests/core/*` (more), `app/tests/providers/anthropic.test.ts`, `app/tests/tools/*` (final), `app/src/core/{skills,subagent}.ts`, `app/src/tools/{agent,codemode,codemode-child,preview}.ts`, patch to `core/loop.ts`.

### Step 2 — integration (owned by the main agent, NOT delegated)
1. `git status` — expect the files above plus this file. Check F1's `loop.ts` patch is additive only.
2. **Register the three new tools** in `app/src/tools/index.ts` (this file was fenced off from all agents): import and add `agentTool`, `codeModeTool`, `previewTool` to the `tools` array.
3. Build checks: `cd app && /home/forge/.bun/bin/bun build src/main.ts --target=bun --outdir=/tmp/hz-b-final`.

### Step 3 — run everything (first full execution; expect some failures from concurrent edits)
```bash
cd kernel && cargo test                      # integration.rs (~1242 lines) + verify eventlog.rs fix
cd app && /home/forge/.bun/bin/bun test      # tests/core, tests/tools, tests/providers, tests/tui
printf 'list files' | /home/forge/.bun/bin/bun run app/src/main.ts   # e2e still green
/home/forge/.bun/bin/bun /tmp/hz-mode-check.ts                       # kernelMode=trusted
```
Fix breakages (most likely spots: interplay of the kernel.ts / eventlog.rs fixes, SSE chunk-splitting assumptions, PTY availability for tui tests — they `test.skip` when `script` is missing).

### Step 4 — feature smoke checks
- **Skills**: create `.hzcode/skills/hello.md` with frontmatter, chat `/hello do the thing` → body should be injected.
- **Subagents**: scratch script (see F1's session) proved the nested runner with a fake provider; re-run after integration; confirm `agent` tool does not recurse.
- **Code Mode**: scratch script per F2's session (fixture read through the RPC bridge, guard consulted); **Preview**: start a tiny server via the tool, capture URL, stop it, confirm no orphan pid.

### Step 5 — final audit + repo deep update (then push)
1. Rewrite `README.md` for the post-v0.1 state: quickstart, architecture map, repo layout, test matrix, how to configure real providers (`HZ_PROVIDER` + `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` or `~/.hzcode/config.json`; mock is the zero-config default).
2. Add `docs/28-implementation-status.md`: each design area → status (designed / implemented / tested) → evidence, plus open gaps vs docs/27.
3. Commit + push `main`.

### Beyond today (from docs/27)
V2+: compaction fidelity checks, subagent fleet of bundled profiles, Code Mode v2 (NF-051), ACI windowing (NF-052), governance pre-submit (NF-053), execution recorder (NF-054), preview hardening (NF-055), tier-parity program (NF-056/057). None started; all designed.

---

## 6. Known risks / fragile spots

- **Subagent infra is flaky today** (3 deaths: provider JWT expiry ×2, empty tool response ×2). Recovery pattern: resume the session with a short continue message; never re-paste the whole prompt.
- **The three WIP fixes are unverified** until Step 3 runs the suites. If a suite fails, diff first against these files.
- **F1/F2 had zero files** at snapshot — if they died again unnoticed, their completion notices (or a session read) will say so; K (kernel tests) and I (interop) are the most mature.
- `bun` is **not on PATH** on this machine — always `/home/forge/.bun/bin/bun`.
- `app/tests/core/_probe.test.ts` is a scratch probe; delete or keep as a smoke test during integration.
- Do **not** commit `.hzcode/` (gitignored) — it is per-workspace runtime state.

---

## 7. Quick reference

| | |
|---|---|
| Repo | https://github.com/sarv-projects/HorizonCode |
| Last full commit before this WIP | `dce5287` (v0.1 vertical slice) |
| This WIP snapshot | adds test suites, 3 agent fixes, this file |
| Design law for code | `app/src/contracts.ts` |
| Kernel protocol | NDJSON stdio, 8 methods, see contracts.ts `KernelRequestMap` |
| Main conversation | `conversation://f93c2c33-49f7-4bda-862e-75311727e427` |
