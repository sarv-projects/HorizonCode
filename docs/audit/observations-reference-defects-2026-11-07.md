# Reference-repo defect observations — 2026-11-07

> **Document class: historical evidence** (per `_conventions.md`, RC-14). No normative force. It records what the named audits already observed about the reference projects; where this file and a source record disagree, the source record wins and the disagreement is a defect to report. Every row is an observation about a *reference repo*, never a claim about HorizonCode (the same rule as `docs/29-final-audit.md` §B.1(d) and `docs/audit/README.md` §Caveats).

**Purpose.** Close `docs/30-steal-list.md` §4 item 11 — “Record the four repos’ defects as reference-repo observations, not ours” (`docs/30-steal-list.md#L201`) — by gathering, in one file, the defect / limitation records that pass-3 and the twelve-repo audit left scattered across five reports and two audit documents.

**Scope.** The pass-3 deep dives named in `docs/30-steal-list.md` §0 (`docs/30-steal-list.md#L9-L14`): aider, mini-swe-agent, hermes-agent, oh-my-pi; plus the DeepSeek/Anthropic observations the queue item names; plus — because this section’s subject is the DeepSeek/Anthropic record — the DeepSeek-Reasonix and claude-code upstream defects the corpus records elsewhere (§5; neither is named by the queue item, and both are labelled as additions).

**Method.** No upstream repository was re-read or re-verified for this file. Every row is transcribed (quoted or closely paraphrased) from an in-repo record and cited as `path#L…` to the line **in that record**, not to the upstream file line — the upstream anchors live inside the records. Where a defect is recorded in more than one place, it appears **once**, and every recording is cited in the same row. Where the corpus names a defect but does not detail it, the row says exactly that. Nothing new is derived here; a row without a citation would be a defect in this file.

**Snapshot.** 2026-11-07 — the date of the four pass-3 reports and of the adoption wave they feed (RC-15). The source record is as of that snapshot (`docs/audit/README.md#L26`).

**How to read a row.**

- **Class** is one of `defect` (behaviour the source report calls wrong), `limitation` (a recorded gap, cost, dead end or deliberate non-optimisation), `claim-unverified` (a published or external claim the source report could not verify from the repo).
- **Disposition in HorizonCode** is `no action` (reference-repo material — “Upstream defects are recorded, not ours to fix”, `docs/29-final-audit.md#L336`, `docs/29-final-audit.md#L100`), a named `NF-###` / document row where the corpus gives one, or `non-goal` where `docs/30-steal-list.md` §4’s “What *not* to copy” refuses it.

---

## 0. “Four repos”, five named sources — how the corpus splits it

The queue wording says “the four repos’ defects” (`docs/30-steal-list.md#L201`), and the document header counts “four pass-3 deep dives” (`docs/30-steal-list.md#L3`). The item text then names **five** defect records, because it writes the provider-specific cost-accounting defect as a separate clause from the two other aider defects. The source record splits it as follows.

| Queue clause (as written at `docs/30-steal-list.md#L201`) | Where the source record puts it | Section here |
|---|---|---|
| “aider’s duplicated repo-map capture (~1.41× weight inflation)” | aider report §5.1 **A** — aider’s own repo-map code | §1, row 1 |
| “DeepSeek/Anthropic cache-cost arithmetic” | aider report §5.1 **B** — the DeepSeek branch and the Anthropic mirror branch of **aider’s own** cost function. This is the fifth named source; it is not a separate clone. | §1, rows 2–3 |
| “`cur_tokens` double count” | aider report §5.1 **C** — aider’s own reminder-fit check | §1, row 4 |
| “mini-swe-agent’s three v1-leftover doc/fixture breaks” | mini-swe report §5.3 items 18–20 | §2, rows 1–3 |
| “hermes’ shallow-clone limitation” | hermes report §0.2, §5.1 O6, Appendix B | §3, row 1 |
| “oh-my-pi’s unstated metric contract and unasserted answer isolation” | omp report §1.1, §5.3 items 13–14 | §4, rows 1–2 |

So: **four clone-level sources** (aider, mini-swe-agent, hermes-agent, oh-my-pi — the four pass-3 dives) **plus one provider-named record** (DeepSeek/Anthropic, owned by §1 because that is where the corpus files it) = the five named sources of this document. Two further record sets carry the DeepSeek/Anthropic names in the wider corpus — **DeepSeek-Reasonix** (one of the twelve clones of `docs/29`, `docs/29-final-audit.md#L16`) and **claude-code**’s two stale-manifest defects (Anthropic’s CLI, recorded by `docs/29` §A.1 cluster 4 and §B.1(d)) — and are carried in §5 as labelled additions.

---

## 1. aider — `docs/audit/pass3/audit-aider-report.md`

Source record: 900 lines, clone `repo-tour/aider` @ `5dc9490`; the report states ~95 % coverage of the semantically relevant source and an explicit NOT-READ table (`docs/audit/pass3/audit-aider-report.md#L44`, `#L881-L896`).

