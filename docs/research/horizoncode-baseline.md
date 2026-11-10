# HorizonCode - Documentation Baseline (Phase 1 Research)

> Read-only research artifact. Source corpus: `docs/` (00–30, `_conventions.md`, `docs/audit/**`) plus `README.md`, `AUDIT.md`, `CURRENT_RUN.md` at repo root. Every claim below cites its source document and section. Nothing was modified.
>
> Product: **HorizonCode** · binary `hzcode` · design corpus ratified through **RC-17** (2026-11-07) · implementation snapshot **2026-11-08/09** in `docs/28` and `CURRENT_RUN.md`.

---

## Part 0 - What HorizonCode is (one paragraph)

A terminal-first ("chat-first") coding agent with an **execution constitution**: the model's *reasoning* is separated from its *authority to act*. A TypeScript/Bun runtime runs the agent loop, context, tools and TUI; a supervised **Rust kernel (`hzk`/`hz-kernel`)** owns capability admission, policy, leases, sandbox confinement, effects and receipts. Design goal: the **strict superset** of eight reference agents (horizoncode-ancestor, opencode, codex, grok-build, DeepSeek-Reasonix, oh-my-pi, forgecode, claude-code) plus a second wave of six (SWE-agent, OpenHands, wshobson/agents, aider, mini-swe-agent, hermes-agent). The "seven things to remember" (`00-index.md`): (1) model proposes, kernel disposes; (2) terminal-first, protocol-first; (3) every mutation leaves a receipt and `UNKNOWN` is terminal, never a retry; (4) one `llm.stream` per step; (5) cache prefix stability is a CI contract; (6) workspace config may only narrow user config; (7) self-improvement never widens authority.

---

## Part 1 - Faithful summary of the designed system, per document

The spec set uses a fixed 10-section template (`_conventions.md` §9) and declares a document class per RC-14: **contract** (normative schemas/protocol), **decision record** (ADRs/rulings, binding on design), or **historical** (learning records, plans, audits, queues - no normative force).

