# Competitive viability audit — HorizonCode

**Date:** 2026-11-08 · **Tree:** wave-11 commit `0a723dd` + the wave-12 hardening working tree (uncommitted at write time; 594 pass / 0 fail / 47 files at 08:46, cargo 9+31, selftest 18, gates 6/6)
**Auditor:** the integrating engineer, synthesising FOUR independent adversarial audits conducted this day (trust/authority with a five-repo code comparison; docs-honesty; robustness with hostile probes; performance/Rust-rewrite) plus first-hand measurements. **Independence note:** the four audits were run by agents with no prior session context, instructed to break the claims, not trust them.
**Head-to-head benchmarks were NOT run** (no provider API keys, no competitor binaries installed in this environment). All statements about competitors come from (a) the code-level comparison of codex, grok-build, opencode, oh-my-pi and forgecode performed earlier today, and (b) the reference baseline supplied with the brief. Relative scores therefore carry LOW confidence; internal measurements carry HIGH confidence.

---

## 1. Executive verdict

**(b) Viable niche today; no architectural rewrite required to reach (a) top-tier — the gaps are additive subsystems, not wrong core abstractions.**
The three load-bearing reasons: (1) the core loop is genuinely reliable — 594 tests green, hardened by four adversarial audits and a failure-injection battery (kill-mid-transaction, symlink/TOCTOU/hardlink attacks, corrupt stores, forged control frames, 20 MB floods, read-only state); (2) one real differentiator exists that no compared competitor has — enforced authority plus hash-chained, keyed receipts ("the chain proves", not "the model said"); (3) every remaining parity gap (compaction, memory files, MCP/hooks/LSP, TUI surfaces, OS sandbox, benchmark harness) is an additive build, not a rewrite. It is not top-tier today because product surfaces are chat-class and long-session context management does not exist.

## 2. Scorecard (0–5)

| Dimension | Score | Confidence | Key evidence |
|---|---|---|---|
| Product experience (TUI) | **2** | high | Queued non-blocking input, aborts, tool cards, y/n/a approvals, slash commands, history, headless, PTY tests (48) — but no fullscreen renderer (docs/13 unbuilt), no @file completion, no vim/paste features, no diff-review UI, no plan mode, no context/cost display, no rewind. Chat-class, not top-tier. |
| Agent capability | **3** | medium-high | 11 tools incl. PageRank repo_map + rg grep + edit ladder w/ reflections + stale-preimage; batch classes + barriers; budget rails; subagents (depth-1); Code Mode (keyed frames); reservation-grade shell. Missing: compaction, LSP/diagnostics, persistent index/tree-sitter, git tooling, MCP, memory files. |
| Engineering quality | **4** | medium-high | Kernel/loop/UI/headless separation; enforced guard + typed refusals; WAL+FULL + quarantine discipline everywhere; admission FIFO; supervisor; 594-test suite incl. interop/parity/PTY/robustness; CI gates with an honest catalogue. Gaps: no compaction subsystem, no OS sandbox, thin provider breadth. |
| Competitive viability | **3** | medium (relative: low) | Sound foundation + unique audit/provenance differentiator + additive gap list; but zero benchmark evidence vs competitors and table-stakes ecosystem items absent. |

**Weighted (35/30/20/15): 3.1 / 5 — usable, clear gaps versus leaders.**

## 3. Feature-parity matrix

Competitor columns per the supplied baseline; HorizonCode labels are from verified code/tests in this tree (label key: **I+T** implemented+tested, **I-u** implemented/untested, **P** partial/stub, **S** specified only, **A** absent).

