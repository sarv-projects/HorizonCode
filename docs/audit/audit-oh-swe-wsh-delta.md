# Delta audit — OpenHands · SWE-agent · wshobson/agents

**Purpose.** Second, exhaustive pass over three repos already covered by earlier reports
(`/tmp/deep-openhands-report.md`, `/tmp/deep-sweagent-aci-report.md`, `/tmp/deep-wshobson-report.md`).
This pass reads *everything remaining*: every Python file + config in SWE-agent, every agent
markdown in wshobson-agents, every markdown + prompt + tool/permission/runtime file in OpenHands.
Findings are things the earlier reports **did not** contain. Report-only; nothing in any repo was modified.

Repo roots

| Short name | Path | HEAD | Earlier report |
|---|---|---|---|
| OpenHands | `OpenHands` (repo not cloned, path not verified) | `56342def7820ebe26218f24a407105394d458fbb` (2026-11-06) | `/tmp/deep-openhands-report.md` |
| SWE-agent | `SWE-agent` (repo not cloned, path not verified) | 436 files; 100 `.py`, 61 yaml, 15 tool bundles | `/tmp/deep-sweagent-aci-report.md` |
| wshobson | `wshobson-agents` (repo not cloned, path not verified) | 92 plugins (79 with agents); 202 agent `.md`, 185 `SKILL.md`, 105 command `.md` | `/tmp/deep-wshobson-report.md` |
| OpenHands | (above) | 2860 files; 85 `.md`, 10 contributor skills, 30 feature-map files | `/tmp/deep-openhands-report.md` |

Status: COMPLETE (2026-11-06). Section 0 records exactly what was and was not read.

---

## 0. Coverage and method

| Repo | Tree | Read in full this pass | Read mechanically / sampled | Not read |
|---|---|---|---|---|
| SWE-agent | 436 files: 100 `.py`, 61 yaml, 15 tool bundles, 12 configs, 9 docs | all 12 configs + all 15 `tools/*/config.yaml` and their `bin/`/`lib/`/`install.sh`; core `sweagent/**` modules (agent, environment, tools, run, utils, hooks, exceptions, types) | — | `tests/**`, `tools/web_browser/lib/browser_manager.py` body, `utils/log.py`, `run/rich_test.py`, `inspector/static.py` body (§1.A.22 lists these) |
| wshobson-agents | 92 plugins, 202 agent `.md`, 185 `SKILL.md`, 105 commands, `tools/`, `docs/`, `evals/`, `.github/workflows` | ship-mate (2 commands, 6 agents), agent-teams (7 commands, 6 skills), conductor (6 commands, 3 skills), plugin-eval (docs, plugin files + static/engine/harness_portability/rubrics), `tools/adapters/*`, `Makefile`, `evals/*`, `docs/{plugin-eval,round-trip-results,harnesses}` | all 202 agent files by mechanical extraction (frontmatter keys, headings, `tools:`, Workflow Position, Key Distinctions, Strict Boundaries); ~30 skills/commands read for technique | the remaining ~150 skills' bodies (domain knowledge), `tools/yt-design-extractor`, `mlops` workflow internals |
| OpenHands | 2860 files, 85 `.md`, `.agents/skills/**`, `src/**` | all repo-level and `docs/` markdown (AGENTS.md, architecture, ACP_AGENTS, DefenseClaw, DEVELOPMENT, SELF_HOSTING, TESTING_MATRIX, CANVAS_EXTENSIONS_TESTING, README); the whole `verify-openhands` skill tree incl. feature-map index, daily/report/adaptation contracts, backfill notes; `src/` tool/permission/runtime surface (client tools, tool catalog, profile tools, system-message adapter, automation permissions, runtime service, claim/ledger utils); `.agents/skills/{custom-codereview-guide,release}.md` | `src/**` UI components and stores beyond the seams named above; `helm/`, electron internals; `tests/e2e/**` bodies | the 29 per-feature map files' bodies (index + contract + one file read), `docker/` entrypoint internals |

**Method.** Every finding below was read directly in this session; nothing is inferred from the earlier reports. Where a claim depends on a file that was not read, it is marked as such (§1.A.22 gap list). Repos were treated as read-only: no file in any repo was modified.

---

## 1. Missed features (file-cited)

### 1.A SWE-agent — things neither report mentioned

#### 1.A.1 The **in-band control-channel token protocol** (the single biggest omission)

The ACI talks to the *harness*, not just the model, through sentinel strings embedded in the command
output that the harness strips before the model sees them. Three tokens, three control-flow outcomes:

```text
###SWE-AGENT-RETRY-WITH-OUTPUT###
###SWE-AGENT-RETRY-WITHOUT-OUTPUT###
###SWE-AGENT-EXIT-FORFEIT###
```

`SWE-agent/sweagent/agent/agents.py` (repo not cloned, path not verified)

```python
RETRY_WITH_OUTPUT_TOKEN = "###SWE-AGENT-RETRY-WITH-OUTPUT###"
RETRY_WITHOUT_OUTPUT_TOKEN = "###SWE-AGENT-RETRY-WITHOUT-OUTPUT###"
EXIT_FORFEIT_TOKEN = "###SWE-AGENT-EXIT-FORFEIT###"
```

Dispatched in `handle_action` (`SWE-agent/sweagent/agent/agents.py` (repo not cloned, path not verified)):

```python
if RETRY_WITH_OUTPUT_TOKEN in step.observation:
    step.observation = step.observation.replace(RETRY_WITH_OUTPUT_TOKEN, "")
    raise _RetryWithOutput()
elif RETRY_WITHOUT_OUTPUT_TOKEN in step.observation:
    step.observation = step.observation.replace(RETRY_WITHOUT_OUTPUT_TOKEN, "")
    raise _RetryWithoutOutput()
elif EXIT_FORFEIT_TOKEN in step.observation:
    raise _ExitForfeit()
```

The semantics (in `forward_with_handling`, `SWE-agent/sweagent/agent/agents.py` (repo not cloned, path not verified)):
`RETRY_WITH_OUTPUT` re-queries the model **with** the (token-stripped) tool output as a normal
observation; `RETRY_WITHOUT_OUTPUT` silently re-queries **without** adding anything — the erroneous
turn never enters the history; `EXIT_FORFEIT` terminates and triggers autosubmission. The tool
*chooses the recovery policy*, and because the token is stripped, the model never learns the
channel exists. This is how `windowed_edit_replace/edit` implements "a failed edit costs one model
turn instead of a broken tree": the editor emits the token, the harness re-asks with the editor's
own error text.

**Why it was missed.** The earlier report quotes the retry marker as a line of editor output but reads
it as cosmetic. It is a *protocol*: tool → harness control messages over the observation channel.

**Adoptable as-is.** HorizonCode's tool-result envelope should reserve a machine-only channel that
(1) the model never sees, (2) can request one of a small closed set of recovery policies
(retry-with-output / retry-silently / abort-and-finalize) that the runtime honours, and (3) is
stripped from the durable record's model-visible projection while remaining in the log.

#### 1.A.2 Every error path in the step loop terminates in **autosubmission**

The agent never just dies. For a catalogue of exception classes the loop instead *finalises the
work product* and returns a scored-comparable submission:

`SWE-agent/sweagent/agent/agents.py` (repo not cloned, path not verified)

```python
except _ExitForfeit:            -> "exit_forfeit"
except _TotalExecutionTimeExceeded: -> "exit_total_execution_time"
except CommandTimeoutError:     -> "exit_command_timeout"
except ContextWindowExceededError: -> "exit_context"
except CostLimitExceededError:  -> "exit_cost"
except RetryError:              -> "exit_api"
except SwerexException:         -> "exit_environment_error"
except RuntimeError:            -> "exit_error"
except Exception:               -> "exit_error"
# after max_requeries format/blocklist/syntax failures:
                                   -> "exit_format"
```

`attempt_autosubmission_after_error` (`SWE-agent/sweagent/agent/agents.py` (repo not cloned, path not verified))
re-runs `git add -A && git diff --cached > /root/model.patch` in the container, and if the container
is already dead it falls back to the **`diff` recorded in the last trajectory step's `state`**
(line 840-848: `if "diff" not in last_trajectory_step["state"]: ... return`). Two nested salvage
levels beneath the failure.

**Adoptable.** A run that ends badly should still emit its best available artifact, and the
termination reason should be an enumerated, typed field, not a string in a log line.

#### 1.A.3 `exit_status` is a first-class typed outcome used for **scoring and selection**

Not a log message. It threads into the reviewer (`failure_score_penalty` applied when
`exit_status != "submitted"`, `SWE-agent/sweagent/agent/reviewer.py` (repo not cloned, path not verified))
and into the chooser (which *filters the candidate pool down to submitted runs* when at least two
submitted, `SWE-agent/sweagent/agent/reviewer.py` (repo not cloned, path not verified)):

```python
n_submitted = sum(s.info.get("exit_status", "") == "submitted" for s in input)
if n_submitted >= 2:
    self.logger.debug(f"Got {n_submitted} submitted submissions, only using them")
    selected_indices = [i for i, s in enumerate(input) if s.info.get("exit_status", "") == "submitted"]
```

#### 1.A.4 A complete **best-of-N / retry architecture** (`RetryAgent`, `ScoreRetryLoop`, `ChooserRetryLoop`)

`SWE-agent/sweagent/agent/agents.py` (repo not cloned, path not verified) and
`SWE-agent/sweagent/agent/reviewer.py` (repo not cloned, path not verified).
Nothing about this exists in the earlier report, which treats "submit" as the end of the story.

| Component | Behaviour worth noting |
|---|---|
| `RetryAgent._next_attempt` | On retry: `self._env.hard_reset()` — the **container is rebuilt, not just the context**. Each attempt gets a clean environment, so a corrupted tree cannot poison attempt 2 |
| `RetryAgent._setup_agent` | Rotates through `agent_configs[i % len]` — retries can *switch ACI/config*, not only model |
| Budget narrowing | `remaining_budget = cost_limit - spent; if remaining_budget < agent_config.model.per_instance_cost_limit: agent_config.model.per_instance_cost_limit = remaining_budget` — the sub-agent is *re-budgeted* per attempt so the sum cannot exceed the loop's cap |
| Failsafe | `if self._total_instance_stats.instance_cost > 1.1 * cost_limit > 0: ... Triggering autosubmit` — 10% overshoot tolerance before force-finalise |
| Trajectory on disk | `attempts: [...]` plus the *chosen* attempt flattened at the top level and `info.best_attempt_idx` — one file carries all attempts, the winner is addressable |
| `Reviewer.review` | `n_sample` independent scores (default 5), **averaged**, minus `failure_score_penalty`, minus `reduce_by_std * stddev(scores)` — a variance penalty that prefers *confidently* good runs |
| `score_range` | Out-of-range scores are *rejected* (`raise ValueError`) rather than clamped |
| `get_best` tie-break | Equal scores → **fewest API calls** (`sorted(max_indices, key=lambda i: self._submissions[i].model_stats.api_calls)`) |
| `Chooser` | Two-stage: optional `Preselector` (LLM returns an index *list*) shortens the pool to ≤ N before the chooser LLM picks one; regex-parses the last integer of the last line; on any failure falls back to index 0 / all indices |
| `TrajectoryFormatter` | Before review, the trajectory is *projected*: `filter` (drop steps whose action starts with X), `output_filter` (+ `only_show_last_n_output`) which replaces `observation` with the literal `"[Output omitted]"` — the reviewer sees the plan, not 40 KB of `grep` output |

#### 1.A.5 The **history-processor pipeline** is 7 stages, and one of them is ACI-aware

`SWE-agent/sweagent/agent/history_processors.py` (repo not cloned, path not verified)
(`HistoryProcessor` = discriminated union of 7). Earlier report knew only 2-3 of these.

