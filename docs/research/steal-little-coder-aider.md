# Steal pass — little-coder + aider recheck (2026-11-13)

> **Class: research note (non-normative).** Clones live under gitignored `repo_take/` (not committed). Pins below. HorizonCode goal: cater to **all** facets — local, cloud, small and frontier models — without weakening the trust spine. Overall product goal remains **NOT COMPLETE** (`docs/GOAL-PROGRESS.md`).

## Pins

| Name | GitHub | Full SHA | Local clone |
|---|---|---|---|
| little-coder | [itayinbarr/little-coder](https://github.com/itayinbarr/little-coder) | `89d4fa0af864230527ab75d12604ed0eb320e6df` | `repo_take/little-coder` |
| aider | [Aider-AI/aider](https://github.com/Aider-AI/aider) | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | `repo_take/aider` |

Prior aider audit: `docs/audit/pass3/audit-aider-report.md` (still says “not cloned” in prose — **stale**; clone now verified). Steal register: `docs/30-steal-list.md` §A/B/E.

---

## little-coder — identity

**What:** Apache-2.0 coding agent **tuned for small/local LLMs** (Qwen3.5 9B / Qwen3.6 35B-A3B on llama.cpp), built as **pi + ~35 extensions + skills + Python benchmarks** — not a pi fork. Thesis: **scaffold–model fit** beats raw scale (paper claims large Polyglot lifts vs vanilla Aider for the same small model).

**Stack:** Node ≥22.19, `@earendil-works/pi-coding-agent`, Vitest, Playwright. Launcher `bin/little-coder.mjs` runs `pi --no-extensions` + explicit bundled extensions (~7k cold-start). Cloud models also work via pi providers; product default is local.

**HorizonCode stance:** Do **not** adopt pi. Port **policies / pure functions / thresholds** into HZ loop, tools, providers, catalog. LC is a measured **local-model policy catalog**, not a substrate.

### Local/small-model load-bearing mechanisms (summary)

| Mechanism | Key knobs / constants | Why it helps weak models |
|---|---|---|
| `llama-cpp-provider` | `/props` `n_ctx` probe; router per-model windows; `LLAMACPP_*` / Ollama / LM Studio base URLs | Wrong context window → silent overflow or premature compact |
| `context-watchdog` | Compact at **80%**; `MIN_PROGRESS_PCT=5` anti-loop | Mid-run compaction on 16–32k windows |
| `local-estimate` | Ollama usage untrusted; `CHARS_PER_TOKEN=4`; max(reported, estimated); truncate if est > 1.5× reported | Fixes post-truncation under-count |
| `output-parser` | Fenced / XML / bare JSON / LFM2; repair JSON; **never execute** recovered calls; known-tool filter | Small models emit prose tool calls |
| `read-guard` | Head **30** lines; fallback 0.5 of remaining budget | Prevents context flood |
| `read-guard-edit` | Block `edit` until path was `read` (or prior write) | Stops blind edits |
| `write-guard` | Refuse overwrite → force `edit` recipe | ~57% Polyglot exercises need this (paper) |
| `skill-inject` / `knowledge-inject` | Budgets **300** / **200** tok; score ≥ **2.0**; **tail** inject for KV cache | Short cards beat long system prompts |
| `quality-monitor` | Empty / unknown tool / repeat-loop; max **2** steers | Harness interventions without inventing tools |
| `thinking-budget` | Default **4096** tok (`chars/3.5`); abort + force-off | Caps reasoning waste |
| `benchmark-profiles` | Local temp **0.3**; TB `max_turns` **40** | Eval / product profiles for local |
| `phase-model` | Plan model vs action model; avoid same-model VRAM reload | Big plan / small implement on one GPU |
| Cold-start harness | Fixed `AGENTS.md` + `--no-context-files` | Predictable ~7k start |

---

## Disposition matrix — little-coder → HorizonCode

Legend: **TAKE** = adapt into HZ · **ALREADY** = present (pointer) · **SKIP** = refuse · **DEFER** = later

| Item | Disposition | Notes |
|---|---|---|
| Pi substrate / extension loader | **SKIP** | HZ native `loop.ts` + kernel |
| Copy `AGENTS.md` / branding | **SKIP** | Conflicts with HZ authority rails; extract ideas only |
| llama.cpp / LM Studio first-class + `n_ctx` probe | **TAKE** | Today: `openai` / `ollama` providers; no `/props` probe |
| Mid-run compact @ 80% + hysteresis | **TAKE** | HZ has `compaction.ts` / hold; missing autonomous mid-run threshold |
| Ollama local usage estimate reconcile | **TAKE** | Port `local-estimate.ts` into `providers/ollama.ts` |
| Tail inject for ephemeral guidance (KV) | **TAKE** | Keep system-rail authority; add non-authority augment channel for local |
| Skill/knowledge card inject (error > recency > intent) | **TAKE** | Content+selector; budgets 300/200; tool allow-list aware |
| Read overflow trim (30 lines) | **TAKE** | Policy on `read` tool results vs window |
| Read-before-edit gate | **TAKE** | Stronger than stale-preimage alone |
| Quality-monitor steer (cap 2) | **TAKE** | Empty / unknown-tool / repeat-call |
| Output-parser repair + known-tool filter | **TAKE (subset)** | HZ toolconv exists; steal repairJson / LFM2 diagnostic; never invent tool args |
| Write-refuse-existing → edit | **ALREADY** | Guard + edit ladder NF-069; verify error recipe quality |
| Checkpoints / rewind | **ALREADY** | `checkpoints` + `/rewind` (wave 14c); LC weaker file snapshots |
| Instruction hierarchy | **ALREADY** | `instructions.ts` (stricter caps than LC 4k) |
| Subagents | **ALREADY** | `agent` spawn; **TAKE** serial-default + read-only default semantics |
| Shell session / auto-background | **ALREADY (partial)** | `shell_session` + `shell-auto-background` (45s); **TAKE** event wake_on pattern |
| Plan mode / deep-research f2 | **DEFER** | Large UX; steal budget math later |
| Phase plan/action models | **DEFER** | Useful for local VRAM; needs dual-endpoint doctor honesty |
| Thinking-budget abort | **DEFER** | Only if HZ exposes thinking streams productively |
| Browser / GAIA evidence pack | **DEFER** | Unless benchmark pillar |
| Bash prefix permission whitelist | **SKIP** | HZ kernel guard + approvals; different trust model |
| Turn-cap / benchmark profiles | **TAKE** | Eval `max_turns` + local temp profiles via catalog/config |
| Playwright browser tools | **DEFER / SKIP as core** | Prefer MCP; don’t vendor Playwright into core |

---

## aider recheck — git-native tools

Clone verified at pin above. Aider’s thesis is **git as undo/state**. HZ deliberately uses **change-journal + checkpoints** (ruling **36**) with **optional** git. Do not switch HZ to auto-commits.

| Mechanism | Aider | HZ | Disposition |
|---|---|---|---|
| Auto-commit after every edit | `base_coder.auto_commit` | Journal + `undo` | **SKIP** (ruling 36) |
| Dirty-commit-before-edit | default-on | `git-dirty-checkpoint.ts` opt-in `HZ_GIT_DIRTY_COMMIT_BEFORE_EDIT=1` on `edit` only | **TAKE** deepen E-1: default policy decision + wire `write`/`apply_patch` |
| Separate lint-fix commit | after `lint_edited` | lint tools; no post-lint commit | **TAKE** (E-1 residual) |
| LLM `/commit` / `hzcode commit` | chat+diff+weak model | `commit.ts` staged-only ruling **83** | **TAKE** E-3: weak-model chain + optional chat slice |
| Attribution env author/committer | full truth table | trailers only (`commit-attribution.ts`) | **TAKE** (E-2 residual) |
| `/undo` via git hashes | git reset rails | journal undo + `/rewind` | **SKIP** as primary; optional safety rails if ever git-undo |
| `/diff` since pre-message HEAD | `commit_before_message` | `turn-diff.ts` journal | **TAKE** optional HEAD-anchored `/diff` |
| `/git` passthrough | `GIT_EDITOR=true` | guarded `shell` | **SKIP** |
| Auto `git add` on edit | yes | no | **SKIP** |
| `ai!` / `ai?` file watch | `watch.py` | none | **TAKE (new E-5 candidate)** |
| Repo map PageRank | tree-sitter | lexical PageRank ruling **19** | **ALREADY**; tree-sitter still deferred (zero-dep) |
| Edit ladder / reflection | coders | NF-069 done | **ALREADY** |
| Cache breakpoints / keepalive | models/cache | B-4 partial | **ALREADY / residual** (live measure needs keys) |
| Synthetic ack after context slabs | yes | rejected **203** | **SKIP** |

### New aider candidates not previously in docs/30

1. **E-5** — `watch.py` `ai!`/`ai?` annotation → interrupt + excerpt prompt.
2. HEAD-anchored turn `/diff` (complements journal `turn.diff`).
3. Orphan-branch `get_diffs` composite for empty repos (`repo.py`).
4. Lint workflow: dirty-commit → isolated lint coder → second commit.
5. Default AI co-author trailer with model id (policy choice; may conflict with honesty).

---

## Cross-cutting “supersede all” priorities (local + cloud)

HorizonCode already has a stronger **trust spine** than either LC or aider (kernel guard, receipts, EffectHost, sandbox). Gaps that matter for **all models** (especially local/small) without regressing cloud:

1. **Local provider truth** — llama.cpp OpenAI-compat + live `n_ctx` probe; Ollama usage reconcile.
2. **Context economy** — mid-run compact hysteresis; read trim; skill/knowledge **tail** inject with budgets.
3. **Weak-model tool hygiene** — quality steer; output-parser repair; read-before-edit; known-tool filter.
4. **Git UX (optional, not state machine)** — finish E-1/E-2/E-3; optional watch E-5; never default auto-commit.
5. **Eval profiles** — turn caps + local temperature profiles in catalog (LC benchmark-profiles pattern).

Do **not** chase: pi lock-in, auto-commits as undo, bash allowlist replacing kernel, wholesale LC `AGENTS.md`, Playwright-in-core, speculative execution (UNWIRED **65**).

---

## License

| Source | License | Copy vs adapt |
|---|---|---|
| little-coder | Apache-2.0 (+ NOTICE / ClawSpring / pi attribution) | Adapt algorithms into HZ modules; preserve NOTICE if copying files |
| aider | Apache-2.0 (`LICENSE.txt`) | Same — adapt ideas; attribution if copying |

Never invent a HorizonCode root `LICENSE` from these (owner decision still **OPEN**).