| Capability | HC | Claude Code | Codex CLI | OpenCode | Aider | Gemini CLI |
|---|---|---|---|---|---|---|
| Rich TUI (persistent input, diff review, vim) | **P** (chat-class; queued input I+T; fullscreen S) | rich | TUI+resume picker | polished client/server | REPL | TUI+checkpoints |
| Non-interactive / headless | **I+T** | yes | exec mode | server+SDK | flags | headless |
| Project memory files | **A** (skills dir P) | CLAUDE.md | AGENTS.md | AGENTS.md+rules | conventions | GEMINI.md |
| Permission modes (allow/ask/deny, accept-edits, plan) | **P** (per-action ask/deny I+T, session grants P, no plan/bypass modes) | full | policies | per-tool config | trust-based | confirm |
| OS-level sandbox | **A** (NF-016 designed; Landlock candidate; this box: no bwrap/userns) | options | Seatbelt/Landlock/containers | none | none | option |
| Enforced (non-prompt) authority | **I+T** (kernel guard, typed refusals — unique) | n/a (prompt+approval) | approval+policy | rules | trust | confirmation |
| Hash-chained receipts/evidence | **I+T** (unique among all compared; keyed HMAC anchors) | absent | absent | absent | absent | absent |
| Edit mechanism | **I+T** (exact + ladder + reflections + stale-preimage) | exact+write | apply_patch | edit/patch+LSP | multi-format | replace |
| Read-before-write / stale detection | **I+T** (both) | enforced | yes | yes | limited | ? |
| Context compaction | **A** (trim only; caps+spill I+T) | auto | yes | multi-strategy | budgeting | huge windows |
| Prompt caching discipline | **P** (stable prefix + canonical JSON; no cache orchestration) | yes | yes | yes | partial | n/a |
| MCP | **A** | yes | yes | yes | no | yes |
| Hooks / middleware | **A** | yes | profiles | plugins | no | extensions |
| LSP / diagnostics loop | **A** | IDE bridges |  | LSP feed-back |  |  |
| Subagents | **I+T** (depth-1, isolated context, no parent leases) | yes | multi-agent | agents | no | ? |
| Session persistence / resume | **I+T / P** (WAL+FULL store, `--continue`; no rewind/checkpoints) | resume+rewind | resume | history/sharing | /undo | checkpoints |
| Git workflow tools | **A** (git used externally; no branch/commit/PR tools) | yes | git review | yes | commits/changes | ? |
| Providers | **P** (anthropic+openai+mock I+T; no local models) | Anthropic | OpenAI+configurable | many | many | Google |
| Automation/SDK/CI | **P** (headless I+T; no SDK/server mode) | SDK | exec/CI | server/SDK | scripting | headless |
| Observability / replay | **I+T / S** (chained events+receipts I+T; `session verify` replay S; no OTel export) | transcripts | logs | logs | logs | logs |
| Eval harness | **P** (post-mortem eval cases I+T; runner + benchmark suites A) | internal | internal | internal | polyglot | internal |

## 4. Benchmark results

**Method:** all numbers are first-hand runs on this machine (4 vCPU, Bun 1.4.4, release kernel). **No cross-agent benchmark was run** — see the independence note; treat relative claims as unverified.