| Processor | What it really does |
|---|---|
| `default` | No-op |
| `last_n_observations` | Elides all but the last `n` observations **with three refinements the earlier report missed**: (a) `polling` — the elision boundary moves only every `polling` steps, so the prefix stays byte-stable and **prompt caching survives**; (b) `always_keep_output_for_tags` / `always_remove_output_for_tags` with default tag sets `{keep_output}` / `{remove_output}` let individual observations opt out of elision in either direction; (c) the *first* observation (the instance template) is never removed, and the elided text is quantified — `"Old environment output: (N lines omitted)"` plus `" (M images omitted)"` when images were dropped |
| `tag_tool_call_observations` | Tags action entries by tool name (`function_names`), so a policy like "always keep every `submit` output" is configurable without a code change |
| `closed_window` | **Parses the windowed ACI's own rendering** (`\[File: (.*) \(\d+ lines total\)\]` and the `^\d+:.*` line pattern), walks history **backwards**, keeps the most recent window for each file intact and replaces every *older* window with `"Outdated window with N lines omitted..."` |
| `cache_control` | Anthropic `cache_control: ephemeral` on the last `last_n_messages` (default 2) with `last_n_messages_offset` (skip the last message you are about to mutate — avoids a cache mismatch) and `tagged_roles: [user, tool]` |
| `remove_regex` | Regex-strips arbitrary spans (default `<diff>.*</diff>`) from history; `keep_last` protects the tail |
| `image_parsing` | Converts `![alt](data:image/png;base64,…)` markdown embedded in *observations* into multimodal `image_url` content blocks at query time, MIME-allowlisted |

**Adoptable.** This is a *declared, ordered, type-discriminated* context-transform pipeline between the
raw history and the provider call — a concrete answer to "where does compaction live?" that is
cheaper than summarisation for the common case (stale file windows, stale search output, images).
`closed_window` in particular is only possible because the *tool output format is a contract*.

#### 1.A.6 Model layer details with direct budget/caching consequences

`SWE-agent/sweagent/agent/models.py` (repo not cloned, path not verified)

| Device | Where | Why it matters |
|---|---|---|
| Multi-key rotation with **thread affinity** | `choose_api_key`, `choose_api_key_by_thread`, keys separated by `:::` or `$ENV_VAR` (L155-L190) | Thread-affine keys exist *specifically so batch runs keep prompt caching* — a different key is a different cache namespace |
| Pre-flight context check | `_single_query` L690-L703 — tokenises the message list and raises `ContextWindowExceededError` **before** sending | Fail fast rather than paying for a 400 |
| Three independent budget dimensions | `per_instance_cost_limit`, `total_cost_limit`, `per_instance_call_limit` (L73-L78, enforced L654-L670) | Cost *and call count*; a global `GLOBAL_STATS` behind a `Lock` aggregates cross-instance spend |
| Cost-measurement is mandatory when budgeting | L743-L755: if `litellm.completion_cost` fails **and** any limit is set → `ModelConfigurationError` | "If you cannot measure, you must not enforce a budget silently" |
| Settings encoded in the run id | `GenericAPIModelConfig.id` L192-L201 → `name__t-0.20__p-0.95__c-2.00` | Reproducibility as a naming convention |
| Non-retryable error set | L809-L833 — 14 exception types are excluded from tenacity retries (context, cost, auth, content-policy, `UnsupportedParamsError`, …); everything else retries 20× with random-exponential 10–120 s backoff | The distinction between "retry the transport" and "do not retry a permanent failure" is explicit |
| Fault-injection DSL | `_handle_raise_commands` L328-L341 — action strings `raise_runtime`, `raise_cost`, `raise_context`, `raise_function_calling <code> [msg]` | The test suite drives every error path by asking the model to *say* the failure |
| `convert_system_to_user` | L98-L101 | Reasoning models that reject a system role |
| Anthropic output-cap special case | L608-L620 (Claude 3.7/4 → 64 k unless the 128 k beta header is present) | Provider quirk handled once, centrally |

#### 1.A.7 Action sampling — self-consistency built into the loop (two strategies)

`SWE-agent/sweagent/agent/action_sampler.py` (repo not cloned, path not verified)

- `ask_colleagues` (L49-L93): sample `n=2` completions, render a "colleagues" discussion block,
then one final query that must return a tool call. `extra_info["colleagues"]` records the discussion.
- `binary_trajectory_comparison` (L153-L314): a **tournament**. Sample `min_n_samples=4`,
drop unparseable ones, drop duplicate actions, then — `if contains_edits(completions) and
min < max` — sample *more* (up to `max_n_samples=10`) **because edits are the risky action class**.
Then a bracket: keep `best_idx`, challenge with each remaining candidate via a 3-message
prompt (system + problem/trajectory + the two candidates), parse `first`/`second` from the last line,
and cache-control the problem/trajectory block once the pool is ≥ 3. Full `comparison_log` recorded.

**Adoptable.** Two cheaply-implementable deliberation modes, keyed off the *action class* (prompt more
when the action mutates) rather than off a global setting.

#### 1.A.8 Task statements have **two projections** (env vs model)

`SWE-agent/sweagent/agent/problem_statement.py` (repo not cloned, path not verified) and L187-L192:

```python
def get_problem_statement_for_env(self) -> str:
    """Used for setting environment variables in the container."""
    return self.get_problem_statement()   # multimodal subclass: returns self.text (no images)
```

And the id is content-addressed: `sha256(text)[:6]` for text/task statements (L83-L87),
`owner__repo-i<n>` for GitHub issues (L143-L147). Images are downloaded with a 10 MB cap, an
incremental abort mid-stream, MIME allowlist (`png/jpeg/jpg/webp`) and cached in a `PrivateAttr`.

**Adoptable.** (a) the same task can be shown to the model and to the sandbox differently — say so in
the schema; (b) task ids derived from content make dedup/replay free.

#### 1.A.9 Templates are validated and warned about, and the pipeline tolerates empty ones

`SWE-agent/sweagent/agent/agents.py` (repo not cloned, path not verified) — every `*_template`
field is passed through `_warn_probably_wrong_jinja_syntax`, and a missing `system_template` warns
with a doc link instead of raising. There is a separate `strategy_template` appended after the
instance template, and `put_demos_in_history` marks each demo entry `is_demo: True` so later
processors (`last_n_observations`, `closed_window`) can treat demonstrations as untouchable.
#### 1.A.10 The lint gate is **narrower and more configurable** than "flake8 the file"

`SWE-agent/tools/windowed/lib/flake8_utils.py` (repo not cloned, path not verified):

```python
def flake8(file_path: str) -> str:
    """Run flake8 on a given file and return the output as a string"""
    if Path(file_path).suffix != ".py":
        return ""
    cmd = registry.get("LINT_COMMAND", "flake8 --isolated --select=F821,F822,F831,E111,E112,E113,E999,E902 {file_path}")
```

Three things the earlier report got wrong or omitted: (a) the select list is **syntax/definition-only**
(`F821/F822/F831` undefined names, `E111/E112/E113` indentation, `E999` syntax error, `E902` IO error) —
never style; (b) only `.py` files are linted at all; (c) the command is **overridable per-run** via the
registry key `LINT_COMMAND`, so the gate is a *policy hook*, not a hard-coded flake8.

The diagnostic-diff algorithm is also more careful than "new errors":
`SWE-agent/tools/windowed/lib/flake8_utils.py` (repo not cloned, path not verified)

- previous errors are **line-shifted** by the edit (`lines_added = replacement_n_lines - replaced_span`);
- errors *inside* the replaced window are always re-reported (never "pre-existing");
- new errors *above* the window are dropped as "shadowed" by the pre-existing ones.

There are **two lint policies in the same repo**, deliberately:
`windowed_edit_*` / `windowed_edit_rewrite` **revert** on a new error (blocking), while
`edit_anthropic/bin/str_replace_editor` has an opt-in `USE_LINTER` flag that *applies the edit anyway*
and appends a warning, with the text: *"In rare cases, the linter errors might not actually be errors or
caused by your edit. Please use your own judgement."*
(`SWE-agent/tools/edit_anthropic/bin/str_replace_editor` (repo not cloned, path not verified)).

#### 1.A.11 `str_replace_editor` internals the earlier report never opened

| Device | Anchor | Why it matters |
|---|---|---|
| **Exit codes are a structured protocol** (1..21) | `str_replace_editor` throughout: 5 unrecognized command, 6 relative path, 7 missing path, 8 exists-on-create, 9 dir, 10–14 bad `view_range`, 15/16/161 not-found / multiple / no-op, 17 bad `insert_line`, 18 empty undo history, 19 decode failure, 20 write failure, 21 missing parent dir | The *class* of failure is machine-visible without parsing prose |
| **Encoding fallback ladder** | `read_file`: `(None,None) → utf-8 → latin-1 → utf-8 + errors='replace'` | Real containers contain non-UTF-8 files; four attempts instead of a crash |
| **Tab normalisation** | `str_replace`: `file_content/old_str/new_str` all `.expandtabs()` before comparison | Kills the classic "model emits spaces, file has tabs" false negative |
| **`WindowExpander`** — snap a viewport to syntactic boundaries | `_find_breakpoints`: score 1 = blank line, 2 = double blank, 3 = `def`/`class`/`@` (`.py` only) or file start/end; expands **outward only**, ≤ `max_added_lines=30` per side | A line range becomes a *semantic* range. Used on `view`, and again after an edit to render the confirmation snippet |
| **Undo stack lives in the registry** | `_file_history` = `defaultdict(list)` persisted as JSON under the registry key `file_history`, keyed by path; `undo_edit` pops and rewrites | Per-file undo works even though each tool call is a fresh process |
| **`str_replace` returns a ±4-line snippet of the *new* file** | `SNIPPET_LINES = 4`, then `WindowExpander` on the snippet range | The model verifies the result without a second read |
| `maybe_truncate` + filemap fallback | `MAX_RESPONSE_LEN = 16000`; `.py` over the cap with `USE_FILEMAP=true` gets the tree-sitter skeleton, with a `<NOTE>` telling the model to use `view_range` next; if filemap raises, it falls back to clipped content | Failure of the optimisation degrades to the original behaviour, never to an error |

#### 1.A.12 `filemap` is a **tree-sitter query**, and the elision rule is stated in the query

`SWE-agent/tools/edit_anthropic/bin/str_replace_editor` (repo not cloned, path not verified)

```python
query = language.query("""
(function_definition
body: (_) @body)
""")
elide_line_ranges = [
    (node.start_point[0], node.end_point[0])
    for node, _ in query.captures(tree.root_node)
    if node.end_point[0] - node.start_point[0] >= 5
]
```

Elides a body when the body node spans ≥ 5 lines; elided lines are replaced by
`"... eliding lines {start+1}-{end+1} ..."` and kept lines are printed as `"{:6d} {line}"`. The file also
carries an explicit `TODO` about *not* eliding docstrings.

#### 1.A.13 The windowed editor family is **four** implementations, not three

`tools/windowed_edit_rewrite` (absent from the earlier report) declares a single verb:

```yaml
tools:
  edit:
    signature: |
      edit <text>
    docstring: >
      Replace the currently displayed lines with <text>.
```

`SWE-agent/tools/windowed_edit_rewrite/config.yaml` (repo not cloned, path not verified) — i.e. *"replace the
window, wholesale"*, with the same lint-gate/revert semantics (`bin/edit` in that bundle is a
near-copy of the replace variant with the same `_LINT_ERROR_TEMPLATE`). The windowed family is therefore
a 2×2 matrix: {search/replace-in-window, replace-window-wholesale} × {linting, non-linting} plus the
line-range variant.

