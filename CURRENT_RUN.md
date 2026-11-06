# HorizonCode — Handoff Document / Current Run State

> **For the next agent picking this up cold.** You have none of the prior chat context — this file is it. Read top to bottom before touching anything.
> Snapshot: **2026-11-06, ~16:10 UTC**. Workspace: `/data/home/forge/hzcode`. Repo: `github.com/sarv-projects/HorizonCode` (branch `main`).
> Everything described as "in flight" was written by parallel sub-agents whose conversations live in this workspace (session URLs in §7 — you can read them with your conversation tools if you have them; otherwise the filesystem is the source of truth).

---

## 0. TL;DR for the next agent

1. **Read this whole file** (~10 min). Then `cd /data/home/forge/hzcode && git log --oneline -5 && git status`.
2. **Find what the sub-agents left**: check for the expected files in §7 (some may have finished after this snapshot; some may have died — recovery pattern in §7).
3. **Integrate** (one edit, §8 Step 2): register the new tools in `app/src/tools/index.ts`.
4. **Run everything** (§8 Steps 3–5): `cargo test`, `bun test`, e2e chat, kernel-mode check. Fix breakage.
5. **Finish the audit** (§8 Step 7): rewrite README, write `docs/28-implementation-status.md`, update this file, commit, push.
The definition of done is in §8; the exact specs for anything missing are in Appendices A and B.

---

## 1. What HorizonCode is (30-second primer)

A **chat-first AI coding agent** for the terminal: a human runs `hzcode`, types natural language into a chat bar, and the agent uses tools (read/write/edit/grep/glob/shell/todo) to do real work in their repo.

Architecture is a **two-language trust stack**:

```
   terminal                 the human
      │  chat
   app/src/tui  ──────────► app/src/core (Bun/TS runtime)
      │                        │  agent loop: provider → guard → tools → receipts
      │                        ▼
      │                     app/src/tools  (7 tools, guard-aware)
      │                        │
      │                        ▼
      └── bin/hzcode       kernel/  (Rust `hz-kernel`)
                               hash-chained event log + receipt chain + guard policy
```

- **`app/src/contracts.ts` is LAW.** It freezes: canonical-JSON + sha256 hashing rules, the event envelope, the kernel's NDJSON protocol (8 methods), and every interface (Tool, Provider, Runtime). Both the Rust kernel and the TS runtime implement it; hashes interop byte-for-byte.
- The **kernel** (Rust) owns trust artifacts: append-only chained event logs per stream, a chained receipts file, and guard decisions (deny > allow > ask, leases, `policy.json`).
- The **runtime** (Bun) falls back to a byte-identical TS implementation when the Rust binary is missing — status shows `kernelMode: trusted | untrusted`.
- The **TUI** is chat-first by charter: no subcommand menus; every capability reachable by conversation. Headless mode (piped stdin) exists for scripting/tests.
- **Design corpus docs 01–27** in `docs/` is complete and frozen; it is the spec for everything beyond v0.1 (see §10).

---

## 2. Environment facts (hard-won — trust these)

| Fact | Detail |
|---|---|
| **bun is NOT on PATH** | Always use `/home/forge/.bun/bin/bun` (v1.4.4). `bin/hzcode` already handles this fallback. |
| cargo | On PATH (`/home/forge/.cargo/bin/cargo`, 1.99.1). Network to crates.io works. |
| Prebuilt kernel binary | `kernel/target/release/hz-kernel` (exists, built). Rebuild: `cd kernel && cargo build --release`. |
| git push | Works from this machine (https remote, credential helper). Commit identity is set automatically (forgecode-app[bot]) — **never** override author/committer or git config. No force-push. |
| Repo state check | `git log --oneline -5` — see §4 for the expected history. |
| **Sub-agent infrastructure is flaky** | Today: 3+ deaths ("JWT is expired", "Empty tool response"). **Recovery pattern**: resume the sub-agent session with a SHORT "continue the original task" message — never re-paste the whole prompt. Do not re-launch duplicates. |
| Sub-agent prompt formatting | When dispatching sub-agents, keep task prompts as clean single-escape JSON strings (\n for newlines, avoid embedded double quotes). Double-escaping produced a garbage task once today (see §7, junk session). |
| Runtime state dir | `<workspace>/.hzcode/` = event log + receipts + sqlite DB + history. Gitignored. Deleting it resets a workspace's session/trust state. |
| Workspace for testing | Use temp dirs (`mktemp -d`) for scratch runs; the repo root as workspace creates real `.hzcode/` state (fine, gitignored). |