| What | Result (measured) |
|---|---|
| Full TS suite / Rust | 594 pass / 0 fail / 47 files (~24 s under load); cargo 9 unit + 31 integration; selftest 18 checks; `ops/gates.sh` 6/6 |
| Kernel IPC | cold start p50 7 ms; ping p50 0.20 ms; `guard.check` p50 0.24–0.47 ms; `log.append`/`receipt` p50 **0.53–0.6 ms flat at 2.2 k and 20 k records** (was 7.99/6.90 ms at 2.2 k before this wave's tail cache) |
| Loop cost (20 tool calls, scripted provider) | 267 ms wall total; kernel ≈ 6.7 ms/tool-call; provider = 86 % of wall at 100 ms/turn — kernel is 0.3–2 % of a realistic loop |
| Tools (this repo, 124 source files) | grep 30–40 ms (rg) / fallback within 1.3×; glob 14–16 ms; read 1.5–6 ms; repo_map 0.5 s (ident counting = 313 of 578 ms — cache is the next win) |
| Failure injection | owner SIGKILL → tree gone in 44–115 ms; two exclusive shells serialize 1412 ms; WAL+FULL survives SIGKILL mid-transaction (integrity ok); corrupt stores quarantine; read-only state dir surfaces typed failures (runs no longer report success) |
| Robustness battery | 17-case path matrix, 15-case R1 parity, forgery battery, 20 MB flood, symlink/TOCTOU/hardlink attacks — all refused after wave 12, no breaker remaining |

## 5. Critical findings, ranked (S = structural, F = fixable)

1. **No context lifecycle (compaction/summarization/usage meter).** At 95 % context nothing protects the goal; only caps+spill and history trimming exist. **F** (additive subsystem; needs its own eval). Highest-impact reliability gap.
2. **No OS-level sandbox; the TOCTOU class is mitigated, not owned.** write/edit now verify the *opened fd* and refuse state-dir targets; code_mode still runs with ambient user authority (one approval can reach the policy file — now hardlink-guarded, but ambient remains); `setsid` descendants escape group kills; non-Linux fallbacks documented as weaker. The class fix is kernel-executed effects / Landlock (NF-016). **S** (new subsystem, no rewrite).
3. **Product surfaces are chat-class.** No fullscreen renderer, diff-review-before-write, plan mode, context/cost display, rewind/checkpoints, @file completion, vim/paste affordances. **F**, largest UX build (docs/13 is the spec; M1-D7 unmet).
4. **Ecosystem table stakes absent:** MCP, hooks, LSP diagnostics, plugins, git workflow tools, project-memory files, local-model providers. **F** (well-understood builds; MCP client + memory files are the cheapest high-value pair).
5. **No benchmark evidence.** An eval runner and a public-suite subset are required before any parity claim can be made; today "improvements" cannot be measured externally. **F**, small build, high leverage.
6. **Deep-repo scaling:** repo_map is lexical, rebuilt per call, 3 000-file cap; grep/glob are fine via rg. **F** (cache → S; tree-sitter → M).
7. **Recorded residuals (already documented):** legacy owner-less leases are globally consultable; child re-approval over the Rust stdio transport is proven at kernel layer, not via a full child loop; other state files remain hardlink-writable (chain *detection* covers); multi-process path-resolution fork on mixed-version runs.

## 6. Spec-vs-reality

| Claimed (docs) | Verified status |
|---|---|
| docs/13 fullscreen+inline TUI (M1-D7) | Specified only; shipped is the readline chat TUI (queued input, approvals, cards) |
| One-use lease consumption (L1/L4) | Designed only; shipped mint/consult/expiry — now owner-scoped — no consumption state |
| Receipt postimage / durable transcript↔kernel bridge | Designed only; shipped = chain + tamper evidence + caller digests |
| Kernel as effect host | Policy/audit prototype; effects execute in TS with effect-time verification (this wave) |
| M1-D6 native capability slice (hz_shell/edit/diff/walker via N-API) | Absent; tools are TS (rg-backed where possible) |
| M1-D9 `hzcode session verify` replay | Designed; storage + chain exist, the command does not |
| M1-D10 record/replay provider harness | Partial (scripted providers in tests; no product harness) |
| Growth loop NF-075 | Reduced form shipped (review-fork spec + editorial standard + curator); no scheduling/wiring/application |
| Evals from post-mortems | Cases + answer-isolation shipped; runner absent |
| Leases/approvals/aubits hardening | Claims match: R1 order, owner scoping, exact-command grants, protected state, keyed frames, keyed anchors — all audit-verified |

## 7. Roadmap (impact on reliability first)

**30 days:** compaction v1 + a context meter in the TUI; eval runner + first internal benchmark suite; project-memory files (AGENTS.md hierarchy); repo_map ident cache; TUI: diff review before write + plan-mode toggle + usage/cost line; MCP client v1 (stdio); Landlock availability spike.
**90 days:** fullscreen renderer slice (docs/13); file checkpoints + session rewind; LSP diagnostics fed back to the model; hooks; providers +google +ollama; OS sandbox GA for shell/code_mode; the first same-model head-to-head benchmark (10–20 tasks) against 2+ competitors.
**180 days:** kernel-executed effects (closes TOCTOU/hardlink/setsid as a class, rewards the authority story); server mode + SDK; plugins; enterprise/governance pack (audit receipts, policy controls, compliance export) as the deliberate niche play; benchmark-driven harness tuning.

## 8. Open questions / unverifiable here

Head-to-head pass rates, cost and wall time (no keys/binaries); TUI behaviour on Windows Terminal/SSH/low-color (PTY evidence is Linux only); real-provider caching/thinking/parallel-tool-call handling (canned-server tests only); Landlock availability on the deployment kernel; macOS/Windows parity for every Unix-hardened path; docs/13 build estimate under a realistic team size; whether tree-sitter is acceptable as a dependency.

## 9. Red-flag checklist (per the brief)

1. Impressive specs without end-to-end tests — **no**: gates 6/6, e2e headless + PTY suites, real-kernel interop tests.
2. Permission security that is only prompts/regex — **no**: kernel-enforced, typed refusals, adversarial-tested; caveat: no OS sandbox, code_mode ambient (finding 2).
3. UI tightly coupled, no headless — **no**: loop/UI/kernel separated; headless mode tested.
4. No session persistence or rewind — **persistence yes** (WAL+FULL, resume), **rewind no** → partial flag (finding 3).
5. Edit failures not recovered — **no**: repair ladder + reflections + stale-preimage + ambiguity refusals, all pinned by tests.
6. Compaction with no evaluation of what it loses — **no compaction at all** → flag (finding 1).
7. Provider abstraction that only works with one vendor — **two real vendors** + mock, SSE-torture-tested; thin vs leaders → partial flag.
8. No eval harness — **partial**: cases exist, runner absent → flag (finding 5).
9. Agent reports success without verifying — **no**: hash-chained receipts, sentinel exits, budget rails, and (this wave) event/receipt write failures make the run exit NOT succeeded.

---

*Evidence base: `docs/audit/triage-external-review-2026-11-07.md`; the four 2026-11-08 audit records (this file synthesises them); `docs/28-implementation-status.md` rulings 14–28; `docs/25` §3.2 (M1 exits); measured runs as cited in §4. This audit's dispositions enter `docs/28` as gap rows in the same commit.*