The shared failure template is worth quoting for its anti-thrash sentence:
`SWE-agent/tools/windowed_edit_rewrite/bin/edit` (repo not cloned, path not verified)

```text
Your changes have NOT been applied. Please fix your edit command and try again.
DO NOT re-run the same failed edit command. Running it again will lead to the same error.
```

#### 1.A.14 The dry-run / replay harness: a trajectory is re-executable from its own config

`SWE-agent/sweagent/run/run_replay.py` (repo not cloned, path not verified)

- The `.traj` file records `replay_config`, and `_get_config_from_agent` re-validates it into a
  `RunSingleConfig`; the *whole environment and agent configuration travels inside the trajectory*.
- `--update_config` merges a new config over the recorded one, **preserving `agent.model` unless the
  update names it** (L108-L118) — "same actions, new toolset".
- A **compatibility gate** before replay (L138-L171): if any assistant item has `tool_calls` but the
  chosen `parse_function` is not `function_calling`, it refuses with an actionable message rather than
  replaying nonsense.

#### 1.A.15 Multi-run plumbing worth naming (batch/parallel/economics)

| Device | Anchor | Note |
|---|---|---|
| **Deterministic shuffle** | `run/batch_instances.py#L67-L84`: `sorted(..., key=id)` **then** `random.seed(42)` then shuffle | Slice/shuffle selections are reproducible across machines — required for fair A/B |
| **Resume = read the artifact** | `RunBatch.should_skip` (`run_batch.py#L376-L409`) | Skip iff a `.traj` exists with a non-empty `info.exit_status` that is not `early_exit`; an unparseable or empty traj is **deleted** and redone |
| **Per-instance log fan-out** | `run_batch.py#L411-L424` | `{id}.trace.log` / `.debug.log` / `.info.log` per instance, filters keyed by thread name |
| **Thundering-herd damping** | `run_batch.py#L89-L94`, L296-L297 | random startup delay ≤ `random_delay_multiplier × (workers-1)` |
| **Exit-status histogram artifact** | `run/_progress.py#L147-L162` | Every batch writes `run_batch_exit_statuses.yaml` = `{instances_by_exit_status, total_cost}` |
| **Continuous evaluation** | `run_batch.py#L223-L233` | `SweBenchEvaluate(..., continuous_submission_every=30)` — partial predictions are submitted to the upstream evaluator every 30 finished instances |
| **Config-mutually-exclusive gate** | `run_batch.py#L119-L130` | `evaluate` + `redo_existing` is refused with the *reason* (the merged `preds.json` would be evaluated with stale entries) |
| **Run identity in the directory name** | `run_single.py#L68-L80`, `run_batch.py#L103-L117` | `trajectories/<user>/<config-stem>__<model-id>___.<instance-id>`; the model id encodes temperature/top-p/cost limit |
| **Replay config written next to the result** | `run_single.py#L196-L197`, `run_batch.py#L343-L346` | `config.yaml` / `{id}.config.yaml` are dumped beside the trajectory, and absolute paths are *stripped back to repo-relative* (`utils/config.py#L30-L39`) for portability |

#### 1.A.16 "Promising" is a defined predicate, and it gates irreversible actions

`SWE-agent/sweagent/run/common.py` (repo not cloned, path not verified)

```python
def _is_promising_patch(info: AgentInfo) -> bool:
    """Do we actually believe that the patch will solve the issue?
    Or are we just submitting the last patch we generated before hitting an error?
    """
    # The exit status can also be `submitted (exit_cost)` etc.
    return info.get("exit_status") == "submitted" and info.get("submission") is not None
```

It gates both the "🎉 Submission successful 🎉" message and **applying the patch to a local repo**
(`run/hooks/apply_patch.py#L36-L49`). A patch that was auto-submitted after `exit_cost` is saved but not applied.

#### 1.A.17 The PR hook: preconditions before an irreversible external side effect

`SWE-agent/sweagent/run/hooks/open_pr.py` (repo not cloned, path not verified) — six gates, in order:
no submission → not `exit_status == submitted` → not a GitHub issue → **issue not open** →
**issue already assigned ("Be nice :)")** → issue locked → already-associated commits (configurable via
`skip_if_commits_reference_issue`). Then the PR is created as a **draft**, and the trajectory is embedded
in the body inside `<details>` with `char_limit=60_000`, triple-backticks escaped, and a
`"... (truncated due to length limit)"` marker.

**Adoptable directly.** Any tool that mutates the outside world should (1) re-read the target's current
state, (2) refuse when someone else is already on it, (3) default to the reversible/draft form, and
(4) record the evidence inline.

#### 1.A.18 Environment device set

| Device | Anchor | Detail |
|---|---|---|
| 6-step repo reset chain | `environment/repo.py#L31-L39` | `git fetch; git status; git restore .; git reset --hard; git checkout <base>; git clean -fdq` — run on every attempt |
| Reset-opt-out | `PreExistingRepoConfig.reset: bool = True` | "Do not reset this repo" is a *declared* option, not a hack |
| Dirty-repo guard, test-aware | `LocalRepoConfig.check_valid_repo` L98-L107 | Refuses a dirty local repo — **except under pytest** (`"PYTEST_CURRENT_TEST" not in os.environ`) |
| Container plumbing | `swe_env.py#L184-L190` | session started with `startup_source=["/root/.bashrc"]`, `startup_timeout=10`, and env defaults `LANG/LC_ALL=C.UTF-8, PIP_PROGRESS_BAR=off, PAGER=cat` set *before* tools install |
| Fatal command ⇒ close first | `swe_env.py#L225-L231` | On `check="raise"` failure the deployment is **stopped before the exception propagates** — no orphan containers |
| SIGINT to the session | `swe_env.py#L192-L194` | `BashInterruptAction` after a timeout, before giving up |
| `state.json` contract | `tools/tools.py#L317-L348` | Reset to `{}`; read+JSON-parsed each turn; a non-dict is a hard error; `mock_state` allows tests to bypass the environment entirely |
| Declared-tool availability check | `tools/tools.py#L276-L312` | After install, `which <name>` for **every** declared command (bash exempt); missing ⇒ `RuntimeError` at setup, not a mysterious mid-run failure |
| Tool-name collision detection | `tools/tools.py#L168-L191` | Two bundles declaring the same verb ⇒ `ValueError` naming both source paths |
| `enable_bash_tool=False` requires a structured parser | `tools/tools.py#L205-L211` | Without function calling / JSON, the bash tool cannot be dropped (there would be no way to invoke anything) |
| `propagate_env_variables` | `tools/tools.py#L86-L92` | With the honest warning that propagated secrets are readable in debug logs |
| Jinja syntax linting of templates | `agents.py#L127-L133`, `tools/utils.py` via `Argument.validate_argument_format`, `utils/jinja_warnings.py` | Every `*_template` field and every `argument_format` is checked for `{var}`-instead-of-`{{var}}` and warns |
| Argument/signature consistency | `tools/commands.py#L167-L205` | Required-before-optional, unique names, name-pattern, and **the set of `{}` keys in `invoke_format` must equal the declared argument names** |
| Per-argument rendering templates | `Argument.argument_format` (`commands.py#L70`) + `_should_quote` (`tools/utils.py#L39-L43`) | Each argument is rendered through its own Jinja template and shell-quoted *unless* the command is `bash` or multiline |
| Heredoc guarding | `tools/utils.py#L8-L36` | Multi-line verbs have `<< 'end_name'` appended to their first line so the outer `bash` consumes the body |
| Failure-class exit codes + structured format errors | `exceptions.py` (`FunctionCallingFormatError(message, error_code, **extra_info)` with `error_code ∈ {missing, multiple, incorrect_args, invalid_json, invalid_command, missing_arg, unexpected_arg}`) | The error template is *parameterised by* `error_code`, so each failure gets its own advice |
| Trajectory/session identity | `__init__.py#L50-L105` | Each run records `swe_agent_hash`, `swe_agent_version`, `swe_rex_version`, `swe_rex_hash`; a version lower-bound check (`impose_rex_lower_bound`) fails fast at import |

#### 1.A.19 Parsing: 11 parsers, not 6

`SWE-agent/sweagent/tools/parsing.py` (repo not cloned, path not verified) — the union is
`ActionParser | ThoughtActionParser | ActionOnlyParser | XMLThoughtActionParser | XMLFunctionCallingParser |
FunctionCallingParser | EditFormat | Identity | JsonParser | BashCodeBlockParser | SingleBashCodeBlockParser`.
New to the catalogue: `EditFormat` (window-replacement), `Identity` (no parsing), `JsonParser`
(`strict` mode distinguishes "unknown command" from "pass it through as text"), `XMLFunctionCallingParser`
(a grader-compatible tag format that also aliases `execute_bash`→`bash` and `finish`→`submit`),
`BashCodeBlockParser` / `SingleBashCodeBlockParser` (with `thought = <extracted_code_block>` substitution so
code is not repeated in both thought and action).

Every parser carries a **Jinja error template keyed by `error_code`** so one template renders
missing/multiple/unexpected-arg/missing-arg advice, and `FunctionCallingParser._parse_tool_call` validates
required args, rejects unknown args (tolerating `end_name` leakage), JSON-parses string arguments, and
special-cases `view_range` needing the literal form `[<start>, <end>]`.

#### 1.A.20 Action sampling, revisited (mechanics)

`SWE-agent/sweagent/agent/action_sampler.py` (repo not cloned, path not verified)

- `ask_colleagues` (`n_samples=2`): the *discussion* is stored in `extra_info["colleagues"]`; the final
  query is made with the discussion appended as a user message and must return a tool call — the
  rendered prompt ends with `<important>You must include a thought and action (as a tool/function call).
  Do not try to invoke commands with triple backticks, use function calls instead.</important>`.
- `binary_trajectory_comparison`: `min_n_samples=4`, `max_n_samples=10`; **dedupe by action string**;
  "contains any edit" ⇒ sample up to the max; pairwise bracket with `best_idx`; `use_cache_control`
  when the pool ≥ 3; every pairwise comparison is logged with both candidate indices, the messages, the
  response and the verdict (`comparison_log`); an uninterpretable verdict defaults to `"first"` and a
  warning. Ops are described to the judge as *junior developers* whose actions an expert must choose
  between, with the problem statement and the trajectory so far in the prompt.

#### 1.A.21 Smaller things that change behaviour

- `config/default.yaml` puts the **entire review loop text into the config** as the registry variable
  `SUBMIT_REVIEW_MESSAGES` (a list of stages), i.e. submission policy is data, not code.
- `tools/review_on_submit_m/bin/submit` keeps a `SUBMIT_STAGE` counter in the registry, substitutes
  `{{diff}}` **and** `{{problem_statement}}` (the latter from the container env var the agent itself set),
  takes the hidden `-f/--force` flag, and prints the submission sentinel **twice** around the patch.
- `tools/multilingual_setup/install.sh` imports env vars from `/proc/1/environ` (excluding `PWD|LANG|PYTHONPATH|ROOT|PS0|PS1|PS2|_|OLDPWD|LC_ALL|LSCOLORS|SHLVL`), de-duplicating `PATH` while preserving
  order, and adds a Python 3.11 shim when the image lacks `python`.
- `tools/diff_state` writes the current patch into `/root/state.json["diff"]` **before every model turn**, so
  every step carries a fresh diff; on exception it sets the diff to `""` rather than leaving a stale value.
- `RunSingle` writes **three** log files per instance (trace/debug/info) plus the trajectory, the
  predictions and the config; `AgentInfo` also carries `edited_files30/50/70` (the diff re-rendered at
  30/50/70 lines of context) as ready-made review inputs.
- `sweagent/__main__.py` is 4 lines; the CLI is a `pydantic-settings` `CliApp` over the same config
  classes that the YAML files populate, with `--print_config` and `--help_option <FullClassName>`.