### 1a. Named by the queue (`docs/30-steal-list.md#L201`)

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 1 | **Repo-map edge-weight inflation from a duplicated tag capture.** In `get_tags_raw` the last node of each tag is appended twice (a stray `captures_by_tag[tag].append(node)` sits outside the node loop). Under the tree-sitter-language-pack path — the default when the pack is installed — `references[name]` is a list, so `Counter(references[ident])` sees one extra reference and `sqrt(num_refs)` inflates that ident’s edge weight by **~1.41×**. The `matches` fallback path is unaffected, so rank order differs subtly between the two parser backends. Report’s fix: delete the stray append or dedupe by `(id(node), tag)`. | defect | `docs/audit/pass3/audit-aider-report.md#L712-L731`; named `docs/30-steal-list.md#L201` | no action (upstream defect). Note: the repo-map *algorithm* itself is separately adopted-adjacent — ranking note at `docs/09-tools.md#L242` via the folded `N-1` (`docs/30-steal-list.md#L39`, row B-1 at `#L57`) |
| 2 | **DeepSeek cache-hit cost is computed with a price where a token count belongs.** `input_cost_per_token_cache_hit` is a per-token *price* (order 1e-8), so `prompt_tokens - input_cost_per_token_cache_hit` is effectively `prompt_tokens`: the whole prompt is billed at the full rate **plus** the cache-hit tokens billed again at the discounted rate. Intended expression: `(prompt_tokens - cache_hit_tokens) * input_cost_per_token`. The report records why it survived: LiteLLM’s `completion_cost` is tried first and this function is only the fallback, and `/tokens` is documented as approximate. | defect | `docs/audit/pass3/audit-aider-report.md#L733-L742`, `#L746-L747`; named `docs/30-steal-list.md#L201` | no action (upstream defect; fallback-only path, per the report) |
| 3 | **Anthropic branch of the same function over-charges.** `prompt_tokens` already *includes* cache-read and cache-write tokens for that API, yet `cache_write_tokens × input_cost_per_token × 1.25`, `cache_hit_tokens × input_cost_per_token × 0.10` and `prompt_tokens × input_cost_per_token` are all added (“over-charging by the cache token counts”). | defect | `docs/audit/pass3/audit-aider-report.md#L744`, `#L746-L747`; named `docs/30-steal-list.md#L201` | no action (upstream defect) |
| 4 | **`cur_tokens` counted twice when deciding whether the format reminder will fit.** `ChatChunks.all_messages()` already ends with `+ self.cur + self.reminder`, but the check uses `messages_tokens + reminder_tokens + cur_tokens`, inflating the estimate by the current turn’s messages. Consequence: the harness **drops the system reminder earlier than necessary** — the format rules disappear while there is still room for them (“the opposite of what the feature intends”). | defect | `docs/audit/pass3/audit-aider-report.md#L749-L766`; named `docs/30-steal-list.md#L201` | no action (upstream defect) |

### 1b. Also recorded in the same report (not named by the queue item)

