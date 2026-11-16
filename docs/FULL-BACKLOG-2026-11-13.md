# Full backlog — consolidated register (2026-11-13)

> ## One file for agents
>
> **Open this file only** for queue + P0 order + verification. Build/commands: [`33-handoff.md`](33-handoff.md). `repo_take/` rules: [`AGENT-DOC-NAVIGATION.md`](AGENT-DOC-NAVIGATION.md). **Goal: NOT COMPLETE.** LICENSE **deferred** — not queued.
>
> `HANDOFF-BACKLOG-2026-11-13.md` and `BACKLOG.md` are **redirects** (do not maintain a third copy).

### What this file is **not**

| Not here | Read instead |
|---|---|
| Repo / module map | [`33-handoff.md`](33-handoff.md) **§1** (`app/`, `kernel/`, key files) |
| HLD / trust planes | [`03-hld.md`](03-hld.md) |
| LLD / modules & signatures | [`04-lld.md`](04-lld.md) (design target; verify vs code) |
| Schemas `*V1` | [`05-domain-and-schemas.md`](05-domain-and-schemas.md) + [`app/src/contracts.ts`](../app/src/contracts.ts) |
| APIs / kernel protocol | [`07-apis-and-contracts.md`](07-apis-and-contracts.md) + `kernel/src/protocol.rs` |
| Loop / tool logic | [`08-runtime.md`](08-runtime.md), [`09-tools.md`](09-tools.md) + `loop.ts` |
| What is **actually shipped** | [`28-implementation-status.md`](28-implementation-status.md) §3 (through **510**, status rulings) |
| Designed superset (may exceed code) | [`31-design-summary.md`](31-design-summary.md) |

**Onboarding order (new agent):** [`../AGENTS.md`](../AGENTS.md) (start here) → FULL-BACKLOG (§Z) → `33-handoff` §1 → `contracts.ts` → `28` §3 → code. **Docs may lag code** — update docs when you implement backlog rows.

---


## 0. Tree state (read first)

| Fact | Evidence |
|---|---|
| Branch | Branch `audit-remediation` at `ddc8ef8`; rulings **343–510** are committed. Confirm `git status` for local edits; no merge or release implied |
| Research | `repo_take/little-coder` @ `89d4fa0…`, `repo_take/aider` @ `5dc9490…` (gitignored) |
| Never claim | Shell-net **`enforced`** |
| WSL caveat | `kernel/tests/sandbox_exec.rs` may fail without CAP/Landlock |
| First action | `git status` / `git diff --stat` |

**Owner commit (2026-11-13):** when you say **commit** → one commit (docs + implementation), not docs-only.

---

## Z. What to implement first (P0 order)

1. EffectHost: **343–348** strict facades, reduced edit parity and direct Rust OwnerLog; **349** adds transport-refusal finality, trusted-kernel R170 Bun guard preflight, preimage pins and *early refusal* of nonatomic multi-op apply_patch. **OPEN:** universal kernel guard-authorize+execute, missing entrypoints, true atomic multi-op fs.batch, complete merge/fuzz, historic replay. **350** adds latest-state file replay (not historical snapshots or shell effects). **351** adds live Guard `allow` inside the same kernel OwnerLog lock and launch-time workspace binding for direct kernel mutations only; **352** adds a private controlling-parent credential for kernel lease/grant/allowlist and caller-receipt minting, refuses privileged fallback after trusted loss and in strict untrusted mode; it does NOT authenticate human approval or remove ambient Bun effects.
2. R170: **344** opt-in TS latch; **348** default-on Rust direct-effect OwnerLog / cross-process flock; **349** versioned durable executing marker + *provable prepare-only crash release*, not general UNKNOWN release, and trusted-guard preflight. **OPEN:** universal atomic Bun/TS admission, executing UNKNOWN recovery and resource alias races, full docs/13.
3. Egress: product netns path without `enforced`  
4. Wave 0: R172 verify + hz.* honesty  
5. Then §7 OPEN rows (§C) by family; Wave E after spine moves  

Rulings ladder: [`28-implementation-status.md`](28-implementation-status.md) §3. Wave honesty: [`GOAL-PROGRESS.md`](GOAL-PROGRESS.md).

---

## Summary counts

| Source | OPEN | DONE | REJECTED | SKIP | TOTAL |
|---|---:|---:|---:|---:|---:|
| §7 steal rows (`30` §2) | **39** | 30 | 2 | 1 | **72** |
| §8 repo-take #1–18 | 16 | 0 | 0 | 1 | 18 |
| forge T-1–T-20 | 1 | 19 | 0 | 0 | 20 |
| second-wave §5 partial lines | 186 (index §V) | — | — | — | — |

---

## A. P0 prototype trust spine (done bars not met)

| # | Area | Still open | Done bar | Docs / code |
|---:|---|---|---|---|
| 1 | Full EffectHost | **343–350** direct execution, OwnerLog, transport refusal and latest-file observe; **351** verifies a Rust Guard `allow` under OwnerLog for direct file effects and output-only shell, checks both rename endpoints, and binds product-launched workspace. Raw kernel `guard.lease` minting still untrusted as human proof; all Bun/other entrypoints, full fs.batch/edit parity and universal ownership OPEN | Kernel owns or refuses every effect, full independent observe, `=require` kernel edit parity | `effect-host-runtime.ts`, `effect-reconcile-attach.ts`, `index.ts` |
| 2 | Postimage / Rust observe | **348** direct receipt/result observe; **349** double-read preimage; **350** latest-file-state replay; **356** archives new direct-file postimages in 64-MiB bounded SHA-256 CAS with independent verification of *superseded* versions, fail-closed UNKNOWN on archive failure. Legacy overwritten bytes, absent-path reconstruction, shell/network/process/ambient and nested effect observation remain OPEN | Rust observes every effect class; complete historical replay tested | `effect_host.rs`, `effect_history.rs`, `receipt-postimage.ts`; `audit/p0-eight-requirements-2026-11-14.md` |
| 3 | Full R170 | **344/348/349** TS latch, kernel OS lock and narrow no-execute recovery; **351** Guard decision executes under the direct kernel OS lock, with hashed evidence for both rename permits. Bun/hook/MCP/extension cross-process atomic fencing, authenticated authorization principals, executed UNKNOWN recovery and alias races OPEN | Kernel-owned mandatory barrier and independent execute/observe settlement | `13-tui.md`, `effect-reconcile-block.ts`, `effect-reconcile-latch-store.ts` |
| 4 | MITM / routed egress | **315–341** probe prototypes; **348** rejects unconfined raw kernel arbitrary shell and adds `ops/usernetns-direct-tcp-denial-smoke.sh` (disposable user+net namespace TCP denial only). Product shell/proxy/TLS E2E and default routing OPEN | Product netns E2E; never `enforced` | `egress-*.ts`, `kernel/` |

## B. Wave 0 spine residuals

| Item | Open work | Rulings |
|---|---|---|
| RC-18 `hz.*` | **50/50** shipped rows mapped; **44/44** canonical names; **32** literal `hz.*` emitters; **0** canonical without emitters (**439**–**454**) | **174b**, **358**–**416**, **432**–**434**, **439**–**454** |
| R172 | **350** RC-7 owner-terminal subset; **357** verifies nested parent/child event hashes/anchors; **360** indexes child receipt links from one verified snapshot and marks legacy v1 IDs unbound; **361** adds backward-compatible v2 hashes covering effect/postimage/child sidecars across Rust/TS; **456** nested receipt-graph replay (depth/cycle budgets) from one verified snapshot into inspector + `session verify`; **478** nested child event-stream replay (depth/cycle budgets) from a verified parent event read into inspector + `session verify`. Full authenticated receipt issuer, `parentReceiptId` terminal/parent-child contracts and keyed cross-process attestation still OPEN | **284**, **289**, **292**, **322**, **350**, **357**, **360**, **361**, **456**, **478** |
| kernel fs.edit | **345/347** reduced unique indented/trim/anchored repair; **349** optional SHA-256 preimage pin before prepare and immediately before kernel edit, without external CAS. General merge/fuzz, full line patch and universal strict routing remain OPEN | **335–339**, **345**, **347**, **349** |
| apply_patch | **349** prevents partial kernel writes; **353** supports a single-file exact multi-hunk Update reduced to ONE preimage-pinned atomic Rust `fs.write`. Multi-file, rename/mixed-operation and ambiguous/fuzzy unsupported plans still refuse before mutation without fs.batch. General kernel patch parity and Bun fuzz under strict mode OPEN | **306**, **313**, **323**, **349**, **353** |
| **338** hydrate / owner | **343** reload, **348** direct Rust flock/duplicate/UNKNOWN, **349** v2 no-execute recovery + trusted Bun guard preflight; **351** Guard policy admission now under Rust owner lock for direct effects, not Bun/SQLite. Universal transactional session fencing and executed-UNKNOWN release OPEN | **338**, **343**, **348**, **349**, **351** |
| Batches 1–9 topic branch | **343–510** committed on `audit-remediation`; batches 10+ landed as rulings **485–510**. Verify commits/PR explicitly; no merge or release implied | §0 above |

### B.1 Queued (not formal §7 yet)

| ID | Item | Pointer |
|---|---|---|
| **E-5** | aider `watch.py` ai!/ai? | `30` §0.1.1 |
| **LC-*** | little-coder TAKE pack | §J + `research/steal-little-coder-aider.md` |

## C. §7 OPEN rows only (execute these)