---

## 3. Repo map

```
hzcode/
├── CURRENT_RUN.md            ← this file (the handoff)
├── README.md                 ← pre-implementation spec README (rewrite planned, §8 Step 7)
├── AUDIT.md                  ← design-corpus audit notes (from earlier phase)
├── bin/hzcode                ← launcher: `hzcode` → opens the chat (works on this machine)
├── docs/                     ← design corpus 00–27 + _conventions.md (frozen; the spec)
├── kernel/                   ← Rust trust kernel, single binary crate
│   ├── Cargo.toml / Cargo.lock
│   ├── src/{canon,eventlog,receipts,guard,protocol,time,main}.rs
│   ├── tests/integration.rs  ← deep suite (WIP, §6)
│   └── target/release/hz-kernel  (build artifact, gitignored)
└── app/                      ← Bun/TS application
    ├── package.json          (scripts: start, check)
    ├── src/
    │   ├── contracts.ts      ← FROZEN INTERFACES — read this before any code
    │   ├── main.ts           ← entry: TTY→chat bar, pipe→headless
    │   ├── core/             ← config, canon, kernel client (+TS fallback), session(sqlite),
    │   │                        providers/{anthropic,openai,mock,sse}, loop, index(createRuntime)
    │   ├── tools/            ← read write edit grep glob shell todo + helpers + index(registry)
    │   └── tui/              ← interactive chat bar, headless, render, approval, banner, style
    └── tests/                ← deep suites (WIP, §6): core/ tools/ providers/ tui/
```

---

## 4. Git history — the day's timeline

| Commit | What |
|---|---|
| `aff1352` | **Design corpus** — docs 01–25 + README + `_conventions.md` (ADRs, HLD/LLD, domain model, events, APIs, runtime, tools, cognition, sessions, TUI, surfaces, extensibility, operations, feature catalog NF-001…050, roadmap, glossary). |
| `10aed5c` | **Learning synthesis II + plan** — docs 26 (10-repo deep dive: wshobson/agents, OpenHands, SWE-agent, OpenCode V2, Code Mode ×2 …) and docs 27 (implementation plan, verified toolchain); doc 24 gains NF-051…062; conventions gain RC-12; doc 13 gains R197–R201. |
| `dce5287` | **v0.1 vertical slice** (41 files, +7068) — Rust kernel, runtime core, tools, chat TUI, `bin/hzcode`. Fully verified (see §5). **This is the known-green reference.** |
| `755af57` | **WIP snapshot** (26 files, +4418) — deep test suites + 3 agent bug-fixes + this handoff doc (originally a shorter version). Agents were still writing when this was committed — see §6/§7. |

Remote `main` is in sync with `755af57` at this snapshot. **Anything newer than that either came from sub-agents finishing after the snapshot, or is you.**

---

## 5. Verified working state (evidence + exact commands to re-check)

Everything below was run by the main agent and observed green **before** the WIP snapshot:

**1. The chat works (zero config, mock provider):**
```bash
cd /data/home/forge/hzcode && printf 'hello\n' | /home/forge/.bun/bin/bun run app/src/main.ts
# → ❯ hello / Hi! I am HzCode running in mock mode. … / exit 0
```

**2. The tool loop works, through the real Rust kernel, with receipts:**
```bash
printf 'list files\n' | /home/forge/.bun/bin/bun run app/src/main.ts
# → ❯ list files
#   Let me look at what is in this workspace.
#   ⏺ glob({"pattern":"*"})
#     └ ok: AUDIT.md
#   Mock mode: the glob tool returned … / exit 0
```

**3. Kernel selftest (14 checks):**
```bash
rm -rf /tmp/hz-selftest && kernel/target/release/hz-kernel --selftest --state-dir /tmp/hz-selftest
# → OK lines for ping/log.append×3/log.verify/log.read/receipt.issue×2/receipt.verify/
#   guard.check (fs.write workspace→allow, shell.exec→ask)/guard.lease/unknown-method/malformed
# → SELFTEST OK (14 checks), exit 0
```

