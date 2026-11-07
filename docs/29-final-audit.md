# 29 — Final Audit: twelve-repo completeness, optimization analysis, and the docs-staleness reconciliation

> **What this document is.** The audit of record (RC-13) for the twelve reference clones under `/data/home/forge/repo-tour/`, plus the final pass over the spec set itself: every doc checked for stale claims, the sixteen insertions queued by `26-learning-synthesis-2.md` §5 carried **in full** in Part D, and a cross-analysis of where to optimise further (speed, capabilities, accuracy).
>
> **Status rules.** Parts A–C record facts read from the clones and analysis derived from them — no implementation claim is made here; implementation levels live in `28-implementation-status.md` (RC-13). Part D records the queued insertions in full; they were folded into their owner documents by the 2026-11-07 adoption revision (RC-15). Part E lists the staleness fixes applied in this audit. Nothing in this audit touched implementation code.

---

## 0. Method and inventory

Snapshot: 2026-11-06 ~18:20 UTC. Twelve repositories, **67,083 files** total:

| Repo | Files | Size | Earlier report(s) |
|---|---|---|---|
| `opencode` | 11,377 | 323 MB | `/tmp/opencode-report.part1-3.md` (46 KB; **part4 empty — undercovered**) |
| `DeepSeek-Reasonix` | 10,918 | 123 MB | `/tmp/DeepSeek-Reasonix-report.md` (38 KB) |
| `oh-my-pi` | 10,321 | 297 MB | `/tmp/oh-my-pi-report.md` (36 KB) |
| `codex` | 10,113 | 127 MB | `/tmp/codex-report.md` (39 KB), `/tmp/deep-codemode-report.md` (33 KB) |
| `horizoncode` (ancestor) | 7,675 | 254 MB | **none dedicated** — its `HANDOFF.md` is cited as the ancestor source in docs 01/03/24/25 |
| `grok-build` | 4,516 | 101 MB | `/tmp/grok-build-report.md` (66 KB), `/tmp/grok-report.md` (5.7 KB, partial) |
| `opencode-v2` | 4,509 | 82 MB | `/tmp/deep-opencode-v2-report.md` (41 KB) |
| `OpenHands` | 2,860 | 41 MB | `/tmp/deep-openhands-report.md` (26 KB) |
| `claude-code` | 2,193 | 46 MB | `/tmp/claude-code-report.md` (102 KB) |
| `wshobson-agents` | 1,200 | 15 MB | `/tmp/deep-wshobson-report.md` (105 KB) |
| `forgecode` | 965 | 9.5 MB | **none** |
| `SWE-agent` | 436 | 65 MB | `/tmp/deep-sweagent-aci-report.md` (37 KB) |

**Evidence basis.** ~15 deep reports (~460 KB, path-cited) from the two earlier passes, **all now preserved in-repo under `docs/audit/pass2/`** (5,115 lines; includes the two known-truncated reports and the empty `opencode-report.part4.md`, kept as honest artifacts); two of them were re-read verbatim in this audit because they are Part D's rule-text sources (`docs/audit/pass2/deep-codemode-report.md`, `docs/audit/pass2/deep-sweagent-aci-report.md`); six delta agents were dispatched (one per repo cluster; IDs in §A.1) to find what every earlier pass missed. Two coverage gaps were identified by the inventory itself: **`forgecode` and `horizoncode` had no dedicated report**, and `opencode`'s report series was truncated (part4 empty) — both closed by §A.1.

---

## Part A — Coverage verdicts

| Repo | Verdict | Basis |
|---|---|---|
| SWE-agent | **COMPLETE (this audit)** | Report re-read in full; every device in it maps to NF-052 or a Part D rule; the "90 %" claim was evaluated against the code and is *conditional* (no such claim exists in the repo — the numbers are caps: 100 lines, overlap 2, 100-file/100-line aborts, 16,000 chars/response, 100,000 chars/observation). |
| codex (code-mode family) | **COMPLETE (this audit)** | `deep-codemode-report.md` re-read in full; CM-1…CM-14 in Part D §09 are its verbatim rules; the codex heap-cap reset gap is captured as CM-14's test. |
| opencode-v2 | Covered | 41 KB report; merged into NF-051/058/059/060/061 and Part D §05/07/10/11/12/14. |
| wshobson-agents | Covered | 105 KB report; P1–P10/A1–A10 merged into Part D §15 and the bundled-15 roster (docs 27). |
| OpenHands | Covered | 26 KB report with an explicit scope caveat (client checkout); A1–A12 merged into Part D §07/08/10/12/14/15. |
| claude-code, grok-build, DeepSeek-Reasonix, oh-my-pi, opencode | **Delta pass delivered** | Original full-tour reports exist; the delta re-checked for missed feature-bearing files (opencode the priority — its old series was truncated). Results: §A.1 clusters 3–5; no residual gap. |
| forgecode | **NO REPORT — largest coverage gap** | Full first-pass dive dispatched this audit (965 files). Result: §A.1. |
| horizoncode (ancestor) | **NO DEDICATED REPORT — second gap** | Full first-pass dive dispatched this audit (7,675 files; ancestor statuses throughout docs 03/25 are derived from its `HANDOFF.md`). Result: §A.1. |

### A.1 Delta-pass results (this audit's six coverage agents)