The report files these as its own optimisation / capability-gap candidates (§5.2–§5.3); they are carried here because they are defect-shaped records about the same repo. None is a HorizonCode finding.

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 5 | **Four-plus full tokenisations per turn** (`check_tokens` over the whole prompt; then `all_messages()`, `reminder_message` and `cur` counted separately; then again on failure) — “seconds of pure CPU per turn” on a 100k-token context. | defect | `docs/audit/pass3/audit-aider-report.md#L770-L773` | no action |
| 6 | **`get_file_mentions` rebuilds an invariant normalised word set inside the per-file loop** — O(files × words) churn on every user message. | defect | `docs/audit/pass3/audit-aider-report.md#L775-L786` | no action |
| 7 | **`GitRepo.path_in_repo` materialises a fresh tracked-file set on every call** (called from `allowed_to_edit`, `is_dirty`, `get_diffs`, repo-map setup) despite commit-keyed memoisation existing nearby. | defect | `docs/audit/pass3/audit-aider-report.md#L788-L801` | no action |
| 8 | **First Tab-completion reads and Pygments-lexes every in-chat file**; worse after `/read-only` on a directory. | defect | `docs/audit/pass3/audit-aider-report.md#L803-L807` | no action |
| 9 | **The repo-map binary search re-renders whole trees per probe** (`tree_cache` cleared; each probe calls `to_tree(ranked_tags[:middle], …)`). | defect | `docs/audit/pass3/audit-aider-report.md#L809-L812` | no action |
| 10 | **The LiteLLM price database (multi-MB JSON) is loaded synchronously on first model construction**, landing in perceived startup. | defect | `docs/audit/pass3/audit-aider-report.md#L814-L817` | no action |
| 11 | **`/tokens` prices every row at the input rate**, so with caching enabled the displayed `$` overstates cost and disagrees with the per-message `Cost:` line. | defect | `docs/audit/pass3/audit-aider-report.md#L821` | no action |
| 12 | **No lazy repo-map refresh** — any refresh rebuilds the whole graph and re-runs PageRank over every ident. | limitation | `docs/audit/pass3/audit-aider-report.md#L823` | no action |
| 13 | **No explicit context-budget allocator** — the repo map and history are budgeted, but read-only files, chat files and the system prompt are unbounded, so a large `/read-only` “can silently starve the map”. | limitation | `docs/audit/pass3/audit-aider-report.md#L825` | no action |
| 14 | **File renames are expressible only in the `patch` format** (`*** Move to:`); the default `diff` format needs a shell `mv`, so users who disable shell commands lose renaming entirely. | limitation | `docs/audit/pass3/audit-aider-report.md#L827` | no action |
| 15 | **No machine-readable output mode** — `--message` writes human-formatted text; scripted consumers must parse Markdown. | limitation | `docs/audit/pass3/audit-aider-report.md#L829` | no action |
| 16 | **No prompt snapshot tests** — the report calls this “the largest untested regression surface in the repo” (17 `*prompts*.py` modules change silently). | limitation | `docs/audit/pass3/audit-aider-report.md#L831` | the general discipline is recorded on our side as golden-prompt tests + prompt token budgets (`docs/29-final-audit.md#L153`, C-25, target doc 16) and queued at `docs/29-final-audit.md#L98` |
| 17 | **Scoping is only `--subtree-only` and `.aiderignore`** — the “1,000+ files, add `.aiderignore`” case is warned about, not solved. | limitation | `docs/audit/pass3/audit-aider-report.md#L833` | no action |
| 18 | **Summarisation triggers on edit-format change but not on a same-format model swap** — in-context few-shot examples and instruction-following quirks differ substantially between models sharing a format. | limitation | `docs/audit/pass3/audit-aider-report.md#L835` | no action |
| 19 | **The multimodal gate is a hard-coded extension allowlist that mislabels PDFs as images**, and any other binary document (`.docx`, `.xlsx`, `.zip`) falls through to a UTF-8 `read_text`, raises `UnicodeError`, and **is silently dropped** with an “`--encoding`” hint. | defect | `docs/audit/pass3/audit-aider-report.md#L837-L839` | no action |
| 20 | **Tool-call-based editing is unreachable** — `single_wholefile_func_coder` is commented out of `coders.__all__` and the other two `*_func_*` coders are never imported; the report calls them “Dead/disabled code”. | defect | `docs/audit/pass3/audit-aider-report.md#L121`, `#L273` | no action |
| 21 | **Deliberate absences** (§2 “What aider deliberately does **not** have”): no MCP client or server; no sandboxing or permission model beyond confirm prompts and static allowlists; no sub-agents or task delegation; no vector embeddings or semantic search (retrieval is lexical + graph-theoretic only). | limitation (deliberate) | `docs/audit/pass3/audit-aider-report.md#L288-L295` | no action — recorded as design centre of gravity, not as a defect |
| 22 | **Evidence-base limitation: the clone has no history** (`git log --oneline -10` returns a single squashed commit `5dc9490`), so no blame/churn/co-change archaeology was possible; all conclusions are from the working tree at that commit. | limitation | `docs/audit/pass3/audit-aider-report.md#L4`, `#L900` | no action; audit-process note (same class as §3 row 1) |

---

## 2. mini-swe-agent — `docs/audit/pass3/audit-mini-swe-report.md`

Source record: 1,007 lines; `minisweagent.__version__ = "2.4.6"`; 221 tracked files, all source / tests / docs read — the NOT-READ list is “assets-only” (`docs/audit/pass3/audit-mini-swe-report.md#L4`, `#L72-L73`).

### 2a. Named by the queue — the three v1-leftover doc/fixture breaks

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 1 | **A stale v1 leftover that fails at runtime.** `tests/test_data/update_outputs_github_issue.py` imports `minisweagent.run.extra.github_issue`, a module removed in v2, so the regeneration script raises `ImportError` — the `github_issue.traj.json` fixture can no longer be refreshed (the `local` counterpart still works). | defect | `docs/audit/pass3/audit-mini-swe-report.md#L975-L979`; flagged mid-report at `#L529-L535`; named `docs/30-steal-list.md#L201` | no action |
| 2 | **A documented command that cannot work.** `docs/reference/environments/swerex_modal.md:27` tells users to pass a config path that none of the five `get_config_path` candidates can resolve, so the copy-pasted command dies with `FileNotFoundError`; the file lives under `config/benchmarks/`. The same passage records that `config/__init__.py` still searches a `builtin/extra/` directory that no longer ships. | defect | `docs/audit/pass3/audit-mini-swe-report.md#L980-L984`, `#L532-L535`; named `docs/30-steal-list.md#L201` | no action |
| 3 | **`docs/contributing.md` steers contributors to the now-empty `run/extra/` folder** as the place specialised components go, so “the convention is unlearnable from the repository”. | defect (docs) | `docs/audit/pass3/audit-mini-swe-report.md#L985-L987`; named `docs/30-steal-list.md#L201` | no action |