---

---


#### 1.A.22 Surfaces this pass found that neither report nor the earlier sections mention

Completing the "every python file + config" sweep surfaced four capabilities and one honest gap list:

* **`tools/web_browser` is a 15th ACI bundle — a stateful interactive browser, not a fetch tool.** `tools/web_browser/config.yaml` declares 16 verbs: `open_site`, `close_site`, `screenshot_site`, `click_mouse <x> <y> [button]`, `double_click_mouse`, `move_mouse`, `drag_mouse <json path>`, `type_text`, `scroll_on_page`, `execute_script_on_page <js>`, `navigate_back/forward`, `reload_page`, `wait_time <ms>`, `press_keys_on_page <json keys>`, `set_browser_window_size <w> <h>`, `get_console_output`. Coordinates are *pixel* coordinates with a rendered red crosshair (L21-L72), i.e. a vision/coordinate ACI rather than a DOM ACI. `lib/web_browser_utils.py` L13-L28 shows two screenshot modes (`SAVE` to png, `PRINT` as base64 to stdout) and a URL normaliser that maps an existing local path to a `file://` URL and a bare host to `https://`; the service is a Flask app with a `validate_request` decorator (L31-L43) so a non-JSON or partially-specified request is rejected with a structured error.
* **`sweagent/inspector/` is a trajectory-inspection product surface.** `inspector/server.py` serves trajectories over HTTP and *prepends the problem statement* as a synthetic first step by extracting the first `user` message (L15-L36) and appends a synthetic "Model Submission" step from `info.exit_status`/`info.submission` (L39-L50) — i.e. it renders a trajectory as a *readable story* without mutating the artefact on disk. `inspector/static.py` L22+ emits a standalone HTML "Trajectory Viewer" template. `sweagent/run/run.py` L21-L27 documents the CLI surface around them: a **terminal** viewer (`inspect`), a **web** viewer (`inspector`), `run-replay`, `traj-to-demo`, and `run-api` ("Run swe-agent as a backend for a GUI").
* **`sweagent/run/compare_runs.py`** is an A/B tool for batches: `get_resolved` / `get_submitted` set difference, `stats_single`, `compare_many` with per-instance **emoji deltas** (L35) and `compare_pair(new, old, show_same=False)` (L69) — i.e. run-to-run regression reading that does not need the evaluator.
* **`sweagent/run/hooks/swe_bench_evaluate.py`** is a full evaluation hook, not just a scorer: `SweBenchEvaluate(RunHook)` with `continuous_submission_every`, `_get_sb_call(preds_path, submit_only)`, `check_running_calls()`, `on_instance_completed`, `move_sb_cli_report()` and `on_end()` (L19-L107) — it owns the subprocess lifecycle of the official harness and its report files.
* **`sweagent/utils/github.py`** parses both issue and repo URLs (`github.com/o/r/issues/N`, `@github.com/o/r`) and caches repo privacy per `owner/repo` (L12-L33) — the piece that lets the PR hook decide what it may do with a repository.
* **`docs/usage/memory_sentinel.py`** is an operational safety script with its provenance attached: it polls available RAM and SIGKILLs the highest-memory process once less than 5 GB is free (L38-L60), and the file header records that it was "generated by Claude 3.7" from a quoted prompt. It is the only artefact in any of the three repos that admits an LLM wrote it *and* keeps the generating prompt.
* **Gap list — read mechanically but not opened**: `sweagent/inspector/static.py` beyond the template header, `tools/web_browser/lib/browser_manager.py`, `sweagent/utils/log.py`, `run/rich_test.py`, and the test suite (`tests/**`, 30+ files) beyond the fixtures already cited. Everything else in the 100-file Python tree, all 12 configs and all 15 tool bundles (config + `bin/` + `lib/` + `install.sh`) was read.

---

### 1.B wshobson/agents — things the earlier census missed

---

#### 1.B.1 `ship-mate` is a state-machine router, not a "pipeline plugin"

The earlier report (S5.1/S2.8) described ship-mate as "the orchestrated pipeline" and read `orchestrate.md` + `review.md`. The real artefact is `plugins/ship-mate/commands/ship.md`, which is a **deterministic stage router with an explicit on-disk state schema**:

```json
{ "story_file": "stories/foo.md", "task_index": 0, "current_task": "[first unchecked task]",
  "task_type": null, "stage": "scan",
  "iteration": { "review": 0, "qa": 0 },
  "checkpoints": { "scan": "pending", "orchestrate": "pending", "architect": "pending",
                   "implement": "pending", "review": "pending", "qa": "pending", "playwright": "pending" },
  "flags": { "review_critical_pending": false, "qa_bugs_pending": false, "escalated": false },
  "last_updated": "[ISO timestamp]" }
```

* `plugins/ship-mate/commands/ship.md` L37-L67 — schema written to `.claude/pipeline/state.json`.
* L113-L180 — per-stage routing: `scan`→`orchestrate`→`architect`→`implement`→`review`→`qa`→`playwright`.
* **Three explicit human gates**, each with a printed banner and a hard stop: architect plan (`checkpoints.architect = "awaiting_approval"`, L119-L130), critical review finding (L139-L147), and QA escalation after 2 failures (`flags.escalated = true`, L157-L165).
* L189-L196 — **Anti-Loop Guards**, named as rules: *Repeated Blocker Rule* (same blocker twice in one delegation chain → escalate to human), *No Cyclic Handoff* (never send work back to a stage that already handled the same issue), *Two-Handoff Rule* (2 unresolved handoffs on one issue → pause and escalate), backed by the `iteration` caps.
* L174-L180 — task completion resets all checkpoints and iterations before the next task; `last_updated` is required on every state write (L202).

Neither earlier report mentioned the state file, the pause points, or the anti-loop guards — i.e. the entire mechanism by which the pipeline is resumable and cannot spin.

#### 1.B.2 The ship-mate agent definitions carry a **deviation protocol** and leaked project assumptions

* `plugins/ship-mate/agents/implement.md` L40-L54: plan-feasibility verification with a mandated *do-not-silently-skip* message format, and an unusual **default-to-proceed** policy — "Proceeding with adjustment unless instructed otherwise". This is the opposite of the architect agent's "do not guess" stance, and it is the only place in the repo where a deviation from a plan is auto-applied.
* L22-L27 — mandatory security halt: "If any code touches authentication, authorisation, tokens, PII, CORS, or session management → halt immediately and flag to the reviewer".
* L77 — coverage requirement is deferred to AGENTS.md, with a flag-if-below-threshold rule.
* **Anti-pattern worth recording**: project-specific assumptions are baked into the shipped agent — L65 says "If the project is MERN stack (MongoDB + Express + React + Node.js — **confirmed in project-doc.md**)", and `plugins/ship-mate/agents/playwright.md` L61-L103 ships a concrete *forgot-password* feature (POM class, `data-testid` locators, AC1/AC2 test names) as a fill-in template. Both reference files that exist in the author's own project, not in the plugin.
* `plugins/ship-mate/agents/qa.md` L27-L35 — severity→pipeline-action table (Critical/High/Medium block; Low logs only), and L78-L81 a mandatory per-task security test.

---

#### 1.B.3 `agent-teams` is a full **runtime protocol with lifecycle commands**, not just four reviewer agents

The earlier report (S5.1, inventory) lists the four agent-teams agents and stops. The plugin actually ships 7 commands + 6 skills that define how a live team is created, monitored, delegated to, and torn down:

* `plugins/agent-teams/commands/team-spawn.md` — 7 preset compositions (`review`, `debug`, `feature`, `fullstack`, `research`, `security`, `migration`) each with default member counts and role splits (L28-L62); a `custom` path that interrogates the user for size 2-5 and per-member role (L64-L70); a pre-flight that hard-stops unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (L12-L14).
* L74-L80 — the concrete runtime API: `TeamCreate`, then `Agent` with `team_name` / `name` / `subagent_type`, plus an explicit **name-collision warning**: "Do not use the role name `team-lead` as the spawned member name. Team creation can reserve role-like names, so use a unique member name and address the teammate by the actual name returned by `Agent` or listed in `~/.claude/teams/{team-name}/config.json`."
* `plugins/agent-teams/commands/team-status.md` L14-L21, L58-L61 — team discovery via `~/.claude/teams/`, `TaskList` for state, a members×status table, a tasks table with owner + dependencies + % complete, and a `--json` machine-readable mode.
* `plugins/agent-teams/commands/team-delegate.md` L41-L68 — a **workload rebalancing algorithm**: count tasks per member, flag 0-task (idle) and 3+-task (overloaded) members, find blocked tasks that could be unblocked, propose moves, require user confirmation, then execute via `TaskUpdate` + `SendMessage`.
* `plugins/agent-teams/commands/team-shutdown.md` L25-L51 — graceful teardown: per-teammate `shutdown_request`, wait for approve/reject, warn and confirm if tasks are in progress unless `--force`, `TeamDelete` unless `--keep-tasks`, final summary (members shut down N/total, tasks remaining).
* Task/team state locations: `~/.claude/teams/{team}/config.json` and `~/.claude/tasks/{team}/` (team-shutdown.md L50-L51).

#### 1.B.4 The agent-teams **message protocol** and its documented failure modes

`plugins/agent-teams/skills/team-communication-protocols/SKILL.md` is the most operationally specific document in the repo and was not cataloged:

* L19-L64 — six message types with JSON shapes: `message`, `broadcast`, `shutdown_request`, `shutdown_response`, `plan_approval_request`, `plan_approval_response`; broadcast is documented as **N messages for N teammates** and reserved for shared-resource changes (L50).
* L66-L75 — an anti-pattern table, including "Sending JSON status messages → not designed for structured data, use `TaskUpdate`" and "Using UUIDs instead of names".
* L77-L107 — the plan-approval workflow: teammate explores read-only, calls `ExitPlanMode`, which emits `plan_approval_request`; the lead replies with `plan_approval_response` carrying `request_id`, `approve`, optional rejection `content`. Spawning with `plan_mode_required` is the trigger (L79).
* L109-L128 — shutdown sequence including "Never force-terminate a teammate that has unsaved work" and rejection handling.
* L155 — teammates must address each other by `name`, never `agentId` or a role alias; `team-lead-2` is not `team-lead`.
* L157-L175 — troubleshooting that encodes real failure modes: idle-but-alive teammates (they process messages after the current operation), **deadlock between two teammates** (lead must send a stub/partial result to unblock one), and the tool-allowlist trap: "Agent Teams communication tools such as `SendMessage`, `TaskList`, `TaskGet`, and `TaskUpdate` must be listed explicitly when an agent uses a restricted tool allowlist" (L162-L163).

Cross-check for Forge: this is the same problem class as our sub-agent messaging, and the allowlist trap in L163 is a concrete bug source we can pre-empt.

---

#### 1.B.5 `conductor` — a second, unrelated orchestration model with a **revert engine** and commit provenance

The earlier report mentions conductor once. It is a context-driven-development plugin: `conductor/product.md` + `tech-stack.md` + `workflow.md` are the persistent project context (pre-flight in `plugins/conductor/commands/new-track.md` L10-L21); work is organised as *tracks* (`spec.md` + `plan.md` + `metadata.json`), registered in `conductor/tracks.md`, with `_archive/` for completed ones (`plugins/conductor/commands/manage.md` L12-L22, L30-L40).