| Cluster | Repos | Dispatched | Result |
|---|---|---|---|
| 1 | forgecode (first full report) | `conversation://e151f255-3835-4c60-959c-0d72ea2a1129` | **Delivered** — `docs/audit/audit-forgecode-report.md` (348 lines; 191 dirs / 936 files walked, ~85 opened). **16 uniques**, 20 common-pattern rows, 15 docs-worthy names, 20 optimisation adoptions. Headline: `allow/deny/confirm` policy DSL over read/write/execute/fetch with `all/any/not`; three-stage patch fallback ladder (exact → fuzzy → text-patch) + post-write syntax validation; hook-enforced stop guards (doom-loop `[A,A,A]`/cyclic at threshold 3; pending-todo loop re-open); snapshot `undo`; agents-as-tools with resumable `session_id`; behavioural evals asserting on the outgoing provider request; deterministic non-LLM compaction preserving the last reasoning block; MCP trust gate keyed by config content hash; ZSH-first UX. |
| 2 | horizoncode (first full report) | `conversation://07df833c-fc35-403d-9f8a-8c0b166254cf` | **Delivered** — `docs/audit/audit-horizoncode-report.md` (846 lines; all 7,675 files enumerated, ~45 read in full incl. `prompt.ts` 3,006 lines). **28 uniques.** As the ancestor whose HANDOFF seeded docs 01/03/24/25, almost all 28 are *already homes in our corpus* (Guard/receipts → NF-001; UNKNOWN terminal → RC-7; guarantee vectors → NF-016; HarnessProfile → NF-020 family; ContextLedger → NF-005 accounting; OwnerLog → ADR-004 log). Residuals folded into NF-063 (checkpoint restore) and NF-070 (output redaction). |
| 3 | opencode + opencode-v2 (delta) | `conversation://0fea8cc7-957c-46c7-969e-b593887f8195` | **Delivered** — `docs/audit/audit-opencode-delta.md` (377 lines; 15,845 files / 1,612 dirs listed, ~120 opened; prior reports cited only 41 files total — the part4 gap is now closed). **27 missed features** (B1–B27), **25 uniques**, 35 docs-worthy, 21 optimisations. Highlights: TUI plugin host (11 slots, routes), shell permission scanner, generated shell-arity dictionary, bounded goal loops, cache-TTL session warming (`interval:auto` = 90 % of ttl), staged undo/redo, gitignore-aware snapshot pruning, tightening-only org policy. Three real v2 defects recorded (skill catalog cannot refresh on version bump; synthesized allow outranks a broader user deny; directory boundary is opt-in per tool). |
| 4 | claude-code + codex (delta) | `conversation://08cdd421-08d9-4c41-a056-2070fef910ee` | **Delivered** — `docs/audit/audit-claude-codex-delta.md` (500 lines; full walks of 2,193 / 10,113 files). **26 missed** (C-1…C-8, X-1…X-18). Highlights: 27-event hook taxonomy × 4 handler types incl. HTTP hooks with allowlists, asyncRewake, agentic-verifier hooks; ~90-key managed-settings schema; fail-closed bash/powershell AST with node allowlist; `/btw` cache-sharing forks; codex guardian/auto-review (29 modules, SQLite evidence boards, 90 s budget); Starlark exec policy with load-time `match`/`not_match` self-tests; 220 feature flags. Two stale-manifest defects recorded (imported-but-undeclared sandbox-runtime; SDK re-exports missing from tree). |
| 5 | grok-build + DeepSeek-Reasonix + oh-my-pi (delta) | `conversation://339dab52-496d-4cdd-b4b7-eff02e917276` | **Delivered** — `docs/audit/audit-grok-ds-ompi-delta.md` (524 lines). **131 file-cited deltas** (25 / 60 / 46). DeepSeek-Reasonix confirmed an agent harness, not a model repo: session inbox/steer, peer mail, projection-debt freshness, surface answers, workspace-lease write authority, golden system prompt + four-line metric contract, per-PR release notes. grok-build: XOR-encrypted prompt templates, 45 PTY scenarios, 3-layer `.sbpl` profiles, changelogs corpus. oh-my-pi: 279-file prompt corpus, 245-rule KDL compat cascade, local MLX inference (`tiny/`), `/ratchet` eval hillclimb, `ovnfs`, `thread` RPC subagents. |
| 6 | OpenHands + SWE-agent + wshobson (delta) | `conversation://ecc76215-7218-47c1-ab9e-a48f315c94a7` | **Delivered** — `docs/audit/audit-oh-swe-wsh-delta.md` (810 lines; ~85 of 100 SWE `.py` read in full, all 202 wshobson agents extracted). **42 file-cited blocks** (22 / 8 / 12, ~150 findings). SWE-agent: in-band control tokens, autosubmit ladder, best-of-N with re-budgeting, variance-penalised scoring, 7-stage history pipeline, web-browser ACI, trajectory inspector. wshobson: ship-mate FSM with human gates, live team runtime + message protocol, published-weight scoring with drift snapshots. OpenHands: verify-openhands harness (feature map, evidence ledger, `xfail`/`xpass`), `request_secret` client tool, canvas attention contract. |

*(Delivery note: all six delivered on the first dispatch; their reports are preserved in `docs/audit/` — they were written to `/tmp` first, which is not durable. Each report carries its own coverage stats and explicit NOT-READ list; several large files (horizoncode `host_kernel.rs`, 48,214 lines) are interface-level, not line-verified, as their reports state.)*

**Totals across the six delta passes: 270 missing/unique findings** (16 + 28 + 27 + 26 + 131 + 42), each file-cited in its report; §B.1 classifies them and lands the eight register appends (NF-063…NF-070).

---

## Part B — Merged-common vs unique ledger (this audit)

**Merge rule (unchanged since the first pass):** a capability that ≥2 independent sources implement is *common* → it belongs in an existing NF row or a Part D rule, never a new NF. A capability only one source has, that a user of HorizonCode would notice missing, is *unique* → it appends to the NF registry (doc 24 Section B) via a normal catalog change.

**Findings of this audit's verbatim re-reads (the two reports that produced Part D):**

| Source device | Classification | Disposition |
|---|---|---|
| Code-mode subset scan, per-call hooks, dual-output results, cell lifecycle, lease amplification ceiling (opencode + codex) | common (two implementations) | NF-051 + CM-1…CM-14 (Part D §09) |
| ACI window/goto/cursor, summary search, lint-revert edit, narrated empties, recovery hints, env-tamed shell (SWE-agent) | unique-but-general | NF-052 + R-read-window-1…4, R-edit-window-1/2, R-edit-lint-1, R-grep-summary-1, R-tools-56/57 (Part D §09) |
| Kanban/queue composer UX (user brief), preview environments (OpenHands `runtime_services` + practice), governance loop (SWE-agent `review_on_submit_m`), recorders (rr/TTD practice) | unique | NF-055/062/053/054 (already in doc 24) |
| Spec-corpus governance: authority table, statuses, generated references, "no checklists in specs" (v2 + wshobson) | common (design practice) | Part D §00 RC-13 + Part D §16 gates |