### 2b. Also recorded in the same report (§5.1–§5.4)

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 4 | **`_check_finished` is copy-pasted 7×** and the timeout / exception-normalisation block 4× — any change to the submit contract must be applied seven times (drift risk). | defect | `docs/audit/pass3/audit-mini-swe-report.md#L920-L923` | no action |
| 5 | **`agent.cost` and `n_calls` are unlocked** while `GLOBAL_MODEL_STATS` is locked — fine for one-agent-per-thread, but a future shared-agent or async design would corrupt both. | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L924-L926` | no action |
| 6 | **`GLOBAL_MODEL_STATS` is a module-level singleton created at import** — env vars are read once and it can never be reset in-process by a library user. | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L927-L929` | no action |
| 7 | **`RequestyModel._calculate_cost` raises on `cost == 0.0` and ignores `cost_tracking`**, unlike every other model class — free/trial Requesty models are unusable while the documented escape hatch silently does not apply. | defect | `docs/audit/pass3/audit-mini-swe-report.md#L930-L932` | no action |
| 8 | **The `FormatError`-persistence contract is enforced only by tests, not by code.** | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L933-L935` | no action |
| 9 | **`OpenRouterTextbasedModel.__init__` builds the parent config and then rebuilds it** — harmless today, but any side-effecting validation would run twice (same shape in the response variant). | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L936-L938` | no action |
| 10 | **Dead code in the shipped agent:** `interactive.py:141-142` defines `_add_observation_messages`, which is never called. | defect | `docs/audit/pass3/audit-mini-swe-report.md#L939` | no action |
| 11 | **`_prepare_messages_for_api` deep-copies the whole history on every call** when cache control is enabled (the default for every Anthropic-family model name) — measurable per-step cost on a 250-step trajectory. | defect (cost) | `docs/audit/pass3/audit-mini-swe-report.md#L943-L946` | no action |
| 12 | **The trajectory is re-serialised on every step** (`finally: save()` → `serialize()` → `json.dumps`) — O(n²) disk/CPU per run at `step_limit=250`. | defect (cost) | `docs/audit/pass3/audit-mini-swe-report.md#L947-L949` | no action |
| 13 | **Observation truncation is character-based (10,000)**, not token-aware — different tokenizers get very different budgets. | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L950-L952` | no action |
| 14 | **`swebench.py` creates a fresh future per instance with no retry on transient environment failures** — a failed `docker pull` marks the instance failed and moves on. | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L953-L955` | no action |
| 15 | **`mini_extra.py` silently prints the help text for an unknown subcommand** — a typo looks like success. | defect | `docs/audit/pass3/audit-mini-swe-report.md#L959-L960` | no action |
| 16 | **`docs/reference/*` are mkdocstrings stubs**, so the API reference is only as good as the docstrings. | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L961-L963` | no action |
| 17 | **No `--version` flag** on `mini`/`mini-extra` (only the import-time banner). | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L964-L965` | no action |
| 18 | **The cost-tracking escape hatch is documented only in prose, and its error text points at an external short link** — an external dependency in the error path. | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L966-L968` | no action |
| 19 | **ProgramBench support is coupled to Docker internals** (`copy_submission` reads `env.container_id` and `env.config.executable`), so other backends cannot produce submissions. | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L969-L972` | no action |
| 20 | **`wall_time_limit_seconds` has no CLI flag** on `mini` (unlike `cost_limit`). | limitation | `docs/audit/pass3/audit-mini-swe-report.md#L973-L974` | no action |
| 21 | **Deliberate non-optimisations the report says should not be “fixed”:** bash-only (no file/patch/search tools), no history compression/compaction, no stateful shell session, text-mode parsing kept alongside tool calls, explicit and required config classes. | limitation (deliberate) | `docs/audit/pass3/audit-mini-swe-report.md#L989-L1003` | **non-goal** for the bash-only / no-compaction half — “deliberate for a benchmark, wrong for a product” (`docs/30-steal-list.md#L205`); the rest no action |

---

## 3. hermes-agent (hermes) — `docs/audit/pass3/audit-hermes-report.md`