**4. Trusted mode + chains verify (recreate the check script at `/tmp/hz-mode-check.ts`, it may be gone):**
```ts
// /tmp/hz-mode-check.ts
const m = await import("/data/home/forge/hzcode/app/src/core/index.ts");
const rt = await m.createRuntime({ workspace: "/data/home/forge/hzcode", mock: true });
console.log("kernelMode=" + rt.kernelMode, "provider=" + rt.providerName, "model=" + rt.model);
await rt.close();
```
```bash
/home/forge/.bun/bin/bun /tmp/hz-mode-check.ts       # → kernelMode=trusted provider=mock model=mock-1
# chain verification (substitute a stream name from .hzcode/kernel/events/):
echo '{"id":1,"method":"receipt.verify","params":{}}' | kernel/target/release/hz-kernel --state-dir .hzcode/kernel
# → {"id":1,"result":{"count":N,"ok":true}}
```

**What "trusted" means:** the runtime spawned the real `hz-kernel` binary and all events/receipts were written by Rust; had the binary been missing it would say `untrusted` and use the byte-identical TS fallback.

---

## 6. The WIP commit (`755af57`) — contents and caveats

### 6a. Three agent-authored fixes — **NOT yet suite-verified** (verify in §8 Step 4)
Review each with `git diff dce5287 755af57 -- <path>`:

| File | Fix | Why |
|---|---|---|
| `app/src/core/kernel.ts` | LocalKernel tail cache now keyed by file **size+mtime** (`fileStamp`); also a `kernelBinOverride` helper for `HZ_KERNEL_BIN` empty-string handling | Two windows on one workspace: a cached chain tail must not be trusted blindly when another process wrote the file |
| `app/src/tools/shell.ts` | `detached: true` (own process group) + 500 ms output-drain grace (`settlesWithin`) | Timeout/abort kills must reach the whole tree (`bash -lc …`), and lingering pipe output must be captured |
| `kernel/src/eventlog.rs` | `log.read` limit check moved BEFORE the push | `limit: 0` previously returned 1 event — off-by-one |

### 6b. Test suites in the snapshot (agents were still completing some)

| Suite | Files at snapshot | Notes |
|---|---|---|
| `kernel/tests/integration.rs` | 1242 lines | chain/tamper/concurrency/receipts/guard-matrix/protocol edges |
| `app/tests/core/` | `helpers.ts` 246, `kernel-trusted.test.ts` 274, `_probe.test.ts` 10 | `_probe` is a scratch probe — delete if useless |
| `app/tests/tools/` | complete-looking set ~1190 lines (read/write/edit/grep/glob/shell/todo/utils/helpers) | — |
| `app/tests/providers/` | `helpers.ts` 277, `sse.test.ts` 190, `anthropic.test.ts` **0 bytes** | anthropic suite was just starting — likely finished after snapshot |
| `app/tests/tui/` | full set ~825 lines incl. `harness.ts` + `pty.test.ts` | PTY tests `test.skip` gracefully if `script` (util-linux) is absent |

---

## 7. Sub-agent status — who, where they stopped, how to recover

All sessions live in this workspace. **How to check:** (1) filesystem first — expected files below; (2) if your tooling can read a conversation by id, read the session URL for its final report; (3) if it died: **resume the session with a short "continue the original task" message** — do NOT repaste the full prompt, do NOT launch a duplicate.

| # | Agent | Session | Task | Expected files | Last known state |
|---|---|---|---|---|---|
| 1 | **Kernel tests** | `conversation://5d563f9f-23dc-4e13-9c20-c5e890651706` | deep Rust suite | `kernel/tests/integration.rs`; allowed minimal fixes to `kernel/src/**` | 1242 lines written; fixed eventlog.rs. Prompt arrived with literal `\n` artifacts but is readable. Probably finished. |
| 2 | **Core interop tests** | `conversation://1a7da929-d4dd-4223-869c-2314484d501c` | `app/tests/core/` | helpers, kernel-trusted, config, sessions, interop tests | helpers + kernel-trusted done; fix to `kernel.ts` landed. May have written more. |
| 3 | **Tools tests** | `conversation://784186a8-6b13-4c28-8c64-e2d4d9b5989d` | `app/tests/tools/` | full set | Complete set on disk; fix to `shell.ts` landed. Probably finished. |
| 4 | **SSE provider tests** | `conversation://ab1a47ff-330c-44e5-8ba4-ee1bc6aabab4` | `app/tests/providers/` | helpers, sse, anthropic, openai tests | sse done; anthropic.test.ts was 0 bytes at snapshot. **Check if openai.test.ts / mock tests exist** — may need finishing. |
| 5 | **TUI tests** | `conversation://9d8baf26-8429-4737-a7f6-6aef6a42f1ea` | `app/tests/tui/` | harness + headless/cli/pty/render/approval tests | Full set on disk. Probably finished. |
| 6 | **Skills + subagents** (V1 feature) | `conversation://46cb212a-ff99-4c63-93dc-a19fe7fd9efb` | create `app/src/core/skills.ts`, `app/src/core/subagent.ts`, `app/src/tools/agent.ts`; additive patch to `core/loop.ts` | those 3 files + loop.ts diff | **No files at snapshot**; had one infra death, was resumed. **If still empty: either resume it, or implement from Appendix A.** |
| 7 | **Code mode + preview** (V1 feature) | `conversation://4172abd7-1fdd-4e30-a810-80f402162968` | create `app/src/tools/{codemode.ts,codemode-child.ts,preview.ts}` | those 3 files | **No files at snapshot**; working. **If still empty: resume or implement from Appendix B.** |
| — | *Junk session* | `conversation://eb929075-da59-4d78-9324-4cf711e56756` | garbage prompt from a malformed dispatch | none | **Ignore/dismiss.** Verified it touched nothing. |