**No uncaptured unique feature was found in the two verbatim re-reads** — every device in them already owns an NF row or a Part D rule. The six delta passes (§A.1) found 270 further items; §B.1 is their classification.

### B.1 The delta results: merged, appended, queued

**(a) Already merged — no action.** The largest block by count. The horizoncode ancestor's 28 uniques land almost entirely on existing homes (Guard → NF-001, UNKNOWN → RC-7, guarantee vectors → NF-016, profiles → NF-020, ledger → NF-005, OwnerLog → ADR-004) — expected, since docs 01/03/24/25 were derived from it. The reference repos' remaining findings are common patterns already reflected in Section A rows or Part D rules: resume-by-id subagents (NF-007/NF-019 rows), MCP trust, plan-mode-as-tools, conditional tool advertisement (R-tools family), auto-compaction, sandbox worktrees, provider transformer chains, conventional-commit generation, and the LSP/DAP lanes. Where two or more sources implement a device, it found an existing home, not a new one — the merge rule applied to ~180 rows.

**(b) Appended — eight new register rows (the unique residual).** Each is genuinely user-noticeable, absent from the corpus, and sourced by ≥2 independent references where the sources were merged:

| New row | Merged sources | What lands in doc 24 |
|---|---|---|
| **NF-063** Workspace checkpoints and staged undo/redo | forgecode snapshot `undo`; opencode staged undo/redo + gitignore-aware pruning; horizoncode guard-admitted checkpoint restore | "restore is a guarded effect, never direct writes" + two-phase staging + pruning rules |
| **NF-064** Pre-approval review (guardian), narrowing-only | codex `approvals_reviewer`/`auto_review` + guardian evidence boards + managed human checkpoints; SWE-agent's submit-time review as the sibling | reviewer may deny, never approve (keeps D-8); trust boundary + anti-over-flag calibration in the prompt; 90 s budget with fallback |
| **NF-065** Shell command classification for policy | claude-code fail-closed bash/powershell AST; opencode shell scanner + arity dictionary; codex Starlark execpolicy with load-time self-tests | structure-not-strings (ADR-015 applied to shell); un-analyzable ⇒ route to human; per-subcommand rules; rule files carry `match`/`not_match` self-tests |
| **NF-066** Lifecycle hook taxonomy and stop guards | claude-code 27 events × 4 handler types (HTTP allowlists, asyncRewake, agentic-verifier); forgecode 6 events + End-hook loop re-open | hook events as declared effects (no ambient authority); doom-loop + pending-todo + stall guards as composable policies |
| **NF-067** Bounded autonomous goal loops | codex goal (budget, no-progress, 3-turn blocked, completion audit); opencode bounded goal loops (50 rounds, 3 stalls, orphan→paused) | objective persists across compaction; caps; process identity respected |
| **NF-068** Side-question forks with cache sharing | claude-code `/btw` + CacheSafeParams; codex `/side` | no tools, reuses captured cache material, cannot derail the main transcript |
| **NF-069** Tool-argument repair and self-healing edit ladders | forgecode json_repair + 3-stage patch ladder + post-write validation; opencode 9-class tool-input repair; SWE-agent encoding-fallback ladder | unambiguous-only repairs, recorded; fuzzy edit with structured refusal; diagnostics fed back |
| **NF-070** Tool-output secret redaction | horizoncode tool-batch pattern redaction; oh-my-pi secret placeholders; OpenHands `request_secret` channel | runtime invariant at the projection boundary; machine value unchanged (NF-061) |

All eight are now written into `24-feature-catalog.md` §5 (NF-063…NF-070, status `DESIGNED`), counted in §6.3 (70 features), tested in §12.2 (tests 55–62), and indexed in `25-roadmap-and-glossary.md` §4.2a.

**(c) Queued — Section-A-level rows, deliberately not dumped.** The ~270 findings contain dozens of reference *devices* (per-model prompt plugins, event-feed backpressure variants, judge/chart tooling, KDL compat cascades, PTY scenario suites, prompt-encryption, artifacts/voice/forms/mDNS/pairing surfaces, PTY hand-off, embedded web UI, changelog corpora, per-PR release notes, eval hillclimbs, answer isolation, golden-prompt tests, feature-flag lifecycles…). They are catalogued **with file citations in the six reports** and queued for the next catalog revision, because each wants either a Section A row (with disposition + recount) or an explicit non-goal — work that needs per-row review, not a bulk paste. Nothing is lost: the reports are in-repo.

**(d) Recorded upstream defects (not ours).** opencode-v2 skill catalogs cannot refresh on version bump; a synthesized allow can outrank a broader user deny; the directory boundary is opt-in per tool. claude-code imports `@anthropic-ai/sandbox-runtime` absent from its manifest, and re-exports five SDK type modules that do not exist in its tree. DeepSeek-Reasonix's `ISOLATION_*` docs describe a package absent from the snapshot while the Studio frontend still ships its refusal strings, and its benchmark README says "six harnesses" over 15 suites. These are observations about the reference repos, recorded here so no later reader mistakes them for our properties.

---

## Part C — Optimization analysis (speed · capabilities · accuracy)

Derived from the full corpus; every item cites its source device and the doc that should record it. These are **analysis recommendations**, not status claims.

### C.1 Speed & cost

