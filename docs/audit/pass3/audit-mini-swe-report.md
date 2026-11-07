# Deep-dive audit: mini-swe-agent (SWE-agent/mini-swe-agent)

- **Repo path**: `/data/home/forge/repo-tour/mini-swe-agent`
- **Version audited**: `minisweagent.__version__ = "2.4.6"` (`src/minisweagent/__init__.py:11`)
- **Audit mode**: read-only. No file in the repo was modified, created or deleted.
- **Report written incrementally to**: `/tmp/audit-mini-swe-report.md`
- **Instruction honoured**: `/data/home/forge/HorizonCode` was never opened, listed or searched.

---

## 0. What this repo is + coverage stats

### 0.1 What it is

`mini-swe-agent` is the *minimal* SWE agent from the SWE-bench/SWE-agent team (Princeton & Stanford): ~100 lines of
Python for the core agent loop, bash as the only tool, one linear message list, and `subprocess.run`-style stateless
execution of every action. It is the reference implementation of the "bash-only ReAct loop" hypothesis — that a 2025-era
LM barely needs a scaffold, it needs a shell and a clean context.

Key claims from `README.md`:

- `README.md:26-27` — "Just some 100 lines of python for the agent class … no fancy dependencies!"
- `README.md:28` — ">74% on SWE-bench verified"; used by Meta, NVIDIA, IBM, Nebius, Anyscale, Princeton, Stanford
- `README.md:42-44` — "Does not have any tools other than bash — it doesn't even need to use the tool-calling interface"
- `README.md:45-47` — "Has a completely linear history — every step of the agent just appends to the messages"
- `README.md:48-50` — "Executes actions with `subprocess.run` — every action is completely independent"

### 0.2 Walk stats (whole-repo walk)

| Metric | Value |
|---|---|
| Total files in tree (excl. `.git`) | 221 (recounted with `find … | wc -l`) |
| Python source files under `src/minisweagent` | 59 — **all read** |
| Core agent (`agents/default.py`) | 190 lines |
| Test modules under `tests/` (`.py`) | 53 — **all read**, 9 636 lines |
| Files under `docs/` | 67 (every `.md` read) |
| Shipped config files | 8 YAML + `inspector.tcss` |
| Files NOT read | see 0.3 — theme assets + one generated list only |

### 0.3 Coverage: what was NOT read (near-empty by design)

**Not read at all — no line-level content to audit** (assets, generated files, CI glue):

- Images/SVG/fonts/Excalidraw and every `.css` (`docs/assets/**`, `docs/stylesheets/**`, `docs/overrides/*.html`),
  `docs/assets/js/*.js` — theme only.
- `docs/data/all_models.txt` (1 445 lines, 46 KB) — a *generated* list of litellm model names, included wholesale into
  `docs/models/quickstart.md:110`; verified by sampling (head/tail) to be a flat name list with no logic.
- **Read since the first pass**: every `.github/**` file — the 6 workflows with their real CI semantics (pytest installs
  podman + bubblewrap + apptainer and runs `pytest -v --cov --cov-branch -n auto`; pylint runs `--errors-only`; docs are
  deployed with `mike` and validated with `mkdocs build --strict`; the release workflow greps `__version__` and *fails the
  release* on a tag/version mismatch, then smoke-tests the published package with `pipx run`/`uvx`) — plus `bump_version.py`,
  the issue/PR templates, `dependabot.yml`, `mlc_config.json`, `.codecov.yml` (50 % project floor, patch coverage
  informational), `.pre-commit-config.yaml` (ruff + ruff-format + typos + whitespace/symlink/private-key checks),
  `.gitignore`, `CODE_OF_CONDUCT.md` (Contributor Covenant), `LICENSE.md` (MIT, Kilian A. Lieret & Carlos E. Jimenez).

**Read at structure level (not line-by-line) — and why that is enough here:**

- `tests/test_data/{local,github_issue}.traj.json` (3.2 KB / 9.0 KB) and `results.json` — golden fixtures, **read in full**
  since the first pass; they are exactly the `messages` array plus `info` block described in §1.7, and the regeneration
  scripts `update_outputs_local.py` / `update_outputs_github_issue.py` were read too (the second one hides a real defect —
  see §5.1 item 18).
- `tests/run/test_inspector.py` (586 lines) — **read in full** since the first pass; it covers step/trajectory navigation,
  four trajectory dialects, empty/invalid/unrecognized inputs, CSS loading, `--no-reasoning`, the `r` reasoning toggle,
  `R` reload with step clamping, and ANSI/null-byte sanitization in rendered output.