**Important:** agents wrote ONLY within their territories. The files `app/src/tools/index.ts` and the existing tool files were fenced off from feature agents — integration is YOURS (§8 Step 2).

---

## 8. Continuation checklist (ordered; each step has acceptance criteria)

### Step 0 — Orient (10 min)
- `cd /data/home/forge/hzcode && git log --oneline -5 && git status --short`
- Any **untracked/modified files** beyond the §6b lists = late agent output → read it, it's probably a feature/fix/test to keep.
- Read `app/src/contracts.ts` (the law) and skim `CURRENT_RUN.md` §5.

### Step 1 — Collect agent results
- For each §7 agent: check expected files; read its session if your tooling supports it.
- Dead + empty ⇒ act per the "If still empty" column (resume via session id, or implement from the Appendices).
- When all collected: nothing should remain in flight.

### Step 2 — THE integration edit (one file, owned by you)
`app/src/tools/index.ts` currently registers only the 7 base tools. Add the new ones **using the actual export names you find in each file** (expected: `agentTool` in `agent.ts`, `codeModeTool` in `codemode.ts`, `previewTool` in `preview.ts`):
```ts
import { agentTool } from "./agent";        // only if that file exists
import { codeModeTool } from "./codemode";  // only if that file exists
import { previewTool } from "./preview";    // only if that file exists

export const tools: Tool[] = [
  readTool, writeTool, editTool, grepTool, globTool, shellTool, todoTool,
  agentTool, codeModeTool, previewTool,      // keep in sync with what exists
];
```
Also verify the F1 `loop.ts` patch is **additive** (`git diff dce5287 -- app/src/core/loop.ts` — should be new imports + new internal calls only; `createRuntime` behavior unchanged).

### Step 3 — Builds
```bash
cd /data/home/forge/hzcode/app && /home/forge/.bun/bin/bun build src/main.ts --target=bun --outdir=/tmp/hz-b-final
cd /data/home/forge/hzcode/kernel && cargo build --release
```
Acceptance: both exit 0.

### Step 4 — Run the full suites (first-ever execution; expect some failures)
```bash
cd /data/home/forge/hzcode/kernel && cargo test            # integration.rs; includes the 4-process concurrency lock test
cd /data/home/forge/hzcode/app && /home/forge/.bun/bin/bun test   # core, tools, providers, tui suites
```
Acceptance: all green. **Likely failure spots, in order of probability:**
1. Interplay of the three WIP fixes (esp. `kernel.ts` tail-stamp + `eventlog.rs` limit) — diff those first.
2. `app/tests/providers/` assumptions about chunk splitting (suite was mid-write at snapshot).
3. PTY tests when `script` is missing — they should `test.skip`; if they fail instead, fix the skip.
4. `_probe.test.ts` scratch residue.
When fixing tests: fixing a TEST to match contract-compliant behavior is fine; fixing PRODUCTION code should be a minimal, well-understood change (the three fixes above are examples of what those look like).

### Step 5 — e2e + trust re-verification
- `printf 'hello\n' | /home/forge/.bun/bin/bun run app/src/main.ts` → greeting, exit 0.
- `printf 'list files\n' | /home/forge/.bun/bin/bun run app/src/main.ts` → `⏺ glob(` + `└ ok:` + exit 0.
- `/tmp/hz-mode-check.ts` (recreate from §5) → `kernelMode=trusted`.
- If the tools registry changed, do one live chat turn that would exercise a new tool through mock (mock emits `glob` only) — for `agent`/`code_mode`/`preview`, use the scratch scripts in the Appendices.