| Doc | Title | Class / role | What it decides (faithful summary) |
|---|---|---|---|
| 00 | Specification Index | index | Read order; the seven principles; status ladder; document classes (RC-14); upstream attribution (ADR-014). |
| 01 | Vision & Superset | vision/historical | Changes the unit of trust from *transcript* to *receipt*. Product principles P1–P10 (model proposes/kernel disposes; evidence over assertion; local-first BYO keys; one Controller many faces; cache is a contract; fail closed; boring where it counts; self-improvement never widens authority; small crates; observable by default). "Superset" made testable via a parity matrix + ratchet. Grills the eight references and states what is inherited vs superseded. |
| 02 | Decisions (ADR-001…016) | decision record | 16 binding ADRs: terminal-first (001); hybrid TS/Bun + Rust (002); kernel is a separate process not a library (003); event-sourced storage (004); one Controller + parity ratchet (005); MCP client **and** server (006); policy-as-code: wildcard rules + Starlark (007); workspace config may only narrow user config (008); cache prefix stability is a CI contract (009); self-improvement never widens authority (010); one provider stream per step, no hidden tool loop (011); every mutation → receipt, `UNKNOWN` first-class (012); local-first/BYO/offline (013); derivative work tracked+attributed (014); tools declared not string-matched (015); subagent construction funnels through one primitive (016). |
| 03 | HLD | contract-ish | Planes, processes, trust boundaries, interfaces, performance targets. Batch admission; the `deny > lease > ask > allow` guard story; §7.1 batch/lease flow. |
| 04 | LLD | contract-ish | Packages, crates, modules, function signatures, invariants (e.g. L-40 lease rule, §5.2 module error codes - internal only per RC-16). |
| 05 | Domain & Schemas | **contract (normative)** | Domain model + every `*V1` wire/durable schema (`GuardDecisionV1`, `EffectReceiptV1`, `DurableEventV1` envelope, `GuardDecisionV1.reasonCode` closed set, D3 blake3 digest domains, D40 canonical-number form). §4.2 registered id prefixes (`evt_`, `apr_`, `bat_`). |
| 06 | Events & Flows | contract/decision | The 44-event catalog + 24 end-to-end flows; the G-rulings behind RC-1…RC-4; exit-code + kernel-absent posture (S6 → read-only + exit 3). |
| 07 | APIs & Contracts | **contract (normative)** | Controller protocol, kernel ABI, HTTP/SSE, ACP, MCP, plugin API, SDKs; §4.1.5 feature-flag registry (RC-9); §4.10.2 `HZ_*` wire error registry (the only cross-surface error vocabulary, RC-16(b)). |
| 08 | Runtime | contract/decision | Agent loop, planner/executor duality, subagents, teams, budgets, scheduler (R-85 DST), self-improvement loop; loop safety rails territory (NF-073). |
| 09 | Tools | **contract (§4 authoritative)** | The complete ~80-tool catalog; every tool declares JSON schema I/O, read-only class, concurrency class, permission reqs, capability ID, effect class, renderers, idempotency. R-tools-32 (children get grants never parent leases), R-tools-39 (exclusive classes), R-tools-42 (16 KiB/4,000-token caps), §8.2 stale-preimage. |
| 10 | Cognition | contract/decision | Providers + models.dev; cache-first context compiler + cache-guard (R65, RC-8); memory tiers (working/episodic/semantic/team); compaction incl. snapcompact; retrieval (BM25+embeddings+symbol index); R121–R123 AGENTS.md/ZH.md instruction hierarchy; R97/R103 persistent index. |
| 11 | Authority & Safety | **contract (authority semantics owner)** | Threat model, Guard, leases (one-use), receipts, reconciliation, sandbox matrix (Linux Landlock+bubblewrap+seccomp+ns; macOS Seatbelt; Windows token/AppContainer/job objects) with per-dimension guarantee vectors + typed residuals, policy. R1 precedence `deny > lease > ask > allow`. §4.1 internal capability IDs. Trusted Host State. |
| 12 | Sessions & State | **contract (layout owner, §4.1)** | Event log, projections, inbox, claims, snapshots, time travel/rewind, durability. §4.3 pragmas (`synchronous=FULL` strict default, RC-16(e)); §4.1 concrete file layout, two-level CAS shards `<ab>/<cd>`, kernel state under `<ws>/.hz/state/kernel/`. S-47 checkpoint bounds. |
| 13 | TUI | contract | Fullscreen alt-screen mouse-interactive TUI; inline fallback; palette, slash commands, diff viewer, session picker, theming, accessibility. (M1-D7.) |
| 14 | Surfaces | contract | Headless/print, HTTP+SSE server, web, desktop (Electron), IDE bridge (ACP + VS Code/JetBrains), MCP server, SDKs, collaboration, voice. §3.2 S16 canonical exit codes (RC-5): 0/1/2/3/4/5/130/143. |
| 15 | Extensibility | contract | Plugins (signed manifest, sandboxed host, marketplace), skills (`runAs: subagent`, skillify), commands/hooks (H1–H10 / `HookV1`), Rhai workflow engine, MCP/ACP depth. |
| 16 | Operations | contract | Install & release integrity, 18 CI gates (§24 §3.5), observability (OTel/GenAI conventions), diagnostics, security ops, runbooks, test corpus (hostile fixtures), metric contract H-7. |
| 17–23 | - | reserved | Unassigned by convention; cited only as `[planned]` (`docs/24` §13 owns the gap). |
| 24 | Feature Catalog | contract/decision | Parity matrix Section A (117 rows across 8 refs: 36 Inherit / 79 Supersede / 2 Reject) + A.9 addendum (6 second-wave sources); Section B new features **NF-001…NF-075**; §3.3 reserved capability IDs; §3.5 the 18 gates; Section D rejections. |
| 25 | Roadmap & Glossary | plan/historical | Phases **M0–M8** (Foundation→Loop→Authority→Surfaces→Intelligence→Scale→Ecosystem→Enterprise→Self-improvement) with per-phase exit gates; the evidence ladder §2.2 (what each status level requires); glossary. P0–P7 mapping in §8.2 OQ-R1. **No phase has formally exited; M1 exit criteria remain open.** |
| 26 | Learning Synthesis 2 | historical | Ten-repo distillation; adoption ledger NF-051…NF-062; the 16 queued doc updates (§5). |
| 27 | Implementation Plan | historical/plan | Build plan: bootstrap, workstreams, runtime viability, subagent build-out, gates, open ADRs; the V0–V7 ladder (coarse map; RC-16(h) says `docs/30` §4 wins on conflict). |
| 28 | Implementation Status | **single source of truth for implementation levels (RC-13)** | See Part 2. |
| 29 | Final Audit | historical (audit of record, RC-13c) | Twelve-repo completeness pass (67,083 files); 270 missing/unique findings across 6 delta passes; NF-063…NF-070 appended; Part D = verbatim copy of the 16 queued insertions; optimization + docs-staleness ledgers. |
| 30 | Steal List | working queue (non-normative) | See Part 3 (full contents). |
| - | `_conventions.md` | **names/status owner + RC-1…RC-17** | Canonical names, the five `hz.` namespaces, TS packages, Rust crates, capability IDs (+ reserved + INTERNAL blocks), the **44 canonical events**, schema naming, status ladder, writing rules, and the 17 ratified cross-document decisions. |
| - | `README.md` | marketing + status line | The designed capability list (§3.1–§3.9) + a shipped-v0.1 status line. **Flagged by the external audit as the single most unreliable document** (over-claims vs shipped reality - see Part 4). |
| - | `AUDIT.md` | historical | 2026-11-06 re-audit of the spec set (pre-implementation): traceability PASS, consistency PASS after 6 fixes (C-1…C-6), parity PASS (117 rows), hole-hunt PASS on spot-check. Verdict: no blockers as a design baseline; the only thing missing is implementation evidence. |
| - | `CURRENT_RUN.md` | live handoff + rules of engagement | See Parts 2 and 5. |

---

## Part 2 - The status ladder: DESIGNED vs CODE_PRESENT/WIRED/TESTED/VERIFIED/RELEASED

**Ladder (`_conventions.md` §8, `docs/25` §2.2):** `DESIGNED → CODE_PRESENT → WIRED → TESTED → VERIFIED → RELEASED`. Only `docs/28` may claim a level above `DESIGNED` (RC-13); everything not listed there is `DESIGNED`. `VERIFIED` means the integrator ran the evidence command and saw the result - agent reports alone never reach VERIFIED. **No capability has reached `RELEASED`**; no roadmap phase has formally exited.