* **Elicitation protocol**: `new-track.md` L31-L33 — "Ask ONE question per turn", max 6 questions, with distinct question sets per track type (feature/bug/chore/refactor) including a mandatory *scope boundaries* question ("What is explicitly OUT of scope") to prevent scope creep.
* **Strict TDD gate**: `plugins/conductor/commands/implement.md` L103-L138 — red → green → refactor, run the tests to confirm they fail first, and the outlier guard "If tests pass unexpectedly: HALT, investigate" (L109). Verification checkpoints pause for user approval between phases (L364), and `workflow.md` is parsed for commit strategy and verification-checkpoint rules (L21-L22).
* **Commit provenance**: every task completion is committed with a traceable message `{prefix}: {task description} ({trackId})` (L142) plus a separate `chore: mark task X.Y complete ({trackId})` commit (L152), and the SHAs are stored in the track's `metadata.json` (`"commits": [...]`, L335) explicitly "for potential revert" (L369). Commit discovery is by grep: `git log --oneline --grep="{trackId}" --grep="Task {X.Y}" --all-match`.
* **The revert engine** (`plugins/conductor/commands/revert.md`) is the most safety-engineered command in the repo: git-cleanliness pre-check (L33), a full revert plan printed before acting (L130-L139), execution in **reverse chronological order** with `git revert --no-edit` per commit (L174-L192), merge-conflict handling that offers abort-mid-sequence while keeping completed reverts (L198-L216), duplicate-revert detection ("already reverted by …", L314-L318), a typed **`(YES/no)` confirmation token** before any destructive action (L334), `plan.md` marker rollback and `tracks.md` status regression to `[~]`/`[ ]` (L225-L248), and the rule "**NEVER use `git reset --hard`** — only use `git revert`" (L287).
* `plugins/conductor/skills/track-management/SKILL.md` L23-L25 — progressive disclosure done explicitly: the skill body defers detail to `references/details.md`, and L30-L40 lists 10 authoring rules (one track one concern, phases of 3-5 tasks, verification task per phase, record SHAs, archive don't delete, 1-5 days per track).

#### 1.B.6 `plugin-eval` — a scoring framework for skills, with published weights and an honesty policy about its own limits

This is the repo's answer to "is this skill any good?" and neither report described it.

* Three layers (`docs/plugin-eval.md`, *Architecture*): **static lint** (no model calls), **LLM judge** (4 model calls, 4 semantic dimensions), **Monte Carlo simulation** (51 or 101 calls). Composite 0-100 → letter grade + Bronze→Platinum badge; `--threshold N` makes CI exit 1 below the bar; depths `quick|standard|deep|thorough`; outputs `json|markdown|html`.
* **Static sub-score weights are published in code** — `plugins/plugin-eval/src/plugin_eval/layers/static.py` L16-L24: `frontmatter_quality 0.32`, `orchestration_wiring 0.23`, `progressive_disclosure 0.14`, `structural_completeness 0.10`, `token_efficiency 0.09`, `ecosystem_coherence 0.06`, `harness_portability 0.06` — and the score is `raw × anti_pattern_penalty(count)` (L98-L100), with double-counting deliberately avoided (L95). `_OVER_CONSTRAINED_THRESHOLD = 15` flags skills that shout MUST/NEVER/ALWAYS too often (L27, L459-L461).
* **Anchored judge rubric** (`plugins/plugin-eval/skills/evaluation-methodology/references/rubrics.md`): four dimensions — *Triggering Accuracy*, *Orchestration Fitness*, *Output Quality*, *Scope Calibration* — each with "what is measured", "how the judge scores it", an anchored rubric, good patterns, and common mistakes. `Scope Calibration` ships **category calibration norms** as target SKILL.md lengths (L456-L463): Reference 200-500, Workflow 150-300, Code generator 100-200, Diagnostic 200-400, Integration 150-350, Coordination 100-200. The document ends with *"Limits of these rubrics"* (L478).
* **Epistemic honesty is enforced in the docs and the CLI**: layers 2-3 are labelled experimental and "not validated against human labels"; badges derive from the composite alone; plugin-level scores are static-only and the weekly CI job is literally named `Static lint report` because `eval_all.py` rejects any depth but `quick` (`docs/plugin-eval.md`, *Status of each layer* / *Weekly CI report*). `evals/README.md` describes the intended trace-based program (error analysis on real session traces first, human-labelled checks second, judge trusted last) and states that traces are kept out of the repo because they contain local paths.
* **Weight renormalisation as a design principle**: `src/plugin_eval/engine.py` L196-L203 and L254-L281 — dimensions/layers that were not measured are excluded and the remaining weights are renormalised, never counted as zero. With `_fallback_prompts` (monte_carlo.py L223) when prompt generation fails, and `elo.py` providing pairwise Elo (K=32) for skill-vs-skill comparison.

#### 1.B.7 The multi-harness adapter layer: one capability matrix, generated per-harness artifacts, verified against real CLIs

The repo is a **single canonical source (Claude Code format) compiled to six other harnesses**. `tools/adapters/capabilities.py` is the single source of truth:

* L14-L51 — a frozen `Capability` dataclass with per-harness flags: `skills_native`, `agents_native`, `commands_native`, `plugin_marketplace`, `parallel_agents`, `tool_allowlist_per_agent`, `todowrite`, `task_spawn`, `mcp_servers`, `hooks`, plus format constraints `context_file_name`, `context_file_max_lines` (150, CI-enforced), `skill_body_max_bytes` (Codex hard-truncates at 8 KiB), `tool_name_case` (`CamelCase`/`lowercase`/`none`), `bare_model_aliases`.
* L52-L209 — per-harness entries documenting real constraints rather than marketing: Codex has no per-agent tool allowlist ("only `sandbox_mode`; coarser"), no TodoWrite, subagent dispatch is "naming an agent in prose", `AGENTS.md` is walked root→cwd under a 32 KiB cap, and `~/.codex/prompts/` is deprecated in favour of skills. Copilot cannot run agents in parallel and maps commands to skills with `user-invocable: true` + `disable-model-invocation: true`. Cursor has only `readonly: true` instead of a tool list. OpenCode uses a `permission:` block (not `tools:`) and "Tool names are strictly lowercase". Pi needs an extension for subagents and MCP. Antigravity uses tier aliases (`inherit/flash/pro`) and inlines command bodies because `agy plugin validate` does not evaluate `@{path}` syntax.
* L215+ — `TOOL_NAME_MAPS`: per-harness body rewriting, e.g. for Codex `Read`→"open the file", `Grep`→`rg`, `TodoWrite`→"track the plan", `Task`→"delegate to a subagent"; Copilot collapses `Edit`/`Write`→"edit"; Cursor uses "subagent".
* Consumed by three callers (docstring L1-L6): adapters for graceful degradation, the docs generator for `docs/harnesses.md`, and plugin-eval's `harness_portability` sub-score — the same matrix is *authoritative for authoring, for generation, and for scoring*.

#### 1.B.8 Round-trip verification, and the class of bug only a real CLI finds

`docs/round-trip-results.md` records verification against the actual harness binaries: OpenCode 1.1.23 (191/191 subagents parsed), agy 1.1.14 (91/91 plugins validate; Gemini CLI support retired May 2026), Codex 0.133.0 (191 agent TOMLs parse; AGENTS.md 43 lines/500 tokens), Copilot (191 agents, 155 skills, 25 commands structurally validated), Pi 0.85.1 (105/105 prompt templates, 183/183 skills expand), `gh skill` 2.98.0 and `npx skills` 1.5.23 (183/183 source skills discovered).

Three defects that unit tests missed and real-CLI round-trips caught (same file, *Issues surfaced and fixed during round-trip*):

1. YAML block-scalar descriptions (`>`/`|`) were parsed including the indicator character, breaking OpenCode's loader (turnstile on `tools/adapters/base.py:parse_frontmatter`).
2. The OpenCode `permission:` block degraded to **deny-everything** when the source `tools:` list held only MCP tools or was empty — the agent became inert. Fix: omit the block entirely rather than emit all-deny.
3. `opencode.json` rejected the custom `$source` key; the emitted config must contain only `$schema`.

A genuinely reusable test technique: the Pi expansion smoke test runs with every credential variable invalid and the base URL pointed at a closed port, so the model call fails before any request completes — proving prompt/skill expansion works **without billing a single token** (`docs/round-trip-results.md`, *Reproduce locally* + `tools/tests/test_cli_smoke.py`).

Repo-level invariant tooling worth noting: `tools/check_version_bumps.py` (a changed plugin must bump its version), `tools/check_agent_name_collisions.py`, `tools/validate_generated.py`, `tools/doc_gardener.py` (drift detection), `tools/generate.py`, per-harness `install_*.py` symlinkers with uninstall counterparts, and CI workflows `.github/workflows/{validate,code-quality,eval-report,mlops,claude,claude-code-review}.yml`. `evals/static-score-snapshot.json` + `tools/tests/test_static_score_snapshot.py` turn scoring into an invariant: the snapshot is keyed by a sha256 digest of each skill's files, edited skills are skipped, and the second test fails when under half the entries still match — so an accidental change to the scoring code is caught, while normal skill edits are not (see `evals/README.md`).

---

### 1.C OpenHands — things the earlier report missed

The earlier report read `src/types/agent-server/**`, the event store, the condenser contract, skill scopes and the action space. It read no markdown docs, none of `.agents/skills/**`, no client tools, no tool catalog, and treated the sandbox/runtime as "not here". Everything below is new.

#### 1.C.1 `.agents/skills/verify-openhands/` is a complete verification harness, not a contributor skill

`AGENTS.md` L65 lists it in one line. It is in fact a 29-family / **836 sub-feature** product-verification program with an executable driver:

* Three-part design stated up front (`.agents/skills/verify-openhands/SKILL.md` L18-L29): `control-openhands` is "the lever" (launches this checkout as an isolated real stack and keeps one browser alive between commands), the **feature map** lists every user-facing behaviour with stable IDs and exact recipes, and **evidence** is screenshots/ARIA snapshots plus a pass/fail/blocked/not-run ledger with `xfail`/`xpass` for known bugs that survives cleanup.
* The CLI contract: every command prints one JSON object; exit codes are `0` ok / `1` action failed / `2` usage / `3` environment (L49-L50). Verbs span `launch`, `doctor`, `onboard`, `llm preset|set`, `browser goto|click|testids|snapshot|screenshot|record|network|network-state|media|events|toasts|reload|reset|wait-url|bbox|downloads|errors`, `conversation start|events|pause`, `workspace open`, `service stop|pause|resume`, `restart [--rotate-key]`, `fixture`, `api ... --write`, `evidence add|report`, `map check|coverage|testids|baseline|affected|ids`, `bug run|proof`, `stop [--purge-private]` (L59-L199).
* `doctor` is defined as a composite health gate — process group, ports, served build revision, unauthenticated rejection, authenticated settings, Agent Server pin vs the UI's minimum, automation health, and a throwaway-tab UI probe (L109-L114).
* The feature map has an **enforced entry contract** (`references/feature-map/README.md` L215-L227): H1 title, `Source:` line whose paths must exist, then exactly four H2 sections in order (`Sub-features`, `How to get to it (user POV)`, `Driving it with control-openhands`, `Gotchas`), checked by `control-openhands map check`. The index table lists all 29 families with per-family sub-feature counts (22, 29, 46, 43, 26, 39, 26, 35, 26, 34, 21, 26, 25, 13, 25, 21, 34, 23, 25, 24, 43, 31, 44, 26, 33, 36, 31, 18, 11) and "Neighbouring families" rules where a shared page has exactly one owner for each behaviour (L233-L274).
* `references/feature-map/README.md` L276-L290 is a **"Not mapped" list that names the blocking prerequisite for each omission** — e.g. a Cloud suspension surface needs "a genuine scoped HTTP 403 with `detail: \"Organization is suspended\"`; an unrelated 403 is not that prerequisite" (L282). This is the most rigorous statement of "unverified ≠ verified" in any of the three repos.

#### 1.C.2 The evidence ledger and report contract

* Evidence lives under `<run>/evidence/<feature-id>/` with an **append-only ledger** `<run>/evidence/ledger.jsonl`; nothing is overwritten (a repeated screenshot name becomes `<name>-2.png`, so you cite the path the command prints); `evidence report` renders fail/blocked rows first and `--baseline <yesterday's ledger>` adds a "Changes since baseline" section (SKILL.md L176-L183).
* Result vocabulary is deliberately richer than pass/fail: `pass`, `fail`, `blocked`, `not-run`, plus `xfail` (known bug reproduced at its marked assertion) and `xpass` (it stopped reproducing, needs map review) — and `references/report.md` L25-L32 requires keeping `xfail`/`xpass` **out of both the pass and fail counts**: "an `xfail` is neither a regression nor a pass". "Not checked this run" rows are explicitly the rotation moving on, not regressions (`references/daily.md` L113).
* Report contract sections: run identity (run ID, UTC interval, BASE/TARGET full SHAs, node/browser/OS/font/theme versions, backend SDK + automation versions, actual ports, spend scope), coverage ledger with one row per sub-feature **and entry point** ("Do not roll up one passing example into a pass for its whole family"), and fix verification with one row per known-bug block (report.md L8-L47).
* Privacy boundary is stated as a rule, not a warning: "Keep the complete ledger private until reviewed… do not publish localStorage, authentication headers, live keys, session URLs, system messages or raw traces. An ARIA/DOM snapshot can contain a password's value even when its screenshot shows only bullets" (report.md L1-L6); keys/logs/browser profile/downloads live in `<run>/private/` and `--purge-private` deletes them once evidence is checked (SKILL.md L189-L194).

#### 1.C.3 An explicit isolation protocol for several agents sharing one machine

This is the part most directly reusable by us:

* One run per agent. `--run DIR` / `$OH_VERIFY_RUN` / "the only live run"; **with several live runs the CLI refuses to guess**; "export `OH_VERIFY_RUN` in every shell command when other agents share the machine: an agent that drives someone else's run corrupts both evidence ledgers" (SKILL.md L75-L79).
* **"never `pkill -f` or `killall` by pattern"** — `control-openhands stop` ends only your run, verifies the ports closed, and treats zombie-only process groups as stopped (L79, L194-L199).
* `launch` starts a private `HOME`, state, session key and a free port block so it never touches a user's `~/.openhands` or another run; it refuses to start below ~2 GB available memory because each run holds ~1.5 GB (L80-L92).
* **File-level handoff discipline**: "Other agents on the machine may be running the same script: edit a copy, run `node --check` and the tests on it, then move it into place in one step" (L56-L57).
* Work division for parallel passes: **shard by family, never by bullet**; each agent gets whole families, its own `launch --new`, its own `OH_VERIFY_RUN`, and writes only its own ledger; one coordinator merges the ledgers and owns the hand-off (daily.md L129-L134).
* Resumption is first-class: `restart` restores stack state, ports and ledger; `browser start` opens a fresh page and you must `browser goto` before asserting (feature-map/README.md L211-L213).

#### 1.C.4 The live-model blast-radius policy (including a dated incident)

`SKILL.md` L201-L224 is a security policy for running a real agent on a developer machine:

* "The local stack is not a sandbox. The agent's terminal runs as your user, and its environment includes the run's own keys."
* Named incident: "On 2026-10-08, deepseek-flash read the run directory, the checkout, other sessions' files under `/tmp` and `env`" when a prompt left the model without a clear task — including "an image with no text, a bare trigger word whose skill is not loaded, and an open-ended setup command".
* Mandated mitigations: append "Do not run any tools" (or the exact command) to every prompt whose check does not need tools; watch `conversation events <id> --kinds ActionEvent` and `conversation pause <id>` as soon as the agent leaves the workspace; never launch the stack as a user whose files hold credentials the model must not read; without a key, run credential-free recipes and record the rest as `blocked` — "never substitute a mock and call it a pass".
* Also flagged: features that start agents with automation/debugging skills "can act on other fixtures by name", so stop those conversations when the recipe is done (L202-L205), and the LLM budget rule (deepseek-flash by default, deepseek-pro only when a second profile or stronger model is genuinely needed, prompts small and confined to the run workspace).
* "Arrange, don't fake" (L123-L131): `llm`, `fixture` and `api ... --write` exist to set up preconditions and "never count as proof that the UI path works"; never intercept routes or add mock LLM responses to make a live check pass; when an outside service is unreachable, stand in a server from `scripts/fixtures/` and **say so in the evidence**.

#### 1.C.5 Verification-skill independence — the oracle may not be edited by the implementer

`AGENTS.md` L69-L73 legislates a separation that most agent setups get wrong:

* Implementor agents must use `.agents/skills/verify-*/` as **read-only** verification tools; they must not update feature maps, expected results, known-bug recipes, drivers or fixtures while implementing a product change — "This separation applies even when an issue's acceptance criteria ask for verification-skill updates. Report a mismatch or missing coverage instead of changing the specification to match the implementation."
* Verification-skill maintenance belongs in a separate PR and a separate agent context, made after the fix lands; a verify-skill PR may contain only verify-skill paths, `AGENTS.md` files and root `.pr/` evidence (no product source, tests, CI or other docs).
* The same norm appears in the CLI's triage section: a product bug keeps its evidence, is filed in the owning repo, and "Never rewrite an expected result to bless broken behavior" (SKILL.md L274-L287), with "Unreachable is never a pass" (L289-L290) and a four-way triage (map drift / harness gap / product bug / blocked).
* Two further human-authority gates: the PR-description `HUMAN:` section is reserved for humans and "AI agents must not add to, edit, move, or remove it… If validation fails because it is missing or empty, stop and ask the human user", reporting the exact validator error rather than editing it (`AGENTS.md` L47-L49); and `.agents/skills/release.md` L59 marks the irreversible publish step with "**STOP HERE and confirm with the user before proceeding**".

#### 1.C.6 Client tools: the browser as the executor, with exactly-once claiming

The earlier report noted `launch-child-conversation-client-tool.ts` once. The mechanism is a small protocol with real engineering behind it:

* Four client tools exist — `canvas_ui_control`, `request_secret`, `automation_form`, and child-conversation launch — each declared as a `ClientToolSpec` with a JSON-schema parameter block **and MCP-style annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) that are used meaningfully: canvas UI is read-only and idempotent, `request_secret` is explicitly `idempotentHint: false` because "Each call prompts the user again" (`src/api/canvas-ui-client-tool.ts` L9-L20, L85-L90; `src/api/request-secret-client-tool.ts` L47-L53).
* **The result channel is a prefixed user message.** Client tools are acknowledged by the agent-server *before* the browser does any work, so the only way back is `postClientToolResult()`, which posts `[secret-request] {...}` (prefix constants live in `src/constants/secret-request.ts`, which documents that the message "carries the outcome only, never the value, and the chat hides it") and thereby runs the agent again; the chat hides the raw message via `should-render-event.ts` (`src/services/client-tool-result.ts` L4-L29).
* **Exactly-once discipline**: `claimClientToolCall(ledgerKey, toolCallId)` keeps a localStorage ledger of handled calls because "replaying their ActionEvent (a socket reconnect that falls back to `resend_mode: \"all\"`, or a REST/WebSocket race after a reload) would repeat real work"; the claim happens *before* the work so a replay arriving mid-flight is dropped; and the failure path is chosen explicitly — on storage failure it proceeds, "accepting replay risk over never acting at all" (`src/utils/claim-client-tool-call.ts` L1-L33).
* A scheduler interaction the earlier report could not see: the agent-server cancels an active `/goal` loop on **any** inbound message, so results are not posted while a goal loop runs and callers must surface the outcome to the user themselves (`src/services/client-tool-result.ts` L9-L23).
* Both tool descriptions are prompt-engineering artefacts worth mining: `request_secret` tells the model to never ask for a pasted secret, never put values in arguments, to reference `$NAME`, never echo it, one call per missing secret, **do not wait in a loop** because the outcome arrives later, and to use the name the user may have renamed it to (L7-L25). `canvas_ui_control` states that the user "will NOT see the files you wrote, the terminal output, or the browser unless you call this tool", gives a when-to-call decision table, requires `browser_get_state(include_screenshot=true)` before opening the Browser tab ("without it the tab opens without a screenshot"), and requires calling it *before* writing the chat summary, one call per logical step (L22-L58).