Source record: 863 lines; 22,752 files / 1,209 directories enumerated; 21 files read in full and 14 in part, with an explicit NOT-READ table (`tests/`, `apps/`, `ui-tui/` enumerated only) (`docs/audit/pass3/audit-hermes-report.md#L40-L53`, `#L78-L95`).

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 1 | **Shallow clone — the queue-named limitation.** `git log --oneline -10` returns exactly one commit (`d4e7c343`): the checkout is a `--depth=1` snapshot of `origin/main`, so history-derived evidence (`git log -p -S`), authored-PR archaeology and the repo’s “proven red on the base” test claims are **not verifiable here**. The report’s O6 concludes: “Any future audit should clone with `--depth` disabled.” | limitation (evidence base) | `docs/audit/pass3/audit-hermes-report.md#L48`, `#L55-L58`, `#L806`, `#L862-L863`; named `docs/30-steal-list.md#L201` | no action (reference-repo checkout limitation); audit-process note: clone with `--depth` disabled in future audits (the report’s own recommendation) |
| 2 | **O1 — extreme module fragmentation** (73 `hermes_state_*.py`, 33 `turn_*.py`, ~130 `gateway/session_*.py`, 46 `run_*.py`). Fragmentation is *policy* (≤ 2,000 lines/file, CC ≤ 20) but has crossed into discoverability cost; “a single index doc per family would pay for itself”. | limitation | `docs/audit/pass3/audit-hermes-report.md#L801` | no action |
| 3 | **O2 — the complexity ratchets can make a file grow-only**: “units already over may only go down”, so a 300-line function can never be split below the ratchet without ceremony. | limitation | `docs/audit/pass3/audit-hermes-report.md#L802` | no action |
| 4 | **O3 — `cli-config.yaml.example` is 132 KB**, a full config dump committed as the documentation surface; “docs-by-dump drifts silently”. | limitation | `docs/audit/pass3/audit-hermes-report.md#L803` | no action |
| 5 | **O4 — comments carry incident IDs heavily** (`#85265`, `#140580`, `KB-12`, `#149708`, `NS-658`): excellent rationale retention, unreadable outside the tracker. | limitation | `docs/audit/pass3/audit-hermes-report.md#L804` | no action |
| 6 | **O5 — the test corpus is ~7× the production code** (7,898 files vs ~1,200 production modules): heavy behavioural-contract testing, but high maintenance drag. | limitation | `docs/audit/pass3/audit-hermes-report.md#L805` | no action |
| 7 | **O7 — auxiliary-path cost discipline is extensive but spread out** (input-token caps, context-fraction budgets, fallback chains, `reasoning_effort` no-ops that need a warning to be visible); a single “aux budget” surface would reduce the places a cost knob must be honoured. | limitation | `docs/audit/pass3/audit-hermes-report.md#L807` | no action |
| 8 | **O8 — `_last_resolved_tool_names` is a process-global** requiring save/restore around subagents; a documented foot-gun a contextvar would remove. | defect | `docs/audit/pass3/audit-hermes-report.md#L808` | no action |
| 9 | **O9 — Windows is a first-class platform with hand-rolled absolute paths** (88 KB `gateway_windows.py`, job objects via ctypes, inline `windows-footgun` markers): “enormous surface for one platform; worth quantifying whether native Windows earns the cost vs WSL2”. | limitation | `docs/audit/pass3/audit-hermes-report.md#L809` | **non-goal** for the full scheme — “take the contracts, not the adapters”; skip the Windows job-object path unless Windows is a real target (`docs/30-steal-list.md#L206`, `docs/audit/pass3/audit-hermes-report.md#L830-L831`) |
| 10 | **§5.3 “What *not* to copy”** (hermes): the full 25-platform gateway; the four-layer process-identity scheme in full; profile multiplexing unless multi-tenancy is a requirement; the per-area `AGENTS.md` count at the current granularity. | limitation (deliberate) | `docs/audit/pass3/audit-hermes-report.md#L826-L835` | **non-goal** — take the contracts, not the adapters (`docs/30-steal-list.md#L206`) |

---

## 4. oh-my-pi (omp) — `docs/audit/pass3/audit-omp-deep-report.md`

Source record: 298 lines, 10,291 files (excl. `.git`), snapshot 2026-11-07; the report states its own not-re-read set (`packages/{ai,tui,…}` internals, `python/robomp`, `sdk`, `nix`, `bazel`, `infra`, `patches`, CI config) (`docs/audit/pass3/audit-omp-deep-report.md#L5`, `#L15`, `#L294`).