| # | Lever | Evidence | Where it lands |
|---|---|---|---|
| C-1 | **Cache-prefix discipline is the single largest cost lever.** Byte-stable prefix + tail-appending compaction + `toolChoice:"none"` final step keeps provider prompt caching intact across turns; the two cache-breaking devices found in the wild (`last_n_observations` elision, mid-session tool-definition mutation) are explicitly prohibited. | v2 `tools.md`; SWE-agent's own docstring admits its elision breaks caching | Part D §10; NF-061 |
| C-2 | **Encode-once event feed** replaces per-connection encoding (553.9 ms → 12.4 ms at 50 subscribers, measured in v2's benchmark) with per-connection dropping queues (capacity 4,096). Our resumable backpressure policy stays (T9). | v2 `event-stream-architecture.md` | Part D §07; NF-060 |
| C-3 | **Code-mode cells yield instead of kill** (`exec/wait/terminate`, 10 s default yield + 1 s grace): hot program state survives turns; a 100-step run stops re-paying parse/plan cost. | codex `service.rs` | Part D §09 CM-13; NF-051 |
| C-4 | **ACI windowing bounds per-result bytes** (≤ ~4 KB/window turn) and summary search bounds per-search bytes (~3 KB for a 100-file search vs ~120 KB of matches) — bought with turns, which are cheaper than dumps at long horizons. | SWE-agent arithmetic (report §7) | Part D §09; NF-052 |
| C-5 | **Speculative decoding + KV reuse** for local engines turns a local model from a latency toy into a usable routing target. | NF-057 practice | docs 07/16 |
| C-6 | **Subagent fleet economics**: base-seven tool subset, own context capsule, digest-addressed handoffs (`adopt_ref`) — delegation without context inflation. | wshobson A8; our NF-007 | docs 08/15 |

### C.2 Capabilities

| # | Lever | Note |
|---|---|---|
| C-7 | The NF-051…062 range is the capability increment of this cycle; NF-055 (preview) and NF-051 (code mode) already have reduced v1 slices (`28-implementation-status.md`). |
| C-8 | **Profile contracts** (P1–P10) make subagents capability-first: allowlist-as-role, tier-by-blast-radius, typed output with escalation ladder, declared refusals, partition fan-out, one-writer-per-file, relay profiles. Bundled 15 roster in docs 27. | Part D §15 |
| C-9 | **Policy statements** (NF-058) add user-authority precedence without widening: safety-inverted order, allow-never-grants, enforcement protection. | Part D §11 |
| C-10 | **Preview + ACI + recorder + governance** close the "vibe loop", long-file archaeology, post-mortem debugging, and pre-submit review — the four capabilities users notice missing in competitors. | Part D §09/§14; NF-052/053/054/055 |

### C.3 Accuracy & honesty

| # | Lever | Note |
|---|---|---|
| C-11 | **Structural pairing + narration**: action↔observation made unrepresentable when unpaired; empty outputs narrated; truncation always names the recovery move. Silence and dangling results are the two most common model-confusing states. | Part D §05/§09 |
| C-12 | **View/log separation everywhere**: forgotten-sets, instruction epochs, sync preambles — a view is reconstructable from the log at any time; the log keeps everything. | Part D §10/§12; T3 |
| C-13 | **Fail-closed retention**: oversized results retained or the execution fails — never lossy success. | NF-061; Part D §05 |
| C-14 | **Tier parity measured, not asserted**: paired evals with a release-blocking ratchet (NF-056) + the honest framing of the ACI claim. | docs 10/16/25 |

### C.4 Delta-pass additions (from the six reports' §5 lists)

The delta reports each closed with an optimisation list; the strongest new levers not already in C.1–C.3:

| # | Lever | Evidence | Target |
|---|---|---|---|
| C-15 | **Repair-then-retry tool arguments** — bounded JSON-repair + schema coercion before rejecting a turn, repairs recorded. | forgecode `forge_json_repair` (11 test suites); opencode 9-class repair | NF-069 |
| C-16 | **Post-write validation feedback** — syntax/diagnostics of the postimage evaluated and fed back in the tool result. | forgecode validation service; SWE-agent lint gate | NF-069 |
| C-17 | **Deterministic compaction + reasoning preservation** — fold tool history into structured summaries (no LLM pass), re-inject the last reasoning block for signature validity. | forgecode `compact.rs` | doc 10 (ladder additions) |
| C-18 | **Cache-split system prompt with justification** — a named global cacheable prefix + dynamic suffix boundary, and a forced written reason for any section that breaks the cache (`DANGEROUS_uncachedSystemPromptSection`). | claude-code `prompts.ts`, `systemPromptSections.ts` | NF-005 / doc 10 |
| C-19 | **Speculative permission classifier** — start classification during pre-tool hooks; consume later. | claude-code `bashClassifier.ts` | doc 11 (speed note) |
| C-20 | **Session warming per provider cache TTL** — keep-alive ≤30 min, `interval:auto` = 90 % of `cache.ttl`. | opencode `warming.mdx` | doc 07/16 |
| C-21 | **Elision before summarisation, at cache-stable boundaries** — drop stale windows/search/images with explicit counts (`(N lines omitted)`), moving the boundary only every `polling` steps. | SWE-agent 7-stage pipeline | doc 10 |
| C-22 | **Memoize hot-path scans** — bash-AST parse memo per command; arity prefix memo; tool-registry resolution memo per (session, provider, model, agent, digest); skill-scan cache by mtime. | claude-code, opencode, horizoncode §5.1 | doc 08 perf notes |
| C-23 | **Best-of-N with variance-penalised scoring** — reject out-of-range scores, tie-break on fewest API calls, choose only among submitted runs. | SWE-agent `reviewer.py` | doc 16 (eval protocol) |
| C-24 | **Human labels before trusting a judge; disjoint categories; re-drive the baseline before calling a regression.** | oh-swe-wsh §5 accuracy list | doc 16 / NF-056 |
| C-25 | **Golden-prompt tests + prompt token budgets in CI** — pin the assembled system prompt byte-for-byte per audience, commit measured budgets, fail on growth. | Reasonix golden `system_prompt.txt` + `schema_budget.json`; oh-my-pi `tool-prompt-usage.ts` | doc 16 gates |
| C-26 | **Anti-over-flag calibration in reviewer prompts** — negative examples (“outside-workspace paths are not automatically high risk”; urgency never changes authorization). | codex guardian policy template | NF-064 |
| C-27 | **Answer isolation for benchmarks** — refuse to run answer-bearing tasks without an OS read sandbox for the child. | Reasonix `answer_isolation.go` | doc 16 |

---

## Part D — The sixteen queued insertions, in full

Sources: `26-learning-synthesis-2.md` §5 (the queue), §2 (the distilled facts) and the verbatim reports where they carry draft rule text (`docs/audit/pass2/deep-codemode-report.md` §5.2 for CM rules; `docs/audit/pass2/deep-sweagent-aci-report.md` §6 for ACI rules). Rule IDs are final; owning documents adopt this text at their next revision (RC-13).

**Adoption status (2026-11-07):** all sixteen insertions are folded into their owner documents (RC-15); this Part remains the historical verbatim copy of the queue. **One ID remap at adoption:** the rendering/state-line rules (queued here as `R-tools-56`/`R-tools-57`) collided with doc 09's existing `R-tools-56`; doc 09 adopts them as **`R-tools-57`** (rendering) and **`R-tools-58`** (state line). Every other ID was adopted verbatim.

### D-05 → `05-domain-and-schemas.md`

**1. `ToolResultV1` dual output** (NF-061). Every tool result carries three independently-typed projections of one execution: `machineOutput` (schema-validated, ephemeral, visible to code mode), `content` (durable, model-facing; MUST be non-empty when `machineOutput` is absent), and `metadata` (compact UI JSON, bounded independently — never an unbounded side-channel). **Retention is fail-closed:** a payload too large for managed storage makes the call **fail operationally**; it is never published as a lossy success. Domain output does not change according to model-output bounding policy (bounding happens at the projection, not the record).

**2. `InstructionsStateV1` — value deltas.** Instruction sources are stored as content-addressed blobs; sessions observe `hz.session.instructions.updated {delta, text?}` where "removed" is absence, never a tombstone; an **instruction epoch spans completed compactions**; a fork adopts the parent's newest instruction values as its baseline. Clients display *changed keys*, not privileged prose.

**3. Action↔observation pairing invariant.** A tool observation with no corresponding call, and a call with no observation, are **invalid states** and fail closed: every `hz.part` observation MUST reference its `step.tool.requested` call id; a drained-but-unpaired call is failed at drain start, never replayed, never silently dropped.

### D-06 → `06-events-and-flows.md`

**1. Precedence:** profile-ceiling ∧ task-override — a task-level override entry point may narrow or re-target *within* the profile ceiling, is honoured only at the declared entry points, and is recorded in the admission event; an override that would exceed the ceiling is refused, not clamped silently.

**2. NF-053 flows:** the governed plan FSM (Plan → Propose → Await verification → enforce linting; violation ⇒ roll back and re-plan) as a named flow, with the pre-submit review gate (re-run repro, remove repro artifacts, restore test files, then re-submit) and its deliberately-audited force path.

### D-07 → `07-apis-and-contracts.md`

**1. Stream framing (NF-060):** one session stream carries three frame classes — `sync` (declares `from_seq`/`through_seq` **before** replay), `durable {seq, …}` (seq = log index; persisted), `transient` (no seq; never persisted; liveness only). Unknown frame types MUST be ignored (the envelope is allowed to grow).

**2. Strict pagination:** a paginated read MUST surface "unsupported" as unsupported — never degrade to an empty page; a partial history must never be mistakable for exhaustion.

**3. Feed laws (NF-060):** encode-once, per-connection dropping queues (capacity 4,096), overflow terminates only that connection (`SubscriberOverflow`), encoding failure fails connected queues but keeps the feed available for later connections; **transport errors are not session errors**.

### D-08 → `08-runtime.md`

**1. Step-allowance accounting:** promoting new input resets the agent's step allowance; a steer batch resets it **once**; queued next-turn prompts reset it at turn start.

**2. Control-item delivery boundaries:** compaction and move are inbox items; a later steer **MUST NOT** cross an undelivered control item (ordering is by `enqueued_seq`, never wall clock).

**3. `runtime_services` URL injection (NF-055):** the backend's actual bound URLs are forwarded into new sessions as a system-context suffix "so agents use correct URLs instead of guessing ports"; the injection is recorded on the session, and the URL is data, never authority.

**4. Recorder as a runtime service (NF-054):** failed verification runs may request a recorded trace; the trace is an artifact (digest-referenced), passed to the model; capture availability is a lane-health fact.

**5. Override-precedence enforcement point:** the single place task overrides are applied is named, and it is the only place (boundary test).

### D-09 → `09-tools.md`

**1. ACI reading-mode rules (NF-052) — verbatim:**

- **R-read-window-1.** `read` MUST accept `cursor: 'open' | 'next' | 'prev'` in addition to `path`/`startLine`/`endLine`. When `cursor` is present, the window is `readWindowLines` (default 100) long and the step is `readWindowLines - readOverlapLines` (default overlap 2), positioned within the file's bounds. The result MUST include `view: {path, firstLine, lastLine, totalLines, moreAbove, moreBelow}` and MUST render the top/bottom cut as `(N more lines above)` / `(N more lines below)` when non-zero.
- **R-read-window-2.** `read` MUST accept `gotoLine: number`, positioning the window so the line sits `floor(readWindowLines / 6)` lines below the window's first line; `gotoLine` on a symbol name MUST be resolved by the symbol index and reported as `resolvedVia: 'symbol'`.
- **R-read-window-3.** The session MUST retain the last window per path as session state (`view.cursor`), refreshed from observed `read`/`edit`/`insert` effects and never from model-authored text. `cursor: 'open'` re-renders that stored window; a stale cursor (path removed) MUST fail with `NotFound`, not silently re-open at line 1.
- **R-read-window-4.** A windowed `read` of a file longer than `readWindowLines` is the default when `path` is given without a range. A full-file read requires `full: true`, is capped by R-tools-42, and MUST report `truncated` with an artifact pointer.
- **R-edit-window-1.** When the session holds a window for the edited path, `edit` MUST resolve `oldString` **within that window**; a unique match elsewhere MUST NOT be applied and the call MUST fail with `detail.matchesOutsideWindow: [line…]` plus a `recoveryHint: "read the file at those lines first"`.
- **R-edit-window-2.** When `oldString` occurs more than once inside the window and `replaceAll=false`, `edit` MUST fail with `AmbiguousMatch` naming every match line in `detail.matches[]`.
- **R-edit-lint-1.** When a syntax check is available for the file's language, `edit`/`insert` MUST evaluate the postimage before writing. If the postimage introduces diagnostics absent from the preimage, the call MUST fail with `category: 'syntax-break'`, MUST leave the file byte-identical, and MUST return both the would-be postimage window and the current window in `detail`.
- **R-grep-summary-1.** `grep` MUST support `mode: 'summary'` returning `files: [{path, matchCount}]` and no match text. Above `grepSummaryMaxFiles` (default 100) it MUST return `truncated{reason: 'count'}` and a `recoveryHint` telling the model to narrow the pattern or scope, and MUST return no file list.
- **R-tools-56 (rendering).** Every model-facing result that reports an empty payload MUST render an explicit sentence (e.g. "the command succeeded and produced no output") instead of an empty block; every `truncated` result MUST carry a `recoveryHint` naming at least one cheaper follow-up call (`read` range, `grep -n`, `outline`, redirect-to-file).
- **R-tools-57 (state line).** The model-facing step tail MUST project an environment-derived state line (`openFile`, window range, `cwd`), produced by a state command and refreshed from observed effects. It MUST NOT be part of the byte-stable prefix, MUST NOT be model-authorable, and MUST NOT be counted as evidence for `verify`.

**2. Phase-2 `aci.*` group** (admitted only under a preset so the default tool prefix does not grow): `aci.open` (files.read, parallel-safe), `aci.goto` (line or symbol), `aci.scroll` (direction, pages), `aci.find` (summary|matches), `aci.insert` (files.patch, kernel lease). Cursor movement is session state (`lease: session`), never a kernel lease and never a tool argument. Prompt fragment + tests as drafted in the report §6 (cursor math, cursor persistence, outside-window refusal, lint-revert, summary cap at 101 files, recovery hints, narrated empty, state-not-model-authorable).

**3. Env-taming defaults:** the shell environment MUST default `PAGER=cat`, `MANPAGER=cat`, `GIT_PAGER=cat`, `LESS=-R`, `TQDM_DISABLE=1`, `PIP_PROGRESS_BAR=off`, and the interactive-command blocklist (`vim`, `less`, `tail -f`, bare `python`, …) applies unless explicitly overridden.

**4. Code-mode invariants (NF-051) — CM-1…CM-14, verbatim from the decision report:**

| # | Rule |
|---|---|
| CM-1 | The callable surface inside the snippet is exactly the declared subset ∩ `visibleTools(session)` ∩ the step's registry snapshot; nothing else resolves. |
| CM-2 | Subset enforcement is **static and total**: dynamic access (`tools[name]`), aliasing `tools`, and computed property calls are rejected by the scanner. |
| CM-3 | Every nested call re-enters the ordinary pipeline: resolve → Guard → durable prepare → its own one-use lease → execute → settle → receipt. The snippet never sees a lease, receipt id, or host object. |
| CM-4 | The outer `ask` shows the declared subset only, and covers exactly "run a confined program with this subset". Loops cannot widen it. |
| CM-5 | Amplification is bounded before the first inner call: `maxToolCalls` (default finite), per-inner-call budget, per-step lease ceiling, and the outer timeout. |
| CM-6 | Timing out or terminating the cell **never** reports a dispatched mutation as failed-safe: every inner call ends in a terminal state, `UNKNOWN` when the transport died after dispatch, and the step reconciles. |
| CM-7 | The result's audit table carries, per call: `toolId`, `toolCallId`, `leaseId`, `receiptId?`, terminal state, `ms`. Read-only calls emit no effect-claiming receipt. |
| CM-8 | Confinement is declared as a guarantee vector with typed residuals, and the operation fails closed when the host cannot meet the caller's minimum (`SandboxUnavailable`). |
| CM-9 | The snippet's engine has no ambient I/O: no filesystem, network, process, `WebAssembly`, shared memory, dynamic codegen of host bindings; imports resolve only to declared globals. |
| CM-10 | Discovery inside the snippet is a pipeline call (`search(...)` lowers to `tool_search`), admitted, counted, paginated, respecting `admitTools`/visibility. |
| CM-11 | Snippet state (`store`/`load`) is JSON-only, session-scoped, snapshotted per exec, and never authority. |
| CM-12 | Snippet output is untrusted data: bounded, truncated with an in-band marker, never re-parsed as tool ids/receipt ids/decisions, never a completion claim. |
| CM-13 | Default posture is one-shot with a bounded wall clock **plus** an explicit cell mode (`exec|wait|terminate`, `cellId`), session-scoped and receipted; no cell survives session termination. |
| CM-14 | Resource caps (heap/wall/call-count/output) are settable per session and actually enforced (no "plumbed but reset to none" gap). |

**5. Dual-output result rendering** (NF-061): the model sees `content`; the UI sees `metadata`; code mode sees `machineOutput` (ephemeral). Retention failure ⇒ operational failure (§D-05).

**6. Cancellation taxonomy:** "effect interruption is the cancellation mechanism" — tools MUST NOT translate interruption or defects into model-visible failures; broad catch-around-execute is invalid because it consumes interruption and defects. Terminal vocabulary is RC-7's single enum.

**7. Reserved tool name `execute` and name normalization:** `execute` is reserved (code-mode call surface); tool names normalize unsupported characters to `_` at declaration load.

### D-10 → `10-cognition.md`

**1. Instruction epochs (NF-059):** content-addressed instruction blobs; `hz.session.instructions.updated {delta, text?}` value deltas; an epoch spans completed compactions; forks adopt newest values as baseline (§D-05.2).

**2. Compaction ladder:** `keep_first` (preserve opening framing), `minimum_progress` (anti-thrash: a compaction that does not reduce the projected context below the trigger is not repeated automatically), and the **bounded hard-reset ladder** (`hard_context_reset_max_retries` × `hard_context_reset_context_scaling`), each rung with a named recovery move; the second overflow after one rebuild is terminal.

**3. `toolChoice: "none"` final step:** the final call of a step retains the tool definitions with `toolChoice:"none"` instead of stripping them, so the cached prefix survives.

**4. Tail-append compaction:** summaries append at the tail; the byte-stable prefix is never rewritten by compaction.

### D-11 → `11-authority-safety.md`

**Policy statements (NF-058)** — `{effect: allow|deny, action, resource}` with wildcards:

1. **Safety-inverted precedence:** ordinary settings read forward; **policy documents read reversed** so user-global beats repository; organization-managed statements append last — "an organization deny cannot be lifted by a repository or user allow".
2. **Allow-never-grants:** an allow statement never overrides a session/agent denial and never grants a saved approval; a deny overrides "Allow always".
3. **Keep-last-snapshot:** a failed config/credential refresh keeps the last good policy snapshot (dropping it would open, not close, enforcement).
4. **Enforcement protection:** plugins cannot add/remove/override policy; a plugin `remove` ignores policy/enforcement modules regardless of selector.
5. **Decider-named denials:** "Blocked by ⟨scope⟩'s policy"; policy-denied skills are absent from every load path; denied MCP servers never open a connection.
6. Unknown actions are skipped preserving order; malformed supported statements remain errors.

### D-12 → `12-sessions-state.md`

1. **Provisional→durable retirement:** streaming slots live in a separate collection from durable events so a provisional id can never dedupe the real message away; `item_started` carries the id the durable event will have.
2. **Forgotten-set view reconstruction:** condensation removes events from the *view* (`forgotten_event_ids`), never from the log; any view is reconstructable from the log at any time.
3. **Sync preamble:** a log subscription declares `from_seq/through_seq` **before** replay; the watermark is emitted as one sync marker; live-only deltas are intentionally absent from replay.
4. **Runtime-identity cache keys:** projection caches key on runtime identity, not path alone.
5. **Placement/fencing (first-class):** id-bound values outlive an execution site; service acquisition is lazy; movement must not pin events to the old place — "local execution remains process-owned until clustering introduces an explicit placement and fencing protocol" (explicit deferral recorded as good practice).

### D-14 → `14-surfaces.md`

1. **Compaction UX metrics:** before/after/saved tokens, manual compaction CTA, busy-guard disabling — with the baseline captured **before** the request (the condense POST can only return after the server emitted its event).
2. **Bulk review (NF-062):** Keep All / Undo All over per-hunk review, both receipted (`files.patch` under the review lease).
3. **Preview surface (NF-055):** the bound preview URL is displayed per session; opening/refreshing is a surface action, never authority.

### D-15 → `15-extensibility.md`

**Profile contract additions (wshobson P1–P10):** every profile declares `resultSchema` (typed output; `kind=verify` MUST be three-valued + typed findings), `requiresInputs[]`, `refusesWhen[]` (evaluated before budget reservation; structured `precondition_unmet`), `partitionBy` (sibling nodes with one profile MUST carry distinct partition keys), `ownsPaths` (kernel refuses cross-session writes to an owned path), and a prompt skeleton (Mission / Invariants / Protocol / Inputs / Output contract / Never). Capability presets compose downward only: `observe ⊂ execute ⊂ mutate`, plus `coordinate`/`verify`/`publish`; `kind=relay` is a single-tool profile; tier policy maps kind → model tier (verify/plan → strongest; act → mid; research → cheapest unless `requiresReasoning`). Canonical id + revision + digest per profile, with `@provenance`. **Bundling decision: 15 profiles, one per capability class** — plugins may add profiles only by narrowing; "python-expert" is a skill over `worker`, not a 20th agent.

### D-16 → `16-operations.md`

1. **Prompt-vs-grant lint:** a profile whose prompt mentions an effect absent from its ceiling fails the build.
2. **Generated-reference drift:** model-facing references (tool catalogs, command docs) are **generated** from the declarations; CI gates drift.
3. **Mutation-tested gates:** gate definitions are themselves tested (a gate that cannot fail is a bug).
4. **`.hz`-cannot-supply-authority test:** workspace-supplied configuration can never encode an authority grant (narrowing only, mechanically asserted).

### D-00 → `00-index.md` and `_conventions.md`

**Document classes + authority-by-concern:** each document declares its class — **contract** (schemas, protocol — normative), **decision record** (ADRs, rulings — binding on design), or **historical** (learning records, plans, audits — no normative force) — and the authority-by-concern table names which document owns which kind of truth: names/status (conventions), wire/durable shapes (05/07 + generated protocol), authority semantics (11), runtime semantics (08/12), implementation levels (28, RC-13), audit record (29). Rejected options are kept with their trade-offs. Applied in this audit as RC-13 plus the status-note reconciliation (Part E).

### D-24A → `24-feature-catalog.md` Section A — parity rows for the three new sources

| New source | Parity row (one line each) |
|---|---|
| SWE-agent (ACI) | **Inherit+Supersede** — bounded read windows with orientation, summary search with a narrowing abort, window-scoped edit with repair hints, lint-gated edit that reverts, append-only insert, narrated empties, recovery hints, environment-derived state line (NF-052; doc 09). |
| OpenHands (Agent Canvas) | **Inherit** — durable/transient frame classes + sync preamble + strict pagination + evented condensation views (NF-060, NF-059; docs 07/10/12/14). |
| wshobson/agents | **Supersede** — the subagent corpus's engineered minority distilled into profile contracts and a bundled-15 roster; the 202-agent sprawl is *rejected* as the failure mode (docs 15/27). |

---

## Part E — Docs staleness ledger (applied in this audit)

Every fix below was applied in this audit; docs-only. "Checked clean" means the search pass found no falsified claim.

| Doc | Stale item found | Fix applied |
|---|---|---|
| `00-index.md` | Status line "Phase 0 — the design"; "Nothing in this set is above DESIGNED"; missing docs 28/29 rows | Status line now says V1 implemented; ceiling paragraph replaced by the RC-13 pointer to docs 28; rows for 28/29 added; "RC-1…RC-13" (widened to "RC-1…RC-15" and the document-classes note RC-14 by the 2026-11-07 adoption revision) |
| `03-hld.md` | "Nothing in this repository is built" blanket claim | Dated status note; sentence marked historical |
| `04-lld.md` | "Nothing below is built" status block | Dated status note (built subset is far smaller than this doc's scope; statuses that moved are in docs 28) |
| `05-domain` | "no implementation of HorizonCode exists yet" (perf targets) | Rephrased: targets unmeasured against the now-existing subset; measurement work item recorded |
| `06-events` | "repository contains no implementation" | Dated status note naming the implemented flow shapes |
| `07-apis` | "no implementation exists yet" (budgets) | Dated status note (NDJSON protocol + adapters exist; HTTP/SSE/ACP/MCP still design) |
| `08-runtime` | "no implementation exists in this tree" | Dated status note (v0.1 loop slice named; rest remains design) |
| `09-tools` | Status line + "Nothing here is CODE_PRESENT…" | Dated status notes (ten v0.1 tools tested; rest design); dangling README reference removed |
| `10-cognition` | "Every capability below is DESIGNED — no implementation" | Dated status note (provider layer implemented/tested; compiler/memory/compaction remain design) |
| `11-authority` | "no implementation exists" | Dated status note (guard/leases/receipts have a v0.1 slice; sandbox/Starlark/THS remain design) |
| `16-operations` | "`hzcode` and `hzk` do not exist yet" + a quote from a README section that no longer exists | Dated status note (bin/hzcode + hz-kernel exist; v0.1 kernel is not the designed `hzk` asset) |
| `24-feature-catalog` | "No row may be upgraded…" without the pointer; Section-13 status table saying "no implementation" | Dated status notes; Section B row now names the v1 slices (NF-051/NF-055) carried in docs 28 |
| `25-roadmap` | "No phase has been entered"; index NF range "…NF-050"; the §10 note calling 00-index stale (itself stale — OQ-R1 closed); §9 row citing the old ceiling | Dated status note; **§4.2a added** (NF-051…062 index; ranges and counts later widened to NF-075 by the 2026-11-07 adoption revision); counts corrected to 62 at this audit; OQ-R1 marked closed; §9 row points at docs 28; related-docs rows for 28/29 added |
| `26-learning-synthesis-2` | §5 queue with no status | Dated note: staleness reconciled; the sixteen insertions were carried in **Part D of this document**, then folded into their owner documents by the 2026-11-07 adoption revision (RC-15); the ledger is closed. |
| `_conventions` | No rule for the post-implementation status split | **RC-13 added** (single owner for implementation status; Part D role; this file as audit of record); RC-14 (document classes) and RC-15 (adoption wave) added by the 2026-11-07 adoption revision |
| `README`, `CURRENT_RUN` | No pointer to the audit | Pointers added |
| `01`, `02`, `12`, `13`, `14`, `15`, `27`, `28` | none found | Checked clean (status-claim search + targeted reads); docs 12–15 are Part D adopters, not stale |

---

## Part F — Open items

1. ~~Six delta reports~~ **RESOLVED** — all six delivered; reports preserved at `docs/audit/` (index: `docs/audit/README.md`); results in §A.1 / §B.1.
2. ~~`forgecode` and `horizoncode` full reports~~ **RESOLVED** — both are the anchors of this pass (§A.1 clusters 1–2); every reference repo now has dedicated in-repo coverage.
3. ~~`opencode` report series (part4 empty)~~ **RESOLVED** — cluster 3 re-covered both checkouts in full; the delta report supersedes the truncated series.
4. **Section-A-level rows from the ~270 findings are queued, not dropped** — §B.1(c); each wants a disposition + recount in the next catalog revision. The file-cited queue is the six reports themselves.
5. **Coverage caveats stand as written** — every report carries its own NOT-READ list (in particular, horizoncode `host_kernel.rs` at 48,214 lines is interface-level, not line-verified); no claim in this audit exceeds what a cited read supports.
6. **Upstream defects are recorded, not ours to fix** — §B.1(d); they belong to the reference repos.

---

## Part G — Re-audit (verification round)

A second pass the same day, verifying the audit rather than re-reading the clones. Every row was produced by a command run in this round; docs-only, implementation untouched.

| Check | Method | Result |
|---|---|---|
| Code claims | Full suites re-run | **285 TS pass / 0 fail** (1,413 expect calls, 27 files); **17 Rust pass** (3 unit + 14 integration) — matches docs 28/README exactly. |
| Clone inventory | `find` recount of all twelve clones | **67,083 files** — identical to §0. |
| Report durability | `wc -l` on the six in-repo delta reports | 348 / 846 / 377 / 500 / 524 / 810 = 3,405 lines — complete copies. |
| Register integrity | NF-id extraction + duplicate check | 70 ids, NF-001…NF-070, **no duplicates or skips** (R5). |
| Recount gate | Mechanical authority-impact count | **46 `none` + 3 `narrows` + 12 `grant-bearing` + 9 `kernel` = 70** — matches §6.3; the first count attempt missed four rows that bold their value (`**none**`) and the discrepancy was resolved against the file, not the table. |
| docs/25 index | Row count in §4.2a | 20 rows (NF-051…NF-070), exactly as indexed. |
| Stale-number sweep | Corpus-wide grep for superseded counts/ranges | One true staleness found and fixed: doc 24 §6.4 "117 rows and 62 features" → **70 features**. All other `NF-062`/62 hits are legitimate historical references (doc 13 R197, doc 26 ledger, doc 00's description of doc 26). |
| Pass-2 durability | Copy of the fifteen earlier reports into `docs/audit/pass2/` | Preserved (5,115 lines); the two known-truncated originals and the empty part4 are kept exactly as found — the defects are part of why the delta passes exist. |

**Residual findings: two — one fixed, one explained; none open.** The re-audit changes no §B.1 classification and no NF row.

---

## Related documents

- `28-implementation-status.md` — implementation levels (the single source of truth; RC-13)
- `26-learning-synthesis-2.md` — the learning record whose §5 queue this audit carries in Part D
- `27-implementation-plan.md` — the build plan for the NF range this audit verifies the sourcing of
- `audit/` — the six delta reports of this audit and the fifteen pass-2 reports (historical class; the evidence this audit cites)
- `audit/pass3/` and `30-steal-list.md` — the follow-on four-repo dives (aider, mini-swe-agent, hermes-agent, oh-my-pi) and their consolidated adoption queue
- `AUDIT.md` — the first design-corpus audit (historical)