#### 1.C.7 The agent-profile tool model: absent ≠ empty, and a cross-tool dependency rule

`src/constants/profile-tools.ts` L16-L63 encodes the whole model: `tools` **absent = the standard set**, `[]` **= bare**, an array = a custom allowlist of `{name, params}` entries with per-tool parameter objects; `buildProfileToolsValue` writes `null` for standard and the picks otherwise; reading de-duplicates by name, keeping the first entry's params. And a dependency rule the earlier report missed entirely: `DELEGATION_TOOLS = ["task_tool_set", "workflow_tool_set"]` **auto-adds `task_tracker`** to any profile that selects a delegation tool, with the comment "Scoped sub-agents need task_tracker on the parent (SDK#5519)".

Paired with `src/api/tool-catalog-service/tool-catalog-service.api.ts` L8-L51: the catalog is fetched from the server and **validated fail-closed** — every entry must carry `name`, `user_selectable`, `usable`, `in_default_set` and `description`, and a malformed entry throws "The agent server returned a malformed tool catalog entry… refusing to pick tools from it" rather than rendering a partially-trusted picker.

#### 1.C.8 The system prompt is inspectable inside the product, with live redaction

`src/utils/system-message-adapter.ts` L13-L34: the UI finds the `SystemPromptEvent` in the conversation and shows `system_prompt.text`, **appending `dynamic_context.text`** because it "is the runtime-injected tail of the same system prompt the model receives, so append it to show the full message as one block" — with `redactCustomSecrets()` applied to that tail. The same event carries the tool list (`tools: ChatCompletionToolParam[]`), which the modal renders with per-tool parameter views (`src/components/features/conversation-panel/system-message-modal/{tools-list,tool-item,tool-parameters,empty-tools-state}.tsx`). Practical consequence: a user can audit exactly what the agent was told and which tools it had, without reading logs — and the redaction happens at the display boundary because the raw event contains real values.

#### 1.C.9 ACP: five external agents, with the authentication precedence rules documented and verified per provider

`docs/ACP_AGENTS.md` (290 lines) is a full integration spec the earlier report mentions only by filename:

* Architecture: the Agent Server spawns the provider CLI as a subprocess and relays turns over JSON-RPC on stdio; "The Agent Server owns the subprocess and the credentials; Agent Canvas only records _which_ agent to run and surfaces a form for the secrets it needs. The agent choice is stored per backend" (L10-L31).
* Provider defaults and availability: Claude Code, Codex, Gemini CLI on all backends; **Pi and OpenCode are local-only** (Cloud hides them); neither is pre-installed, so the first conversation downloads the CLI via `npx` (L41-L53).
* **Credential precedence as a product rule**: a subscription login takes priority over an API key, so a key in the environment is not used while signed in — hence "the onboarding key fields do nothing and can be left blank" (L59-L66). The claim is verified per provider with tool output: `codex login status` still reports the ChatGPT login with `OPENAI_API_KEY` set; `claude auth status` reports subscription auth; Gemini uses the OAuth auth type unless switched (L89-L101). Base URL overrides are the one exception that *does* apply under a login (L114-L117).
* Container path: credentials are saved as **global secrets whose name is exactly the env var** the server exports; the start request references each as a `LookupSecret` and the server resolves it from its own store at spawn time, "off the event loop (software-agent-sdk#3510), so the loopback fetch does not self-deadlock"; the SDK then materialises `CODEX_AUTH_JSON` back to `auth.json` under `CODEX_HOME` (L152-L160, L189-L199).
* Provider-specific traps documented rather than averaged: Pi requires *some* credential and picks its model from whichever provider the credential unlocks, ignores `ANTHROPIC_BASE_URL` (route it via Pi's own `models.json`), and shares the same `ANTHROPIC_API_KEY` name as Claude Code (so Pi's key changes Claude Code's auth); OpenCode runs keyless on free models (default `opencode/big-pickle`), so its credential step never blocks (L104-L112).

#### 1.C.10 Supply-chain, release and review governance for an agent-written codebase

* **Dependency release-age policy** (`AGENTS.md` L97-L125): wait ≥7 days after publication before adding or updating any third-party npm/PyPI version, including transitive lockfile changes; verify the *exact version's* publication time from registry metadata rather than the package's creation date; Dependabot `cooldown.default-days: 7`; security updates may bypass only with maintainer approval recorded in the PR (package, version, advisory, publication time) and "Agents must not grant themselves an exception"; `npm ci` replays the lock and "is not proof that newly locked versions meet the age rule" (npm pinned to 11.12.1 because 10.5.0 silently ignored `--min-release-age`).
* **Shared-frontend change checklist** (`AGENTS.md` L39-L45): raise `compatibility.minimumAgentServer` whenever Canvas starts requiring a new server endpoint/field/schema; enumerate affected consumers across Local and Cloud backends × OpenHands and ACP agents × standard/planning/delegated conversations × standalone/embedded Canvas — "Test every path with distinct control or data flow without testing an irrelevant Cartesian product"; durable frontend state gets "one named owner and one obvious writer" with hydration/migration handled.
* **Release process** (`.agents/skills/release.md`): trunk-based release-please; Conventional Commit PR titles are the version input (`fix`→patch, `feat`→minor, `!`/`BREAKING CHANGE`→major); the release PR pre-stages every version surface (`package.json`, `package-lock.json`, `config/defaults.json` `versions.agentCanvas`, and README image pins annotated `x-release-please-version`); "Marking the release PR **Ready for review** is the explicit cut-a-release signal"; `Release-As: X.Y.Z` forces a version; a `.pr/` directory in the tree fails CI on release PRs; "**Never commit to the release PR's branch by hand** — release-please owns it and force-pushes it on every push to `main`".
* **Code-review policy** (`.agents/skills/custom-codereview-guide.md`, 396 lines) defines blocking checkpoints by class of change — Agent Server/Cloud API access (L124-L147), Agent Server compatibility (L148-L163), affected Canvas modes (L164-L180), event wire contracts (L181-L198), durable state and transitions (L199-L222), Docker user/permission workarounds (L223-L228) — plus a review sequence and decision (L72-L108), design-review depth rules (do not ask for design context on trivial or generated changes, L255), dependency/release review, testing/production-evidence requirements (L298+), release-age review (L377+) and comment discipline: "Do not comment on formatting handled by tooling, minor style, praise, optional [suggestions]" and "**Do not manufacture feedback to avoid approval**" (L369-L371).

#### 1.C.11 A third-party security-governance integration path (DefenseClaw)

`docs/DefenseClaw.md` (303 lines) documents running an external security governance layer beside the stack **with no code changes on either side**, which is itself the finding: skill injection (a CodeGuard `SKILL.md` dropped into `~/.agents/skills/` or `.agents/skills/` so generated code avoids blockable patterns), LLM traffic through an OpenAI-compatible guardrail proxy (`base_url` → `localhost:4000`, provider detection automatic, modes `observe` and `action`), pre-installation skill scanning with a `PASS`/`WARN`/`BLOCK` verdict and a recommended CI/pre-commit gate (L152-L169), post-hoc scanning of agent-generated code with a GitHub Actions gate that fails on HIGH/CRITICAL findings, and audit export to OTLP/Splunk/Slack/PagerDuty. The integration summary table ("Config change? / Code change?" for all five goals) and a *Future work* section naming the Agent Server hooks that would enforce rather than observe make the trust boundary explicit.

#### 1.C.12 Testing-matrix honesty, and an MSW-only path with explicit non-coverage

* `docs/TESTING_MATRIX.md` is a P0/P1/P2 checklist matrix of install × OS × agent, automations × install × agent, auth modes and per-agent feature checklists, plus the CI coverage table and a **"Not yet covered by CI" list**: real ACP credentials (Claude Code/Codex/Gemini), macOS, public auth mode, subscription login paths, Windows.
* `docs/CANVAS_EXTENSIONS_TESTING.md` documents a mock-only development path (MSW serves an in-memory implementation of the not-yet-existing `/api/canvas-extensions`) and states plainly what it does not test (Agent Server installation, filesystem validation, persistence, authentication, Git resolution), which port to use and why (`3102` to avoid the local stack's Vite on `3001`), and the security assertion that "Installation must not execute the bundle or add its navigation item" (L48-L49) with a trusted-app confirmation gate before enablement.


---

## 2. Common patterns

Twelve patterns recur across all three repos. Each is a design decision the earlier reports did not name.

1. **Tool output is a contract, and the parser is written against that contract.** SWE-agent's `closed_window` history processor parses the *windowed ACI's own header format* to find stale windows; the windowed editors' failure text is a fixed template; OpenHands pairs every action kind with exactly one observation kind at the type level, and its client tools carry schema + annotations that the host validates. A tool that changes its output format silently changes the context pipeline.
2. **Recovery is a closed, named vocabulary — never an open-ended retry.** SWE-agent: three in-band tokens (retry-with-output / retry-silently / abort) plus lint-gate revert-vs-warn. ship-mate: *Repeated Blocker*, *No Cyclic Handoff*, *Two-Handoff*, iteration caps of 2, pause-and-escalate. conductor: TDD "if tests pass unexpectedly, HALT". QA/Playwright: two failures then escalate. Every repo bounds the loop and names the exits.
3. **Budgets are typed, enforced and *measurable*.** SWE-agent enforces per-instance cost, total cost and per-instance call count, re-budgets each retry attempt against the remaining budget, fails safe at 10% overshoot, and refuses to enforce a cost limit it cannot measure. plugin-eval states its own call counts (0 / 4 / 51-101) per depth. OpenHands budgets model choice and marks unaffordable checks `blocked` rather than skipping them silently.
4. **Irreversible actions are gated by state re-reads, reversible defaults and typed human confirmation.** The PR hook checks six preconditions (issue open, unassigned, unlocked, no prior commits) and opens a *draft*. Release cuts require marking the PR ready; `conductor revert` prints a plan, demands `(YES/no)`, uses `git revert` in reverse chronological order and forbids `reset --hard`. ship-mate stops at three named checkpoints. OpenHands forbids agents from touching the `HUMAN:` PR section.
5. **Verification artefacts are append-only and content-addressed.** Evidence ledger `ledger.jsonl` with immutable `<name>-2.png` naming; plugin-eval snapshots keyed by a sha256 digest of each skill's files; run directories that encode config + model + instance; task ids `sha256(text)[:6]`; `BASE`/`TARGET` full SHAs recorded in the report contract. Nothing is overwritten or reconstructed from memory.
6. **The verifier verifies itself, and its limits are published.** plugin-eval: the judge is labelled experimental and "not validated against human labels"; plugin badges are static-only; a snapshot test fails when scoring changes without an intended change. OpenHands: `doctor` must pass before driving, and "harness gap" versus "product bug" is a required triage outcome. Round-trip tests check generated artefacts against real CLIs (and caught three bugs unit tests missed).
7. **Progressive disclosure is structural, not stylistic.** conductor's skill body defers to `references/details.md`; plugin-eval ships `references/rubrics.md` + `improving-scores.md`; verify-openhands' map is an index of 29 files behind a README contract; plugin-eval even publishes target SKILL.md lengths per skill category (Reference 200-500, Workflow 150-300, …).
8. **Anti-patterns are first-class artefacts.** plugin-eval detects them and applies a multiplicative penalty; openhands ships *Anti-Loop Guards* and a four-row anti-pattern table for messaging; the windowed editor's error text contains "DO NOT re-run the same failed edit command"; the review guide forbids "manufacturing feedback to avoid approval"; the verification skill forbids substituting a mock for a pass and rewriting an expected result "to bless broken behavior".
9. **Every piece of durable state has one writer and a named owner.** ship-mate's `state.json` (with a mandated `last_updated`); conductor's `tracks.md` + per-track `metadata.json`; the map's single `Maintenance baseline` line; OpenHands' "one named owner and one obvious writer" rule for frontend state and its `loadedConversationId`/scope invariant; SWE-agent's per-file undo history living in the registry.
10. **Concurrent agents on one machine need an isolation protocol.** `launch --new` + private HOME/state/keys/ports + `OH_VERIFY_RUN` pinned per agent + "never `pkill -f` by pattern" + "edit a copy then move it into place" + "shard by family, never by bullet"; batch runners add random startup jitter and per-instance log fan-out. Nothing in the earlier reports covers multi-agent coexistence.
11. **Claim scope is written down, including what is deliberately unmapped.** OpenHands' "Not mapped" list names the exact blocking prerequisite per omission ("an unrelated 403 is not that prerequisite"); `TESTING_MATRIX` lists what CI does not cover; plugin-eval's docs say which layers are unvalidated; the ACP doc says which providers Cloud cannot run.
12. **Human authority is a typed gate, not a convention.** `HUMAN:` PR section with a validator; `(YES/no)` token; `awaiting_approval` checkpoint; `review: ready` label as the release signal; draft-PR default; escalation flags after two QA failures.

---

## 3. Unique capabilities not yet cataloged

Capabilities that exist in exactly one of the three repos and were absent from both earlier reports.

**OpenHands**

| Capability | Evidence path |
|---|---|
| Executable verification harness (`control-openhands`) with a feature map, evidence ledger and bug-proof protocol | `.agents/skills/verify-openhands/SKILL.md`; `references/{daily,report,mapping,maintenance,bug-backfill}.md`; `scripts/*` |
| 836 sub-features across 29 families with `Source:` path ownership and `map affected` change routing | `references/feature-map/README.md`; `scripts/lib/map-sources.mjs` |
| `xfail`/`xpass` known-bug proofs (baseline must xfail twice, fix must xpass twice; `verified`/`not-fixed`/`inconclusive`) | `SKILL.md` L234-L251; `scripts/lib/known-bug.mjs` |
| Verification-skill independence policy (oracle not editable by the implementer) | `AGENTS.md` L69-L73 |
| Client-tool protocol with exactly-once claiming and a prefixed user-message result channel | `src/utils/claim-client-tool-call.ts`; `src/services/client-tool-result.ts`; `src/constants/secret-request.ts` |
| `request_secret` tool (agent asks the user for a credential mid-task, outcome-only reply, secret never in arguments) | `src/api/request-secret-client-tool.ts` |
| `canvas_ui_control` attention contract (the user cannot see files/terminal/browser unless the agent opens the panel) | `src/api/canvas-ui-client-tool.ts` |
| In-product system-prompt inspection with runtime-context tail and secret redaction | `src/utils/system-message-adapter.ts`; `system-message-modal/*` |
| Fail-closed tool catalog validation (`user_selectable`/`usable`/`in_default_set`) | `src/api/tool-catalog-service/tool-catalog-service.api.ts` |
| Tool-profile semantics (absent=standard, `[]`=bare, per-tool `params`) + `task_tracker` auto-add for delegation tools | `src/constants/profile-tools.ts` |
| Five ACP providers with verified credential precedence and container credential materialisation | `docs/ACP_AGENTS.md` |
| Dependency release-age policy an agent may not exempt itself from | `AGENTS.md` L97-L125 |
| External security-governance integration path (skill scanning, guardrail proxy, CI gate) | `docs/DefenseClaw.md` |
| Server-defined permission strings with an anti-flash loading contract for automations | `src/hooks/use-automation-permissions.ts` |

**SWE-agent**

| Capability | Evidence path |
|---|---|
| In-band tool→harness control tokens (retry-with-output / retry-silently / abort) | `sweagent/agent/agents.py` L219, L995, L1142 |
| Autosubmission ladder with two salvage levels (container `git diff`, else last step's recorded diff) | `agents.py` L823-L868, L1154-L1218 |
| Best-of-N loop with container `hard_reset`, config rotation, per-attempt re-budgeting, 10% failsafe | `agents.py` L257-L441 |
| Variance-penalised scoring, `score_range` rejection, fewest-API-calls tie-break, chooser that filters to submitted runs | `reviewer.py` L332-L421 |
| 7-stage history pipeline incl. cache-stable elision (`polling`), tag opt-outs, `closed_window`, `cache_control`, image→multimodal | `history_processors.py` |
| Thread-affine API keys to preserve prompt caching; 14 non-retryable exception classes; fault-injection DSL (`raise_cost`, `raise_context`, …) | `models.py` L155-L190, L328-L341, L809-L833 |
| Action samplers: `ask_colleagues` and a dedupe-then-bracket tournament that samples harder when the action edits | `action_sampler.py` |
| Four windowed editors + lint gate as an overridable policy hook; line-shift-aware diagnostic diff | `tools/windowed*/`, `tools/windowed/lib/flake8_utils.py` |
| `str_replace_editor` with 21 exit codes, encoding fallback ladder, tab normalisation, syntactic `WindowExpander`, registry-persisted undo | `tools/edit_anthropic/bin/str_replace_editor` |
| Trajectory-replay harness that carries its own config and refuses incompatible replays | `sweagent/run/run_replay.py` |
| Stateful browser ACI bundle (16 verbs, pixel coordinates, screenshots as file or base64) | `tools/web_browser/config.yaml`, `lib/web_browser_utils.py` |
| Trajectory viewers (terminal + web) that synthesise a problem-statement step and a submission step | `sweagent/inspector/`; `run/run.py` |
| Continuous evaluation hook driving the official harness during a batch | `run/hooks/swe_bench_evaluate.py` |
| Deterministic shuffle, exit-status histogram artefact, thundering-herd damping, resume-by-artefact | `run/batch_instances.py`, `_progress.py`, `run_batch.py` |
| OOM sentinel with its generating prompt preserved | `docs/usage/memory_sentinel.py` |

**wshobson-agents**

| Capability | Evidence path |
|---|---|
| Pipeline state machine with resumable stages, three human gates and named anti-loop guards | `plugins/ship-mate/commands/ship.md` |
| Live agent-team runtime: presets, `TeamCreate`/`Agent`/`TaskList`/`SendMessage`, rebalancing, graceful shutdown | `plugins/agent-teams/commands/*` |
| Six-type team message protocol with plan approval via `ExitPlanMode` and documented deadlock recovery | `plugins/agent-teams/skills/team-communication-protocols/SKILL.md` |
| Track lifecycle with commit provenance and a safe revert engine (`git revert`, `(YES/no)`, no `reset --hard`) | `plugins/conductor/commands/{new-track,manage,revert}.md` |
| Three-layer skill scoring with published weights, anti-pattern penalties and an anchored 4-dimension rubric | `plugins/plugin-eval/**`, `docs/plugin-eval.md` |
| Content-addressed score snapshots that detect scoring-code drift without failing on skill edits | `evals/static-score-snapshot.json`, `tools/tests/test_static_score_snapshot.py` |
| Cross-harness capability matrix + tool-name rewriting, consumed by adapters, docs and scoring | `tools/adapters/capabilities.py` |
| Real-CLI round-trip verification with published result table and the bugs it caught | `docs/round-trip-results.md` |
| Token-free expansion smoke tests (invalid credentials, closed port) | `tools/tests/test_cli_smoke.py` |
| Repo invariants: version-bump on change, agent-name collision check, generated-artefact validation, doc drift garden | `tools/check_version_bumps.py`, `check_agent_name_collisions.py`, `validate_generated.py`, `doc_gardener.py` |

---

## 4. Docs-worthy items

Each row is a document worth writing for our own project, with the source that justifies it.

| # | Document | Source of truth to mine |
|---|---|---|
| D1 | Tool-result control channel: a machine-only envelope with a closed recovery vocabulary (retry-with-output / retry-silently / finalize), stripped from the model view but kept in the log | SWE-agent tokens (`agents.py`), OpenHands typed action↔observation pairing, client-tool claim ledger |
| D2 | Verification harness: feature-map entry contract, evidence-ledger schema, result vocabulary incl. `xfail`/`xpass`, baseline line, and the "baseline must reproduce twice" rule | `verify-openhands/SKILL.md` + `references/{daily,report,mapping}.md` |
| D3 | Oracle independence: the verifier's specifications, expected results and fixtures are read-only to the implementer, maintained in a separate PR/context | `AGENTS.md` L69-L73 |
| D4 | Multi-agent concurrency on shared hardware: per-run identity, private state, no pattern-kill, edit-copy-then-move, shard by capability not by case | `SKILL.md` L56-L92, `references/daily.md` L129-L134 |
| D5 | Irreversible-action gate library: precondition re-reads, reversible defaults (draft PR, `--dry-run`), typed confirmations, forbidden commands | `run/hooks/open_pr.py`, `conductor/commands/revert.md`, `ship-mate/commands/ship.md` |
| D6 | Budget semantics: cost vs call-count limits, mandatory measurability, per-attempt re-budgeting, overshoot failsafe, and "blocked, never silently skipped" | `models.py`, `reviewer.py`, `verify-openhands` LLM-budget section |
| D7 | Context-pipeline order and its cache interaction: elision before cache marking, stable boundaries (`polling`), tag opt-outs, last-N offsets, image handling | `history_processors.py` (all 7 stages) |
| D8 | Skill/agent quality scoring: published weights, anchored rubric dimensions, category length norms, anti-pattern penalties, and how a snapshot test keeps the scorer honest | `plugin-eval` docs + `static.py` + `rubrics.md` |
| D9 | Harness portability: the capability matrix (native skills/agents/commands, parallel agents, per-agent tool allowlist, hooks, MCP, context-file caps) and the degradation rules per harness | `tools/adapters/capabilities.py`; `docs/harnesses.md` |
| D10 | Live-model blast radius: prompts must be task-bounded, tools disabled when unneeded, run dirs isolated, what may be recorded and published, redaction before display | `verify-openhands/SKILL.md` L201-L224, `references/report.md` |
| D11 | Supply chain and release: minimum dependency age with recorded exceptions, version-surface list, release-please ownership, conventional-commit versioning | `AGENTS.md` L97-L125, `.agents/skills/release.md` |
| D12 | Prompt transparency: the session shows the exact system prompt plus its runtime-injected tail, with secrets redacted at the display boundary | `src/utils/system-message-adapter.ts` |

---

## 5. Optimization ideas (speed, capabilities, accuracy)

**Speed**

1. **Cheap elision instead of summarisation for the common case.** SWE-agent drops stale file windows, stale search output and images with an *explicit count* (`"Old environment output: (N lines omitted)"`) rather than calling a model. Cheaper than compaction and fully reversible; apply before any summariser runs.
2. **Keep one prompt-cache-friendly prefix.** Move the elision boundary only every `polling` steps so the prefix stays byte-stable; put Anthropic `cache_control` on the last N messages *minus the message about to be mutated*; keep API keys **thread-affine** so parallel workers do not invalidate each other's caches.
3. **Fail before paying.** Pre-flight tokenise and raise `ContextWindowExceeded` locally instead of taking a provider 400; check available memory before launching a heavy stack; run composite `doctor` before driving anything.
4. **Skeletons over full files.** `filemap` sends a tree-sitter outline (bodies elided ≥5 lines) with a note telling the agent to request ranges; degrades to clipped content if the parser fails.
5. **Never re-do finished work.** Resume by inspecting artefacts (`exit_status` present and not `early_exit`); deterministically shuffle workloads (`sort` → `seed(42)` → shuffle) so slices are reproducible; damp startup bursts with jitter.
6. **Drive only what changed.** `map affected --base` narrows a daily pass to changed families; `compare_runs`/`quick_stats` read results without re-running evaluation; continuous scoring submits partial predictions while the batch is still running.
7. **Keep expensive context alive across steps.** One browser kept alive between commands, one run directory per agent, `restart` instead of relaunch where the state is preserved.
8. **Parallelise by capability, not by case.** Preset team compositions (review/security/migration/research) and family-level sharding avoid duplicated setup and keep ledgers mergeable.

**Capabilities**

9. **In-band tool→runtime control channel** with three recovery policies (§D1). Highest-leverage single idea for tool ergonomics: a tool can ask for a re-ask without burning a model turn on garbage.
10. **Typed termination reasons with best-effort artefact salvage** (container diff, else last recorded diff) so a failed run still produces a comparable artefact.
11. **Best-of-N with environment reset and per-attempt re-budgeting**, plus a chooser that prefers submitted runs and breaks ties by fewest API calls.
12. **A skill/agent linter with published weights and an anchored rubric**, gating in CI with a threshold, and a snapshot test so the scorer cannot drift silently.
13. **A harness capability matrix** as the single source of truth for what each runtime supports, used by generators, docs and scoring alike.
14. **A live team protocol**: named teammates, plan approval, workload rebalancing, graceful shutdown with reject-and-retry, and an explicit warning that team tools must be in a restricted agent's allowlist.
15. **An evidence ledger with a baseline diff** so "newly failing" is computed rather than remembered, and `xfail`/`xpass` so known-bug state is executable rather than prose.
16. **A client-tool channel** (host app executes, agent observes): request-a-secret, drive-the-UI, open-a-form, launch-a-child-session — with an idempotency claim before the side effect.
17. **Stateful browser ACI** with both file and inline screenshots, plus transient-state observation (`--observe`) to capture "Saving…" style states during an action.
18. **A governance sidecar path**: scan skills/plugins before install, proxy model traffic in observe/action mode, scan generated code in CI, keep an audit store.
19. **Repo invariants as tooling**: version bump on change, name-collision check, generated-artefact validation, doc-drift gardener, token-free expansion smoke tests.

**Accuracy**

20. **Human labels before trusting a judge.** Start with error analysis on real traces, write checks for the failures found, and only then score with a model judge; keep the rubric anchored and re-publish its limits.
21. **Re-drive on the baseline before calling a regression.** Same recipe, same viewport, same fixtures on `BASE`; otherwise classify as reproduced-on-both / environment / harness gap / unconfirmed.
22. **Never count a known failure as a pass, never count an unreachable path as verified.** Categories are disjoint and the report requires denominators per family *and* per check.
23. **Project the artifact before judging it.** SWE-agent filters steps and replaces long observations with `[Output omitted]` before the reviewer sees the trajectory; the same principle keeps any LLM judge focused on the plan instead of 40 KB of grep output.
24. **Require a second, read-only view for mutations** (reload, re-open, or an API GET) and capture the action *and* the resulting state, not only the final screen.
25. **Penalise variance, reject out-of-range scores, and break ties on cost** instead of averaging everything into one number.
26. **Test the loaders with the real tools.** Unit tests passed while three harness-breaking bugs (YAML block scalars, deny-all permission block, invalid config key) were found only by round-tripping through the actual CLIs; smoke-test expansion with credentials deliberately invalid so no tokens are billed.
27. **Fault-inject the error paths deliberately** (`raise_cost`, `raise_context`, `raise_function_calling <code>`) so every termination branch has a test rather than a hope.
28. **Verify the verifier's own boundary conditions**: a snapshot must not fail when inputs legitimately changed; a partial pass must say so per row; an unfinished pass must leave the baseline where it was.

---