### 4a. Named by the queue, and the claim-verification record the same queue item rests on

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 1 | **Unstated metric contract (queue-named).** No committed result files; the metaharness normalises `meanTrialMs` per arm — a **mean**, and a live dashboard metric, not a published number; `omp bench` medians are of **model** TTFT/decode, not agent runtime. The only committed numbers are README marketing rows with **“no stated metric/anchor/population/excludes”** — “exactly the contract the sibling repo Reasonix formalises and this one does not”. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L58`, `#L274`, plus §1 tables at `#L49`, `#L54`; named `docs/30-steal-list.md#L201`; the reading is `docs/30-steal-list.md#L29-L31` | **doc 16 §2.4.3 metric contract** (H-7 → R-ops-50), adopted 2026-11-07 from the adoption wave (`docs/16-operations.md#L151-L156`, `#L212`; queue sources `docs/30-steal-list.md#L139`, `#L198`) |
| 2 | **Unasserted answer isolation (queue-named).** “The answer-isolation precondition is not asserted in `if-bench` or `/ratchet`. Both grade agent output against material that may be readable from the same filesystem.” The sibling Reasonix refuses to run answer-bearing tasks without an OS read sandbox. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L275`; named `docs/30-steal-list.md#L201`; general item `docs/29-final-audit.md#L155` (C-27, target doc 16) and queued `docs/29-final-audit.md#L98` | **queued, not adopted**: `docs/30-steal-list.md#L198` (item 8, verification wave — “answer-isolation precondition on eval runs”); C-27 was not among the RC-15 folded insertions (`docs/29-final-audit.md#L361-L370`) |
| 3 | **Claim 1 — “fastest median runtime across agent benchmarks”: NOT-VERIFIABLE.** No agent-runtime benchmark result is committed anywhere in the tree; `find` for `*.jsonl`/`results*.json` returns zero benchmark outputs. What is verifiable is that the repo is built to be measured this way (four first-party adapters, a microVM Terminal-Bench runner, a 7-model floor pool). | claim-unverified | `docs/audit/pass3/audit-omp-deep-report.md#L49`, `#L66`; consolidated `docs/30-steal-list.md#L27` | no action (the claim is not repeated as fact; the metric contract is the corpus’s remedy) |
| 4 | **Claim 2 — “bypasses heavy multi-turn thinking loops”: PARTIAL.** Confirmed as an engineered posture (difficulty-routed thinking ceiling one tier below Max; two loop-guard prompts; Harmony/DSML leak re-sampling) but **refuted as literal** — “there is a real multi-turn loop with a nested work loop and an outer follow-up loop”. | claim-unverified | `docs/audit/pass3/audit-omp-deep-report.md#L50`, `#L67` | no action |
| 5 | **Claim 4 — “fewest tokens”: PARTIAL.** Mechanisms verified (stable-prefix/append-only log, output-budget fit, 3000-line/50 KiB caps, read summariser, shell minimiser on by default), but no comparative count is committed; the only committed token numbers are marketing deltas. | claim-unverified | `docs/audit/pass3/audit-omp-deep-report.md#L52`, `#L69` | mechanisms are adopted-adjacent (context-cost contracts, NF-074 at `docs/24-feature-catalog.md#L1052`); the number is not quoted |
| 6 | **Claim 5 — “fewest tool calls”: PARTIAL / NOT-VERIFIABLE.** No committed tool-count comparison exists; the bash interceptor ships 10 ordered rules but `bashInterceptor.enabled` defaults **false**, so it is opt-in. | claim-unverified | `docs/audit/pass3/audit-omp-deep-report.md#L53`, `#L70` | no action |
| 7 | **Claim 6 — “72 % pass rate / reasoning-for-velocity trade”: NOT-VERIFIABLE, and contradicted by the repo’s own numbers.** No `72` pass-rate figure exists anywhere in the tree; the repo’s own claims point to *higher* pass rates from better edit formatting; the one explicit velocity/reasoning trade (prewalk) is **off by default**. | claim-unverified | `docs/audit/pass3/audit-omp-deep-report.md#L54`, `#L71`, `#L58` | no action; verdict tally “1 CONFIRMED, 3 PARTIAL, 2 NOT-VERIFIABLE” at `#L73` (claim 3, “batches commands”, is the CONFIRMED one — see NF-072 at `docs/24-feature-catalog.md#L1031`) |

### 4b. Also recorded in the same report (§5.1–§5.4)

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 8 | **Tools/generated-index drift:** `docs/tools/` documents 34 tools while `BUILTIN_TOOL_NAMES` lists 30 + 3 hidden and 88 files live in `prompts/tools/`. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L256` | no action |
| 9 | **The 279-file prompt corpus has no index**; 42 of the 88 `tools/` files are result/notice templates, not descriptions. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L257` | no action |
| 10 | **`bashInterceptor.enabled` defaults false while its rules already ship** — “the cheapest token win in the tree … and it is off”. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L258` | no action |
| 11 | **The KDL compat cascade has a reference doc but no authoring doc** — nothing explains how to add a provider or resolve `AmbiguousOverlapError`. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L259` | no action |
| 12 | **`docs/` does not document `if-bench`, `/ratchet`, or the metaharness metric contract** — three evaluation mechanisms with user-facing entry points and no doc page. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L260` | no action |
| 13 | **`agent-session.ts` is 15,853 lines** and `sdk.ts` 5,979 — the file every session feature edits. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L264` | **non-goal** for the monolith — “steal the mechanisms, not the sprawl” (`docs/30-steal-list.md#L208`) |
| 14 | **`streamAssistantResponse` (~660 lines) inlines the whole stream-event switch**, including two large near-duplicate finalisation paths. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L265` | no action |
| 15 | **Per-turn prompt templating risk** — the prompt corpus is build-time text, but the system prompt is rebuilt whenever a tool roster or setting changes; the report proposes precompiling + memoising with a test asserting the cache hit. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L266` | no action |
| 16 | **`if-bench` and `/ratchet` are local-only gates with no CI dry-run** — harness rot can only be found by running the real thing. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L267` | no action |
| 17 | **No golden-file test for the base system prompt** — it is rendered per session from dozens of conditionals, so “what the prompt actually said in this configuration” is only observable at runtime. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L271` | the general discipline is C-25 / doc 16 (`docs/29-final-audit.md#L153`); queued per `docs/29-final-audit.md#L98` |
| 18 | **No committed token budget for the prompt corpus** — nothing fails a build when it grows. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L272` | as row 17 |
| 19 | **`scripts/rewrite-system-prompt.ts` has no `--check` mode** — it cannot verify the committed prompts still satisfy the style contract. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L273` | no action |
| 20 | **`if-bench` does not report the two failure modes it was designed to separate** — the score should carry both components so a model change is attributable. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L276` | no action |
| 21 | **Role-ladder resolution is not reported** — `role-defaults` lists dozens of candidate ids per role (slow alone ~30) and resolution picks the first authenticated/enabled one; nothing journals which arm served a session. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L280` | no action |
| 22 | **`thinkingBudgets.max` and `thinkingBudgets.xhigh` are both 32,768** while `auto`’s ceiling defaults to `XHigh` — the documented “one tier below the top” rule is moot for any model that caps out at the same number on both tiers. | defect | `docs/audit/pass3/audit-omp-deep-report.md#L281` | no action |
| 23 | **Speculative execution commits no measurement of its hit rate** — there is no counter for “candidates started” vs “candidates committed”, the one number that tells you whether the feature earns its complexity. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L282` | no action |
| 24 | **The `web/` role ladder lists ten providers before any fallback** and `image`/`speech`/`dictation` are similarly long — each fallback step is a silent capability downgrade a user cannot see. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L283` | no action |
| 25 | **`ovnfs` fallbacks are invisible in tool results** — daemons are advertised as the default way to make a second copy, but nothing says whether a search ran in the overlay or silently fell back to native. | limitation | `docs/audit/pass3/audit-omp-deep-report.md#L284` | no action |