### Step 6 — Feature smoke checks
- **Skills**: `mkdir -p .hzcode/skills && printf -- '---\nname: hello\ndescription: demo skill\n---\nSay HELLO-SKILL-LOADED and list one fun fact.\n' > .hzcode/skills/hello.md`; then chat `/hello go` — the skill body should influence the reply / appear in events. Verify unit-level with a scratch script if uncertain.
- **Subagent**: scratch script per Appendix A (inline fake provider) — nested run terminates, returns text; `agent` not available inside the child.
- **Code mode**: Appendix B scratch script — RPC round-trip + guard consulted.
- **Preview**: Appendix B scratch script — start tiny server, capture URL, stop, pid gone.

### Step 7 — Final audit + repo deep update
1. **README.md rewrite** (it currently describes the pre-code design; make it post-v0.1): what it is, quickstart (`./bin/hzcode`), architecture diagram, repo map, test matrix (`cargo test` / `bun test`), provider configuration (`HZ_PROVIDER` + `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, or `~/.hzcode/config.json`; mock = default), docs index link.
2. **`docs/28-implementation-status.md`** (new): a table mapping each design area (kernel, core, tools, TUI, skills, subagents, code mode, preview) → status **designed / implemented / tested / verified** → evidence (commit, command, observed output). Cite NF IDs (NF-015 code mode, NF-051…062).
3. **Update this file** (CURRENT_RUN.md) — overwrite with the new current state (or mark sections done inline).
4. `git add -A && git commit && git push` — push works; keep the style: a short imperative subject + body bullets. Never force-push; never change git identity.

---

## 9. Known issues / fragile spots (carry these forward)

| Item | Note |
|---|---|
| Sub-agent flakiness | JWT expiry + empty tool response, several times today. Resume-with-continue is the only recovery. |
| `bun` not on PATH | Use `/home/forge/.bun/bin/bun` everywhere; `bin/hzcode` handles it. |
| Mock provider quirks | Emits exactly ONE `glob` tool call for messages matching /list files|what.*here|ls/ — it does NOT call other tools; use scratch scripts for other tools. |
| Guard defaults | fs.read/fs.write **inside workspace = allow** (no approval prompt), outside = ask; shell.exec/net.fetch/spawn = ask. Approvals in headless mode = auto-deny with a notice. |
| `.hzcode/` dirs | Per-workspace runtime state; gitignored; safe to delete to reset. Never commit. |
| `app/tests/core/_probe.test.ts` | Scratch probe from the interop agent; keep only if it's a useful smoke test. |
| `AUDIT.md` | Pre-code design audit notes; leave as-is (historical). |
| Docs 26/27 | Learning + plan references — consult docs/27 for the V2+ roadmap before designing beyond V1. |

---

## 10. Design corpus orientation (docs/)

- **00-index** — the catalog. **01** vision · **02** ADRs (incl. terminal-vs-web) · **03** HLD · **04** LLD · **05** domain model/schemas · **06** events+flows · **07** APIs/contracts · **08** runtime · **09** tools · **10** cognition · **11** authority/safety · **12** sessions/state · **13** TUI · **14** surfaces · **15** extensibility · **16** operations.
- **24 feature-catalog** — NF-001…062 with parity rows vs the 10 studied products; **25** roadmap + glossary; **26** learning synthesis II; **27** implementation plan (V0–V7, runtime viability, workstreams). **`_conventions.md`** — canonical names, reserved registries, RC rulings (RC-12 is the latest).
- If a spec question arises: grep docs for the term, check `_conventions.md` first, and honor NF numbering if adding features.

---

## 11. Rules of engagement (non-negotiable)

1. **`app/src/contracts.ts` is law.** Any change to it is a design decision — document it (docs + conventions) before code.
2. **"Verified" means you ran it and saw it.** Agent reports are evidence candidates, not proof. Re-run before claiming green.
3. **Territory discipline for parallel work**: one writer per file; fence `tools/index.ts` and `loop.ts` to the integrator; give every agent explicit "do NOT touch" lists.
4. **Commit style**: concise imperative subject; body = what/why bullets; never force-push; never touch git identity; do not commit `.hzcode/`, `node_modules/`, `kernel/target/`.
5. **Chat-first is the product charter**: no subcommand menus; flags are optional conveniences; headless is for scripts/tests only.

---

## Appendix A — Skills + Subagent v1 spec (if agent #6 produced nothing)

**Skills** — new file `app/src/core/skills.ts`:
- Discovery: `WORKSPACE/.hzcode/skills/*.md` and `~/.hzcode/skills/*.md`. Format: optional frontmatter between `---` lines with `name:` and `description:`, then a markdown body. Parse errors skip the file silently (never throw).
- API: `listSkills(workspace)` → {name, description, source}; `getSkill(workspace, name)`; `skillsPromptSection(workspace)` → compact one-line-per-skill section, cap 12, '' when none; `resolveSkillForMessage(workspace, text)` → for `/name …` where name is a known skill: {skill, action: rest-of-text}.
- Loop integration (additive, in `app/src/core/loop.ts`): append `skillsPromptSection` under heading `Available skills` when non-empty; when `resolveSkillForMessage` matches, append `Active skill: <name>` + body (cap 8000 chars) and use the stripped action text as the user content for that turn.

**Subagent** — new files `app/src/core/subagent.ts` + `app/src/tools/agent.ts`:
- Tool: name `agent`; description: *Delegate a focused task to a subagent that works in its own context and returns a final summary. Use for self-contained research or multi-step sub-tasks.* Params: `{task: string, max_steps?: number}`.
- Behavior: creates a CHILD session (title `subagent: <first words of task>`); runs a nested agent loop reusing loop.ts internals (refactor additively — e.g. export a `runNested` from subagent.ts or a reusable piece from loop.ts); child system prompt: *You are a focused subagent. Complete the task, then report concisely. Do not ask questions.*; tool set = the 7 base tools **minus `agent`** (no recursion); max steps default 12, hard cap 20; inherits `ctx.signal` (abort); guard/approve flow identical to parent; returns `{ok, output: final text (cap 8000)}`.
- Verify: build check + a /tmp scratch script running the nested runner with an inline fake provider (scripted stream events) proving termination + returned text.

---

## Appendix B — Code Mode + Preview v1 spec (if agent #7 produced nothing)

**Code Mode** — new files `app/src/tools/codemode.ts` + `app/src/tools/codemode-child.ts`:
- Tool: name `code_mode`; description: *Run a JavaScript program in an isolated Bun subprocess to chain tool calls, filter large outputs, and compute; returns logs plus the final value.* Params: `{code: string, timeout_ms?: number}`.
- Parent side: spawn `/home/forge/.bun/bin/bun run <repo>/app/src/tools/codemode-child.ts` with cwd=ctx.cwd. **NDJSON bridge over child stdio**: child → parent lines `{"rpc":"tool.call","rpcId":N,"name":"...","args":{...}}`; parent resolves against a LOCAL map of the 7 base tools (import them directly — not via index.ts), runs each through `ctx.guard` (ask → `ctx.approve`, title mentioning the tool name) then `ctx.receipt`, and writes back `{"rpcId":N,"result":{ok,output,error}}` on stdin. Non-RPC child stdout lines = console output, collected (cap 20KB). Timeout: default 30s, cap 120s; kill on timeout or `ctx.signal` abort.
- Child side: defines global `tools.call(name, args)` (RPC handshake reading stdin lines), captures console.log, wraps user code in an async function, prints final `{"done":true,"result":<json>}` (or `{"done":false,"error":...}`, exit 1).
- Result text: calls made count + logs + returned value (truncated sensibly).

**Preview** — new file `app/src/tools/preview.ts`:
- Tool: name `preview`; params `{action: start|stop|status, command?: string, cwd?: string, port?: number}`.
- `start`: guard `shell.exec` + approve when asked; command = explicit arg → else `scripts.dev` from package.json → else `scripts.start` → else clear error; spawn `bash -lc` detached in resolved cwd; keep a 4KB output ring; scan for `http://localhost:PORT` up to 12s; return `Preview running at <url>` (or log tail + warning on failure — kill the child on failure). Registry: module `Map<sessionId, {id,pid,cmd,url,startedAt,logTail}>`.
- `stop`: kill the process group (negative pid), confirm, remove entry. `status`: list this session's previews (pid, url, uptime).

**Verify both** with /tmp scratch scripts (per the original prompts): code_mode RPC round-trip with a mock ToolContext (assert guard consulted, logs + return value present); preview start/stop of a tiny Bun server (assert URL captured, pid gone — see feature smoke in §8 Step 6).

---

*End of handoff. If you finish everything in §8: you've taken HorizonCode from "v0.1 verified" to "v0.1 + deep test suite + first V1 features + status docs" — a fully green, deeply-documented checkpoint. The next planning surface after that is docs/27 (V2+).*