**Everything else was opened and read**: all 59 `.py` files under `src/minisweagent/` (including the 10 empty or one-line
`__init__.py` files, all 269 lines of `models/test_models.py`, and all 7 environments), the 8 shipped config YAMLs plus
`inspector.tcss`, all 53 test modules, `README.md`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`,
`pyproject.toml`, `mkdocs.yml`, and every `docs/**/*.md` (incl. `docs/SECURITY.md`, `docs/faq.md`, the three
`docs/models/*` pages, and all `docs/reference/*` stubs).

**Coverage verdict**: of 221 tracked files, only images/CSS/JS theme assets and the one generated model-name list were not
line-read. No source, test, doc-prose or config file was skipped — the NOT-READ list is assets-only.

---

## 1. Complete feature inventory (line-level)

### 1.1 The default agent loop — `src/minisweagent/agents/default.py` (190 lines total)

**Config (`AgentConfig`, lines 19-35)** — the whole agent surface is 6 knobs:

| Field | Line | Default | Meaning |
|---|---|---|---|
| `system_template` | 22 | required | Jinja2 template for message 0 |
| `instance_template` | 24 | required | Jinja2 template for message 1 |
| `step_limit` | 26 | `0` (unlimited) | max model calls |
| `cost_limit` | 28 | `3.0` | "Stop agent after exceeding (!) this cost" |
| `wall_time_limit_seconds` | 30 | `0` | wall-clock budget |
| `max_consecutive_format_errors` | 32 | `3` | exit after N format errors in a row (0 = no limit) |
| `output_path` | 34 | `None` | where to dump the trajectory |

Note `system_template`/`instance_template` have **no defaults in code** — a deliberate move (tested at
`tests/config/test_swebench_template.py:174-181`): config must be explicit, nothing is hidden in Python. Also note
`pydantic >= 2.0` is required precisely for safe mutable defaults (`pyproject.toml:37`).

**Construction (39-50)** — state is exactly: `messages[]`, `model`, `env`, `extra_template_vars{}`, `logger`,
`cost`, `n_calls`, `n_consecutive_format_errors`, `_start_time`. There is no plan, no scratchpad, no tool registry,
no working-memory compaction, no history processor.

**Template variables (52-64)** — `get_template_vars()` merges, left→right, an arbitrary number of dicts with
`recursive_merge`:

```python
def get_template_vars(self, **kwargs) -> dict:
    return recursive_merge(
        self.config.model_dump(),
        self.env.get_template_vars(),
        self.model.get_template_vars(),
        {
            "n_model_calls": self.n_calls,
            "model_cost": self.cost,
            "elapsed_seconds": int(time.time() - self._start_time),
        },
        self.extra_template_vars,
        kwargs,
    )
```

So a prompt template can read agent config, environment config, model config, live spend, live clock, and per-run
kwargs. Rendering uses `jinja2.Template(..., undefined=StrictUndefined)` (66-67) — a typo in a template is a loud
failure, not a silent empty string.

**`run()` (88-124)** — the whole control loop:

```python
def run(self, task: str = "", **kwargs) -> dict:
    self.extra_template_vars |= {"task": task, **kwargs}
    self.messages = []
    self.add_messages(
        self.model.format_message(role="system", content=self._render_template(self.config.system_template)),
        self.model.format_message(role="user", content=self._render_template(self.config.instance_template)),
    )
    while True:
        try:
            self.step()
            self.n_consecutive_format_errors = 0  # reset on any clean step
        except FormatError as e:
            self.cost += e.messages[0].get("extra", {}).get("cost", 0.0)
            self.n_consecutive_format_errors += 1
            ...
        except InterruptAgentFlow as e:
            self.add_messages(*e.messages)
        except Exception as e:
            self.handle_uncaught_exception(e)
            raise
        finally:
            self.save(self.config.output_path)
        if self.messages[-1].get("role") == "exit":
            break
    return self.messages[-1].get("extra", {})
```

Points worth naming:
1. The loop terminates on exactly one condition: **the last message has `role == "exit"`** (122-123). Every
   termination path (submit, limit, format-error spiral, uncaught exception) works by appending an exit message.
2. `finally: self.save(...)` (120-121) — **the trajectory is written after every single step**, so a crash, a SIGINT or
   a killed process still leaves a complete, inspectable trace. There is no separate "save at end" path.
3. Format errors are *charged* before being counted (101-102): cost is read out of the exception's carried message
   because `model.query()` failed after billing. This makes `cost_limit` a true spending guard.
4. Retry-on-format-error is implemented as **message injection, not as an internal retry loop**: the `FormatError`
   carries a user-role message that gets appended to history, and the model simply sees it on the next turn
   (104-114). The model is the one that gets to fix its own syntax, in-context, with the bad output already parsed.
5. A clean step resets the consecutive-error counter (99) — isolated format errors are free, only a *spiral* is fatal.
6. Non-`InterruptAgentFlow` exceptions are recorded into the trajectory (`handle_uncaught_exception`, 74-86 — stores
   `exit_status`, `exception_str`, full `traceback`) and then **re-raised** (117-119). The tool fails loudly and still
   leaves a usable artefact.

**`step()` (126-128)** — one line: `return self.execute_actions(self.query())`.

**`query()` (130-152)** — the safety rails, checked *before* spending money:

```python
def query(self) -> dict:
    if 0 < self.config.step_limit <= self.n_calls or 0 < self.config.cost_limit <= self.cost:
        raise LimitsExceeded({... "exit_status": "LimitsExceeded" ...})
    if 0 < self.config.wall_time_limit_seconds <= int(time.time() - self._start_time):
        raise TimeExceeded({... "exit_status": "TimeExceeded" ...})
    self.n_calls += 1
    message = self.model.query(self.messages)
    self.cost += message.get("extra", {}).get("cost", 0.0)
    self.add_messages(message)
    return message
```

Note the guard ordering (step/cost first, then wall time) and the `0 <` idiom meaning "0 disables this limit".

**`execute_actions()` (154-157)** — a comprehension over actions the model already parsed:

```python
def execute_actions(self, message: dict) -> list[dict]:
    outputs = [self.env.execute(action) for action in message.get("extra", {}).get("actions", [])]
    return self.add_messages(*self.model.format_observation_messages(message, outputs, self.get_template_vars()))
```

A `Submitted` raised by `env.execute()` mid-list propagates out of the comprehension — earlier outputs are simply
discarded. Observations are formatted by the **model** class, not the agent (models own action parsing *and* observation
formatting; see 1.3).

**Serialization contract (`serialize`/`save`, 159-190)** — the trajectory schema is explicit and versioned:

```python
agent_data = {
    "info": {
        "model_stats": {"instance_cost": self.cost, "api_calls": self.n_calls},
        "config": {
            "agent": self.config.model_dump(mode="json"),
            "agent_type": f"{self.__class__.__module__}.{self.__class__.__name__}",
        },
        "mini_version": __version__,
        "exit_status": last_extra.get("exit_status", ""),
        "submission": last_extra.get("submission", ""),
    },
    "messages": self.messages,
    "trajectory_format": "mini-swe-agent-1.1",
}
return recursive_merge(agent_data, self.model.serialize(), self.env.serialize(), *extra_dicts)
```

`recursive_merge` here is how `model`/`environment` configs and per-instance metadata (e.g. `instance_id` from the
SWE-bench runner, `swebench.py:166-173`) end up inside `info.config` without either side knowing about the other.
`save(path, *extra_dicts)` (182-190) both writes to disk and returns the dict, so it doubles as the serialization API.

**Exception taxonomy (`exceptions.py`, 26 lines)** — the entire control-flow vocabulary:

```python
class InterruptAgentFlow(Exception):
    def __init__(self, *messages: dict):
        self.messages = messages

class Submitted(InterruptAgentFlow): ...
class LimitsExceeded(InterruptAgentFlow): ...
class TimeExceeded(LimitsExceeded): ...
class UserInterruption(InterruptAgentFlow): ...
class FormatError(InterruptAgentFlow): ...
```

An exception **is** a message (or several); catching it and calling `add_messages(*e.messages)` is the entire handler.
This is the mechanism that keeps `run()` at ~20 lines while supporting submit, limits, user interruption and format
retries. Rationale documented at `docs/advanced/control_flow.md:93-123` — "Using exceptions for control
flow is a lot easier than passing around flags and states, especially when extending or subclassing the agent."

### 1.2 The environment abstraction

Environment protocol (`src/minisweagent/__init__.py:61-70`): `execute(action: dict, cwd: str = "") -> dict`, plus
`get_template_vars()` and `serialize()`. There is **no** `BaseEnvironment` to inherit from — duck typing via `Protocol`
(`__init__.py:6-8`: "By the magic of protocols & duck typing, you can pretty much ignore them").

The canonical output dict shape (identical in every implementation):

```python
{"output": <merged stdout+stderr>, "returncode": int, "exception_info": str, "extra": {...optional...}}
```

| Environment | File | Backing mechanism | exec call lines |
|---|---|---|---|
| `local` | `environments/local.py` | `subprocess.Popen(shell=True)` | 74-85 |
| `docker` | `environments/docker.py` | `docker run -d … sleep 2h` + `docker exec` | 77-97, 107-124 |
| `singularity` | `environments/singularity.py` | `singularity build --sandbox` + `singularity exec` | 52-56, 95-105 |
| `bubblewrap` | `environments/extra/bubblewrap.py` | `bwrap` with explicit ro-binds | 86-103 |
| `swerex_docker` | `environments/extra/swerex_docker.py` | SWE-ReX `DockerDeployment` | 29-45 |
| `swerex_modal` | `environments/extra/swerex_modal.py` | SWE-ReX `ModalDeployment` | 63-80 |
| `contree` | `environments/extra/contree.py` | `contree_sdk` sessions | 86-105 |

**Timeouts.** Every environment applies a per-action timeout (default 30 s; 60 s in `swebench.yaml`; 180 s in
`programbench.yaml`) and converts a timeout into a *normal observation*, not an exception:

```python
except Exception as e:
    raw_output = getattr(e, "output", None)
    raw_output = (
        raw_output.decode("utf-8", errors="replace") if isinstance(raw_output, bytes) else (raw_output or "")
    )
    output = {
        "output": raw_output,
        "returncode": -1,
        "exception_info": f"An error occurred while executing the command: {e}",
        "extra": {"exception_type": type(e).__name__, "exception": str(e)},
    }
```
(`local.py:31-41`, `docker.py:126-136`, `bubblewrap.py:105-115`, `contree.py:106-120` — parallel, near-identical).
Two details matter: **partial output before the timeout is preserved** (`TimeoutExpired.output`, asserted by
`tests/agents/test_default.py:208-229`) and `returncode: -1` is a clean in-band signal for "never ran properly".

`LocalEnvironment` is the only one that kills the whole process group:

```python
process = subprocess.Popen(..., start_new_session=os.name == "posix")
try:
    stdout, _ = process.communicate(timeout=timeout)
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL) if os.name == "posix" else process.kill()
```
(`local.py:72-91`) — without this, `bash -c 'foo &'` leaves orphans holding the pipe open and `communicate()` hangs
forever.

**Termination detection.** `_check_finished` is duplicated verbatim in all 7 environments (`local.py:45-56`,
`docker.py:140-151`, `singularity.py:121-132`, `bubblewrap.py:119-130`, `contree.py:124-135`,
`swerex_docker.py:56-67`, `swerex_modal.py:91-102`):

```python
def _check_finished(self, output: dict):
    lines = output.get("output", "").lstrip().splitlines(keepends=True)
    if lines and lines[0].strip() == "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" and output["returncode"] == 0:
        submission = "".join(lines[1:])
        raise Submitted({"role": "exit", "content": submission,
                         "extra": {"exit_status": "Submitted", "submission": submission}})
```

The magic string must be the *first non-whitespace line* **and** the command must exit 0 — so `git diff > patch.txt`
never accidentally submits, but `echo COMPLETE… && cat patch.txt` does (exactly what `swebench.yaml:97-104`
instructs). The consequence: "the patch is whatever the model printed", i.e. the agent needs no diff-extraction logic and
`preds.json` is populated directly from that string (`swebench.py:176`).

**Registry / plug-in mechanism** (`environments/__init__.py:8-33`): a 7-entry string→import-path map plus
`get_environment_class(spec)` which accepts either a short name or **any dotted import path**; unknown specs raise a
`ValueError` listing the available names. Container-lifecycle concerns stay out of the agent: the docker container is
named `minisweagent-{uuid4[:8]}` (`docker.py:76`), started detached with `sleep 2h` (`docker.py:87-88`, configurable via
`container_timeout`), and `__del__` fires a *backgrounded* `(timeout 60 docker stop || docker rm -f)` so teardown never
blocks (`docker.py:153-161`).

### 1.3 Model layer

Model protocol (`__init__.py:43-58`): `query()`, `format_message()`, `format_observation_messages()`,
`get_template_vars()`, `serialize()`. **v2 deliberately moved action parsing and observation formatting from the agent
into the model** — `docs/advanced/v2_migration.md:166`: "Models now parse actions and format observations. This enables
switching between tool calls and text parsing by changing model classes. The Agent class is now a simpler coordinator."

**The universal `query()` shape** (implemented identically in 7 classes — `litellm_model.py:81-106`,
`litellm_response_model.py:52-78`, `openrouter_model.py:97-117`, `openrouter_response_model.py:85-103`,
`portkey_model.py:104-128`, `portkey_response_model.py:96-121`, `requesty_model.py:102-122`):

1. `for attempt in retry(logger=..., abort_exceptions=...)` — tenacity loop (`utils/retry.py:19-25`: exponential backoff
   4→60 s, `stop_after_attempt(MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT, default 10)`, `reraise=True`, `before_sleep_log`).
2. `self._query(self._prepare_messages_for_api(messages), **kwargs)` — messages are re-prepared **inside** the retry loop,
   and `_prepare_messages_for_api` strips the `extra` key before the API sees it (`litellm_model.py:77`).
3. Cost first, parse second (`litellm_model.py:85-98`): `cost_output = self._calculate_cost(response)`,
   `GLOBAL_MODEL_STATS.add(...)`, *then* `try: actions = self._parse_actions(response)` with a `FormatError` handler that
   **persists cost and the raw response onto the exception message before re-raising**.
4. Return the model's own message dict plus
   `message["extra"] = {"actions": ..., "response": ..., "cost": ..., "timestamp": time.time()}`.

Step 3 is a hard, documented contract (`litellm_model.py:87`): *"all model.query() implementations must persist the
response and cost on FormatError"*. It is enforced by 529 lines of tests (`tests/models/test_format_error_response_persistence.py`),
including a `repr()` fallback so the contract holds even when `model_dump()` itself raises (`litellm_model.py:92-98`;
tests at lines 419-500).

**Cost accounting.** `_calculate_cost` (e.g. `litellm_model.py:108-126`) treats **missing cost as a hard error** unless
`cost_tracking: ignore_errors` / `MSWEA_COST_TRACKING=ignore_errors` is set; the raised `RuntimeError` text is a
mini troubleshooting guide linking docs and the issue tracker. Portkey's version additionally repairs inconsistent token
counts (`portkey_model.py:168-213`) with the comment "This is probably a portkey bug or incompatibility with litellm
cost tracking".

**Hard global rails** (`models/__init__.py:13-42`): a process-wide `GLOBAL_MODEL_STATS` singleton with a `threading.Lock`,
`add(cost)` called by *every* model class, and optional `MSWEA_GLOBAL_COST_LIMIT` / `MSWEA_GLOBAL_CALL_LIMIT` env caps that
raise `RuntimeError` (25-31). This is what makes `-w 8` batch runs safe; the batch progress bar reads its cost display
from the same singleton (`batch_progress.py:117-123`).

**Action parsing, tool-calling path** (`models/utils/actions_toolcall.py`): one tool `BASH_TOOL` with a single required
string parameter `command` (11-27); `parse_toolcall_actions` (30-76) raises `FormatError` for zero tool calls, unparseable
JSON arguments, an unknown tool name, or a missing `command` — each with a *specific* error string that lands in the
prompt. `format_toolcall_observation_messages` (79-113) pads missing outputs with
`{"returncode": -1, "exception_info": "action was not executed"}` (89) so `actions` and `outputs` can never desync, and
picks `role="tool"` (+`tool_call_id`) vs `role="user"` depending on whether a `tool_call_id` exists (105-109).

**Action parsing, text path** (`models/utils/actions_text.py:15-40`) — the v1-compatible mode. One regex, one invariant:

```python
actions = [a.strip() for a in re.findall(action_regex, content, re.DOTALL)]
if len(actions) != 1:
    error_msg = f"Expected exactly 1 action, found {len(actions)}."
    raise FormatError({...})
```

Exactly one action, no "pick the first block" fallback — ambiguity is an error the model must resolve.

**Responses-API path** (`models/utils/actions_toolcall_response.py`): flat `BASH_TOOL_RESPONSE_API` (11-25);
`finish_reason_from_responses_api` (45-55) maps Responses-API `status="incomplete"` +
`incomplete_details.reason="max_output_tokens"` onto chat-completions `finish_reason="length"` so **the same
`format_error_template` works on both APIs**; observation messages are shaped as `function_call_output` (132-140). The
stateless-API adapters (`litellm_response_model.py:29-38`, `openrouter_response_model.py:70-83`,
`portkey_response_model.py:82-94`) explicitly *flatten* previous response objects into their `output` items because
`previous_response_id` is unsupported.

**Cross-provider plumbing** (all opt-in, all in `models/utils/`):
- `cache_control.py` — `set_cache_control(..., mode="default_end")` walks messages *in reverse* and marks only the last
  one (62-66), clearing stale markers first, with a documented workaround for a tool-role quirk (43-46). Auto-enabled for
  anthropic-family model names in `get_model` (`models/__init__.py:55-60`).
- `anthropic_utils.py:11-27` — reorders thinking/redacted_thinking blocks ahead of other content, appending a trailing
  empty text block when thinking would otherwise be last (Anthropic API requirement).
- `openai_multimodal.py` — a `MSWEA_MULTIMODAL_CONTENT`/`CONTENT_TYPE` tag convention (7-9) expanded into structured
  content; disabled by default (empty regex).
- `content_string.py` — a display-only normalizer used by the interactive agent and inspector that accepts all five
  message dialects (chat, multimodal, Anthropic tool_use/tool_result, tool_calls, Responses API).

**Model class registry** (`models/__init__.py:78-89`) — 10 short names mapping to import paths; `model_class` also accepts
a full dotted path; `get_model_name` falls back `input → config → MSWEA_MODEL_NAME` before raising with a pointer to
`mini-extra config setup` (65-75).

### 1.4 Config layer

Three sources, one merge function, no framework:

1. **Built-in YAMLs** under `src/minisweagent/config/` (`mini.yaml`, `default.yaml`, `mini_textbased.yaml`,
   `inspector.tcss`, `benchmarks/{swebench,swebench_backticks,swebench_xml,swebench_modal,programbench}.yaml`).
2. **Global `.env`** (`__init__.py:26-36`): `MSWEA_GLOBAL_CONFIG_DIR` or `platformdirs.user_config_dir("mini-swe-agent")`,
   loaded by `dotenv` at import; a startup banner prints version + migration link + config path unless
   `MSWEA_SILENT_STARTUP`.
3. **CLI specs** (`config/__init__.py:12-61`): `get_config_path` searches
   `[given path, MSWEA_CONFIG_DIR/…, builtin/, builtin/extra/, builtin/benchmarks/]`; `get_config_from_spec` accepts
   `key.subkey=value` (JSON-parsed value) *or* a YAML file, so `-c agent.cost_limit=5` is a first-class config source.

Merging is `recursive_merge(*configs)` with a sentinel (`utils/serialize.py:1-29`):

```python
UNSET = object()

def recursive_merge(*dictionaries: dict | None) -> dict:
    result: dict[str, Any] = {}
    for d in dictionaries:
        if d is None:
            continue
        for key, value in d.items():
            if value is UNSET:
                continue
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = recursive_merge(result[key], value)
            elif isinstance(value, dict):
                result[key] = recursive_merge(value)   # filters nested UNSETs
            else:
                result[key] = value
    return result
```

The `UNSET` sentinel is the trick that lets a CLI build a "patch dict" where *absent* flags mean "don't override"
(`mini.py:73-91`): every `None` CLI option becomes `UNSET` and silently disappears from the merge; nested dicts are
merged to strip nested `UNSET`s (24-26), a bug that is regression-tested at `tests/utils/test_serialize.py:141-149`.
The entire config system is 64 lines of Python plus YAML.

Template conventions are documented as first-class API (`docs/advanced/yaml_configuration.md:78-84`): templates see agent
config, environment config, model config, run kwargs and the current observation; `StrictUndefined` everywhere means
unknown variables fail loudly instead of rendering as empty strings.

Turning a config dict into objects is two 5-line functions (`agents/__init__.py:25-28`, `environments/__init__.py:30-33`):

```python
def get_environment(config: dict, *, default_type: str = "") -> Environment:
    config = copy.deepcopy(config)
    environment_class = config.pop("environment_class", default_type)
    return get_environment_class(environment_class)(**config)
```

The class name lives *in* the config dict (`environment_class: docker`) and is popped before the rest is splatted into the
constructor — adding a custom class is a config edit, not a code edit.

### 1.5 The run / batch CLI layer

Entry points (`pyproject.toml:89-93`): `mini`/`mini-swe-agent` → `run/mini.py:app`; `mini-extra`/`mini-e` →
`run/utilities/mini_extra.py:main`, a 49-line dispatcher over a `(module, aliases, description)` list
(`mini_extra.py:13-19`) that lazy-imports the right Typer app and forwards `sys.argv[1:]` (41-43).

**`mini`** (`run/mini.py`, 109 lines) — 10 flags, all with `rich_help_panel` grouping: `-m/--model`, `--model-class`,
`--agent-class`, `--environment-class`, `-t/--task`, `-y/--yolo`, `-l/--cost-limit`, `-c/--config` (a *list*, repeatable),
`-o/--output`, `--exit-immediately`. Flow: `configure_if_first_time()` (68) → build the override dict with `UNSET`s →
merge → if no task, an interactive multiline prompt (`agents/utils/prompt_user.py:12-20`, prompt_toolkit with file-backed
history in the global config dir) → `get_model()` → `get_environment(..., default_type="local")` →
`get_agent(..., default_type="interactive")` → `agent.run(task)` → print the trajectory path (99-105).

**Batch SWE-bench** (`run/benchmarks/swebench.py`, 275 lines) — the benchmark integration:
- `DATASET_MAPPING` (53-62): `full`, `verified`, `lite`, `multimodal`, `multilingual`, `smith`, `_test`
  (`klieret/swe-bench-dummy-test-dataset` — a test dataset name shipped in prod code), `rebench`.
- `get_swebench_docker_image_name` (68-76): uses `instance["image_name"]`/`docker_image`, else reconstructs
  `docker.io/swebench/sweb.eval.x86_64.<id>:latest` with `__` → `_1776_` because "Docker doesn't allow double underscore".
- `get_sb_environment` (79-94): `docker`/`swerex_modal` get a plain image, `singularity`/`contree` get `docker://`-prefixed;
  an optional `run.env_startup_command` is rendered with the **instance fields as Jinja variables** (89-93).
- `update_preds_file` / `remove_from_preds_file` (97-119): read-modify-write of `preds.json` under a module-level
  `threading.Lock`, in SWE-bench's native schema (`model_name_or_path`, `instance_id`, `model_patch`).
  `process_instance` *deletes* the instance's own entry and previous trajectory first (132-133) so a re-run can never see
  stale state.
- `process_instance` (122-177): start env → wrap the agent in `ProgressTrackingAgent` → run → in `finally` save the
  trajectory **with `exit_status`/`submission`/traceback merged in** and update `preds.json` unconditionally (161-177).
  `model.config.model_name` becomes `model_name_or_path` (176).
- `filter_instances` (180-197): regex filter + `slice(*values)` slice spec + a **seeded `random.seed(42)` shuffle**
  (185-187) so "shuffle" is reproducible across runs.
- Concurrency (256-271): `ThreadPoolExecutor(max_workers=workers)` + `rich.Live` at 4 fps, with a `KeyboardInterrupt`
  path that cancels not-yet-started futures and *then* drains the rest (267-271) — Ctrl-C is graceful, not destructive.
- `--redo-existing` (229-232) skips instances already in `preds.json` — resumability by data, not by bookkeeping.

**Single-instance debugging** (`run/benchmarks/swebench_single.py`, 100 lines): same config/agent plumbing, but `-i`
accepts either an `instance_id` **or a numeric index** into the sorted dataset (65-67), and the agent defaults to
`interactive` — you debug a benchmark instance with a human in the loop using the production prompt/config.

**Progress UI** (`run/benchmarks/utils/batch_progress.py`, 178 lines) — lifted from swe-agent (docstring line 2): two rich
`Progress` bars, an exit-status table, a `_yaml_report_path` rewritten on **every** instance end (155-157, 175-178), ETA
from completed count (89-97), and total cost read from `GLOBAL_MODEL_STATS` (117-123).

**Per-step progress wrapper** (`run/benchmarks/utils/common.py`, 17 lines) — the entire benchmark/agent coupling:

```python
class ProgressTrackingAgent(DefaultAgent):
    def step(self) -> dict:
        self.progress_manager.update_instance_status(self.instance_id, f"Step {self.n_calls + 1:3d} (${self.cost:.2f})")
        return super().step()
```

**`mini-extra config`** (`run/utilities/config.py`, 131 lines): `setup` / `set KEY VALUE` / `unset KEY` / `edit`, all
writing the single `.env` (`dotenv.set_key`) with a `_reload_config()` that re-loads with `override=True` (21-22), a
first-run wizard gated on `MSWEA_CONFIGURED` (62-66), and a deliberate **deferred import** of prompt_toolkit to keep CLI
startup fast (55-59).

**Trajectory inspector** (`run/utilities/inspector.py`, 316 lines): a textual TUI over `*.traj.json` that groups messages
into steps (`_messages_to_steps`, 25-38), renders role + ANSI-colored content + optional `reasoning_content` (205-225),
and exposes bindings as a command palette (44-76). `e` opens the current step in `jless` (255-272). The style sheet path
is overridable via `MSWEA_INSPECTOR_STYLE_PATH` (98-101).

### 1.6 The "extras" — what each one adds

| Extra | Adds | Key lines |
|---|---|---|
| `agents/interactive.py` (209) | `mode∈{human,confirm,yolo}`, slash-commands `/y /c /u /m /h`, whitelist regexes, `confirm_exit`, Ctrl-C → injected comment, limit-raising prompt | 24-30, 58-94, 109-122, 162-182, 184-208 |
| `environments/extra/bubblewrap.py` (151) | unprivileged Linux sandbox: explicit `--ro-bind /usr /bin /lib /lib64 /etc`, `--tmpfs /tmp`, `--proc`, `--dev`, per-instance `--bind <tmpdir>` | 38-65, 78-86 |
| `environments/extra/swerex_docker.py` (80) | SWE-ReX Docker deployment; `deployment_extra_kwargs` pass-through | 22-27 |
| `environments/extra/swerex_modal.py` (124) | Modal cloud sandboxes: `startup_timeout`, `runtime_timeout`, `deployment_timeout`, `install_pipx`, `modal_sandbox_kwargs`, guarded `stop()` (117-124) | 12-34, 52-61 |
| `environments/extra/contree.py` (148) | ConTree sessions with Git-like execution; auto-creates `cwd`, imports images with user/password | 21-45, 66-72, 74-80 |
| `models/extra/roulette.py` (64) | `RouletteModel` (random model per call) and `InterleavingModel` (deterministic sequence) — meta-models wrapping `get_model` configs and stamping `response["model_name"]` (28-33) | 9-64 |
| `models/test_models.py` (269) | `DeterministicModel`, `DeterministicToolcallModel`, `DeterministicResponseAPIToolcallModel` + `make_*_output` helpers + `_process_test_actions` (`/sleep`, `/warning`, `raise`) | 16-31, 75-87, 90-269 |
| `run/benchmarks/programbench.py` (193) | `ProgramBenchAgent` that strips `raw_output` from saved messages; `copy_submission` (tar+gzip the container workspace out via `docker cp`) | 33-60 |

Two dormant v1 vestiges are worth knowing about before the next section. `src/minisweagent/run/extra/` now contains only an
*empty* `__init__.py` (the `github_issue` run script was removed — `docs/advanced/v2_migration.md:138`), yet
`tests/test_data/update_outputs_github_issue.py:9` still imports `minisweagent.run.extra.github_issue` and would die with
`ImportError` if anyone ran it. In the same vein, `config/__init__.py:22` still searches a `builtin/extra/` config directory
that no longer ships, and `docs/reference/environments/swerex_modal.md:27` documents
`--config src/minisweagent/config/extra/swebench_modal.yaml` — a path that does not exist (the file lives under
`config/benchmarks/`) and that `get_config_path` will reject with `FileNotFoundError`. Both are catalogued in §5.1.

### 1.7 Benchmark integration (SWE-bench harness wiring)

The wiring is intentionally thin and *standard-compliant rather than harness-aware*: the agent's only obligations are
(1) print a unified diff as the submission and (2) never modify test files. Both are **prompt-level contracts**, not code
(`swebench.yaml:75-110`, which prescribes `git diff -- <files> > patch.txt`, a verification step, and finally
`echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat patch.txt`).

The harness side is three fields (`docs/usage/output_files.md:97-110`):

```json
{ "owner__repo__123": {
    "model_name_or_path": "anthropic/claude-sonnet-4-5-20250929",
    "instance_id": "owner__repo__123",
    "model_patch": "diff --git a/file.py b/file.py\n..." } }
```

The docs point at two evaluation routes — the free cloud `sb-cli submit` (~20 min) or local
`python -m swebench.harness.run_evaluation` (`docs/usage/swebench.md:108-135`). There is **no runtime dependency on the
SWE-bench package**: only `datasets.load_dataset` is imported (`swebench.py:222`), and image names are reconstructed by
string convention. That is what "benchmark-standard compatibility" means here: the agent knows the dataset field names and
the prediction schema, and nothing else.

### 1.8 Docs philosophy — every design principle stated

Docs are a first-class deliverable: `docs/index.md` carries the same positioning copy as the README;
`docs/advanced/control_flow.md` embeds a Mermaid flowchart *and* the real source via a snippet include
(`--8<-- "src/minisweagent/agents/default.py"`, line 56), and `docs/usage/*.md` embed their configs and run scripts the
same way. `mkdocs.yml:56-57` turns on `pymdownx.snippets: check_paths: true`, so a doc pointing at a deleted file
**breaks the docs build** — the docs cannot silently drift.

Extracted principles, with sources:

1. **"What if our agent was 100x simpler, and still worked nearly as well?"** — `README.md:21`, `docs/index.md:28`.
2. **Bash is the only tool** — "it doesn't even need to use the tool-calling interface of the LMs. This means that you can
   run it with literally any model… you also don't need to take care of installing a single package — all it needs is
   bash." (`README.md:42-44`, `docs/faq.md:33-34`)
3. **Linear history** — "every step of the agent just appends to the messages and that's it. So there's no difference
   between the trajectory and the messages that you pass on to the LM. Great for debugging & fine-tuning."
   (`README.md:45-47`)
4. **Stateless execution** — "every action is completely independent (as opposed to keeping a stateful shell session
   running) … Seriously, this is a big deal" (`README.md:48-50`); long justification in `docs/faq.md:102-119`: (a) it's
   not obvious when a command terminated, (b) bad commands can kill the session, (c) interrupting corrupts the session.
   "`mini` is different: There is no running shell session."
5. **Hackable, not a black box** — "Some agents are overfitted research artifacts. Others are UI-heavy frontend monsters.
   The `mini` agent wants to be a hackable tool, not a black box" (`README.md:61-63`); *simple* / *convenient* /
   *flexible* (`README.md:65-67`).
6. **Baseline-first, scaffold-light for research** — "perfect as a baseline system and for a system that puts the language
   model (rather than the agent scaffold) in the middle of our attention" (`README.md:52-53`); the SWE-bench "bash only"
   leaderboard exists to rate *models*, not scaffolds.
7. **Prefer prompt-side solutions over code** — "Want it to do something specific like opening a PR? Just tell the LM to
   figure it out rather than spending time to implement it in the agent." (`README.md:72-74`)
8. **Exceptions over flags for control flow** — `docs/advanced/control_flow.md:93-123`.
9. **Polymorphism with simple parts** — "The project embraces polymorphism: Every individual class should be simple, but
   we offer alternatives. Every use case should start with a run script, that picks one agent, environment, and model
   class to run." (`AGENTS.md:16-17`)
10. **Minimalism as a coding rule, not a vibe** — `AGENTS.md:19-33`: "Keep code comments to a minimum", "Do not catch
    exceptions unless explicitly told to", "Not every exception has to be caught. Exceptions are a good way to show
    problems to a user", "This repository rewards minimal code. Try to be as concise as possible."
11. **Migration docs are mandatory** — a 257-line migration guide (`docs/advanced/v2_migration.md`) plus a startup banner
    pointing at it (`__init__.py:30-35`).
12. **The agent is documented by its own source** — docs include the real files, so the essay and the implementation are
    the same artefact.

### 1.9 Test suite shape (what it tells us about the design)

9 636 lines of tests across 44 files; 300+ test functions. Notable properties:

- **Every agent behaviour is exercised against all three message dialects** via one parametrized fixture
  (`tests/agents/test_default.py:117-126`, `tests/agents/test_interactive.py:122-131`): `text`, `toolcall`,
  `response_api`. A change to the loop that only works for tool-calls fails immediately.
- **Deterministic model doubles** (`models/test_models.py`, shipped in `src/`, not in `tests/`) make the whole loop
  testable without network: `outputs=[make_output(content, actions)]` is a scripted conversation. `_process_test_actions`
  (75-87) even supports `raise`, `/sleep N` and `/warning` pseudo-actions, so exception paths and slow paths are
  expressible *in the scripted output itself*.
- **Real end-to-end runs are marked `slow` and gated**: `tests/test_fire.py` needs `--run-fire` *and* warns in
  ALL-CAPS that it should never be run by an AI agent; `conftest.py:12-19` registers the option, and docker tests
  autoskip via `container_executable` (43-64).
- **Trajectory fixtures as golden files**: `tests/test_data/{local,github_issue}.traj.json` plus `normalize_outputs`
  (conftest.py:90-96) that strips `<args>` blocks (container IDs) and `root root` lines (timestamps) — a pragmatic
  way to golden-test full agent runs.
- **Global-state hygiene**: `reset_global_stats` (conftest.py:26-40) takes a module-level lock and zeroes
  `GLOBAL_MODEL_STATS` around tests that assert on cost.

---

## 2. Common patterns shared with typical coding agents

`mini-swe-agent` is deliberately unusual, but a lot of what it does is the *same set of decisions* any coding agent
harness ends up making — it just makes them in ~200 lines instead of ~20 000:

1. **ReAct-style loop**: query → act → observe → append (default.py:96-124). Same skeleton as every other agent.
2. **System + task prompt pair**: exactly two seed messages (default.py:92-95).
3. **Single bash/shell tool**: the same surface Claude Code, Codex and Aider expose; the difference is that `mini`
   spends *zero* code on it (a 17-line JSON schema, `actions_toolcall.py:11-27`).
4. **Tool-call plumbing**: OpenAI-style `tool_calls` → role `tool` reply with `tool_call_id` (actions_toolcall.py:105-109),
   i.e. the standard chat-completions contract, plus the Anthropic `thinking`-block ordering fix
   (`anthropic_utils.py`) that every Claude-using harness needs.
5. **Retry with backoff on transport errors**, aborted on non-retryable auth/config errors (`utils/retry.py:19-25`,
   `abort_exceptions` lists in each model class).
6. **Cost/token accounting per call**, accumulated per run and reported in the artefact (`default.py:150`,
   `info.model_stats.instance_cost`).
7. **Step/turn limits and a budget guard** (`step_limit`, `cost_limit`) — but checked *before* the call rather than after.
8. **Prompt-injected output truncation for long tool results** (`default.yaml:119-141`, `mini.yaml:113-128`) — the
   head/tail + "elided chars" convention is the same idea as Claude Code's "output too long" truncation, and is
   plausibly the earliest public version of it in an open agent.
9. **Human-in-the-loop confirmation with a whitelist** (`interactive.py:24-30`, 162-182) — the same UX as permission
   prompts in commercial CLIs.
10. **Path/config discovery from cwd + user config dir** (`config/__init__.py:17-26`, `__init__.py:26-28`) — standard CLI
    ergonomics.
11. **Trajectory logging to JSON with a format version field** (`trajectory_format: "mini-swe-agent-1.1"`, default.py:178) and a dedicated viewer — same as every harness's `runs/` directory.
12. **Multi-provider model abstraction with a class registry** (`models/__init__.py:78-89`) — LiteLLM plus thin bespoke clients (OpenRouter, Requesty, Portkey), mirroring how most harnesses abstract providers.
13. **Per-environment sandbox abstraction with a common exec signature** (`execute(action, cwd, timeout) -> dict`) — the "one interface, many backends" pattern of Docker/remote sandboxes.
14. **Batch runner with a worker pool, resumability and a live progress table** (`swebench.py:229-271`, `batch_progress.py`) — the standard benchmark-runner shape.
15. **A minimal smoke-test entry point**: `hello_world.py` (42 lines) is the "does my install work" path (`tests/run/test_run_hello_world.py`).

What is *not* shared with typical coding agents — and this is the interesting part — is everything in section 3.

---

## 3. Unique capabilities / design decisions (with evidence)

Each item: **decision** — evidence — *why it matters*.

### 3.1 Architecture-level

1. **Radical simplicity floor: the whole agent is 190 lines and the loop is 5 statements.**
   `agents/default.py:88-128` (`run`, `step`, `query`, `execute_actions`). *Why: any harness bug that survives 200 lines
   of green tests is a bug you can actually find; a 20k-line harness hides its own bugs in itself.*
2. **Exceptions carry messages; catching == appending.** `exceptions.py:1-26` + `default.py:115-116`. *Why: it collapses
   "terminate", "interrupt", "retry" and "inform the model" into one mechanism with no state machine.*
3. **Single termination signal: `messages[-1]["role"] == "exit"`.** `default.py:122-123`. *Why: extensions (new task,
   new limit, new error class) never need to touch the loop — they just append an exit message.*
4. **`finally: self.save()` inside the loop.** `default.py:120-121`. *Why: crash-safe trajectories — the artefact always
   matches the last completed step, which is the single most useful thing in a failed benchmark run.*
5. **Uncaught exceptions are recorded *and* re-raised.** `default.py:74-86, 117-119`. *Why: loud failure for the operator,
   full forensic artefact for triage — no "agent silently returned an empty patch".*
6. **Stateless-per-step execution: no shell session, ever.** `environments/local.py:24-29`; rationale
   `docs/faq.md:102-119` and `README.md:48-50`. *Why: no "when did the command end", no session corruption on
   interrupt, no orphaned locks, and sandboxing/parallelism become trivial.*
7. **Process-group kill on timeout.** `local.py:84, 89`. *Why: without `start_new_session` + `killpg`, background children
   hold the pipe open and the harness deadlocks instead of timing out.*
8. **Protocols + duck typing instead of base classes.** `__init__.py:43-81`. *Why: any object with the right methods is a
   drop-in component (see `tests/run/test_swebench.py:421-458`, where a bare class with 5 methods is a model).*
9. **Config carries the class name.** `get_environment`/`get_agent`/`get_model` all do `config.pop("*_class", default_type)`
   (`environments/__init__.py:30-33`, `agents/__init__.py:25-28`, `models/__init__.py:53`). *Why: swapping a backend is a
   config-file edit, full import paths are accepted, and there is no plugin registry to maintain.*
10. **The model owns parsing *and* observation formatting.** `litellm_model.py:128-151`,
    `docs/advanced/v2_migration.md:166`. *Why: text-mode vs tool-mode vs Responses-mode becomes three model classes
    instead of three agent branches; the agent never sees a provider quirk.*

### 3.2 Loop semantics

11. **Format-error retry is a *conversation*, not an internal retry loop.** `default.py:100-114` +
    `actions_toolcall.py:40-74`. *Why: the model sees its own bad output plus a targeted explanation
    ("Unknown tool 'shell'", "Missing 'command' argument"), which fixes a syntax error in one turn instead of re-rolling
    the dice N times.*
12. **Consecutive-error circuit breaker.** `AgentConfig.max_consecutive_format_errors` (default 3), counter reset on any
    clean step (`default.py:99, 103-104`), exit status `RepeatedFormatError` (110). *Why: a broken model/provider config
    burns 3 calls instead of the entire budget, while isolated hiccups are forgiven.*
13. **Billed format errors still count against the cost limit.** `default.py:101-102`; models persist `cost` onto the
    exception (`litellm_model.py:91`); regression test `tests/agents/test_default.py:530-544` asserts `agent.cost == 3.0`
    after 3 billed failures. *Why: otherwise `cost_limit` is bypassable by making the model output garbage.*
14. **Limits checked before the call, not after.** `default.py:132-147`. *Why: the budget is a hard ceiling, not a
    post-hoc report; the last allowed call is the last one paid for.*
15. **Wall-clock limit is separate and un-liftable.** `TimeExceeded(LimitsExceeded)` (`exceptions.py:17-18`) and the
    interactive agent explicitly refuses to prompt for it (`interactive.py:75-79`; test
    `tests/agents/test_interactive.py:928-947`). *Why: an operator-raised limit can't help if the clock is the constraint,
    so prompting would loop forever.*
16. **`0` means "unlimited" everywhere** (`step_limit`, `cost_limit`, `wall_time_limit_seconds`,
    `max_consecutive_format_errors`, `MSWEA_GLOBAL_*`): `default.py:26-33`, `models/__init__.py:30`. *Why: no `None` vs `0`
    ambiguity across YAML, env vars and CLI flags.*
17. **The format-error template can distinguish truncation from malformation.** `finish_reason` and `has_tool_calls` are
    passed to the template (`litellm_model.py:134`, `actions_toolcall.py:47, 70`) and the shipped templates branch on them
    (`mini.yaml:130`); tested in `tests/models/test_truncation_finish_reason.py:81-120`. *Why: telling the model "you were
    cut off, be brief" prevents the death spiral where it re-sends the same too-long response.*

### 3.3 Prompt / template conventions

18. **Templates are the configuration surface.** Everything the prompt needs — agent config, env config, model config,
    live `n_model_calls`, `model_cost`, `elapsed_seconds`, the last observation, plus per-run kwargs — is merged into one
    dict (`default.py:52-64`) and rendered with `StrictUndefined` (`default.py:67`). *Why: prompt engineering becomes a data
    change with no code deploy, and typos fail loudly.*
19. **Budget-aware prompts with no supporting code.** `programbench.yaml:238-256` renders "you are N steps away from your
    limit" and "you have ~M minutes remaining" straight from `step_limit - n_model_calls` and
    `wall_time_limit_seconds - elapsed_seconds`. *Why: graceful degradation near the budget in ~19 lines of Jinja instead
    of a summarization/compaction subsystem.*
20. **Long-output handling is a *prompt* policy.** `mini.yaml:113-128` / `swebench.yaml:136-158`: under 10 000 chars show
    everything; over, show head 5 000 + tail 5 000 + `elided_chars` + advice on `head`/`tail`/`sed`/redirect-to-file.
    *Why: the model is told how to get the rest, so truncation isn't a dead end, and it's tuned per-config with no code.*
21. **Machine-readable observation shapes chosen per config.** `mini.yaml:114-118` renders observations as JSON
    (`{"returncode": ..., "output": "..."}`); the swebench config uses XML-ish tags (`swebench.yaml:131-158`). *Why: one
    loop serves tool-call models, XML-preferring models and legacy backtick models purely by config.*
22. **A unique fence token to avoid prompt collisions.** Actions live in ```` ```mswea_bash_command ````, not ```` ```bash ````
    (`litellm_textbased_model.py:8`; rationale `docs/advanced/v2_migration.md:46-48`). *Why: prompts contain many `bash`
    examples, and a unique fence means those examples can never be mistaken for actions.*
23. **The current config *is* the documentation.** `docs/usage/*.md` embed the YAML via snippet includes and
    `mkdocs.yml:56-57` fails the build on a missing path. *Why: docs that cannot silently drift.*

### 3.4 Parsing robustness

24. **The tool-call parser validates semantics, not just syntax.** `actions_toolcall.py:57-74`: JSON-parse errors, unknown
    tool names and a missing `command` each produce a distinct message. *Why: the error text is the repair instruction.*
25. **Actions and outputs cannot desync.** `format_toolcall_observation_messages` pads with a synthetic
    "action was not executed" output (`actions_toolcall.py:88-89`; same in the Responses-API variant, 116-117). *Why: one
    model call emitting N tool calls where action k raises still yields exactly N well-formed tool-result messages, so no
    dangling `tool_call_id` can reach the provider.*
26. **Text mode requires exactly one action — no guessing.** `actions_text.py:25-26`. *Why: silently picking a block turns
    a model ambiguity into a wrong action executed on a real filesystem.*
27. **Response-persistence contract on parse failure.** `litellm_model.py:87-98` (and 6 siblings), enforced by
    `tests/models/test_format_error_response_persistence.py` (11 tests, including the `repr()` fallback at
    `litellm_model.py:94-97`). *Why: you can still debug *why* the model failed by reading the trajectory.*
28. **Multi-dialect display normalization.** `models/utils/content_string.py:32-87` handles chat, multimodal, Anthropic
    tool_use/tool_result, `tool_calls` and Responses-API `output` arrays in one function. *Why: the human-facing UI works
    across every provider with zero per-model UI code.*

### 3.5 Benchmark / CLI

29. **Submission = first line `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` AND `returncode == 0`; the remainder is the
    submission.** All 7 environments, e.g. `local.py:45-56`. *Why: zero diff-extraction code, the patch is literally what
    the model printed, and a failing command can't accidentally submit.*
30. **`preds.json` written under a lock in SWE-bench's exact schema.** `swebench.py:65, 97-119`. *Why: `-w 8` is safe and
    the output drops straight into `sb-cli submit` / `swebench.harness.run_evaluation` with no post-processing.*
31. **Resumability by artefact, not bookkeeping.** `swebench.py:229-232` (`--redo-existing` off by default, keyed on
    `preds.json` keys) and `programbench.py:146-150` (keyed on `submission.tar.gz`); stale entries are deleted up-front
    (`swebench.py:132-133`). *Why: a crashed or killed batch is resumed by re-running the same command.*
32. **Deterministic `--shuffle` (`random.seed(42)`).** `swebench.py:185-187`; test `tests/run/test_swebench.py:193-202`.
    *Why: subset selection is reproducible and comparable across runs.*
33. **`--slice '0:5'` and regex `--filter` on every runner.** `swebench.py:180-197`, `programbench.py:123-144`. *Why:
    probing 5 instances costs seconds, and the flags being identical across runners makes them a convention, not a one-off.*
34. **Batch progress = two rich bars + an exit-status histogram + a YAML report rewritten on every instance end.**
    `batch_progress.py:57-82, 145-157`; the displayed cost comes from the global singleton (`117-123`). *Why: a long run is
    observable *and* diagnosable while it runs — a systematic failure shows up as one dominant status immediately.*
35. **`model_name_or_path` taken from `model.config.model_name`.** `swebench.py:176`; `tests/run/test_save.py:42-44`
    asserts the `*_type` strings. *Why: predictions are self-describing, which is what the harness needs to attribute
    scores.*
36. **Interrupt-proof batch cancellation.** `swebench.py:264-271`. *Why: Ctrl-C drains in-flight instances and saves their
    trajectories instead of losing paid-for work.*

### 3.6 Interface / DX

37. **Ctrl-C is a *feature* of the interactive agent, not a failure.** `interactive.py:109-122`: a KeyboardInterrupt is
    caught and the user's typed text becomes an injected user message. *Why: the user can steer without losing the
    trajectory, and the correction reaches the model as ordinary history.*
38. **`/m` multiline, `/h` help, `/y /c /u` mode switches, with prompt history persisted.** `interactive.py:184-208`,
    `agents/utils/prompt_user.py:7-9`. *Why: an interactive agent is a REPL, and a REPL needs history and help.*
39. **Non-interactive safety: never call `input()` without a tty.** `interactive.py:81-87, 96-107`; test
    `tests/agents/test_interactive.py:899-925` asserts `input()` is *never* called under redirected stdin. *Why: unattended
    runs exit cleanly with a `LimitsExceeded` artefact instead of crashing on `EOFError`.*
40. **First-run wizard + a single `.env` as the global config.** `run/utilities/config.py:62-96`, `__init__.py:26-36`.
    *Why: "works on the first try" for a new user, and credentials live in one auditable file instead of a bespoke
    settings system.*
41. **Deterministic test models ship in the package (`src/…/test_models.py`), not in `tests/`.** *Why: downstream users
    (benchmark authors, RL harnesses) can script agent runs and unit-test their own prompts offline.*

---

## 4. STEAL LIST

Numbered and actionable. "Steal" = copy the *decision*, not necessarily the code.

1. **Enforce a hard simplicity floor on the core loop (≈200 LOC).** `src/minisweagent/agents/default.py:88-157` — *if the
   loop can't be read in one sitting, every future bug becomes a haystack problem; keep the loop tiny and push policy into
   config and prompts.*
2. **Make exceptions carry their messages; handle by appending.** `src/minisweagent/exceptions.py:1-26`,
   `agents/default.py:115-116` — *one mechanism for terminate/interrupt/retry/inform replaces a state machine and all of its
   transition bugs.*
3. **Terminate on a single sentinel (`messages[-1]["role"] == "exit"`).** `agents/default.py:122-123` — *new termination
   reasons then require zero loop changes, which is what keeps the loop small forever.*
4. **Persist the trajectory inside the loop (`finally: save()`), not at the end.** `agents/default.py:120-121` — *a crash,
   SIGINT or OOM kill still leaves the exact state of the last finished step for triage.*
5. **Handle format errors by injecting a corrective user message and continuing.** `agents/default.py:100-114` +
   `models/utils/actions_toolcall.py:40-74` — *the model repairs itself in context; you avoid blind re-rolls without turning
   a syntax slip into a failed task.*
6. **Cap *consecutive* format errors (reset on any clean step) and give the spiral its own exit status.**
   `agents/default.py:32, 99, 103-111`; tests `tests/agents/test_default.py:481-512` — *kills runaway loops in 3 calls while
   forgiving isolated glitches.*
7. **Charge for failed turns too.** `agents/default.py:101-102`, `models/litellm_model.py:91` — *otherwise garbage output is
   free and the cost ceiling is fiction.*
8. **Check the budget *before* the call and use `0 = unlimited` uniformly.** `agents/default.py:132-147, 26-33` — *the
   ceiling becomes a real ceiling, and there is no `None`/`0` ambiguity across YAML, env vars and CLI flags.*
9. **Keep a separate, non-liftable wall-clock limit.** `exceptions.py:17-18`, `agents/interactive.py:75-79` — *time can't be
   bought back with more money, so it must be its own terminal condition.*
10. **A global, lock-guarded spend ceiling (`GLOBAL_MODEL_STATS`).** `models/__init__.py:13-42` — *the only way an
    unattended `-w 8` batch run can be trusted with money (`MSWEA_GLOBAL_COST_LIMIT`).*
11. **Stateless per-action execution (a fresh subprocess per step).** `environments/local.py:24-29`; rationale
    `docs/faq.md:102-119` — *eliminates the three hardest problems of agent shells (termination detection, session death,
    interrupt corruption) instead of patching them.*
12. **Kill the whole process group on timeout and keep partial output.** `environments/local.py:72-92` — *10 lines that turn
    the most common harness hang into a clean observation.*
13. **Make every environment return the same 4-key dict, including on failure.** `local.py:30-41`, `docker.py:125-136` — *one
    observation contract means the agent and prompt layers never branch on transport type.*
14. **Termination check = first non-whitespace line is a magic string AND exit code 0; submission = the remainder.**
    All environments, e.g. `environments/local.py:45-56` — *no diff extraction, no special submit tool, and no accidental
    submit from a command that merely mentions the token.*
15. **Let the model class own `format_message` / `format_observation_messages`.** `models/litellm_model.py:137-151`,
    `docs/advanced/v2_migration.md:166` — *switching provider dialect becomes a one-line config change instead of an
    agent-level `if provider == …` chain.*
16. **One merge function with an `UNSET` sentinel for layered config.** `utils/serialize.py:1-29`, used at
    `run/mini.py:73-92` — *CLI overrides, YAML files and defaults compose predictably, and "not specified" is
    representable.*
17. **Let config keys name the class, accepting short names *or* import paths.** `environments/__init__.py:8-33`,
    `agents/__init__.py:8-28` — *extensibility with no plugin API to design, document or version.*
18. **Use `StrictUndefined` Jinja templates everywhere and expose the *whole* runtime state as template vars.**
    `agents/default.py:52-67` — *typos fail loudly and prompt changes stop requiring code changes.*
19. **Put the budget countdown in the prompt via template vars (`step_limit - n_model_calls`,
    `wall_time_limit_seconds - elapsed_seconds`).** `config/benchmarks/programbench.yaml:238-256` — *graceful degradation
    near the deadline in ~19 lines of Jinja instead of an entire context-compaction subsystem.*
20. **Truncate long observations with head/tail + an `elided_chars` counter + remediation advice.**
    `config/mini.yaml:113-128` — *keeps context bounded while telling the model how to see the rest, so truncation never
    becomes a dead end.*
21. **Use a distinct fence token for actions and require exactly one action in text mode.**
    `models/litellm_textbased_model.py:8`, `models/utils/actions_text.py:25-26` — *prompt examples can't be mistaken for
    actions and model ambiguity fails loudly instead of executing a guess.*
22. **Emit distinct, specific parse errors (unknown tool / bad JSON / missing arg) into the retry prompt.**
    `models/utils/actions_toolcall.py:53-76` — *the error message is the repair instruction; a generic "parse error"
    wastes a turn.*
23. **Pad observation outputs so `actions` and `outputs` can never desync.** `models/utils/actions_toolcall.py:88-89` —
    *N tool calls always produce exactly N tool-result messages, even when one raises — required by strict providers.*
24. **Persist the raw model response on parse failure (with a `repr()` fallback) as a written contract.**
    `models/litellm_model.py:87-98` — *trajectory logs stay debuggable even in the worst failure mode.*
25. **Pass `finish_reason` (and `has_tool_calls`) into the format-error template and ship a "you were cut off" branch.**
    `models/litellm_model.py:134`, `models/utils/actions_toolcall.py:47,70`, `config/mini.yaml:130`; tests in
    `tests/models/test_truncation_finish_reason.py` — *tell the model to be concise instead of letting it re-roll the same
    too-long response.*
26. **Map Responses-API truncation onto the chat-completions vocabulary.**
    `models/utils/actions_toolcall_response.py:45-55` — *one `format_error_template` then works across both APIs.*
27. **Standardise on the harness's own prediction schema (`preds.json`) and nothing else.**
    `run/benchmarks/swebench.py:97-108` + `docs/usage/output_files.md:97-110` — *free compatibility with `sb-cli` and the
    SWE-bench evaluator, with no runtime dependency on the benchmark package.*
28. **Make batch runs resumable from the output artefact, purging stale entries first.**
    `run/benchmarks/swebench.py:132-133, 229-232` — *restarting a failed 500-instance run is just re-running the same
    command.*
29. **Provide deterministic `--shuffle` plus `--slice`/regex `--filter` on every runner.** `run/benchmarks/swebench.py:180-197`
    — *cheap, reproducible subsetting is the difference between a 30-second probe and a 6-hour run.*
30. **Answer "is it broken or just slow?" from the live UI: per-status histogram + ETA + running cost.**
    `run/benchmarks/utils/batch_progress.py:57-123, 145-157` — *a systematic failure is visible in seconds instead of after
    the whole batch.*
31. **Drain in-flight work on Ctrl-C instead of aborting.** `run/benchmarks/swebench.py:264-271` — *interrupted batches keep
    the results they already paid for.*
32. **Treat Ctrl-C in the interactive agent as user input (inject a message), not as an abort.**
    `agents/interactive.py:109-122` — *the user's intent enters the conversation as history and nothing is lost.*
33. **Never prompt for input without a tty.** `agents/interactive.py:81-87, 96-107` — *unattended runs degrade to a saved
    `LimitsExceeded` trajectory instead of an `EOFError` crash.*
34. **Ship the deterministic test model inside the library.** `models/test_models.py:16-130` — *any downstream user can
    script and unit-test agent runs offline; this is also why 9.6k lines of tests need no network.*
35. **Parametrize agent tests over every message dialect.** `tests/agents/test_default.py:117-126` — *a loop change that
    only works for tool calls fails immediately rather than in production.*
36. **Encode the agent's own contribution contract in `AGENTS.md` (style, test style, commit format) and make
    `CLAUDE.md` a one-line import of it.** `AGENTS.md:19-52, 65-109`, `CLAUDE.md:1` — *one source of truth for humans and
    agents, so contributions look like the codebase.*
37. **Include real source files in the docs and fail the docs build on missing paths.** `mkdocs.yml:56-57`,
    `docs/advanced/control_flow.md:56` — *the design essay and the implementation can't drift apart.*

38. **Default-deny network for the agent's container — and prove it with a test against a real container.**
    `config/benchmarks/programbench.yaml` ships `run_args: [--rm, --network, none]`, and
    `tests/run/test_programbench.py:80-116` asserts both that the shipped config contains `--network none` **and** that a
    container started that way reports `INTERNET_BLOCKED`. — *it makes the benchmark environment what the benchmark
    assumes it is, and it caps the blast radius of a prompt-injected `curl | bash`.*
39. **Scriptable pseudo-actions inside the deterministic model: `/sleep N`, `/warning MSG`, `{"raise": Exception}`.**
    `models/test_models.py:75-87` (`_process_test_actions`) + `tests/models/test_test_models.py:77-110`. — *timing
    pressure, log expectations and crash paths become data in a scripted conversation, so no monkeypatching is needed to
    test the hard branches.*
40. **Keep provider-shape repair in tiny, single-purpose utils; never in the loop.** `models/utils/anthropic_utils.py:11-27`
    (move `thinking`/`redacted_thinking` blocks first, append an empty text block when needed — an Anthropic API
    requirement), `models/utils/cache_control.py:43-46` (the documented tool-role workaround), and the stateless Responses
    adapters that *flatten* prior response objects and strip `extra` before resending
    (`models/portkey_response_model.py:82-94`; asserted byte-for-byte in `tests/models/test_portkey_response_model.py:43-90`).
    — *provider quirks are real, permanent, and must not be able to grow into the agent core.*
41. **Make configuration errors self-documenting: put the fix and the doc link inside the exception text.**
    `models/litellm_model.py:108-126` raises with the model name, a docs link, the issue-tracker link and the literal
    `MSWEA_COST_TRACKING='ignore_errors'` escape hatch; asserted by tests (`tests/models/test_litellm_textbased_model.py:109-126`).
    — *an unattended run should never die on a "you had to know the magic env var" failure.*

**41 steal items.** Forced to pick the top 8 for a harness being built today: **1, 3, 4, 5, 6, 10, 11, 14**.

---

## 5. Optimisation + what-to-do candidates

Ordered by (impact × likelihood the maintainers would accept it).

### 5.1 Correctness / robustness

1. **`_check_finished` is copy-pasted 7×** (`local.py:45-56`, `docker.py:140-151`, `singularity.py:121-132`,
   `bubblewrap.py:119-130`, `contree.py:124-135`, `swerex_docker.py:56-67`, `swerex_modal.py:91-102`). Any change to the
   submit contract must be applied 7 times. Extracting `maybe_submitted(output) -> dict | None` into a shared module would
   remove the drift risk. The same duplication exists for the timeout/exception-normalisation block (4 copies).
2. **`agent.cost` and `n_calls` are plain attributes with no locking**, while `GLOBAL_MODEL_STATS` *is* locked
   (`models/__init__.py:19, 27-29` vs `agents/default.py:47-48`). That's fine for one-agent-per-thread (as in
   `swebench.py`), but a future shared-agent or async design would corrupt both. Worth a comment or a lock.
3. **`GLOBAL_MODEL_STATS` is a module-level singleton created at import** (`models/__init__.py:42`), so it reads the env
   vars once and can never be reset in-process by a library user (tests reach into `_cost`/`_n_calls`, conftest.py:35-40).
   A `reset()` method would be a 3-line improvement for embedders.
4. **`RequestyModel._calculate_cost` raises on `cost == 0.0` and ignores `cost_tracking`** (`requesty_model.py:124-132`),
   unlike every other model class. Inconsistent: free/trial Requesty models are unusable while the documented escape hatch
   (`MSWEA_COST_TRACKING=ignore_errors`) silently doesn't apply.
5. **The `FormatError`-persistence contract is enforced only by tests, not by code** (comment at `litellm_model.py:87`).
   A tiny shared helper (`_attach_response_and_reraises(e, response, cost)`) used by all 7 model classes would make the
   contract structural instead of conventional.
6. **`OpenRouterTextbasedModel.__init__` builds the parent config and then rebuilds it**
   (`openrouter_textbased_model.py:28-30`); harmless today, but it means `self.config` is created twice and any
   side-effecting config validation would run twice. Same shape in `openrouter_response_model.py:39-41`.
7. **`interactive.py:141-142` defines `_add_observation_messages` that is never called** (dead code in the shipped agent).

### 5.2 Performance / cost

8. **`_prepare_messages_for_api` deep-copies the whole history on every call.** `cache_control.py:60` does
   `copy.deepcopy(messages)` when cache control is enabled (the default for every Anthropic-family model name,
   `models/__init__.py:55-60`). For a 250-step SWE-bench trajectory this is a measurable per-step cost; mutating a
   copy-on-write structure or only deep-copying the tail would be cheaper.
9. **Trajectory is re-serialized on every step** (`default.py:120-121` → `serialize()` → `json.dumps`). At step_limit=250
   with large observations, that's O(n²) disk/CPU per run. Writing only when the message count changes *and* debouncing
   would keep the crash-safety property at a fraction of the cost.
10. **`observation_template` truncation is character-based (10 000)** (`mini.yaml:113`), which is provider-independent but
    not token-aware; a 4-char-per-token model and a 1-char-per-token model get very different budgets. A `token_limit`
    variant (or a documented ratio) would be a cheap win.
11. **`swebench.py` creates a fresh `ThreadPoolExecutor` future per instance with no retry on transient environment
    failures** (`swebench.py:257-263`); a failed `docker pull` marks the instance `exit_status=<ExceptionName>` and moves on.
    A bounded retry for *setup* failures (before the model has been billed) would improve complete-run yields.

### 5.3 Product / DX

12. **`mini_extra.py` silently prints the help text for an unknown subcommand** (`mini_extra.py:45`) — a typo (`mini-extra sweepbench`)
    looks like success. A non-zero exit + "unknown subcommand" is friendlier for scripts.
13. **`docs/reference/*` are mkdocstrings stubs**, so the API reference is only as good as the docstrings — and
    `AgentConfig`/`LocalEnvironmentConfig` have good ones while several model configs repeat long literals. Worth a docs
    sweep.
14. **No `--version` flag** on `mini`/`mini-extra` (only the import-time banner, `__init__.py:30-35`); scripts that want a
    version must parse the banner or import the package.
15. **`docs/models/troubleshooting.md` and `docs/models/local_models.md`** are the only places describing the cost-tracking
    escape hatch in prose, yet the error text points at a short link (`klieret.short.gy/mini-local-models`). Making the
    link target stable in-repo (a docs anchor) would remove an external dependency from the error path.
16. **ProgramBench support is coupled to Docker internals**: `copy_submission` reads `env.container_id` and
    `env.config.executable` directly (`programbench.py:46-60`). A `dump_workspace(dest)` method on the environment
    protocol would let `singularity`/`swerex` backends produce submissions too (the docs already recommend singularity for
    SWE-bench).
17. **`wall_time_limit_seconds` has no CLI flag** on `mini` (only settable via config/`programbench.yaml:4`), unlike
    `cost_limit` (`run/mini.py:62`). Small ergonomics gap.
18. **A stale v1 leftover that fails at runtime.** `tests/test_data/update_outputs_github_issue.py:9` imports
    `minisweagent.run.extra.github_issue`, a module removed in v2 (`docs/advanced/v2_migration.md:138`;
    `src/minisweagent/run/extra/__init__.py` is now empty), so that regeneration script raises `ImportError` — meaning the
    `github_issue.traj.json` fixture can no longer be refreshed (the `local` counterpart still works). Delete the script or
    port it to the `mini` CLI.
19. **A documented command that cannot work.** `docs/reference/environments/swerex_modal.md:27` tells users to pass
    `--config src/minisweagent/config/extra/swebench_modal.yaml`, but none of the five candidates in `get_config_path`
    (`config/__init__.py:17-30`) can resolve it — the copy-pasted command dies with `FileNotFoundError`. Correct the path to
    `config/benchmarks/swebench_modal.yaml` and either remove the vestigial `builtin/extra/` candidate or document it as the
    reserved home for third-party configs.
20. **`docs/contributing.md:19` steers contributors to the now-empty `run/extra/` folder** as "this one" when explaining
    where specialised components go. Either ship one real example there or reword the guidance, otherwise the convention is
    unlearnable from the repository.

### 5.4 Where the repo is *deliberately* not optimising (and should not be "fixed")

These look like omissions but are load-bearing decisions, documented in-repo:

- **No tool other than bash** (`README.md:42-44`): adding file/patch/search tools would move the scaffold back into the
  middle of the experiment.
- **No history compression/compaction.** The truncation-at-the-observation is the whole policy (item 20 of the steal list).
  Adding summarisation would break the "trajectory == what the model saw" property (`README.md:45-47`) and invalidate
  fine-tuning datasets.
- **No stateful shell session** (`docs/faq.md:102-119`): the stated costs (cd/env not persistent) are accepted in exchange
  for termination/robustness/parallelism.
- **Text-mode parsing kept alongside tool calls** (```` ```mswea_bash_command ````, `actions_text.py:1-4`): required for
  models without tool-calling, and it is what the v1 SWE-bench numbers were produced with.
- **Config classes are explicit and required** (`tests/config/test_swebench_template.py:174-181`): no code-level default
  prompts, so nothing silently diverges between the library and the shipped configs.

---

*End of report. 0 files in `/data/home/forge/repo-tour/mini-swe-agent` were modified; `/data/home/forge/HorizonCode` was not touched.*