---

## 5. DeepSeek / Anthropic observations

The queue’s “DeepSeek/Anthropic cache-cost arithmetic” is **recorded once, in §1** (aider rows 2–3: the DeepSeek branch and the Anthropic mirror branch of aider’s own cost function, `docs/audit/pass3/audit-aider-report.md#L733-L747`). It is not duplicated here. This section carries the further DeepSeek- and Anthropic-related records the corpus holds elsewhere. **Neither sub-table is named by the queue item**; both are included because they carry the same two names, and both are labelled so a reader can tell them apart from the item-11 set.

### 5a. DeepSeek-Reasonix (a twelve-repo-audit clone, not a pass-3 dive)

Clone of record: `docs/29-final-audit.md#L16` (10,918 files). Its pass-2 report is a known-truncated original, superseded by the delta report (`docs/audit/README.md#L43`, `docs/audit/audit-grok-ds-ompi-delta.md#L52`).

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 1 | **Docs describe a package that is absent from the snapshot.** The `ISOLATION_*`/`ISOLATED_*` docs describe an `internal/runtime/isolation` package and its refusal codes, but that package does not exist in the checkout while the Studio frontend still ships the refusal strings — “Treat the isolation docs as *design of record* for a subsystem missing from this snapshot, not as documentation of shipped code.” | defect (code/doc drift) | `docs/audit/audit-grok-ds-ompi-delta.md#L155`, `#L466`; recorded at `docs/29-final-audit.md#L100` | no action (upstream defect) |
| 2 | **`benchmarks/README.md` says “Six harnesses live under `benchmarks/`” while the tree has 15 suites** — “a stale doc, but also evidence the corpus grew without the README”. | defect (docs) | `docs/audit/audit-grok-ds-ompi-delta.md#L216`, `#L466`; recorded at `docs/29-final-audit.md#L100` | no action; the general gate idea (docs vs tree) is the delta report’s §4.2 item 12 (`#L506`), and the adopted doc-side response is **doc 16 §2.4.2** generated-reference drift (`docs/16-operations.md#L148`) |
| 3 | **`docs/SPEC.md` §2 and `CONTRIBUTING.md` describe an older package layout** that no longer exists (“three self-inflicted drifts” in the delta report’s §4.1). | defect (docs) | `docs/audit/pass2/DeepSeek-Reasonix-report.md#L42`; `docs/audit/audit-grok-ds-ompi-delta.md#L466` | no action (upstream defect) |
| 4 | **No in-CLI eval hillclimb gate** — the repo has the benchmark harnesses but not a keep/revert gate of the kind oh-my-pi’s `/ratchet` provides. | limitation | `docs/audit/audit-grok-ds-ompi-delta.md#L497` | related HorizonCode owner: eval hillclimb gates in the host → **NF-034** (`docs/30-steal-list.md#L126`, G-8) |
| 5 | **Benchmark reports record numbers without a cross-repo stated population/exclusion** — the same gap as oh-my-pi’s (§4 row 1), named in the delta report’s cross-repo recommendation. | limitation | `docs/audit/audit-grok-ds-ompi-delta.md#L508` | **doc 16 §2.4.3** metric contract (`docs/16-operations.md#L151-L156`) |
| 6 | **Three historic mechanism errors that a missing metric contract allowed** — the corpus names them (`benchmarks/README.md` documents them) but does not reproduce them anywhere in `docs/`. Recorded here exactly as named, without detail. | limitation (recorded without detail) | `docs/audit/audit-grok-ds-ompi-delta.md#L230` | no action (the corpus does not say more than this) |
| 7 | **Evidence-base limitation: the pass-2 DeepSeek-Reasonix report is truncated mid-sentence** (it stops inside §8.1, so §8.2 and later sections were never written) and is superseded by the delta report; the truncated original is preserved in-repo as an honest artifact. | limitation | `docs/audit/README.md#L43`; `docs/audit/audit-grok-ds-ompi-delta.md#L52`; `docs/29-final-audit.md#L28`, `#L355` | no action (historical artifact kept exactly as found) |