| ID | Title | Status (from `30-steal-list.md` §2) |
|---|---|---|
| **B-2** | Per-message relevance budget that expands when no files are in context + 3-step map fallback ladder | **partial — TESTED** (ruling **191**): repo-map budget doubles when `focus` is absent and the focus→repo→plain ladder is wired; residual: derive "no files in context" from the conversation, not just the `focus` tool argument. |
| **B-4** | Cache layout as an explicit invariant (stable slabs first, 3 breakpoints, `cacheable_messages()` largest-prefix computat | **partial — TESTED** (rulings **200**, **222**, **223**, **246** stub, **276**, **277** wire default `cacheableBlocksCutIndex` when `HZ_ANTHROPIC_CACHE_BREAKPOINTS=1`; `HZ_ANTHROPIC_CACHE_SYSTEM=1` +  |
| **B-5** | Frozen fingerprinted prefix + append-only log; `syncMessages` truncates to longest byte-stable prefix on rewrite; per-pr | **done** (rulings **27**, **470**, **482**, **489**): frozen sha256 `StablePrefix` (system+tools), full `AppendOnlyLog` with drift rebuild, and a per-provider `auto` gate from committed local capabilities. Residual notes in 489 are empirical (measured KV-cache) rather than missing mechanisms. |
| **B-7** | Structural read summaries + line/byte caps with spill-to-artifact; shell minimiser default-on | **partial** (rulings **18**, **499**): structural read summaries for ts/js/py/md/json with line/byte caps and spill-to-file; residual: spill is `<state>/spills/<sha256>.txt`, not an `hz://artifact/...` pointer. |
| **C-5** | Check budgets **before** the call; `0 = unlimited` uniformly; separate non-liftable wall-clock limit; global lock-guarde | **partial** (rulings **15**, **508**): the lock-guarded `SpendLedger` reserve/settle rail is wired and the batch engine reuses it; residual: `runBatchCli` does not construct a batch-wide workspace ledger (per-row runtimes use scratch workspaces). |
| **C-7** | Auto-background long commands (default on, 60 s threshold) racing a steering signal | **partial — TESTED** (rulings **191**, **490**): the auto-background↔steer race is closed with a live-pid notice; residual: the real Responses `response.steer` WebSocket wire (C-9). |
| **C-8** | Re-execute an unpaired tool-call tail before the next model call (pairing invariant preserved) | **partial — TESTED** (ruling **364**: `HZ_REEXECUTE_UNPAIRED_TOOL_TAIL=1`; default UNKNOWN repair unchanged) |
| **C-9** | Live steering into the in-flight stream; refusal path for image-bearing messages | **partial — TESTED** (rulings **172**, **369**, **373**, **415**, **426**, **457**): mid-stream cut + serve interject + live-steer channel + OpenAI assembly-cancel; images refused; **OPEN**: real Responses `response.steer` WebSocket wire |
| **C-10** | Loop guards as one prompt file per failure class, emitted in a `<system-interrupt reason>` wrapper | **partial — TESTED** (rulings **201**, **217**, **372**, **458**, **481**: `tool-call-loop` + `consecutive-mistakes` + `action-stationarity` + `format-errors` + `context-overflow` system-interrupt nudges; other failure classes open); ruling **491** |
| **C-11** | Thinking effort routed by cheap difficulty judgment; auto ceiling one tier below max; explicit `ultrathink` to reach the | **partial — TESTED** (rulings **199**, **216**, **464**: `ultrathink` + `HZ_THINKING_EFFORT`; default-on cheap heuristic when unset clamped to one tier below max; `HZ_THINKING_AUTO=0` opts out; calibrated probs / live judge still open); ruling **493** |
| **C-12** | Owner/worker split: per-turn worker over a framed pipe with identity handshake before any work is reserved; closed versi | **partial — TESTED** (rulings **22**, **471**, **492**): framed control-pipe protocol with a publish step and FIFO reserve gate; residual: real owner↔worker OS pipe, ancestor-chain proving and product spawn wiring. |
| **C-13** | Durable per-session admission FIFO with `unknown` as a first-class state that halts followers | **partial — TESTED** (rulings **22**, **359**, **363**: FIFO + `Runtime.send` + `loop.ts` executeTool refusal; NOT atomic R170) |
| **D-3** | Boot-relative process births surviving NTP steps and VM resume; spawn ledger with quarantine-on-corruption | **partial — TESTED** (rulings **22**, **473**: pid+`/proc` start ticks + spawn-ledger quarantine; boot-id tokens `boot:<bootId>:<pid>@<startTicks>` when `/proc/stat` btime available; macOS/Windows + monotonic sleep-wake re-anchor still open) |
| **D-5** | Stateless per-action subprocess execution (fresh process per step); kill the whole process group on timeout keeping part | **partial** (shell runs in a detached process group killed on timeout with partial output kept (CURRENT_RUN tools row); a fresh process per step is the default for `shell`; the uniform 4-key observati |
| **D-6** | Turn frames (`delta`/`tool.start`/`approval`/`clarify`/`result`/`finished`), not filesystem diffs - the structural sourc | **partial** (ruling **492**): six `session.frame` kinds are emitted additively; residual: approval/clarify are projected from notice prefixes, not dedicated RuntimeEvents; worker-pipe publication is open. |
| **E-1** | Dirty-commit-before-edit, then a separate commit for lint fixes (independently revertible units) | **partial — TESTED** (rulings **191**, **460**, **479**, **496**): dirty checkpoint wired to edit/write/apply_patch (opt-in) and lint-fix commit on all three; residual: default-on is an owner policy decision. |
| **E-2** | Commit attribution as a configurable, documented truth table (`--attribute-*`); env-scoped implementation | **done** (rulings **202**, **497**): documented five-cell env/CLI truth table for coauthor / signed-off-by / reviewed-by with CLI precedence and conflict notices; the reduced `--attribute-*` path is byte-identical. |
| **E-3** | LLM commit messages from diff **plus conversation context**, Conventional Commits, weak-model-first with token-limit fal | **done** (rulings **459**, **475**, **480**, **498**): capped conversation excerpt + staged diff, Conventional Commits normalization, packaged default weak-model map with `HZ_WEAK_MODEL` override and token-limit fallback. |
| **E-4** | Continuous Markdown chat transcript + parser (resume, post-mortem, support at ~zero cost) | **TESTED + VERIFIED** (rulings **80**, **467**, **476**, **485**: `/export` on demand; default-on continuous append under `<state>/transcripts/` (0600 file / 0700 dir, `HZ_MARKDOWN_TRANSCRIPT=0` opt-out); `parseMarkdownTranscript` + `resumeMessagesFromMarkdownTranscript`; `hzcode --restore [path]` → `RuntimeOptions.restoreFromTranscript` → SessionStore seed, fail-closed on missing/corrupt; per-event `appendMarkdownTranscriptEvent` via the central onEvent tap with a cursor shared with `syncMarkdownTranscript`; round-trip parse + resume verified) |
| **F-1** | Narrow the lint signal to compiler-grade errors; render failures as marked tree-sitter excerpts | **partial — TESTED** (rulings **204**, **462**, **486**: errors-only LSP + marked line-context excerpts with best-effort structural (balanced-delimiter/dedent) windows; grammar-aware tree-sitter ERROR-node windows still OPEN and owner-blocked by the zero-runtime-dependency rule; user lint commands via **210**) |
| **F-2** | Tell the model what the harness already does for it (pre-commit lint list) | **done** (ruling **191**): `.pre-commit-config.yaml` hook ids are rendered into the main system prompt via `harnessAutomationSection`. |
| **F-3** | User-supplied per-language lint command with catch-all fallback and `filename:line` parsing | **done** (rulings **210**, **462**, **486**): user lint commands, deterministic last-wins catch-all with an ambiguity diagnostic, shell-inert `{file}`, and Windows/ANSI/multi-finding `path:line` parsing with a 200 cap. Grammar-aware tree-sitter excerpts are F-1's clause and remain open there. |
| **F-4** | Evals built from post-mortems; evals that measure cost/latency, not just pass/fail | **TESTED (reduced)** (rulings **28**, **487**): post-mortem-derived cases with answer isolation; per-case wall-clock + USD cost with explicit source, opt-in `max_wall_ms`/`max_cost_usd` thresholds, suite gates and `--metrics-out`. **Still OPEN (not full):** live-provider cost capture through `makeRuntimeExecutor` and invoice reconciliation. |
| **G-1** | Post-turn background-review fork inheriting the parent's cached prefix byte-for-byte (~26 % measured cost cut), persiste | **PARTIAL (reduced)** (rulings **27**, **488**: runnable review fork with byte-identical prefix-parity refusal, closed read-only tool subset and `origin: review-fork` attribution; `SpendLedger` reservation before dispatch; opt-in `HZ_REVIEW_FORK=1` + `HZ_SPEND_LIMIT_USD` post-turn wiring; proposals via curator rows only, ADR-010. Still OPEN: detached/fire-and-forget scheduling, live cost capture, explicit CLI trigger) |
| **G-4** | Curator: archive-as-maximum (never delete) + pre-run snapshots + pins | **partial** (ruling **500**): frozen append-only archive with pre-run snapshots and pins; residual: in-memory only — not persisted or auto-invoked by `curate`. |
| **G-5** | `/learn` as a prompt, not an engine; knowledge-base layout (lean index + per-chapter references), read one unit at a tim | **done** (ruling **198**): `/learn` reads `<state>/learn/index.json`, lists chapter ids with `seeAlso`, and returns one chapter body at a time (12k cap); prompt material only, no engine/graph by design. |
| **G-6** | Untrusted-source hygiene: strip zero-width/bidi characters before distilling (Trojan-Source vector) | **done** (rulings **55**, **66**, **501**): invisible/bidi format controls are stripped at both distill boundaries (curator + review), with shell-side refusal and completion masking already shipped; ANSI/homoglyphs are out of scope. |
| **G-7** | Visible growth surface (learning graph render) | **partial — TESTED** (rulings **199**, **502**): bounded expanded graph with labelled edges and `/graph expanded`; residual: a whole-agent Hermes graph beyond curator/proposal data. |
| **G-8** | Eval hillclimb gates in the host (approval freshness by content hash, frozen split, held-out-leakage check) | **partial — TESTED** (rulings **204**, **463**, **465**, **503**): frozen-split keep/revert rounds with an append-only decision log; residual: on-disk variant gate wiring in the eval runner. |
| **G-9** | Benchmark ground truth computed locally; stimuli encode so paraphrase cannot help; every trial derived from an index | **partial — TESTED** (rulings **211**, **510**): index-derived stimuli + local grading + contracted numbers; residual: full if-bench corpus and a product runner (`buildIndexedEvalCases` has test-only callers). |
| **H-1** | Model capability/settings as declarative YAML with user overrides + `accepts_settings` negotiation (unsupported param =  | **partial — TESTED** (rulings PR #4 catalog seam + **472**: `accepts_settings` strips unsupported `reasoning_effort` with notice; declarative YAML / user override layers still open) |
| **H-2** | Cost accounting distinguishing cache-write/cache-hit with provider multipliers | **partial — TESTED** (rulings **191**, **455**: `Usage.cache*InputTokens` + `usage-cost.ts`; `hz.usage.recorded` carries harness `costMicroUsd`/`currency`/`priceTableRevision`; OpenAI/Anthropic adapters parse when present; loop notice; **OPEN**: live billing truth) |
| **H-3** | Config keys naming the class (short name or import path); `UNSET` sentinel merge for layered config | **partial — TESTED** (rulings **198** + **484**: `CONFIG_UNSET` + `mergeConfigFileLayers`; closed `providerClass`/`modelClass` short-name→module map + documented import-path resolve; product module load / more keys still open) |
| **H-4** | Model class owns `format_message`/`format_observation_messages` (dialect switch = config change) | **partial** (ruling **494**): swappable `formatMessageClass` with built-in dialect formatters, default byte-identical; residual: not exposed on `HzConfig` and adapters do not consume it. |
| **H-5** | Provider-shape repair in tiny single-purpose utils; never in the loop | **partial — TESTED** (rulings **67** `json-repair.ts`; **199** `openai-delta-content.ts`; **469** `tool-args-object.ts` Google/Ollama wire args; **477** `anthropic-tool-args.ts` Anthropic `toolArguments`/`safeParse`; other adapter-local repair still open); ruling **495** |
| **H-6** | Provider compat as compiled data (KDL cascade, ranked resolver, ambiguity = CI failure) | **partial — TESTED** (ruling **244**: T-8 host→quirk map in `provider-quirks.compat.json` loaded by `quirks.ts`; transform bodies stay code. **Still deferred/SKIP:** full KDL cascade, ranked resolver, |
| **H-7** | Metric contract (Metric / Anchor / Population / Excludes) attached to every published number | **partial** (wave 6b/7: the metric-contract helper (`app/src/core/metrics.ts`) with the canonical-number contract; routing every published number through it is open (docs/28 ruling 20)); ruling **505**; ruling **510**: corpus/session/bench numbers contracted (scoped); repo-wide sweep still open |
| **I-2** | `/tokens`-style per-chunk context cost table with `$` and a remediation hint per row | **partial — TESTED** (rulings **191**, **461**: `/tokens` + compaction summary row + harness-`$` label; **OPEN**: live provider invoice truth / elided-journal cross-check) |
| **I-4** | Observability flags externalising internal state (`--show-repo-map`, `/settings`, local-only analytics log) | **partial — TESTED** (ruling **506**): 10-event / 14-field local analytics catalogue with a strict allowlist; residual: emit the new names from call sites. |
| **I-5** | Batch "is it broken or just slow?": per-status histogram + ETA + running cost; Ctrl-C drains in-flight work; Ctrl-C in i | **partial — TESTED** (rulings **206**, **483**, **508**): histogram/ETA/running cost plus SIGINT drain of the in-flight batch row; residual: interactive Ctrl-C as user input and concurrent in-flight rows. |
| **I-7** | Configuration errors self-documenting: fix + doc link + escape hatch inside the exception text | **partial** (ruling **507**): uniform fix + doc link + escape hatch in config/doctor diagnostics; residual: `$schema` is still rejected as an unknown key and `CONFIG_ERROR_DOC` points at a non-existent config-keys section. |
| **I-8** | Onboarding: OAuth-style setup, fuzzy `--list-models`, did-you-mean for unknown models | **partial** (ruling **509**): `--list-models`, did-you-mean and a first-run TTY notice with `HZ_NO_ONBOARDING=1`; residual: fullscreen startup notice and persisted seen-once state. |
| **J-1** | Standardised prediction schema (`preds.json`) with zero runtime dependency on the benchmark harness | **partial — TESTED** (ruling **191** reduced: `preds-writer.ts`; `bun run eval --preds-out preds.json`; SWE-bench submit wiring still open) |
| **J-2** | Resumable batch runs purging stale entries; `--shuffle`/`--slice`/`--filter`; resumable long runs from runner-config sna | **done** (rulings **207**, **346**, **466**, **508**): resumable batch runs, stale-entry purge, filter/shuffle/slice, runner-config snapshot, live row execution through an injected guarded runtime, transition persistence, fail-closed terminals and SIGINT drain. Interactive Ctrl-C is I-5; omp adapters are J-4. |
| **J-3** | Default-deny network in the agent container - and prove it with a test against a real container | **partial** (PR #9: per-origin egress decider for `net.fetch` (ruling 43) and the fail-closed SandboxMode ladder (ruling 44); the OS confinement backend and a default-deny proof against a real contain |
| **J-4** | Own the benchmark manager: typed metric definitions, arms grouped by job prefix, resume without re-specifying | **partial — TESTED** (rulings **212**, **474**: `benchmark-manager.ts` + `batch --status` arms; `--arm` snapshotted in **466** runner-config + `resumeBenchmarkFromRunnerConfig`; full omp metaharness adapters still open); ruling **508** |
| **J-5** | Analyse your own session corpus to tune your own tools (read optimiser scripts over real transcripts) | **partial — TESTED** (rulings **213**, **504**): read-only corpus tuning suggestions plus `--suggest/--tune/--json`; residual: optimiser scripts over the full session DB/transcripts. |

## R. §7 COMPLETE mirror (all A–J rows)

| ID | Bucket | Title | Status |
|---|---|---|---|
| **A-1** | DONE | Escalating edit-application ladder: literal → 3-way-merge → line-level patch, each retried | **done** (wave 3, docs/28 ruling 16; the escalating ladder lives in `app/src/tools/edit.ts`, extended by PR #7, docs/28 ruling 41) |
| **A-2** | DONE | Relative-indent normalisation before matching edit blocks | **done** (docs/28 ruling 16: relative-indent normalisation rung) |
| **A-3** | DONE | Structured, diff-shaped failure feedback: failing block + "did you mean these actual lines | **done** (docs/28 ruling 16 and PR #7 docs/28 ruling 41: diff-shaped failure with closest lines, similarity %, REPLACE-already-present, up to 5 candidate previe |
| **A-4** | DONE | Bounded reflection loop: one `reflected_message` slot + `max_reflections` hard stop | **done** (docs/28 ruling 16: `max_reflections=1` per session and file) |
| **A-5** | DONE | Edit engine shipped with cross-implementation parity fixtures and byte-identical error str | **done** (docs/28 ruling 16: byte-identical fixtures in `app/tests/tools/edit-ladder.test.ts`) |
| **B-1** | DONE | Repo map: tree-sitter def/ref graph + personalised PageRank + token-budget binary search;  | **done** (wave 5, docs/28 ruling 19: reduced lexical form (no tree-sitter), personalised PageRank, binary-search budget; tree-sitter def/ref capture DEFERRED: z |
| **B-2** | OPEN | Per-message relevance budget that expands when no files are in context + 3-step map fallba | **partial — TESTED** (ruling **191**): repo-map budget doubles when `focus` is absent and the focus→repo→plain ladder is wired; residual: derive "no files in context" from the conversation, not just the `focus` tool argument. |
| **B-3** | REJECTED | Synthetic "assistant ack" turns after context slabs to mark injected context settled | **rejected** (ruling **203**: system-rail context slabs (ruling 9a) make synthetic assistant ack turns redundant; not adopting aider's ack-after-slab pattern) |
| **B-4** | OPEN | Cache layout as an explicit invariant (stable slabs first, 3 breakpoints, `cacheable_messa | **partial — TESTED** (rulings **200**, **222**, **223**, **246** stub, **276**, **277** wire default `cacheableBlocksCutIndex` when `HZ_ANTHROPIC_CACHE_BREAKPOI |
| **B-5** | DONE | Frozen fingerprinted prefix + append-only log; `syncMessages` truncates to longest byte-st | **done** (rulings **27**, **470**, **482**, **489**): frozen sha256 `StablePrefix` (system+tools), full `AppendOnlyLog` with drift rebuild, and a per-provider `auto` gate from committed local capabilities. Residual notes in 489 are empirical (measured KV-cache) rather than missing mechanisms. |
| **B-6** | DONE | Fit output cap to remaining window per request: usage-anchored prompt-size estimate, frami | **done** (wave 4, docs/28 ruling 18: output cap fitted from the usage anchor with a 16-token framing charge per message (constants differ from omp: headway 4,09 |
| **B-7** | OPEN | Structural read summaries + line/byte caps with spill-to-artifact; shell minimiser default | **partial** (rulings **18**, **499**): structural read summaries for ts/js/py/md/json with line/byte caps and spill-to-file; residual: spill is `<state>/spills/<sha256>.txt`, not an `hz://artifact/...` pointer. |
| **B-8** | DONE | Budget countdown rendered into the prompt via template vars (steps left, seconds left) | **done** (docs/28 ruling 15: live budget countdown (steps, tokens, seconds left) rendered into the run) |
| **B-9** | DONE | Truncation with head/tail + `elided_chars` + remediation advice; 10 K guard in the observa | **done** (docs/28 ruling 18: head/tail truncation with a remediation note and a 16 KiB / 4,000 token per-result cap) |
| **C-1** | REJECTED | Hard simplicity floor on the core loop (~200 LOC); policy in config and prompts, not code | **rejected** (as a literal LOC floor: `app/src/core/loop.ts` is about 2,580 lines because budgets, rails, hooks, admission and receipts live there; kept as a pr |
| **C-2** | DONE | Terminate on a single sentinel (`role == "exit"`); exceptions carry their messages; new ex | **done** (docs/28 ruling 15: one sentinel budget check; terminal vocabulary RC-7; new exit reasons need no loop change) |
| **C-3** | DONE | Persist the trajectory inside the loop on every step (`finally: save()`); trajectory forma | **done** (the hash-chained event log is appended on every event (docs/28 ruling 31: an append failure fails the run); trajectory format is the versioned event e |
| **C-4** | DONE | Format-error continuation: corrective message in-context; **consecutive**-error cap (reset | **done** (docs/28 ruling 15: corrective message, 3-strike consecutive format-error cap with its own exit status, charged failed turns; PR #5 docs/28 ruling 40 a |
| **C-5** | OPEN | Check budgets **before** the call; `0 = unlimited` uniformly; separate non-liftable wall-c | **partial** (rulings **15**, **508**): the lock-guarded `SpendLedger` reserve/settle rail is wired and the batch engine reuses it; residual: `runBatchCli` does not construct a batch-wide workspace ledger (per-row runtimes use scratch workspaces). |
| **C-6** | DONE | Per-tool concurrency declaration (default shared, `exclusive` opt-out) + parallel batch wi | **done** (wave 1, docs/28 ruling 14: `shared` default, `exclusive` opt-out, last-exclusive barrier) |
| **C-7** | OPEN | Auto-background long commands (default on, 60 s threshold) racing a steering signal | **partial — TESTED** (rulings **191**, **490**): the auto-background↔steer race is closed with a live-pid notice; residual: the real Responses `response.steer` WebSocket wire (C-9). |
| **C-8** | OPEN | Re-execute an unpaired tool-call tail before the next model call (pairing invariant preser | **partial — TESTED** (ruling **364**; opt-in re-exec before provider; not default-on) |
| **C-9** | OPEN | Live steering into the in-flight stream; refusal path for image-bearing messages | **partial — TESTED** (rulings **172**, **373**, **426**, **457**); residual real Responses `response.steer` wire |
| **C-10** | OPEN | Loop guards as one prompt file per failure class, emitted in a `<system-interrupt reason>` | **partial — TESTED** (rulings **201**, **217**, **372**, **458**, **481**: `tool-call-loop` + `consecutive-mistakes` + `action-stationarity` + `format-errors` + `context-overflow` system-interrupt nudges; other failure classes open); ruling **491** |
| **C-11** | OPEN | Thinking effort routed by cheap difficulty judgment; auto ceiling one tier below max; expl | **partial — TESTED** (rulings **199**, **216**, **464**: default-on heuristic auto ≤`high` when effort unset; `ultrathink`→`xhigh`; calibrated probs / live judge open); ruling **493** |
| **C-12** | OPEN | Owner/worker split: per-turn worker over a framed pipe with identity handshake before any  | **partial — TESTED** (rulings **22**, **471**, **492**): framed control-pipe protocol with a publish step and FIFO reserve gate; residual: real owner↔worker OS pipe, ancestor-chain proving and product spawn wiring. |
| **C-13** | OPEN | Durable per-session admission FIFO with `unknown` as a first-class state that halts follow | **partial — TESTED** (rulings **22**, **359**, **363**: FIFO + Runtime.send + loop executeTool refusal; NOT atomic R170) |
| **D-1** | DONE | `spawn_owned` as the single sanctioned spawn path, enforced by an AST lint with reason-req | **done** (docs/28 ruling 22: one `spawnOwned` site, spawn lint test with required reasons (`app/tests/core/spawn-lint.test.ts`); lint is a test, not an AST lint |
| **D-2** | DONE | Owner-death supervisor in POSIX `sh` (~0.5 MB, EOF-driven, killpg on SIGKILL/OOM) | **done** (docs/28 ruling 22: owner-death supervisor, live SIGKILL test; implemented in TypeScript (`app/src/core/supervisor.ts`), not as a POSIX `sh` script) |
| **D-3** | OPEN | Boot-relative process births surviving NTP steps and VM resume; spawn ledger with quaranti | **partial — TESTED** (rulings **22**, **473**: pid+startTicks + ledger quarantine; boot-id birth tokens when `/proc/stat` btime available; macOS/Windows + monotonic sleep-wake re-anchor open |
| **D-4** | SKIP | At-most-once scheduling: advance `next_run_at` before dispatch, stamp the slot in the same | **deferred (SKIP)** (goal F: no scheduler/cron runner — at-most-once `next_run_at` has nothing to attach to; do not queue) |
| **D-5** | OPEN | Stateless per-action subprocess execution (fresh process per step); kill the whole process | **partial** (shell runs in a detached process group killed on timeout with partial output kept (CURRENT_RUN tools row); a fresh process per step is the default  |
| **D-6** | OPEN | Turn frames (`delta`/`tool.start`/`approval`/`clarify`/`result`/`finished`), not filesyste | **partial** (ruling **492**): six `session.frame` kinds are emitted additively; residual: approval/clarify are projected from notice prefixes, not dedicated RuntimeEvents; worker-pipe publication is open. |
| **E-1** | OPEN | Dirty-commit-before-edit, then a separate commit for lint fixes (independently revertible  | **partial — TESTED** (rulings **191**, **460**, **479**, **496**): dirty checkpoint wired to edit/write/apply_patch (opt-in) and lint-fix commit on all three; residual: default-on is an owner policy decision. |
| **E-2** | DONE | Commit attribution as a configurable, documented truth table (`--attribute-*`); env-scoped | **done** (rulings **202**, **497**): documented five-cell env/CLI truth table for coauthor / signed-off-by / reviewed-by with CLI precedence and conflict notices; the reduced `--attribute-*` path is byte-identical. |
| **E-3** | DONE | LLM commit messages from diff **plus conversation context**, Conventional Commits, weak-mo | **done** (rulings **459**, **475**, **480**, **498**): capped conversation excerpt + staged diff, Conventional Commits normalization, packaged default weak-model map with `HZ_WEAK_MODEL` override and token-limit fallback. |
| **E-4** | CLOSED | Continuous Markdown chat transcript + parser (resume, post-mortem, support at ~zero cost) | **TESTED + VERIFIED** (rulings **80**, **467**, **476**, **485**: default-on per-event transcript with 0600/0700 hardening; `--restore` runtime wire with fail-closed notice; per-event append + parse/resume round-trip; full suite 3225/2 skip/0 fail) |
| **F-1** | OPEN | Narrow the lint signal to compiler-grade errors; render failures as marked tree-sitter exc | **partial — TESTED** (rulings **204**, **462**, **486**: structural excerpt windows added; tree-sitter ERROR-nodes still OPEN / owner-blocked) |
| **F-2** | DONE | Tell the model what the harness already does for it (pre-commit lint list) | **done** (ruling **191**): `.pre-commit-config.yaml` hook ids are rendered into the main system prompt via `harnessAutomationSection`. |
| **F-3** | DONE | User-supplied per-language lint command with catch-all fallback and `filename:line` parsin | **done** (rulings **210**, **462**, **486**): user lint commands, deterministic last-wins catch-all with an ambiguity diagnostic, shell-inert `{file}`, and Windows/ANSI/multi-finding `path:line` parsing with a 200 cap. Grammar-aware tree-sitter excerpts are F-1's clause and remain open there. |
| **F-4** | CLOSED (reduced) | Evals built from post-mortems; evals that measure cost/latency, not just pass/fail | **TESTED (reduced)** (rulings **28**, **487**): post-mortem-derived cases with answer isolation; per-case wall-clock + USD cost with explicit source, opt-in `max_wall_ms`/`max_cost_usd` thresholds, suite gates and `--metrics-out`. **Still OPEN (not full):** live-provider cost capture through `makeRuntimeExecutor` and invoice reconciliation. |
| **F-5** | DONE | Hostile-input fixtures for the read path (lockfile tarpit, 600 KB line, FIFO, lying extens | **done** (wave 6a: hostile-read fixtures and read-tool hardening (`app/tests/tools/`)) |
| **G-1** | PARTIAL | Post-turn background-review fork inheriting the parent's cached prefix byte-for-byte (~26  | **PARTIAL (reduced)** (rulings **27**, **488**: runnable review fork with byte-identical prefix-parity refusal, closed read-only tool subset and `origin: review-fork` attribution; `SpendLedger` reservation before dispatch; opt-in `HZ_REVIEW_FORK=1` + `HZ_SPEND_LIMIT_USD` post-turn wiring; proposals via curator rows only, ADR-010. Still OPEN: detached/fire-and-forget scheduling, live cost capture, explicit CLI trigger) |
| **G-2** | DONE | Editorial standard for what may be written down (forbids capturing unresolved failures and | **done** (docs/28 ruling 27: editorial standard as one function in `app/src/core/review.ts`) |
| **G-3** | DONE | Read-before-write enforcement on self-edits; 60-char test-enforced description budget tied | **done** (docs/28 ruling 27: read-before-write and title/body budgets enforced in code) |
| **G-4** | OPEN | Curator: archive-as-maximum (never delete) + pre-run snapshots + pins | **partial** (ruling **500**): frozen append-only archive with pre-run snapshots and pins; residual: in-memory only — not persisted or auto-invoked by `curate`. |
| **G-5** | DONE | `/learn` as a prompt, not an engine; knowledge-base layout (lean index + per-chapter refer | **done** (ruling **198**): `/learn` reads `<state>/learn/index.json`, lists chapter ids with `seeAlso`, and returns one chapter body at a time (12k cap); prompt material only, no engine/graph by design. |
| **G-6** | DONE | Untrusted-source hygiene: strip zero-width/bidi characters before distilling (Trojan-Sourc | **done** (rulings **55**, **66**, **501**): invisible/bidi format controls are stripped at both distill boundaries (curator + review), with shell-side refusal and completion masking already shipped; ANSI/homoglyphs are out of scope. |
| **G-7** | OPEN | Visible growth surface (learning graph render) | **partial — TESTED** (rulings **199**, **502**): bounded expanded graph with labelled edges and `/graph expanded`; residual: a whole-agent Hermes graph beyond curator/proposal data. |
| **G-8** | OPEN | Eval hillclimb gates in the host (approval freshness by content hash, frozen split, held-o | **partial — TESTED** (rulings **204**, **463**, **465**, **503**): frozen-split keep/revert rounds with an append-only decision log; residual: on-disk variant gate wiring in the eval runner. |
| **G-9** | OPEN | Benchmark ground truth computed locally; stimuli encode so paraphrase cannot help; every t | **partial — TESTED** (rulings **211**, **510**): index-derived stimuli + local grading + contracted numbers; residual: full if-bench corpus and a product runner (`buildIndexedEvalCases` has test-only callers). |
| **H-1** | OPEN | Model capability/settings as declarative YAML with user overrides + `accepts_settings` neg | **partial — TESTED** (rulings PR #4 + **472**: unsupported-param strip for `reasoning_effort`; YAML / user overrides still open) |
| **H-2** | OPEN | Cost accounting distinguishing cache-write/cache-hit with provider multipliers | **partial — TESTED** (rulings **191**, **455**: cache fields + harness `costMicroUsd` on `hz.usage.recorded`; live billi |
| **H-3** | OPEN | Config keys naming the class (short name or import path); `UNSET` sentinel merge for layer | **partial — TESTED** (rulings **198** + **484**: `CONFIG_UNSET` + `mergeConfigFileLayers`; closed `providerClass`/`modelClass` short-name→module map + documented import-path resolve; product module load / more keys still open) |
| **H-4** | OPEN | Model class owns `format_message`/`format_observation_messages` (dialect switch = config c | **partial** (ruling **494**): swappable `formatMessageClass` with built-in dialect formatters, default byte-identical; residual: not exposed on `HzConfig` and adapters do not consume it. |
| **H-5** | OPEN | Provider-shape repair in tiny single-purpose utils; never in the loop | **partial — TESTED** (rulings **67** `json-repair.ts`; **199** `openai-delta-content.ts`; **469** `tool-args-object.ts` Google/Ollama wire args; **477** `anthropic-tool-args.ts` Anthropic `toolArguments`/`safeParse`; other adapter-local repair still open); ruling **495** |
| **H-6** | OPEN | Provider compat as compiled data (KDL cascade, ranked resolver, ambiguity = CI failure) | **partial — TESTED** (ruling **244**: T-8 host→quirk map in `provider-quirks.compat.json` loaded by `quirks.ts`; transform bodies stay code. **Still deferred/SK |
| **H-7** | OPEN | Metric contract (Metric / Anchor / Population / Excludes) attached to every published numb | **partial** (wave 6b/7: the metric-contract helper (`app/src/core/metrics.ts`) with the canonical-number contract; routing every published number through it is; ruling **505**; ruling **510**: corpus/session/bench numbers contracted (scoped); repo-wide sweep still open |
| **I-1** | DONE | `--show-prompts`: dump the exact rendered message list and exit, no API call | **done** (2026-11-12, docs/28 ruling 187: `hzcode --show-prompts` via `core/show-prompts.ts`; synthetic `Hello!` + `ProviderRequest` JSON, no API) |
| **I-2** | OPEN | `/tokens`-style per-chunk context cost table with `$` and a remediation hint per row | **partial — TESTED** (rulings **191**, **461**: `/tokens` + compaction summary row + harness-`$` label; **OPEN**: live provider invoice truth / elided-journal cross-check) |
| **I-3** | DONE | Cache versioned by extractor provenance; rebuild-then-fallback on corruption; two-API shim | **done** (wave 14b: `repo_map` persistent identifier cache (`app/src/tools/repo-map-cache.ts`)) |
| **I-4** | OPEN | Observability flags externalising internal state (`--show-repo-map`, `/settings`, local-on | **partial — TESTED** (ruling **506**): 10-event / 14-field local analytics catalogue with a strict allowlist; residual: emit the new names from call sites. |
| **I-5** | OPEN | Batch "is it broken or just slow?": per-status histogram + ETA + running cost; Ctrl-C drai | **partial — TESTED** (rulings **206**, **483**, **508**): histogram/ETA/running cost plus SIGINT drain of the in-flight batch row; residual: interactive Ctrl-C as user input and concurrent in-flight rows. |
| **I-6** | DONE | Never prompt without a tty; unattended runs degrade to a saved `LimitsExceeded` trajectory | **done** (headless approvals fail closed (docs/28 section 1 item 5) and a budget stop exits with a distinct status (exit 5)) |
| **I-7** | OPEN | Configuration errors self-documenting: fix + doc link + escape hatch inside the exception  | **partial** (ruling **507**): uniform fix + doc link + escape hatch in config/doctor diagnostics; residual: `$schema` is still rejected as an unknown key and `CONFIG_ERROR_DOC` points at a non-existent config-keys section. |
| **I-8** | OPEN | Onboarding: OAuth-style setup, fuzzy `--list-models`, did-you-mean for unknown models | **partial** (ruling **509**): `--list-models`, did-you-mean and a first-run TTY notice with `HZ_NO_ONBOARDING=1`; residual: fullscreen startup notice and persisted seen-once state. |
| **I-9** | DONE | Deterministic test model inside the library (with scriptable pseudo-actions `/sleep`, `/wa | **done** (`app/src/core/providers/scripted.ts` and the mock provider; `bun run eval` uses the scripted model in-library; the `/sleep` and `{"raise"}` pseudo-act |
| **J-1** | OPEN | Standardised prediction schema (`preds.json`) with zero runtime dependency on the benchmar | **partial — TESTED** (ruling **191** reduced: `preds-writer.ts`; `bun run eval --preds-out preds.json`; SWE-bench submit wiring still open) |
| **J-2** | DONE | Resumable batch runs purging stale entries; `--shuffle`/`--slice`/`--filter`; resumable lo | **done** (rulings **207**, **346**, **466**, **508**): resumable batch runs, stale-entry purge, filter/shuffle/slice, runner-config snapshot, live row execution through an injected guarded runtime, transition persistence, fail-closed terminals and SIGINT drain. Interactive Ctrl-C is I-5; omp adapters are J-4. |
| **J-3** | OPEN | Default-deny network in the agent container - and prove it with a test against a real cont | **partial** (PR #9: per-origin egress decider for `net.fetch` (ruling 43) and the fail-closed SandboxMode ladder (ruling 44); the OS confinement backend and a d |
| **J-4** | OPEN | Own the benchmark manager: typed metric definitions, arms grouped by job prefix, resume wi | **partial — TESTED** (rulings **212**, **474**: arm report + runner-config `--arm` resume-without-re-spec; full omp metaharness adapters still open); ruling **508** |
| **J-5** | OPEN | Analyse your own session corpus to tune your own tools (read optimiser scripts over real t | **partial — TESTED** (rulings **213**, **504**): read-only corpus tuning suggestions plus `--suggest/--tune/--json`; residual: optimiser scripts over the full session DB/transcripts. |

## D. `30-steal-list.md` §8 — repo-take wave #1–#18

| # | Steal | Landing | Bucket | Status |
|---:|---|---|:---:|---|
| **1** | Session FTS + resume list/search | `app/src/core/session-search.ts`; `SessionStore.re | OPEN | **partial — TESTED** (rulings **167**, **196**, **249**, **262**): FTS + scrollback list + picker; user-turn snippet; picker rows show relative time + message count; fork hint on p |
| **2** | Egress / MITM shell-net close | docs/33 §5.2; `kernel/src/egress.rs`, `kernel/src/ | OPEN | **partial — TESTED** (rulings **178**, **195**, **208**, **218**, **231**, **234**, **253**): doctor honesty + TS decider + optional forward; netns CONNECT denial (**218**); TLS MI |
| **3** | Engram-style handoffs | native or MCP `handoff_*`; `.hz/state/handoffs.db` | OPEN | **partial — TESTED** (rulings **366**–**425**): durable todos + branch auto-merge; residual embeddings |
| **4** | remember/recall (+ banks) | extend `app/src/core/memory/`; `memory_search` | OPEN | **partial — TESTED** (rulings **170**, **238**, **242**, **367**, **375**, **391**, **429**): FTS banks + tool `limit`/`diversify`; residual embeddings / graph/triples |
| **5** | Credential store + OAuth refresh lock | `app/src/core/auth/` | OPEN | **partial — TESTED** (rulings **173**, **194**, **274**, **379**, **401**): flock + `auth.oauth_refresh_gen` doctor; residual real IdP e2e |
| **6** | Permission presentation + saved allows + unattended | `app/src/tui/approval*.ts` | OPEN | **partial — TESTED** (rulings **173**, **370**, **388**–**398**, **427**–**431**, **436**–**437**): grant tick + SQL `saved_allows` + `guard.grant.query` + `{action,resource}`; residual multi-resource projector |
| **7** | Doom-loop tiers + truncate-fail-all-tools | `app/src/core/guards/` + `loop.ts` | OPEN | **partial — TESTED** (rulings **171**, **372**, **404**, **408**, **417**, **435**): stationarity reset; max_tokens partial dispatch; search tools in tight tier |
| **8** | Interjection / mid-turn steer | `app/src/core/interjection.ts`; `Runtime.interject | OPEN | **partial — TESTED** (rulings **172**, **369**, **373**, **377**, **389**, **457**): steer cut + live-steer channel + OpenAI assembly-cancel; residual Responses WebSocket `response.steer` |
| **9** | Sandbox deepen (child_net / hook write deny) | `hz-sandbox-exec` residuals; hooks | OPEN | **partial — TESTED** (ruling **173**, **197**, **201**): `HZ_SANDBOX_FS_RO_PATHS` Landlock deny; `HZ_SANDBOX_CHILD_NET=off` wired from env/config → netns network-off on wrapped chi |
| **10** | Two-step MEMORY (index + topic files) + caps | `.hz/state/MEMORY.md` index + `.hz/state/memory/*. | OPEN | **partial — TESTED** (rulings **180**, **368**, **381**, **402**): rank + prefetch + doctor topic summary; residual embeddings / full memdir attach |
| **11** | Subagent nested session + isolation / Never | `agent` tool + profiles | OPEN | **partial — TESTED** (rulings **175**, **385**): `never` preset + durable `hz.agent.*` on parent stream; child prompt delegation-scope copy |
| **12** | Provider failure codes + retry budgets | `contracts.ts` union + `providers/retry.ts` | OPEN | **partial — TESTED** (rulings **175**, **403**–**406**, **409**, **410**): classify + UI + `run.complete`; residual receipt chip |
| **13** | Repo map / CBM paging | `repo_map` + MCP proxy | OPEN | **partial — TESTED** (rulings **180**, **239**, **263**): `fileCursor` / `nextFileCursor` + `symbolCursor` / `nextSymbolCursor`; MCP `tools/list` `nextCursor` passthrough (`list-pa |
| **14** | Autonomy / AutoMode ladder | config presets beside permission modes | OPEN | **partial — TESTED** (rulings **175**, **230**): `autonomy-presets.ts` + config `autonomy` → `permissionMode`; TUI `/autonomy` + bare `/mode` scrollback ladder |
| **15** | Tool result paging (`cursor`, max_output) | heavy tools / MCP | OPEN | **partial — TESTED** (rulings **175**, **239**): `planToolOutputFromOffset` + loop/MCP `outputOffset` arg wired) |
| **16** | LSP/DAP op breadth | docs/33 §5.1 | OPEN | **partial — TESTED** (ruling **182** hermetic TCP e2e; real dlv open) |
| **17** | Foreign session import | migrator | SKIP | **deferred (SKIP)** (goal F: until memory spine #1–#4; do not queue) |
| **18** | Collab-web / desktop session-ui | docs/14 | OTHER | **SKIP** (goal F: collab-web / desktop session-ui until memory spine #1–#4; do not queue) |

## E. `33-handoff.md` §5 deferred entries

| § | Topic | Pri | Open / residual |
|---|---|:---:|---|
| **5.1** | DAP debug tool | P3 | Hermetic TCP **182**; real dlv open |
| **5.2** | MITM egress (staged) | P2 | Production netns + TLS intercept |
| **5.3** | OS confinement backend | P1 | Landlock/seccomp/netns product |
| **5.4** | Memory + dream | P1 | Embeddings, full tiers |
| **5.5** | toolconv dialects | P2 | Beyond T-18 XML base |
| **5.6** | OAuth acquisition | P2 | Full onboarding UX |
| **5.7** | models.dev full snapshot | P2 |  |
| **5.8** | models.dev live refresh | P3 | In-memory reload on poll |
| **5.9** | Speculation + guardian LLM | — | **65** UNWIRED |
| **5.10** | forge T-8 quirks depth | P2 |  |
| **5.11** | T-9 debug requests | P3 | Maintain eval pack |
| **5.12** | T-15 worktree | — | Pool **266** partial |
| **5.13** | T-17 status line | P3 |  |
| **5.14** | T-18 toolconv | P2 |  |
| **5.15** | T-20 JSON schema | P3 | Nested shapes descriptive |
| **5.16** | suggest | P3 | TESTED |
| **5.17** | Grok fullscreen R1–R12 | P2 | R2,R4,R9–R12 |
| **5.18** | TUI part 3 gaps | P2 | D6, overlay, /verbose |
| **5.19** | Keymap/mouse/palette | P3 |  |
| **5.20** | §8 repo-take wave | P0–P3 | §D + `superpowers/plans/2026-11-12-repo-take-steal-wave.md` |

## F. `33-handoff.md` §6 — known gaps (full)

1. 1. **Root skips 8 chmod tests.** Expected: see above. Use `setpriv --reuid=1000 ...` to run as non-root when you need the full count.
2. 2. **Build the kernel before app tests.** `cd kernel && cargo build --release --locked`. Tests that need `hz-kernel` will fail or fall back otherwise.
3. 3. **`CARGO_HOME`.** If `~/.cargo` is read-only, set `CARGO_HOME=/projects/sandbox/.scratch/cargo-home` (already populated) for every cargo command.
4. 4. **Never commit `app/bun.lock`.** `bun install` rewrites it. After any `bun install`, run `git checkout -- app/bun.lock`. Before every commit, check `git status` for it and stage files by name (never `git add -A` or `git add .`).
5. 5. **Background cargo builds die between tool calls.** In the agent sandbox a `cargo build &` is killed when the call returns. Run cargo in the foreground in one call (give it a long timeout).
6. 6. **`/tmp` is wiped between calls** in the agent sandbox. Put scratch files, caches and generated artefacts under `/projects/sandbox/.scratch/` (or any path inside the workspace). `ops/gates.sh` itself uses `${TMPDIR:-/tmp}` for a throwaway directory and removes it on exit; that is fine because it lives within one call.
7. 7. **No network in some sandboxes.** `bun install` and `cargo` need registries unless already cached. The caches in `.scratch/` exist for this reason. Keyed provider runs need real API keys and were never possible there (this is why several quality items are deferred).
8. 8. **Run the gates in one call.** `bash ops/gates.sh` takes roughly 15 seconds locally; it is fail-fast and prints a summary table.
9. 9. **Do not run `bun test` while another bun process holds the same state directory.** Tests create temp dirs, but file-lock tests are timing sensitive on a loaded machine.
10. 10. **`gh` GraphQL does not work; use REST.** GraphQL-backed `gh` subcommands (`gh pr create`, `gh pr list`, `gh pr merge`) are unsupported. Use `gh api` REST calls as in known gap 7, and do not assume a sub-agent sandbox has `gh` access.
1. 1. **Zero runtime dependencies in `app/`.** `package.json` may only carry `devDependencies` (types, compiler). No parser-combinator, no TUI framework, no HTTP client. The Rust kernel uses std plus serde; adding the first async runtime or TLS crate is an owner decision (see section 5.2).
2. 2. **`app/src/contracts.ts` is ADDITIVE ONLY.** New optional fields and new union variants are allowed with an in-comment justification and a docs/28 note in the same commit. Never rename, remove or retype an existing member. Existing additive examples: `Tool.exposure`, `Tool.searchInfo` (ruling 45), `subagent.event` (ruling 54), `assistant.thinking` (C3, ruling 87), `subagent.start` and `subagent.end` (C2, ruling 88), `ApprovalRequest.guardian` (ruling 60).
3. 3. **`kernel/src/canon.rs` is unchanged.** Canonical JSON and hashing are frozen and mirrored by `app/src/core/canon.ts`; a change would invalidate every existing log. Docs/05 D40 fixes the number rules.
4. 4. **Docs are updated in the same commit as the code.** A behaviour change must land with its docs/28 ruling or level update, its docs/30 Status cell, and the affected design-doc Provenance or deferral note. A feature without a doc update is not done.
5. 5. **No em dashes (the long dash character) in new prose.** Use a hyphen, a comma, a colon or parentheses. The research notes were cleaned the same way.
6. 6. **CI workflow edits only through a pull request.** The automation token lacks the `workflow` scope. Edit `ops/ci/github-actions.yml`, run `bash ops/install-ci.sh`, and have a human with the scope push `.github/workflows/ci.yml` via a PR.
7. 7. **No direct pushes to `main`.** Work on a branch, open a pull request. Never force-push.
8. 8. **Honest sandbox reporting.** `kernel_applied_mechanisms()` reflects what **`hz-sandbox-exec` actually applies** (process/resources/network/filesystem when enabled — rulings 140–150). `sandbox.report` must never say `enforced` unless the mechanism is applied and denial-tested (rulings 44, 51). `hostCapabilities.available` must never be converted into `enforced` by itself. A git worktree is not a sandbox. The egress decider governs the `net.fetch` guard kind only, not the traffic of a shell child (MITM still open).
9. 9. **No yolo or bypass permission mode.** The modes are `default`, `plan`, `accept-edits`, `read-only` (ruling 58). Hooks are deny-only. A model verdict (guardian) never grants. Unattended runs never auto-approve.
10. 10. **The status ladder lives only in `docs/28`.** Other documents say DESIGNED or DESIGN ONLY or quote docs/28; they never invent a level. Do not mark anything VERIFIED without a measured run recorded in docs/28; nothing is RELEASED.
11. 11. **Every executed tool call is guarded, approved if asked, and receipted.** This includes calls parsed from text (a future T-18) and calls from code mode. The loop refuses an unmapped registered tool fail-closed (`guardActionFor`, ruling 49).
12. 12. **Prompt text from files cannot carry authority.** Instruction files, skills, commands and plan files are text only; the readers refuse symlinks (ruling 79). Terminal output from model text goes through `sanitizeText`.
13. 13. **Secrets are masked** (`maskSecrets`) in every export, dump or summary. Request dumps (T-9) must follow the same rule.
14. 14. **Do not weaken a test to pass.** If a test fails, find the cause; if you must change an assertion, say why in the commit and in docs/28.
1. 1. **LICENSE / NOTICE (§6 hygiene).** **Partial — TESTED (ruling 233):** root `NOTICE` + `docs/LICENSE-STATUS.md` + doctor `repo.license` WARN when no root `LICENSE`; README points here. **Still open:** owner-chosen root `LICENSE` (do not invent); release-grade NOTICE keyed to full Provenance tables.
2. 2. **Hook trust gate (docs/15 H1, design rule H7/D31).** **Partial — TESTED (2026-11-11):** list gate + `trust.json` digest binding for `hooks.json`, workspace **skills**, **agent presets**, **`mcp.json`**, and **`providers.json`** (`skillsDigest` / `agentsDigest` / `mcpDigest` / `providersDigest`); `ensureWorkspaceHookTrust` re-prompt + `hook.trust` receipt at `send()`; project skills gated in `listSkills`; workspace agent presets gated in `loadPresets` (`agents-trust.test.ts`); untrusted workspace MCP/providers notices (`mcp-trust.test.ts`); **trusted** workspace **`mcp.json` / `providers.json` merge at `createRuntime`** (`workspace-config-trust.test.ts`, ruling **113**). **Still open:** Grok [`trust.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-hooks/src/trust.rs) parity.
3. 3. **Event type names versus the `hz.*` catalogue (docs/06 J4).** **TESTED (2026-11-15):** `event-catalogue.ts` — **50** shipped / **32/44** literal / **44/44** mapped (**454** closes RC-18 canonical map; many literals reduced). Doctor **`session.kernel`** (**416**). **Still open:** full EffectHost (**243**); full payload parity for reduced emitters.
4. 4. **Stale module header in `app/src/core/checkpoints.ts`.** **Partial (2026-11-10):** header fixed; `recordCheckpoint` retries append once and calls `onAppendFailure` (wired from runtime `note`). Memory-only tail on double failure remains by design.
5. 5. **JSONL appends fsync by default (2026-11-12, dir fsync 2026-11-13).** SQLite commits remain `synchronous=FULL`; file replacements use temp+fsync+rename. Kernel (`eventlog`/`receipts` via `jsonl_append.rs`, ruling **251**) and TypeScript JSONL appends (events, receipts, spawn ledger, change journal, checkpoints, curator) now `fsync`/`sync_data` after each append via `jsonl-append.ts` / Rust helpers; both stacks best-effort fsync the parent directory on Unix (ruling **249** TS). Disable with `HZ_JSONL_FSYNC=0` (fast/test; doctor warns). **432** advisory `ops/jsonl-fsync-contract-probe.sh` re-runs contract unit tests (not power-loss). **Still open:** measured power-loss matrix (docs/12 F10); torn final line still skipped by readers.
6. 6. **PR numbers, titles and merge commits for #25 to #28 are verified** (GitHub API, 2026-11-10; see section 4). Nothing is left to check there.
7. 7. **Publishing.** The orchestrating agent publishes through `gh api` REST (GraphQL-backed `gh` subcommands are unsupported). Create a PR: `gh api repos/sarv-projects/HorizonCode/pulls -f title=... -f head=<branch> -f base=main -f body=...`. Merge: `gh api -X PUT repos/sarv-projects/HorizonCode/pulls/N/merge -f merge_method=merge -f sha=<head sha>`. CI status: `gh api repos/sarv-projects/HorizonCode/commits/<sha>/check-runs`, looking for the check named `gates`. Sub-agent sandboxes may not have `gh` access at all, so a sub-agent commits locally and the orchestrator pushes. Do not push to `main` directly.
8. 8. **Prompt golden, tool-schema snapshot and plain-output golden are tests that read docs and fixtures** (section 2.5). A "docs only" change to those places can fail `bun test`.
9. 9. **Event log and receipts are tamper-evident, not tamper-proof.** Without `HZ_ANCHOR_KEY`, anyone who can write the files can rewrite the whole chain (README and docs/11 say so). Keep that wording.
10. 10. **Subagents.** Delegation depth is 1; the generic child holds only the base seven tools. **Delegation-scope + return guidance TESTED (2026-11-12):** `CHILD_PROMPT_SECTIONS` state scope cannot widen, denied ops must not be retried, and the parent gets only the final report (docs/08 Provenance / DeepSeek adapt).
11. 11. **Markdown tables in docs:** a pipe inside a cell must be written `\ / ` (GFM), or the row breaks. Several rows in docs/30 use it.
12. 12. **Two repositories' evidence is second-hand.** aider, mini-swe-agent, hermes-agent, OpenHands, SWE-agent, wshobson-agents, DeepSeek-Reasonix and opencode-v2 were not cloned in the sandbox; their findings come from `docs/audit/pass2` and `pass3` and no file path can be verified. The claude-code pin holds docs, examples and plugins, not the agent source (`research/upstream-pins.md`). Treat unverified claims as leads.

## G. docs/12 §11 session infra (F-items)

| ID | Slice | Status |
|---|---|---|
| **F1** | Snapshot refuse | TESTED **270** |
| **F3** | Fork/meet + permission_mode | Reduced **273** |
| **F4** | .hzs export | **268** |
| **F5** | Migration stub | **269** |
| **F6** | Admission/FIFO | Reduced **269** |
| **F7** | Blob CAS | **271** |
| **F8** | Session FTS | **273** |
| **F9** | Workspace mount WARN | **266** |
| **F10** | JSONL fsync | **251**, **432** contract probe; power-loss matrix gate open |
| **F11** | Worktree pool | Reduced **266** |

## H. Waves A–D / E headlines

- Speculation UNWIRED **65**
- Live DAP e2e (§5.1)
- toolconv per-dialect (§5.5)
- Wave C durable grants + bash AST depth
- §8 #11–#15 (see §D)
- MCP beyond **263/264**
- Memory embeddings/banks **238/242**
- Grok R1–R12 (**5.17**)
- cellbuffer/escape-writer **176/183**
- fullscreen **193–317** reduced

## I. forgecode T-1–T-20 (full)

| ID | Take | Bucket | Status |
|---|---|:---:|---|
| **T-1** | Tool-argument JSON repair and schema coercion | DONE | **done** (PR #25, commit 493573d, docs/28 ruling 67; follow-ups docs/28 ruling 73, docs/28 ruling 74 (truncation repairs |
| **T-2** | Tool-schema snapshot test | DONE | **done** (PR #25, commit 5e66459, docs/28 ruling 68; the max-description-length half of the idea is part of the same tes |
| **T-3** | Re-open the loop when todos are pending | DONE | **done** (PR #25, commit a666cd1, docs/28 ruling 69; refined by docs/28 ruling 75 (fires only for a list this run modifi |
| **T-4** | Attempts remaining on failed tool results | DONE | **done** (PR #25, commit 0763c14, docs/28 ruling 70; the optional reflect-on-the-error partial is not adopted) |
| **T-5** | Streaming markdown renderer for the chat | DONE | **done** (PR #23 (feat/tui-polish), commit f6402fd; docs/13 'Part 2'. Verified in code: `createMarkdownStream` handles h |
| **T-6** | Spinner with elapsed time and a cancel hint | DONE | **done** (PR #23, commits 5b782dc and d1838f8. Verified in code: braille spinner (ASCII fallback), `formatElapsed`, and  |
| **T-7** | Structured deterministic compaction summary | DONE | **done** (PR #26, commit 165c3ca, docs/28 ruling 76; commands are masked in the summary (docs/28 ruling 79)) |
| **T-8** | Provider quirk table | OPEN | **partial** (2026-11-11, docs/33 §5.10 / ruling 151): shipped quirks on the OpenAI wire + provider `quirks` event; remai |
| **T-9** | Behavioural eval pack that asserts on the outgoing request | DONE | **done** (2026-11-11, docs/33 §5.11 / ruling 130): request dump + hygiene pack 8 scenarios TESTED; keep `.env` `HZ_MODEL |
| **T-10** | `hzcode doctor` | DONE | **done** (PR #25, commit 4884146, docs/28 ruling 71) |
| **T-11** | Startup latency CI gate | DONE | **done** (PR #25, commit 2057837, docs/28 ruling 72: eighth gate `startup-latency`, medians of 5 runs with 5x ceilings) |
| **T-12** | Conversation management verbs | DONE | **done** (PR #27, commit 484b713, docs/28 ruling 80: `/rename`, `/retry`, `/stats`, `/export [json\ / html]`, `/copy`; t |
| **T-13** | Custom commands as files | DONE | **done** (PR #26, commit 8bdf2d6, docs/28 ruling 77; symlinks refused (docs/28 ruling 79); `/name args` in the TUI, `hzc |
| **T-14** | Skill folders with bundled resources | DONE | **done** (PR #26, commit 9b3ec75, docs/28 ruling 78; symlinks refused (docs/28 ruling 79)) |
| **T-15** | Git worktree isolation flag | DONE | **done** (2026-11-10, docs/33 §5.12): `runGuardedShell` + re-exec; `worktree.test.ts` + `worktree-e2e.test.ts` |
| **T-16** | `hzcode commit` and `suggest` | DONE | **done** (commit half: PR #27 ruling 83; `suggest` half: 2026-11-10 docs/33 §5.16 TESTED) |
| **T-17** | Status line with a JSON-on-stdin script contract | DONE | **done** (2026-11-12, docs/33 §5.13 / rulings 152, 163): user-config `statusLine` + `used/window` polish; workspace `sta |
| **T-18** | Request transformer for models without native tools | DONE | **done** (2026-11-10, docs/33 §5.14): XML wire + catalog `tools:false` default; further dialects live under §5.5 residua |
| **T-19** | Plan-file convention and `execute-plan` skill | DONE | **done** (PR #27, commit 165715e, docs/28 ruling 82: `.hz/plans/<date>-<slug>-vN.md`, built-in `execute-plan` skill (`BU |
| **T-20** | Config diagnostics: unknown-key report and generated JSON schema | DONE | **done** (check half: PR #27 ruling 81; schema half: 2026-11-10 docs/33 §5.15 TESTED — nested MCP/LSP/provider shapes re |

## J. Grok TUI §5.12 rows (full)

| Item | HC implementation | Bucket | Status |
|---|---|:---:|---|
| Bracketed paste collapsed to one input | `app/src/tui/paste.ts` | DONE | **done** (TUI part 3, ruling 84; commit b62c8a2) |
| Single-key bordered approval card | `app/src/tui/approval-card.ts`, `approva | DONE | **done** (TUI part 3, rulings 85 and 91; commits 0e2668b, 9f9448d) |
| Diff gutters with line numbers | `app/src/tui/diff.ts` | DONE | **done** (TUI part 3, ruling 86; commit 6b150fe) |
| Thinking display | provider `thinking`, runtime `assistant. | DONE | **done** (TUI part 3, ruling 87; commit 669dcb0) |
| Subagent boundary events | `subagent.start`/`subagent.end` (C2), `c | DONE | **done** (TUI part 3, ruling 88; commit 344045a) |
| Tab completion and ghost text | `app/src/tui/completion.ts` | OPEN | **partial** (TUI part 3, rulings 89 and 91; commits 134a888, 6c9902d: Tab completion and ghost text  |
| `/theme` | `app/src/tui/style.ts`, `interactive.ts` | DONE | **done** (TUI part 3 ruling 90 + 2026-11-10 `persistThemeMode`; docs/33 §5.18) |

## K. little-coder TAKE (implement)

- [ ] llama.cpp/LM Studio n_ctx
- [ ] mid-run compact ~80%
- [ ] Ollama reconcile
- [ ] tail skill/knowledge
- [ ] read trim + read-before-edit
- [ ] quality steer
- [ ] output-parser repair
- [ ] eval profiles
- [ ] subagent serial-default
- [ ] shell wake_on

## L. aider TAKE (implement)

- [x] E-1 dirty-checkpoint wired to edit/write/apply_patch (**496**; lint-fix on all three **460**, **479**); default-on remains an owner policy decision
- [x] E-2 env author truth table (**497**)
- [x] E-3 weak-model-first token-limit fallback + packaged default weak-model map (rulings **459**/**475**/**480**/**498**)
- [ ] E-5 ai!/ai? watch
- [ ] optional HEAD /diff

## M. Verification / CI

- [ ] `bash ops/gates.sh` — record fresh ruling
- [ ] `sandbox_exec.rs` host-class note
- [ ] Live cache/provider benches (keys)

## N. Explicit SKIP (do not queue)

- Wave F: D-4 scheduler, hosted tools, external subagents, collab UI
- §8 #17 foreign import, #18 collab/desktop
- Rust TUI, Effect-TS, Kitty, vendored memory MCP
- forge hosted search, spoofed OAuth
- Full H-6 KDL cascade
- pi substrate; aider auto-commit undo; bash allowlist trust
- Speculation wire without ruling

## V. Second-wave §5 partial index (by section)

> Full prose + upstream links: `30-steal-list.md` §5.1–5.12. Below: every partial row label.

### 1. The oh-my-pi claim check (asked explicitly) (1 partial)

- Fewest tokens and tool calls

### 3. Register candidates (adopted by RC-15) (2 partial)

- **NF-071**
- **NF-075**

### 4. What to do — the action queue (3 partial)

- 6
- 7
- 8

### 5.1 opencode (`externals/opencode`) (8 partial)

- Interpolate concrete OS/shell into the shell tool description at request time...
- Invalid-tool-JSON replay: synthesise a paired tool result carrying the byte-f...
- Cache-breakpoint planner: up to 4 breakpoints (`BREAKPOINT_CAP`), tail advanc...
- Hold-then-swap background compaction keyed to remaining cache TTL: summarise ...
- Debounced MCP reconcile on a tools-changed event (100 ms) + binary-resource s...
- Typed decision helper (`predicate`/`choice`/`score` with calibrated probabili...
- Rope / order-statistic indexing for large-file paging + negative-offset tail ...
- Per-parsed-command shell permission + durable resource-scoped grants (`{actio...

### 5.11 Specialised agent presets (Kiro CLI, Freebuff (1 partial)

- Cheap model for context gathering

### 5.12 Third TUI wave: Grok Build minimal-mode behav (1 partial)

- Tab completion and ghost text

### 5.2 cline (`externals/cline`) (6 partial)

- Batch-tolerant `read` with a union input schema + per-item result/error array...
- Harden clarify/terminal tools: refuse to fabricate a dismissed answer; eviden...
- Command-guard for a read-only/plan lane: data-masking (heredocs/quotes/commen...
- User provider registry: register `{ name, baseURL, apiKey, protocol, models[] \
- Typed hook taxonomy (`beforeRun`/`afterRun`/`beforeModel`/`afterModel`/`befor...
- Uniform `restrictToCwd` / `..`-escape rejection across every write-capable to...

### 5.3 codex (`externals/codex`) (4 partial)

- Self-documenting provider-removal errors: `WireApi` deserialization rejects r...
- OS-level sandbox layering for shell/codemode: `no_new_privs` + seccomp networ...
- Streaming retry with server-advised backoff that cannot extend configured lim...
- Guardian-style action classifier reviewing proposed actions against instructions

### 5.4 oh-my-pi (re-verified, NEW findings only) (`ex (5 partial)

- Cross-check and align output-budget constants against the verified source: `M...
- Bash PTY selection + interactive bash: decide per command whether to run unde...
- Cross-process locking + mutation queue + concurrent-edit conflict detection
- Speculative execution across turns: a dependency-graphed candidate scheduler ...
- DAP (debugger) tool: full launch/attach, breakpoints (line/function/data/inst...

### 5.5 grok-build (xai-org) (`externals/grok-build`) (5 partial)

- Bash command splitting + per-sub-command risk scoring: split a compound shell...
- Multi-dialect tool compatibility: optional `codex`/`opencode`/`claude` tool-n...
- Folder-trust + source-identity gating: a program named by a workspace stays o...
- Egress proxy with per-origin `Allow\
- Memory retrieval + background "dream" consolidation: embeddings + BM25 + MMR ...

### 5.6 Claude Code SDK/docs (`externals/claude-code`) (6 partial)

- Subagent description token budget: warn when non-built-in subagent descriptio...
- Exit-code hook contract: exit 2 blocks the tool and shows stderr to the model...
- Richer hook lifecycle: add `SessionStart/End`, `PreCompact/PostCompact`, `Sub...
- Permission modes (`default`/`acceptEdits`/`plan`/`auto`/`bypassPermissions`) ...
- Bash network allowlist shape: `sandbox.network` with `allowedDomains`, `allow...
- Agent SDK / headless `-p --output-format json` surface so non-TS callers driv...

### 5.7 DeepSeek harness (`dsh`) (`externals/deepseek- (10 partial)

- `systemPromptUpdate: 'in-history'`: when the model reads the latest `system` ...
- Stable provider failure codes + route-on-code (`NO_ADAPTER`, `MISSING_CREDENT...
- Subagent delegation-scope statement + return guidance injected into every chi...
- PTC tool-call allowance tied to timeout (`floor(timeoutMs/60000 x maxSubCalls...
- Fail-closed sandbox with a per-call escalation ladder: `SandboxPolicy` rides ...
- Four-stage tool pipeline (`tools/pre-execute` allow/deny/ask -> monotonic `gu...
- Compaction split: a tool-result pruner that trims oversized outputs BEFORE su...
- Deliverables recorder: a `present` tool declaring final files + a per-turn ch...
- Capability-seam discipline (Service Definition / Provider / Consumer) applied...
- Configurable providers activated from config without restart (`LlmConfigurabl...

### 5.8 Consolidated tiers across the second wave (9 partial)

- Stable provider failure codes, route-on-code
- Per-request OS/shell in the shell tool description
- Fail-closed sandbox + per-call escalation ladder + enforcement-completeness (...
- Richer typed hook / tool-pipeline lifecycle (pre/post, allow/ask/deny)
- KV-cache-preserving prompt/tool updates (append, do not rewrite the prefix)
- Per-call network egress authority (ask/allow/deny, parked connections, observ...
- Multi-dialect / provider-neutral tool + model layer
- Server mode + daemon recovery / Agent SDK surface
- Memory retrieval + background consolidation

### 6. Fourth steal wave: forgecode, takes T-1 to T-20 (1 partial)

- T-8

### 7. Open-work register: every deferred or partial r (108 partial)

- B. Repo map and context selection
- B. Repo map and context selection
- B. Repo map and context selection
- B. Repo map and context selection
- C. Loop mechanics and velocity
- C. Loop mechanics and velocity
- C. Loop mechanics and velocity
- C. Loop mechanics and velocity
- C. Loop mechanics and velocity
- C. Loop mechanics and velocity
- C. Loop mechanics and velocity
- C. Loop mechanics and velocity
- D. Process ownership and runtime safety
- D. Process ownership and runtime safety
- D. Process ownership and runtime safety
- E. Git and change control
- E. Git and change control
- E. Git and change control
- E. Git and change control
- F. Lint, verification and reflection
- F. Lint, verification and reflection
- F. Lint, verification and reflection
- F. Lint, verification and reflection
- G. Growth, memory and skills
- G. Growth, memory and skills
- G. Growth, memory and skills
- G. Growth, memory and skills
- G. Growth, memory and skills
- G. Growth, memory and skills
- G. Growth, memory and skills
- H. Model/provider layer
- H. Model/provider layer
- H. Model/provider layer
- H. Model/provider layer
- H. Model/provider layer
- H. Model/provider layer
- H. Model/provider layer
- I. UX, observability and developer surface
- I. UX, observability and developer surface
- I. UX, observability and developer surface
- I. UX, observability and developer surface
- I. UX, observability and developer surface
- J. Benchmarks and batch operations
- J. Benchmarks and batch operations
- J. Benchmarks and batch operations
- J. Benchmarks and batch operations
- J. Benchmarks and batch operations
- 3. Register candidates
- 3. Register candidates
- 4. What to do - the action queue
- 4. What to do - the action queue
- 4. What to do - the action queue
- 5.1 opencode
- 5.1 opencode
- 5.1 opencode
- 5.1 opencode
- 5.1 opencode
- 5.1 opencode
- 5.1 opencode
- 5.1 opencode
- 5.2 cline
- 5.2 cline
- 5.2 cline
- 5.2 cline
- 5.2 cline
- 5.2 cline
- 5.3 codex
- 5.3 codex
- 5.3 codex
- 5.3 codex
- 5.4 oh-my-pi
- 5.4 oh-my-pi
- 5.4 oh-my-pi
- 5.4 oh-my-pi
- 5.4 oh-my-pi
- 5.5 grok-build
- 5.5 grok-build
- 5.5 grok-build
- 5.5 grok-build
- 5.5 grok-build
- 5.6 Claude Code SDK/docs
- 5.6 Claude Code SDK/docs
- 5.6 Claude Code SDK/docs
- 5.6 Claude Code SDK/docs
- 5.6 Claude Code SDK/docs
- 5.6 Claude Code SDK/docs
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.7 DeepSeek harness
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.8 Consolidated tiers across the second wave
- 5.11 Specialised agent presets
- 5.12 Third TUI wave: Grok Build minimal-mode beh
- 6.1 Worth taking: T-1 to T-20

### 8. Repo-take steal wave (2026-11-12): learn from c (16 partial)

- 1
- 2
- 3
- 4
- 5
- 6
- 7
- 8
- 9
- 10
- 11
- 12
- 13
- 14
- 15
- 16


## W. Related plans and audits

| Doc | Role |
|---|---|
| `docs/superpowers/plans/2026-11-12-repo-take-steal-wave.md` | §8 implementation plan |
| `docs/29-final-audit.md` | Twelve-repo audit |
| `docs/audit/pass3/*` | aider 35, mini 41, hermes 38, omp 28 |
| `repo_take/notes/99-SYNTHESIS.md` | Competitive ordering (gitignored) |
| `docs/27-implementation-plan.md` | Build plan |
| `docs/MASTER-BACKLOG-ALL.md` | Wave summary (not duplicate of this file) |

## X. Design-only (no row = not queued)

`31-design-summary.md`, `14-surfaces.md`: web, desktop, IDE bridge, marketplace, collab, voice, SDK packages.

---

*Regenerate: extract from `30-steal-list.md` + `33-handoff.md`. Update after §7 status edits or ruling **343+**.*