### 2.1 TESTED + VERIFIED (shipped v0.1 + V2 waves 1–14c), per `docs/28` §1

- **Rust trust kernel** - chained event log, receipt chain, guard (leases, `policy.json`, R1 precedence `deny > lease > ask > allow` since wave 9), keyed anchors (`HZ_ANCHOR_KEY`, HMAC-SHA256), structural kernel-state protection, 8-method NDJSON protocol. Evidence: `cargo test` (9 unit + up to 35 integration depending on wave), `--selftest` SELFTEST OK (18 checks).
- **Frozen contracts / hashing** (`app/src/contracts.ts`) - canonical JSON + sha256, Rust↔TS byte-for-byte interop (`log.verify`/`receipt.verify`).
- **Runtime core** - config, kernel client (`trusted`) + byte-identical TS fallback (`untrusted`), SQLite sessions, agent loop (stream → guard → approve → tool → receipt → events).
- **Eleven tools** - base seven `read write edit grep glob shell todo` + `repo_map` (B-1 PageRank) + `agent` (subagent) + `code_mode` (keyed NDJSON bridge) + `preview` (dev-server lifecycle).
- **NF-072** per-tool concurrency classes + parallel batches (ruling 14/24); **NF-073** loop safety rails (ruling 15); **NF-069/052** edit-application ladder (ruling 16); **NF-074** context-cost contracts (ruling 18); **B-1** repo_map (ruling 19) + persistent identifier cache (wave 14b); **NF-071** managed runtime v1 (ruling 22); audit-response wave (rulings 24–25); canonical state paths RC-17 (ruling 26); **NF-075** growth-loop v1 reduced form (ruling 27); evals-from-post-mortems (ruling 28); wave-12 distrust-reaudit hardening (rulings 29–31); one-use leases + session grants (ruling 32); kernel-mode provenance (ruling 33); **MCP client v1** stdio (ruling 34); **Hooks v1** tool.pre/tool.post (ruling 35); durable change journal + crash-safe undo (ruling 36); plan mode + diff review (ruling 37); Landlock spike measurement (ruling 38); providers +google/+ollama (wave 14c); rewind/checkpoints v1 (wave 14c); CI gate runner `ops/gates.sh` (6 real gates, ruling 17); skills, subagents, Code Mode, preview (V1); providers (Anthropic/OpenAI/mock + SSE); chat TUI (interactive + headless); project-memory AGENTS.md/ZH.md hierarchy + eval runner (wave 13).
- Headline suite numbers (grow across waves; latest in `docs/28`): **`bun test` 892 pass / 0 fail / 75 files**; `cargo test` 9 + 35; `hz-kernel --selftest` 18 checks; `ops/gates.sh` 6/6. (Earlier milestones cite 607/48, 709/60, 840/71.)

### 2.2 DESIGNED ONLY (per `docs/28` §1 final row + §4)

Everything else in docs 01–30: the authoritative `docs/09` §4 tool catalog beyond the 11 shipped tools; planner/executor duality; memory tiers; multi-strategy compaction/snapcompact; the full sandbox matrix (OS-level confinement, NF-016); web/desktop/IDE/ACP/MCP-server/SDK surfaces; plugins/marketplace; the governance/self-improvement loop; execution recorder; ACI windowing; fullscreen TUI (docs/13, M1-D7); server mode; LSP/DAP loop; `hzcode session verify` replay (M1-D9); record/replay provider harness (M1-D10); the kernel as the effect host. Sequenced in `docs/27` (V0–V7).

### 2.3 Important nuances on the "VERIFIED" claims

- The kernel is a **policy/audit prototype, not the effect host** - effects execute in TypeScript and are receipted afterward (triage finding 2, CONFIRMED architecture gap; `docs/28` §4). So kernel "enforcement" is advisory in the shipped tree.
- Levels above DESIGNED are claimed only on commands the integrator ran in this workspace (methodology note at the end of `docs/28`).
- Status levels are context-dependent per wave; `docs/28` is explicitly the single source and must be updated in the same commit as any status/count change (RC-13; CURRENT_RUN §7 rule 6).

---

## Part 3 - Full current contents of `docs/30-steal-list.md`, section by section

**Class:** working queue (non-normative). Consolidates four pass-3 deep dives - aider (35 items), mini-swe-agent (41), hermes-agent (38), oh-my-pi (28) - into one traceable shortlist. Register candidates were **adopted as NF-071…NF-075 (RC-15, 2026-11-07)**; items 1–8 and 11 of §4 remain the live work plan.