### 5b. claude-code (Anthropic’s CLI — recorded by the claude-code + codex delta)

| # | Observation | Class | Source | Disposition in HorizonCode |
|---|---|---|---|---|
| 8 | **Imports an enforcement package absent from its own manifest.** `sandbox-adapter.ts` wraps `@anthropic-ai/sandbox-runtime`, which is absent from both `package.json` dependencies and the tree — “the sandbox silently cannot be constructed from this tree”, a stale-manifest gap alongside the `zod` v3-vs-v4 one. | defect | `docs/audit/audit-claude-codex-delta.md#L120-L132`, `#L472`, `#L488`, `#L497`; recorded at `docs/29-final-audit.md#L52`, `#L100` | no action (upstream defect); related owner for fail-closed confinement: **NF-016** (`docs/24-feature-catalog.md#L516`) |
| 9 | **SDK type modules referenced by the public entrypoint are missing from the archive.** `agentSdkTypes.ts` re-exports five SDK type modules that do not exist in the tree (only three sibling files exist), and `coreTypes.ts` documents a codegen contract whose script is absent. | defect | `docs/audit/audit-claude-codex-delta.md#L140-L141`, `#L497`; recorded at `docs/29-final-audit.md#L52`, `#L100` | no action (upstream defect) |
| 10 | **An undocumented sandbox key read via `.passthrough()`** (`enabledPlatforms`, added to unblock one enterprise rollout) — it gates behaviour yet is invisible to anyone reading the typed settings surface. | limitation | `docs/audit/audit-claude-codex-delta.md#L121`, `#L476` | no action |

---

## 6. Counts, and what this does not claim

### 6.1 Counts per source (mechanical count of the tables above)

| Source | Rows | of which named by `docs/30` §4 item 11 | defect | limitation | claim-unverified |
|---|---|---|---|---|---|
| aider (`§1`) | 22 | 4 | 13 | 9 | 0 |
| mini-swe-agent (`§2`) | 21 | 3 | 9 | 12 | 0 |
| hermes-agent (`§3`) | 10 | 1 | 1 | 9 | 0 |
| oh-my-pi (`§4`) | 25 | 2 | 1 | 19 | 5 |
| DeepSeek / Anthropic (`§5`) | 10 | 0 (the item-11 record lives in §1 rows 2–3) | 5 | 5 | 0 |
| **Total** | **88** | **10** | **29** | **54** | **5** |

### 6.2 What this does not claim

1. **No upstream repository was re-read, rebuilt or re-verified in this pass.** Every observation is as recorded by the named audits, at the snapshot they state; the reference clones drift independently of this repo (`docs/audit/README.md#L26`), and a later pass records that the clones were not even present in the container that ran it, so upstream `source:` citations remain unverified there (`docs/audit/pass5/repo-wide-audit-2026-11-07.md#L31`). Re-verification would be a new audit, not a reading of this file.
2. **Nothing here is a HorizonCode defect.** Upstream defects “are observations, not claims about HorizonCode” (`docs/audit/README.md#L28`); they “are recorded, not ours to fix” (`docs/29-final-audit.md#L336`), and are logged as such at `docs/29-final-audit.md#L100`. A disposition of `no action` means exactly that — not “resolved”.
3. **The line anchors are in-repo.** Every `#L…` in this file points at a line in a file under `docs/`, never at an upstream file line; the upstream file anchors (and each report’s own NOT-READ / coverage ledger) live inside the cited reports.
4. **Coverage is bounded by the source reports’ own coverage.** Each pass-3 report states what it did not read (e.g. hermes’ `tests/`, `apps/`, `ui-tui/` enumerated only; oh-my-pi’s `packages/*` internals not re-read) and each clone has its own depth (aider is history-free; hermes is a one-commit shallow checkout). An absence of a defect row for a subsystem means the corpus does not record one, not that the subsystem is clean.
5. **The counts in §6.1 are counts of rows in this file**, not of defects in the reference repos, and not deduplicated against the reports’ own numbering (a row may bundle a report subsection, e.g. the two “what not to copy” rows).

---

## Related documents

- `docs/30-steal-list.md` — the adoption queue this file closes item 11 of; its §0 names the four pass-3 sources and its §4 “What *not* to copy” supplies the `non-goal` dispositions used above
- `docs/29-final-audit.md` — the twelve-repo audit; §B.1(d) is the upstream-defect register rule, §A.1 cluster 4 and §B.1(d) hold the claude-code records, Part C C-25/C-27 the queued verification items
- `docs/audit/pass3/` — the four deep-dive reports every §1–§4 row is transcribed from
- `docs/audit/audit-grok-ds-ompi-delta.md`, `docs/audit/audit-claude-codex-delta.md`, `docs/audit/pass2/DeepSeek-Reasonix-report.md` — the §5 records
- `docs/audit/README.md` — the audit index and the caveat that upstream defects belong to the reference repos