**§0 - Sources and synthesis rule.** Table of the four repos (clone @ commit, report path, steal-item count, core character). Synthesis rule: consolidate by *mechanism family*, keep every entry traceable to its report §4 number, mark disposition against the corpus (NF-### / doc / new candidate). Register stays closed until candidates pass revision.

**§1 - The oh-my-pi claim check.** Four external claims verified against `audit-omp-deep-report.md` §1: "batches commands bypassing multi-turn loops" → **CONFIRMED**; "fastest median runtime" → **NOT VERIFIABLE** (no benchmark artifact); "fewest tokens/tool calls" → **PARTIAL** (mechanisms real, no comparative measurements); "72% pass rate / reasoning-for-velocity trade" → **NOT VERIFIABLE** (README marketing only). Reading: steal the mechanisms, do not quote the ranking as fact. Motivates the H-7 metric contract.

**§2 - The consolidated steal list** (each row: mechanism → source report §4 item → disposition; "extends" = existing NF/doc owns the topic). Candidate resolution note (RC-15): `N-1`→doc 09 repo_map ranking; `N-2`→NF-073; `N-3`→NF-072; `N-4`→NF-071; `N-5`→NF-075.

- **A. Edit and patch engineering** (aider's strongest suit): A-1 escalating edit ladder (literal→3-way→line-patch under ~4 preprocessing variants, extends NF-069); A-2 relative-indent normalisation (NF-069); A-3 diff-shaped failure feedback / "did you mean" / REPLACE-already-present (NF-052/069); A-4 bounded reflection loop + `max_reflections` (doc 10); A-5 parity fixtures with byte-identical error strings (NF-069).
- **B. Repo map and context selection:** B-1 tree-sitter def/ref graph + personalised PageRank + token-budget binary search, empirical weight table, no embeddings (doc 09, candidate N-1); B-2 per-message relevance budget + 3-step fallback (doc 09/10); B-3 synthetic assistant-ack turns after context slabs (doc 10); B-4 cache layout as invariant (stable slabs first, 3 breakpoints, `cacheable_messages()`, keep-alive pings) (NF-005/Part D §10); B-5 frozen fingerprinted prefix + append-only log, longest byte-stable prefix truncation, per-provider gate (NF-005); B-6 fit output cap to remaining window (usage-anchored, 16/msg framing, 64 headway) (NF-061); B-7 structural read summaries + caps + spill + shell minimiser (NF-052); B-8 budget countdown in prompt via template vars (doc 08/10); B-9 head/tail truncation + `elided_chars` + remediation (R-tools-57).
- **C. Loop mechanics and velocity:** C-1 ~200 LOC simplicity floor, policy in config/prompts not code (doc 08); C-2 single sentinel terminate (`role=="exit"`) (RC-7); C-3 persist trajectory every step (`finally: save()`) (doc 12); C-4 format-error continuation + consecutive-error cap + charge failed turns (doc 08, candidate N-2); C-5 check budgets before call, `0=unlimited`, non-liftable wall clock, global spend ceiling (NF-025); C-6 per-tool concurrency declaration + last-exclusive barrier (**new capability**, candidate N-3, claim-verified); C-7 auto-background long commands (60 s) racing a steering signal (doc 08/09); C-8 re-execute unpaired tool-call tail (Part D §05); C-9 live steering into in-flight stream + image-message refusal (doc 08); C-10 loop guards as per-failure-class prompt files in `<system-interrupt>` wrapper (NF-066); C-11 thinking effort by cheap difficulty judgment + `ultrathink` (doc 07/10); C-12 owner/worker split over framed pipe w/ identity handshake (**new capability**, candidate N-4); C-13 durable per-session admission FIFO with `unknown` halting followers (NF-001/RC-7).
- **D. Process ownership and runtime safety:** D-1 `spawn_owned` single sanctioned spawn path + AST lint (fold into N-4); D-2 owner-death supervisor in POSIX sh (N-4); D-3 boot-relative process births + spawn ledger w/ quarantine (N-4); D-4 at-most-once scheduling (advance `next_run_at` before dispatch, idle watchdogs, pre-run data as FILE) (NF-028/053); D-5 stateless per-action subprocess + process-group kill keeping partial output + 4-key observation contract (doc 08); D-6 turn frames (delta/tool.start/approval/clarify/result/finished) (N-4 / doc 07).
- **E. Git and change control:** E-1 dirty-commit-before-edit then separate lint-fix commit (doc 09); E-2 commit-attribution truth table (`--attribute-*`) (doc 05 provenance); E-3 LLM commit messages from diff+conversation, Conventional Commits, weak-model-first (doc 09); E-4 continuous Markdown chat transcript + parser (NF-062/doc 14).
- **F. Lint, verification and reflection:** F-1 narrow lint to compiler-grade errors + tree-sitter excerpts (doc 09 lint); F-2 tell the model what the harness already does (doc 10 prompts); F-3 user per-language lint command + `filename:line` parsing (doc 09); F-4 evals from post-mortems + cost/latency evals (doc 16/NF-056); F-5 hostile-input read fixtures (lockfile tarpit, 600 KB line, FIFO, lying extension, Unicode names) (doc 16).
- **G. Growth, memory and skills** (hermes' core, the biggest family): G-1 post-turn background-review fork inheriting cached prefix byte-for-byte (~26% cost cut), persistence-isolated (**new capability**, candidate N-5, extends NF-010/033); G-2 editorial standard for what may be written down (part of N-5); G-3 read-before-write on self-edits + 60-char description budget (N-5); G-4 curator archive-as-maximum + pre-run snapshots + pins (N-5); G-5 `/learn` as a prompt not an engine + KB layout (doc 15 skills); G-6 untrusted-source hygiene: strip zero-width/bidi before distilling (NF-070); G-7 visible growth surface / learning graph (doc 14); G-8 eval hillclimb gates (approval freshness by content hash, frozen split, held-out-leakage check) (NF-034); G-9 benchmark ground truth computed locally + encoded stimuli (doc 16).
- **H. Model/provider layer:** H-1 declarative YAML model capabilities + `accepts_settings` negotiation (NF-044); H-2 cost accounting distinguishing cache-write/cache-hit (NF-050); H-3 config keys naming the class + `UNSET` sentinel merge (doc 07); H-4 model class owns `format_message`/`format_observation_messages` (NF-044); H-5 provider-shape repair in tiny utils, never in the loop (doc 07); H-6 provider compat as compiled data (KDL cascade, ranked resolver, ambiguity=CI failure) (NF-044); H-7 **metric contract** (Metric/Anchor/Population/Excludes) on every published number (doc 16, binding for future claims).
- **I. UX, observability, developer surface:** I-1 `--show-prompts` dump+exit (doc 14); I-2 `/tokens` per-chunk cost table with `$` + remediation (doc 14); I-3 cache versioned by extractor provenance + rebuild-then-fallback (doc 09); I-4 observability flags (`--show-repo-map`, `/settings`, local analytics) (doc 14); I-5 batch "broken or slow?" histogram + ETA + cost, Ctrl-C drains (doc 14/16); I-6 never prompt without a tty, degrade to saved `LimitsExceeded` trajectory (doc 08); I-7 self-documenting config errors (fix + doc link + escape hatch) (doc 16); I-8 onboarding OAuth-style + fuzzy `--list-models` + did-you-mean (doc 14); I-9 deterministic test model in-library with scriptable pseudo-actions (doc 16).
- **J. Benchmarks and batch operations:** J-1 standardised `preds.json` schema (doc 16); J-2 resumable batch runs + `--shuffle/--slice/--filter` (doc 16); J-3 default-deny network in agent container, proven by a container test (NF-016/023); J-4 own the benchmark manager, typed metric definitions (doc 16); J-5 analyse your own session corpus to tune your tools (NF-035).

**§3 - Register candidates (adopted by RC-15)** as NF-071…NF-075 (doc 24 §5):

| Proposed | Feature | Primary source |
|---|---|---|
| NF-071 | Managed persistent runtime: owner/worker turn frames, durable admission FIFO with `unknown`, process ownership (spawn_owned + supervisor + lint) | hermes (C-12, D-1…D-3, D-6) |
| NF-072 | Per-tool concurrency classes + parallel batch (shared default, `exclusive` opt-out, last-exclusive barrier) | omp (C-6) |
| NF-073 | Loop safety rails: sentinel exit, budget countdown, consecutive format-error cap + own exit status, charged failed turns, non-liftable wall clock | mini (C-2,C-4,C-5,B-8) |
| NF-074 | Context-cost contracts: usage-anchored output-budget fit, framing tokens, spill-to-artifact, shell-output minimisation + command interception | omp (B-6,B-7,C-7) |
| NF-075 | Growth loop v2: post-turn review fork on warm cache, editorial standard, curator archive-not-delete | hermes (G-1…G-4) |

Plus extend-only notes (no new row) folded into owners, and the six second-wave sources recorded in the A.9 addendum.

**§4 - The action queue** (ordered by value ÷ effort; RC-16(h): this queue is the execution order, V0–V7 is the coarse map, newest ratified queue wins on conflict):

1. Wire loop safety rails (NF-073). **Landed 2026-11-07** (`rails.test.ts`, 11 tests).
2. Per-tool concurrency + parallel batch (NF-072). **Landed** (ruling 14).
3. Upgrade the edit path (NF-069/052, A-1…A-5). **Landed** (ruling 16, `edit-ladder.test.ts`, 12 tests).
4. Context-cost contracts (NF-074). **Landed** (24 tests, suite 351/0 at that wave).
5. Repo-map algorithm (B-1). **Landed** (ruling 19, 13 tests, suite 364/0). *(Note: the on-disk file has a minor rendering corruption at the end of item 5 - stray literal tokens - but the content is intact.)*
6. Managed runtime (NF-071). **Landed wave 8** (ruling 22); framed owner/worker control pipe excluded; FIFO not yet wired into `loop.ts` dispatch.
7. Growth loop (NF-075). **Landed wave 11, reduced form** (ruling 27); no scheduling/loop-wiring/provider-calls/application.
8. Verification wave: hostile read fixtures, evals-from-post-mortems, H-7 metric contract, answer-isolation precondition, test-model-in-library. **Partly landed** (waves 6a/6b/7/11/13/14); remaining: same-model head-to-head benchmarks (needs keys).
9. Fold the register - **done (RC-15)**.
10. Fold the extend-notes into owners - **done (RC-15)**.
11. Record the four repos' defects as reference-repo observations. **Landed** - `observations-reference-defects-2026-11-07.md` (88 rows).

**"What not to copy" (deliberate refusals):** mini-swe-agent's "bash only, no compaction" (benchmark-right, product-wrong); hermes' 25-platform gateway / four-layer Windows identity / profile multiplexing (take contracts not adapters); aider's per-call-site `--dry-run` guards (prefer the I/O-layer guard); omp's 15,853-line `agent-session.ts` monolith (steal mechanisms, not sprawl).

**Extension guidance for the merge step:** new external steal items should be appended as new rows in §2 under the right mechanism family (A–J), each with a source citation and a disposition (NF-### / doc / new candidate), and must pass the merge test (≥2 sources OR uniquely user-noticeable) before becoming a register candidate in §3. Avoid duplicating any A-1…J-5 mechanism, any NF-071…NF-075, or any §4 queue item already listed above.

---

## Part 4 - Consolidated weaknesses, open items, residuals, known issues (all docs)

### 4.1 Top structural / release-blocking items

- **Permissions are advisory, not enforced (the load-bearing flaw).** The Rust kernel performs no effect; deps are only serde/serde_json/sha2/uuid; all writes/spawns happen in TS; no OS sandbox code exists (`external-audit-2026-11-08.md` finding 1; triage finding 2 CONFIRMED). The kernel decides and records; it cannot prevent.
- **OS-level sandbox for Code Mode and shell (NF-016) - the top open authority item.** Code Mode runs with ambient user authority (bridge-policed only); `setsid` descendants escape group kills; non-policy hardlinks rely on chain *detection*; non-Linux fallbacks weaker. Environment facts (measured 2026-11-08, `landlock-spike-2026-11-08.md`): no `bwrap`; **Landlock not available on this deployment kernel** (`4.19.0-gvisor`, raw syscall ENOSYS, no LSM list); **unprivileged user namespaces are NOT blocked** (`unshare -U/-Ur/-Urm/-Uprf` succeed; bare `unshare -p` EPERMs). Direction (ruling 38): seccomp + `no_new_privs` + rlimits + netns reduced form first; outer sandbox is confinement of record on gVisor; Landlock probe-gated.
- **Crash during tool execution bricks the session (external audit finding 2, structural).** The assistant `tool_calls` row is persisted before tools run; a kill in that window leaves an unanswered call, and resume replays it → real API HTTP 400 permanently. `core/admission.ts::recoverInterrupted` exists but is called from nowhere.
- **README over-claims vs shipped reality (external audit finding 3 + §6 table).** README §3.4 "enforced by the kernel, not prompt text", the sandbox matrix, the `Shell(git *)` + Starlark DSL, ~80 tools, multi-strategy compaction, cache-first compiler, reasoning control, checkpoints/rewind, read-before-write - all specified only / false-as-written against the shipped tree. `docs/28` is accurate; **README is the unreliable document a stranger reads first.**

### 4.2 Capability gaps (competitive + external audits)

- **No context lifecycle / compaction / usage meter (highest-impact reliability gap).** Shipped: only caps+spill + a newest-80-message trim with no summary/notice; early constraints silently vanish after ~40 turns (external audit finding 5, measured). (`competitive-viability-audit` finding 1; note `docs/28` §4 gap 12 claims a compaction v1 + `/context` landed later - the two audits disagree on timing; treat as in-flux.)
- **Product surfaces are chat-class:** no fullscreen renderer (docs/13 unbuilt), no diff-review-before-write at the time of the audit, no plan mode (later partly landed, ruling 37), no @file completion, no vim/paste, no context/cost display, originally no rewind (later wave 14c).
- **Ecosystem table stakes absent at audit time:** MCP (later wave 14 ruling 34), hooks (later wave 14 ruling 35), LSP/diagnostics loop (still open), plugins, git-workflow tools, project-memory files (later wave 13), local-model providers (later +ollama wave 14c).
- **No benchmark evidence / eval harness unwired.** `evals.ts::runEvalCase/runEvalSet` had zero callers/tests when the external audit ran (later wired wave 13/14); no published number on any board (Terminal-Bench 4.0 bar cited: Claude Code+Opus 5.5 64.85%, Codex+GPT-6 58.18%). Same-model head-to-head benchmarks remain open (needs keys).
- **Deep-repo scaling:** repo_map is lexical, rebuilt per call, 3,000-file cap (persistent cache later wave 14b).
- **Provider breadth thin:** anthropic+openai+mock (+google/+ollama wave 14c); the models.dev registry task failed on infra; `HZ_PROVIDER=groq` etc. still silently falls back to mock (CURRENT_RUN §5 item 11).

### 4.3 External-audit individual defects (`external-audit-2026-11-08.md` findings 3–16)

- Failed run exits 0 in headless mode (exit-code table divergence).
- `write` is non-atomic (`truncate(0)`), no staleness/binary guard, no undo/snapshot/rewind to recover.
- No retries / backoff / 429 handling; no prompt caching; no reasoning control.
- Tool surface is ~14% of advertised (11 vs ~80/91 named).
- Silent `glob` truncation at `MAX_SCANNED=50_000` (marker only fires at `MAX_RESULTS=300`).
- Suite changes shape with environment: 5 unguarded parity tests *fail* (not skip) without the Rust binary.
- `grep` results differ by whether ripgrep is installed (JS fallback ignores `.gitignore`).
- Env scrub misses DSN-shaped secrets (`DATABASE_URL`, `*_DSN`, `*_CREDENTIALS`, `*_PASS`).
- Spill marker overstates completeness (nested truncation: shell 30,000 B cap then 16 KiB loop cap, labelled "full output").
- No hosted CI/coverage/mutation/fuzzing; GH Actions ships as an installable payload (no `workflow` token scope).
- Timed-out command gets SIGKILL with no preceding SIGTERM; stdin-reading commands run the full 120 s.
- Dropped stream persists half an answer as a finished turn, never retried.
- File content reaches the model verbatim (no spotlighting/provenance); in-workspace writes need no approval → injected instruction can rewrite any workspace file.
- The internal competitive audit **over-claims three matrix rows** ("enforced authority I+T", "read-before-write I+T both", red-flag 2 "kernel-enforced") - the external audit contests them and the "(b) viable niche, no rewrite" verdict (its own verdict: **(c) prototype requiring architectural rework, 2.3/5**).

### 4.4 Documented residuals that remain OPEN (recorded, not implied)

From `reaudit-2026-11-08.md` §6, `triage-external-review-2026-11-07.md` §6, `docs/28` §4, CURRENT_RUN §5:
1. Code Mode / shell OS-level confinement (NF-016) - top authority item.
2. `setsid` descendants escape group kills.
3. Hardlink class outside `policy.json` relies on chain *detection*; fd verification covers write/edit only, not arbitrary code.
4. Legacy owner-less leases/grants stay globally consultable (compat path); grants/leases are in-memory (restart loses them → next check asks, fail-closed).
5. Child re-approval over the Rust stdio transport proven at kernel layer, not via a full child loop.
6. Non-Linux fallbacks documented as weaker (no `/proc` verification).
7. `write` can be raced into creating an empty file in the state dir; intermediate-component swap window on non-Linux.
8. Receipt postimage / durable transcript↔kernel bridge (receipts are post-hoc records with caller-supplied digests, issued even for read-only calls).
9. Kernel-absent posture ruled mode-honest, not fail-closed (ruling 33) - `docs/06` S6 specifies read-only + exit 3; shipped keeps full decisioning in `untrusted` mode.
10. Conversational rewind absent (SessionStore has no truncation API; `messageIndex` recorded but unused).
11. Hooks trust gate absent (workspace hooks not trust-gated - load-bearing residual, ruling 35).
12. repo_map durable CAS = mtime/size equality only; no cross-process lock on journals/checkpoints; checkpoint compaction none.
13. Growth loop: no scheduling/loop-wiring/provider-calls/application; grow proposal-library is write-only.
14. Canonical numbers: `contracts.ts`/`kernel/src/canon.rs` still describe floats as outside the v0.1 interop contract; Rust serializer not yet aligned (ruling 20 residual).
15. Standalone kernel default (no `--state-dir`) still names `~/.hzcode/kernel`; mixed-version concurrent runs can fork state paths (RC-17 residual).
16. **Typecheck is RED - 51 errors** (`bun run typecheck` added in `820dcdc`), not yet a gate; it exposed a shipped bug where `compactHistory` was called without `{limit}`, collapsing context to one message on every dispatch (fixed `820dcdc`). Real findings in the 51: `AtomicWriteOutcome.refusal` on the ok branch ×6, `Lease.owner` ×3, `write.ts:79` arity, dead `false===true` comparisons, `Stats` import from `node:fs/promises` ×2, `getReader` on `number | ReadableStream` ×5 (CURRENT_RUN §5 item 10).

### 4.5 Spec-set internal audit (`AUDIT.md`, 2026-11-06, pre-implementation)

5 real inconsistencies + 1 gap fixed (C-1 five-namespace register; C-2 15 event names → 13 reserved / 2 withdrawn; C-3 `hz.receipt.*` collision corrected; C-4 14 reserved capability IDs; C-5 `hz.db` vs `hzcode.db` path; C-6 scheduler DST). Verdict: no blockers as a design baseline; the only missing thing is implementation evidence.

### 4.6 Reference-repo defects (explicitly NOT HorizonCode's)

`observations-reference-defects-2026-11-07.md` (88 cited rows, `no action` dispositions): aider's duplicated repo-map capture (~1.41× weight inflation), DeepSeek/Anthropic cache-cost arithmetic errors, `cur_tokens` double count, disabled tool-call coders, PDF-as-image mislabel; mini-swe-agent's three v1-leftover doc/fixture breaks; hermes' shallow-clone limitation; oh-my-pi's unstated metric contract + unasserted answer isolation.

---

## Part 5 - Rules of engagement / conventions any future change must obey

### 5.1 From `_conventions.md`

- **Names are law.** Every doc MUST use the names in `_conventions.md`; a new name MUST be added here in the same change (the one exception: feature flags live in `docs/07` §4.1.5, RC-9). Product `HorizonCode`; binary `hzcode` (`hz`,`horizon`); kernel `hz-kernel`/`hzk`; config `.hz/` (legacy `.hzcode/` honoured in place, RC-17); resource URIs `hz://`; TS scope `@horizoncode/*`; Rust crates `hz_*`; `HZ_ABI=1`,`HZ_PROTO=1`.
- **The five `hz.` namespaces are never confusable; only namespace 1 is an event.** Events (past tense) · protocol methods (imperative) · observability names (OTel) · digest domains (`hz.<record>.v1`) · storage keys/manifest fields. A name in §6 is an event and MUST NOT also be a method. **44 canonical events** (any doc claiming a different count is stale).
- Capability IDs are stable; aliases never change effect class. Reserved + INTERNAL blocks MUST NOT cross any surface and are promoted only in the change that first implements them (RC-11). Effect classes: read-only · workspace-write · network · process · credential · remote · external-effect.
- Every wire/durable schema is `<Name>V<major>`; TS and Rust types are generated by `hz_codegen`, never hand-edited in two places.
- **Status ladder is mandatory on every capability**; a doc MUST NOT claim a level above its evidence; unknown is `UNKNOWN`, never an implied success (§8).
- Writing rules (§10): absolute file paths in every citation; cite derivation as `source: <repo> <path>`; prefer tables/numbered rules; name real functions/files, `[planned]` if not yet existing; no marketing language.
- **RC-1…RC-17 are binding on every document.** Key ones for code: RC-5 exit codes owned by `docs/14` §3.2; RC-7 one effect-terminal enum (`succeeded|failed|denied|cancelled|unknown|budget_exhausted|timeout|interrupted`), `UNKNOWN` never a synonym for failure; RC-8 cache-guard pins need `--update-golden` + rationale; RC-13 `docs/28` is the only owner of implementation levels; RC-14 document classes + authority-by-concern; RC-16 the eight cross-document conflict resolutions (per-effect leases; `HZ_*` is the only wire error vocab; closed lowercase reason codes; sha256 session-log chain; `synchronous=FULL` default; `docs/12` §4.1 owns layout + two-level CAS shards; `DurableEventV1` envelope + `evt_`/`apr_`/`bat_` + `approvalId`; `docs/30` §4 is execution order); RC-17 canonical `.hz/state/...` + `~/.config/horizon/`, legacy `.hzcode/` honoured in place forever, one resolver `app/src/core/paths.ts`.

### 5.2 From `CURRENT_RUN.md` §7 "Rules of engagement (non-negotiable)"

1. **`app/src/contracts.ts` is law.** Changes are design decisions - document them (docs + `_conventions.md`) before code. Recent contract additions were strictly additive (`Tool.concurrencyClass`; `RunBudget`/`RunExit`+`RuntimeOptions.budget`; `sessionId` on lease-mint/guard-check; `guard.grant`). Rust↔TS interop byte-for-byte.
2. **"Verified" means you ran it and saw the result.** Agent reports are evidence candidates, never proof.
3. **Parallel work: one writer per file**; fence `tools/index.ts` and `core/loop.ts` to the integrator.
4. **Commit style:** concise imperative subject; body = what/why; **never force-push; never touch git identity; never commit `.hz/`, `.hzcode/`, `node_modules/`, `kernel/target/`.**
5. **Chat-first is the product charter:** no subcommand menus; flags are optional conveniences; headless is for scripts/tests only.
6. **Update `docs/28` in the same commit** as any code that changes a status or count.

### 5.3 Environment facts to trust (CURRENT_RUN §6)

- **bun is NOT on PATH** - always `/home/forge/.bun/bin/bun` (v1.4.4); `bin/hzcode` handles it. cargo on PATH (1.99.1); kernel binary `kernel/target/release/hz-kernel`.
- **git push:** https credential helper; identity auto-set - never override. **The token has NO `workflow` scope** → never commit under `.github/workflows/`; ship workflows as payloads + installers (`ops/install-ci.sh`).
- Runtime state under `<workspace>/.hz/state/` (legacy `.hzcode/` kept in place, RC-17); all state files 0600 / dirs 0700; gitignored. Kernel state dir structurally protected.
- Keyed anchors via `HZ_ANCHOR_KEY` (hex ≥32 chars) → HMAC; `HZ_ACCEPT_LEGACY_ANCHORS=1` migrates on next append.
- Sandbox env: no `bwrap`; unprivileged userns NOT blocked; Landlock NOT available (gVisor, ruling 38).
- Guard defaults: fs.read/write inside workspace = **allow**; outside = ask; shell.exec/net.fetch/spawn = ask; precedence `deny > held lease > grant > ask > allow`; headless approvals auto-deny; `always` = a session grant that mints a fresh one-use lease per covered effect (a lease admits exactly one effect, ruling 32).
- Reference clones live at a local directory outside this repo (the original path is omitted; re-clone from the URLs in [upstream-pins.md](upstream-pins.md)) - **OUTSIDE** this repo (`.gitignore` blocks a copy appearing inside).
- Sub-agents can die mid-run (provider infra errors): use clean single-escape JSON prompts, one task list per call, treat deaths as normal.
- Typecheck `bun run typecheck` exists since `820dcdc` but is **RED (51 errors)** and not yet a gate.

### 5.4 Verification commands (the honest baseline to reproduce)

```
cd app && /home/forge/.bun/bin/bun test      # full TS suite (892/0/75 at latest wave)
bash ops/gates.sh                            # 6 real CI gates (~13 s), exit 0
cd kernel && cargo test                      # 9 unit + up to 35 integration
kernel/target/release/hz-kernel --selftest   # SELFTEST OK (18 checks)
printf 'list files' | ./bin/hzcode           # headless e2e: answer → tool card → receipt
```

---

## Appendix - Document inventory (sizes, as read)

docs/ 00–30 + `_conventions.md` (25 files, ~2.0 MB; largest: 24 feature-catalog 199k, 09 tools 185k, 05 schemas 179k, 11 authority 172k). docs/audit/ top-level: README, audit-forgecode/horizoncode reports, 5 delta reports, competitive-viability-2026-11-08, external-audit-2026-11-08, landlock-spike, observations-reference-defects, reaudit-2026-11-08, triage-external-review. docs/audit/pass2 (15 pass-2 reports incl. truncated/empty honesty artifacts), pass3 (4 adoption-wave dives), pass4 (3 line-by-line reaudits, 222 findings), pass5 (1 repo-wide audit). Root: README.md, AUDIT.md, CURRENT_RUN.md.

*End of baseline report.*
