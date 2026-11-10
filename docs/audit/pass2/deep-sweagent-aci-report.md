# SWE-agent ACI Deep-Dive Report

Repo: `SWE-agent` (repo not cloned, path not verified) (SWE-agent 1.x, bundle-based ACI). Every statement below was read out of the tree; line-level anchors are given per section.

## 1. Repo map

| Path | Role in the ACI |
|---|---|
| `config/*.yaml` | Run configs that *compose* bundles + variables. `config/default.yaml` (registry + edit_anthropic + review_on_submit_m), `config/sweagent_0_7/07*.yaml` (classic windowed ACI), `config/exotic/windowed_replace.yaml` (windowed + search + windowed_edit_replace + submit), `config/bash_only.yaml` (pure-bash ACI), `config/human/`, `config/benchmarks/`, `config/coding_challenge.yaml` |
| `sweagent/tools/commands.py` | `Argument` / `Command` pydantic models. `Command.invoke_format` renders a signature; `get_function_calling_tool()` turns a command into an OpenAI-style tool schema; validated at load (required args before optional, names match the signature). Builtin `BASH_COMMAND = bash <command>` |
| `sweagent/tools/bundle.py` | `Bundle`: a directory holding `config.yaml` (tool declarations) + `bin/` (executables) + optional `install.sh`; uploaded to `/root/tools/<name>` inside the container |
| `sweagent/tools/tools.py` | `ToolConfig` (bundles, `env_variables`, `registry_variables`, `submit_command`, `parse_function`, `enable_bash_tool`, timeouts, blocklist, `command_docs`) and `ToolHandler` (install/reset, `/root/state.json`, `should_block_action`, multiline guard, per-command regexes, submission sentinel) |
| `sweagent/tools/parsing.py` | Action parsers: `function_calling`, `thought_action`, `thought_action_xml`, `action`, `action_only`, backticks variants; each carries a `format_error_template` shown to the model on a malformed action |
| `sweagent/tools/utils.py` | `generate_command_docs()` (the `{{command_docs}}` prompt block for text parsers: docstring / signature / argument list) and `_guard_multiline_input()` (turns `end_name` commands into heredocs) |
| `tools/windowed/` | **The file-viewer ACI**: `bin/{open,goto,scroll_up,scroll_down,create,_state}`, `lib/windowed_file.py`, `lib/flake8_utils.py`, `install.sh` |
| `tools/search/` | **The search ACI**: `bin/{find_file,search_dir,search_file}` |
| `tools/windowed_edit_replace/` | **Search/replace-in-window editor**: `bin/{edit,insert}` (lint-gated) |
| `tools/windowed_edit_linting/` | The 0.7 line-range editor: `edit <start>:<end>` … `end_of_edit` |
| `tools/edit_anthropic/` | Claude-style `str_replace_editor` (view/create/str_replace/insert/undo_edit) with `filemap` fallback for large `.py` files |
| `tools/filemap/` | tree-sitter Python viewer that elides function/method bodies |
| `tools/registry/` | `EnvRegistry`: a JSON KV file `/root/.swe-agent-env` (env-var fallback) that carries `CURRENT_FILE`, `FIRST_LINE`, `WINDOW`, … across process invocations; `bin/{_read_env,_write_env}` + `state_command` |
| `tools/submit/`, `tools/review_on_submit_m/` | `submit` (git-add + `git diff --cached` → `/root/model.patch` + the `<<SWE_AGENT_SUBMISSION>>` sentinel) and the review-gated variant (staged `SUBMIT_REVIEW_MESSAGES`, hidden `-f` force flag) |
| `tools/diff_state/`, `tools/forfeit/`, `tools/image_tools/`, `tools/web_browser/`, `tools/multilingual_setup/` | Extra state commands and capability bundles |
| `sweagent/environment/swe_env.py` | `SWEEnv`: `communicate()` (one command → combined output + exit code), `read_file`/`write_file`, `set_env_variables`, timeouts. **No output truncation here** — bounding is an agent/tool-layer concern |
| `sweagent/agent/agents.py` | Templates (`system_template`, `instance_template`, `next_step_*`), `add_step_to_history()` (observation truncation), `_get_format_dict()` (injects `command_docs`, `WINDOW`, `open_file`, `working_dir`) |
| `sweagent/agent/history_processors.py` | `last_n_observations` (elide all but the last n observations), `cache_control`, content-eliding processors |
| `docs/background/aci.md` | The design rationale in four bullets (100-line viewer, linter-gated edits, match-summary search, explicit empty-output message) |

Architectural fact worth copying: the ACI is **container-resident binaries + a per-bundle `config.yaml` declaration**, and the model-facing tool schema (function calling) or the `COMMANDS:` text block (text parsers) is *generated* from those declarations at startup — one source of truth, two presentations.

## 2. COMPLETE command table

### 2.1 Bundle `windowed` (the viewer)

| Command | Inputs | Output semantics | Why it saves tokens |
|---|---|---|---|
| `open "<path>" [<line_number>]` | `path` (req), `line_number` (opt) | Prints the display window: `[File: <abs path> (<N> lines total)]`, `(<k> more lines above)`, `<n>:<line>` rows, `(<k> more lines below)`. Line is clamped with warnings (line > n_lines → set to n_lines; line < 1 → set to 1). With no argument and a file already open it just re-prints the current window | Replaces `cat`/`head`: at most `WINDOW` (100) lines + 2 status lines regardless of file size |
| `goto <line_number>` | `line_number` (req) | `first_line = line - window * 1/6`, so the target lands ~1/6 down the window; errors if `line > n_lines`; prints the window | One call replaces N `scroll_down` calls; the 0.7 prompt spells this out ("don't scroll to line 583, use `goto 583`") |
| `scroll_down` / `scroll_up` | none | `scroll(±window)` ⇒ `first_line += ±(window - overlap)`, i.e. a net 98-line step with 2 lines of overlap; clamped by the `first_line` setter to `[0, n_lines - window]`; prints the window | Bounded, overlapping navigation; the 2-line overlap removes the usual "re-read to re-anchor" turn |
| `create <filename>` | `filename` (req) | Creates parent dirs, `touch`es the file, opens it at the top and prints the (empty) window; refuses if the file already exists | File creation without a heredoc `cat > f << EOF`, and the cursor state stays consistent afterwards |
| `_state` | — (bundle `state_command`, not model-visible) | Writes `open_file` (resolved, or `"n/a"`) and `working_dir` (cwd) into `/root/state.json` | Those two values are templated into *every* prompt, so the model never spends a turn on `pwd`/`ls` to re-orient |

### 2.2 Bundle `search`

| Command | Inputs | Output semantics | Why it saves tokens |
|---|---|---|---|
| `find_file <file_name> [<dir>]` | name/pattern (req, shell wildcards), dir (opt, default `./`) | `find <dir> -type f -name <pattern>`; prints `Found <N> matches for "<name>" in <dir>:` and the path list, or `No matches found …` | Paths only — no contents, no metadata; cost is O(matches), not O(tree) |
| `search_dir <search_term> [<dir>]` | term (req), dir (opt) | Recursive `grep`, hidden paths excluded; prints **per-file match counts** — `./pkg/a.py (3 matches)` — wrapped by `Found <N> matches …` / `End of matches …`. If **more than 100 files** match it prints `More than <N> files matched … Please narrow your search.` and *no results* | The signature ACI move: one line per **file** instead of one line per **match**; the 100-file abort forces narrowing instead of a repo-wide dump |
| `search_file <search_term> [<file>]` | term (req), file (opt → the currently open file, read from the registry) | `grep -n`; prints `Found <N> matches …` then `Line <n>:<text>`; if **> 100 distinct matching lines** it aborts with "Please narrow your search." | Defaults to the file in view (no path argument), and the 100-line cap bounds the worst case |

### 2.3 Bundles `windowed_edit_replace` / `windowed_edit_linting` (the editors)

| Command | Inputs | Output semantics | Why it saves tokens |
|---|---|---|---|
| `edit <search> <replace> [<replace-all>]` | search, replace, `replace-all` (opt) | Searches **only inside the currently displayed window**. Failures never mutate and are *repaired*: text not in window but present elsewhere → lists every occurrence line number + "You can use the `goto` command…"; >1 occurrence in the window → "make your search string more specific"; `search == replace` → no-op error; flake8 sees a **new** syntax error → the edit is **undone** and the message shows the would-be-applied window *and* the original window. Success prints a 3-point review checklist and re-prints the window | A failed edit costs ~5–15 lines of targeted advice instead of a re-read; the lint gate prevents a broken tree that would cost many repair turns. Window scope keeps search strings short |
| `insert <text> [<line>]` | text (req), line (opt = append) | Inserts after `<line>` (or at EOF), trims one trailing newline, lint-gated like `edit`, prints the window | Append-only edits without shipping a whole file through `write` |
| `edit <start_line>:<end_line>` … `end_of_edit` | range + multiline replacement (heredoc-terminated) | Replaces the inclusive range in the open file; indentation must be supplied literally; lint-checked | The 0.7 form: line addressing avoids a long search string, and the sentinel keeps multi-line text parseable in a text-only protocol |

### 2.4 Bundle `edit_anthropic` (the default-config ACI)

| Command | Inputs | Output semantics | Why it saves tokens |
|---|---|---|---|
| `str_replace_editor <command> <path> [file_text] [view_range] [old_str] [new_str] [insert_line]` | `command ∈ {view, create, str_replace, insert, undo_edit}` (enum in the declaration), path, per-command args | `view`: `cat -n`-style numbered output; optional `view_range` (1-based; `[start, -1]` = to EOF); the viewport can be expanded to whole functions/classes (`MAX_WINDOW_EXPANSION_VIEW`, **default 0 = off**). A `.py` file longer than **16,000 chars** is replaced by the `filemap` skeleton, with `<NOTE>`s telling the model to use `view_range` next. `create` refuses an existing file; `str_replace` requires an exact unique match; `undo_edit` reverts the last edit. **Every** output goes through `maybe_truncate(…, 16000)`, appending `<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with grep -n in order to find the line numbers of what you are looking for.</NOTE>` | A hard 16 KB ceiling per call independent of file size, and the truncation message teaches the exact recovery move (`grep -n`) rather than leaving the model to guess |
| `filemap <file_path>` | file_path (req) | tree-sitter Python; elides each function/method body spanning **≥ 5 lines** as `... eliding lines a-b ...`; prints `%6d <line>` numbering | Structural skeleton of a large file for a fraction of the bytes (signatures, docstrings, control flow kept) |

### 2.5 Supporting bundles and the builtin bash tool

| Command | Inputs | Output semantics | Why it saves tokens |
|---|---|---|---|
| `submit` (`tools/submit`) | none | `cd $ROOT`; `git apply -R /root/test.patch` (restores the golden tests); `git add -A`; `git diff --cached > /root/model.patch`; echoes `<<SWE_AGENT_SUBMISSION>>` | Submission is one token-cheap sentinel; the patch is written to disk, not into the context |
| `submit` (`tools/review_on_submit_m`) | model sees none (harness may pass hidden `-f/--force`) | Writes the same patch, then walks `SUBMIT_REVIEW_MESSAGES` staged in the registry: prints the stage message with `{{diff}}`/`{{problem_statement}}` substituted and returns *without submitting*; only when all stages are exhausted (or `-f`) does it emit the sentinel and the patch | Turns "done" into a review loop (re-run repro, delete repro script, `git checkout --` any test edits, submit again) at the cost of a few hundred tokens instead of a failed submission |
| `_read_env` / `_write_env` (`tools/registry`) | key (and value) | Reads/writes `/root/.swe-agent-env` (JSON), with env-var fallback | Lets stateful ACIs (cursor, window, submit stage) work across stateless process invocations — the alternative would be the model re-establishing state every turn |
| `_state` (diff_state), `exit_forfeit` (forfeit) | — | Emits the workspace diff into state / exits the run | Diff-in-state feeds the review message without an extra model turn |
| `bash <command>` (builtin, `enable_bash_tool`) | command (req) | Runs anything, except the blocklist: `vim, vi, emacs, nano, nohup, gdb, less, tail -f, python -m venv, make` (prefix), `python, python3, ipython, bash, sh, /bin/sh, su, …` (standalone), plus a `block_unless_regex` guard for `radare2` | The escape hatch that keeps the ACI honest; the blocklist protects the harness from interactive commands that would hang the session |

Cross-cutting: `ToolConfig.env_variables` sets `PAGER=cat`, `MANPAGER=cat`, `LESS=-R`, `PIP_PROGRESS_BAR=off`, `TQDM_DISABLE=1`, `GIT_PAGER=cat` in the container. `execution_timeout=30 s`, `total_execution_timeout=1800 s`, `max_consecutive_execution_timeouts=3`, `install_timeout=300 s`.

## 3. The window / truncation model, with exact numbers

**Viewer state** (all of it lives in `/root/.swe-agent-env` through `EnvRegistry`, so it survives across the short-lived processes that implement each command):

| Variable | Default | Set by | Effect |
|---|---|---|---|
| `WINDOW` | `100` | `tools/windowed/install.sh` (`${WINDOW:-100}`), overridden by the configs' `env_variables.WINDOW` (every ACI config sets 100) | Lines shown per `open`/`goto`/`scroll` |
| `OVERLAP` | `2` | `install.sh` (`${OVERLAP:-2}`); configs set 2 | Bookmark lines kept between scroll steps (net step = 98) |
| `FIRST_LINE` | `0` | `install.sh`, then updated by the `first_line` setter on every navigation/edit | Top of the window, **clamped to `[0, n_lines - WINDOW]`** |
| `CURRENT_FILE` | `""` | `WindowedFile.__init__` writes the resolved absolute path | Target of `open` (no args), `goto`, `scroll_*`, `edit`, `insert`, `search_file` |

**Window arithmetic** (`tools/windowed/lib/windowed_file.py`):

- `line_range = (first_line, min(first_line + WINDOW - 1, n_lines - 1))` — exactly `WINDOW` lines except at EOF.
- `goto(line)` ⇒ `first_line = line - WINDOW * 1/6` (`offset_multiplier = 1/6`), i.e. ~17 lines of context above the target line.
- `scroll(±WINDOW)` ⇒ `first_line += ±(WINDOW - OVERLAP)` ⇒ 98-line net advance, 2-line overlap.
- Rendering: `print_window(line_numbers=True, status_line=True, pre_post_line=True)` ⇒ header `[File: <path> (<N> lines total)]`, rows `"<n>:<line>"`, and `(<k> more lines above)` / `(<k> more lines below)`. **The model always knows how much file it has not seen.**
- `create` seeds `first_line = 0` for the new file; `open` without a line number keeps the current `first_line`.

**Edit-layer truncation / repair semantics** (`tools/windowed_edit_replace/bin/edit`, `tools/windowed/lib/flake8_utils.py`):

- The search must match **inside the window**; a match elsewhere in the file is *not* applied, and the error enumerates the line numbers plus the `goto` hint.
- More than one occurrence in the window with `replace-all=False` ⇒ refusal (no mutation) asking for more context.
- `search == replace` ⇒ refusal (`No changes were made`).
- Pre- and post-edit `flake8` runs; only **newly introduced** diagnostics in the replacement range are reported (`format_flake8_output(..., previous_errors_string=pre_edit_lint, replacement_window=..., replacement_n_lines=...)`). On a lint failure the edit is **undone** (`wf.undo_edit()`) and both windows are printed — the postimage that would have been written and the current preimage. Every failure path also prints the `###SWE-AGENT-RETRY-WITH-OUTPUT###` marker that the harness uses to re-render the retry.
- The `init` message of the editor is model-teaching prose: "Before every edit, please 1. Explain the code you want to edit…" (in the `edit` docstring) and the success message asks the model to re-check indentation, duplicate lines and non-breaking behaviour.

**Search-layer truncation** (`tools/search/bin/*`):

- `search_dir`: results are **per-file counts**, and the call refuses to answer at all above **100 matched files** ("Please narrow your search.").
- `search_file`: refuses above **100 distinct matching lines** in the file.
- `find_file`: no cap, but it returns paths only.

**Editor-layer truncation** (`tools/edit_anthropic/bin/str_replace_editor`):

- `MAX_RESPONSE_LEN = 16000` characters; `maybe_truncate` clips and appends the `TRUNCATED_MESSAGE` that tells the model to `grep -n` first.
- `view` on a `.py` file longer than 16,000 chars and `USE_FILEMAP=true` (set in every `default*`/benchmark config via `registry_variables`) delegates to the `filemap` skeleton; if filemap itself fails, it falls back to the clipped content.
- `MAX_WINDOW_EXPANSION_VIEW` / `MAX_WINDOW_EXPANSION_EDIT_CONFIRM` are registry knobs, **default 0** (expanding a viewport to whole functions/classes is off unless a config enables it).

**filemap elision** (`tools/filemap/bin/filemap`): tree-sitter query captures `function_definition` bodies and elides those with `end - start >= 5` lines, replacing them with `... eliding lines <a>-<b> ...`; output is `%6d <line>` numbered.

**Agent-layer observation caps** (`sweagent/agent/agents.py`):

- `max_observation_length: int = 100_000` characters by default; above it the step uses `next_step_truncated_observation_template`: `"Observation: {{observation[:max_observation_length]}}<response clipped><NOTE>Observations should not exceed {{max_observation_length}} characters. {{elided_chars}} characters were elided. Please try a different command that produces less output or use head/tail/grep/redirect the output to a file. Do not use interactive pagers.</NOTE>"`.
- Config overrides: `config/bash_only.yaml` sets `max_observation_length: 10_000` and splits the observation into `head`/`tail` halves in its templates; the multimodal configs raise it to `10_000_000` (they must carry base64 images).
- Empty output is **narrated**, not silent: `next_step_no_output_template` → "Your command ran successfully and did not produce any output." plus the state footer.

**History-layer elision** (`sweagent/agent/history_processors.py`): `last_n_observations` (n=5 in the 0.7 and `windowed_replace` configs) replaces everything but the last ≤5 observations with "Old environment output: (n lines omitted)"; the docstring is explicit that it **breaks prompt caching**. `cache_control` with `last_n_messages: 2` is used in `config/default.yaml` instead.

**Net effect of the numbers**: per viewer turn the model sees ≤ ~4.2 KB (100 numbered lines + 2 status lines + the 2-3 line state footer); per search it sees ≈ 1 line per matching file; per `view` of a large file it sees ≤ 16 KB; per pathological command it sees ≤ 100 KB (default) — and the messages that accompany each cut tell the model which cheaper command to use next.

## 4. How the ACI is presented to the model

There are two presentations, generated from the *same* `Command` objects:

**(a) Function calling** (`parse_function: {type: function_calling}`, the default in `config/default.yaml`): every command becomes a tool schema via `Command.get_function_calling_tool()` — `name`, `description = docstring`, `parameters` from the `Argument` list with `enum`/`items`/`required`. The prompt therefore contains no command list at all; the ACI is the tool namespace plus the templates. Verbatim system prompt (`config/exotic/windowed_replace.yaml` — the windowed ACI's own text, the clearest statement of the design):

```text
SETTING: You are an autonomous programmer, and you're working directly in the command line with a special interface.

The special interface consists of a file editor that shows you {{WINDOW}} lines of a file at a time.
In addition to typical bash commands, you can also use specific commands to help you navigate and edit files.
To call a command, you need to invoke it with a function call/tool call.

Please note that THE EDIT COMMAND REQUIRES PROPER INDENTATION.
...
RESPONSE FORMAT:
Your shell prompt is formatted as follows:
(Open file: <path>)
(Current directory: <cwd>)
bash-$

First, you should _always_ include a general thought about what you're going to do next.
Then, for every response, you must include exactly _ONE_ tool call/function call.
```

**(b) Text parsers** (`thought_action`, `thought_action_xml`, `action`, …): the system template embeds `{{command_docs}}`, produced by `generate_command_docs()` as one block per command:

```text
open:
  docstring: opens the file at the given path in the editor. If line_number is provided, the window will be move to include that line
  signature: open "<path>" [<line_number>]
  arguments:
    - path (string) [required]: the path to the file to open
    - line_number (integer) [optional]: the line number to move the window to (if not provided, the window will start at the top of the file)
```

**The state footer** is the piece most worth stealing. `next_step_template` in every windowed config is:

```text
{{observation}}
(Open file: {{open_file}})
(Current directory: {{working_dir}})
bash-$
```

`open_file` and `working_dir` come from the bundles' `state_command` (`tools/windowed/bin/_state`), which the harness runs before each turn (`ToolHandler.get_state` → `/root/state.json` → `add_step_to_history`'s `**step.state`), so the footer is *derived from the environment*, never from the model's text. It costs 2–3 lines per turn and removes an entire class of wasted `pwd`/`ls`/`open` turns.

**Task-level instructions that make the ACI usable** (same templates): "If you open a file and need to get to an area around a specific line that is not in the first 100 lines, say line 583, don't just use the scroll_down command multiple times. Instead, use the goto 583 command. It's much quicker."; "Always make sure to look at the currently open file and the current working directory … The currently open file might be in a different directory than the working directory!"; "When editing files, it is easy to accidentally write code with incorrect indentation … Always check the code after you issue an edit". Demonstrations (`put_demos_in_history: true`) show a full solved trajectory as examples of the interface.

## 5. Comparison with HorizonCode doc 09 (`09-tools.md`)

Doc 09 is the reference surface: 91 catalog rows, model-facing caps of **16 KiB / 4,000 tokens** per result (`R-tools-42`), explicit `truncated` descriptors with `nextOffset` + artifact pointers (`R-tools-43/44`), declared bounds for every search tool (`R-tools-55`), and the deliberate absence of a persistent-editor/cursor tool family.

| SWE-agent device | Nearest doc 09 tool | Verdict |
|---|---|---|
| `open`/`goto`/`scroll_up`/`scroll_down` + `CURRENT_FILE`/`FIRST_LINE` state | `read(path, startLine?, endLine?, maxBytes?)` | **Gap**: doc 09 has no *persistent view cursor* and no `goto`/`scroll` verbs. A model re-deriving ranges is strictly more error-prone and costs arguments (and because a re-derived range is a new call, it also loses the "N more lines above/below" orientation) |
| Window = 100 lines, `(k more lines above/below)`, overlap 2 | `read` cap 16 KiB default / 64 KiB hard | **Equivalent in bytes, missing in orientation.** Doc 09 caps *bytes*; SWE-agent caps *lines* and always states the unseen remainder — a cheap, high-value addition to the `read` rendering |
| `search_dir` = per-file match counts, refuses > 100 files | `grep` (matches with `path,line,column,text`, `maxMatches` 200, 10 s cap) | **Gap**: doc 09's `grep` has richer *per-match* output but no *summary mode* and no "too many hits, narrow your search" abort; the summary form is the single cheapest search-level token saver here |
| `search_file` defaults to the open file from the registry | `grep(path?)` / `symbols(path?)` | **Minor gap**: no "currently open file" default — HZ has no cursor to default to (see the state line below) |
| `edit` scoped to the window; not-found-in-window lists every occurrence line; multi-occurrence refusal; `NoChange` refusal | `edit(oldString, newString, replaceAll?, expectedSha256?)` with `NoMatch`/`AmbiguousMatch`/`Conflict`/`NoChange` | **Doc 09 is stronger on safety** (sha256 preimage conflict, atomic `multi_edit`/`apply_patch`) but weaker on *repair*: it does not scope the search to what the model just saw, nor return "found elsewhere at lines …" — so the model's failure mode is a blind retry |
| flake8 gate: postimage linted, edit **reverted**, both windows printed | `lint(fix?)` is a separate process tool; `edit` does not run diagnostics | **Gap**, and a good one to close: an `edit` that refuses a postimage which introduces *new* diagnostics, leaving bytes untouched, removes whole repair loops ("apply broken code → run tests → read traceback → fix") |
| `insert <text> [<line>]` (append/insert-only) | `write` (whole file) and `edit` | **Gap**: an append-only verb is cheaper than a whole-file `write` for new files and for adding functions/blocks |
| `filemap` skeleton (elide bodies ≥5 lines) | `outline`, `repo_map`, `symbols`, `ast_grep` | **HZ superset** (multi-language, token-budgeted, `stale` flags). Nothing to port |
| `bash` + blocklist of interactive commands + `PAGER=cat`-style env taming | `shell` (policy-gated, `mode: fg|bg|pty`, `env` allow-list, caps) | **HZ superset**, except the *env taming set* (`PAGER/MANPAGER/GIT_PAGER=cat`, `LESS=-R`, `TQDM_DISABLE=1`, `PIP_PROGRESS_BAR=off`) which is a concrete, worth-copying default |
| `next_step_no_output_template` ("Your command ran successfully and did not produce any output.") | empty `data` payloads / `R-tools-47` ("no matches" is a success) | **Gap (rendering)**: doc 09 treats empty results as data but does not mandate a *narrated* empty result; silence is ambiguous to a model |
| State footer `(Open file: …) (Current directory: …)` re-derived from the environment every turn | `context_notes`, `todo` (model-authored session state) | **Gap**: HZ's session state is model-*authored*; HZ has no environment-*derived* state line. This is different in kind: model notes can lie, a derived state line cannot |
| Observation cap 100,000 chars default (10,000 in `bash_only.yaml`) with a recovering hint | `R-tools-42/43` caps + `truncated{reason, omittedBytes, omittedLines, nextOffset, artifactUri}` | **HZ superset in contract**, except the *hint* ("use head/tail/grep/redirect") that teaches the model the cheapest next move. HZ truncation should carry an equivalent `recoveryHint` |
| `last_n_observations` (elide all but the last 5 observations) | `compress` / auto-compaction (`doc 10`) | **HZ superset**; note SWE-agent's own docstring says this **breaks prompt caching**, which matters under HZ's byte-stable-prefix discipline |
| `submit` + `review_on_submit_m` staged review (re-run repro, delete repro, `git checkout --` test edits, re-submit) | `verify`, `complete_step`, `review` | **Different and complementary**: HZ verifies with receipts; SWE-agent verifies with a *forced conversational loop* at submit time. The loop text is worth reusing as a pre-submit review policy for postures where receipts are unavailable |

**Summary of what HZ lacks**: (1) a persistent view cursor with window navigation; (2) line-based windows with explicit "N lines above/below" orientation; (3) summary-mode search with a narrowing abort; (4) window-scoped edit semantics with "found elsewhere" repair hints; (5) an insert/append verb; (6) a syntax gate that reverts an edit which introduces new diagnostics; (7) an environment-derived state line; (8) empty-output narration; (9) truncation messages that name the recovery command. Items (2), (7), (8), (9) are rendering/prompt changes with no new capabilities; (1), (3), (4), (5) are tool-surface changes; (6) is an execution-pipeline change.

## 6. Recommendation: a `read` windowing mode first, an `aci` group second

**Phase 1 — extend existing tools, no new authority (do this first).** Everything below maps to capabilities doc 09 already has (`files.read`, `files.patch`), so it needs no `_conventions.md` change and no new lease semantics.

Draft rule text for doc 09 (phrasing follows the existing `R-tools-N` style):

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

**Phase 2 — the `aci` tool group, behind a preset.** Add a group `aci.*` only where the round-trip economy matters (SWE-bench-like and "long file archaeology" runs), not as the default surface:

| Proposed tool | Inputs | Capability / class | Lease |
|---|---|---|---|
| `aci.open` | `path`, `line?` | `files.read`, `read-only`, `parallel-safe` | none (emits a session-state fact) |
| `aci.goto` | `line` or `symbol` | `files.read`, `read-only`, `session-serial` (mutates the cursor) | none |
| `aci.scroll` | `direction: 'up'\|'down'`, `pages?` | `files.read`, `read-only`, `session-serial` | none |
| `aci.find` | `query`, `mode: 'summary'\|'matches'`, `scope?` | `files.read`, `read-only`, `parallel-safe` | none |
| `aci.insert` | `text`, `line?` | `files.patch`, `mutating`, `session-serial` | kernel |

Design constraints to write into the declarations: (a) cursor movement is `lease: session`, never a kernel lease (it has no effect); (b) `aci.*` declarations MUST NOT be visible unless the preset admits them (`R-tools-24` deferred discovery), so the default tool prefix does not grow; (c) the cursor lives in `hz` session state — never in tool arguments — so the prefix stays stable and the model cannot claim to have looked at lines it never saw; (d) all `aci.*` tools share the rendering contract of Phase 1 (lines, `moreAbove/Below`, `truncated` + `recoveryHint`), so the two phases are one implementation, two surfaces.

**Prompt fragment draft** for the group (≤ 512 bytes, per `R-tools-10`):

```text
aci.open/goto/scroll move a 100-line window over one file and re-show it; the
current window and open file are printed at the end of every step. Prefer
goto <line> or goto <symbol> over repeated scrolling. aci.find mode=summary
lists files with match counts and refuses above ~100 files: narrow instead.
Edits apply inside the window; a refusal lists where the text actually is.
```

**Tests to add with the adapter** (mirroring doc 09 §11 style): `tools.read.window_math` (goto/scroll positions, clamp at both bounds, overlap preserved), `tools.read.cursor_persisted` (two calls, second uses stored cursor), `tools.edit.outside_window_refused` (postimage hash unchanged, `matchesOutsideWindow` populated), `tools.edit.lint_reverted` (new diagnostic ⇒ bytes identical), `tools.grep.summary_capped` (101 files ⇒ `truncated{reason:'count'}` and no list), `tools.render.recovery_hint` (every truncated result names a next call), `tools.render.no_output_narrated`, `tools.state.not_model_authorable` (state line derived from effects only; a model claim in text cannot set it).

## 7. Evaluating the "up to 90% context reduction" claim

The repo contains **no such claim and no measurement**: `docs/background/aci.md` argues qualitatively (100-line viewer, linter-gated edits, summary search) and cites the paper; `grep -rn "90%"` over `README.md`, `docs/`, `config/`, `tools/` finds only a CSS width. So the claim must be evaluated against the code's arithmetic, per comparison:

| Comparison the claim rests on | Code anchor | Arithmetic | Verdict |
|---|---|---|---|
| One 100-line window instead of dumping a file | `WINDOW=100`, `line_range`, `print_window` | A 1,000-line file (~40 chars/line ≈ 40 KB) → ~4.1 KB per window ⇒ **~90%**; 2,000 lines ⇒ ~95%; 3,000 ⇒ ~96.7% | **Supported for files ≥ ~1,000 lines** |
| Reading a *whole* file through windows | `scroll` net step 98 | 1,000-line file in 10 windows ≈ 41 KB vs 40 KB for one `cat` ⇒ **~0%** (windows re-print the 2-line overlap) | **Not supported** — windowing only pays when the model needs a *region*, which is the common case but not a universal one |
| Directory search summary instead of raw matches | `search_dir` (per-file counts, >100 files abort) | 100 files × 20 matches × ~60 chars ≈ 120 KB → 100 lines ≈ 3 KB ⇒ **~97%**; a 5-match grep ⇒ **no saving** (a few lines of overhead) | **Supported for broad searches**, absent for narrow ones |
| `view` capped at 16,000 chars | `MAX_RESPONSE_LEN = 16000` | A 200 KB file ⇒ **~92%** cut; a 12 KB file ⇒ **0%** | **Supported for large files only** |
| `filemap` skeleton | elides bodies ≥ 5 lines | Depends entirely on the function/body ratio; for a body-heavy module this can exceed 80%, but it triggers only when the file is **> 16,000 chars** | **Plausible, unmeasured** |
| Observation truncation | `max_observation_length = 100_000` default | At the default, nothing under 100 KB is cut ⇒ **0%** for typical commands. `config/bash_only.yaml` lowers it to 10,000 | **Not supported at default settings** |
| Transcript elision | `last_n_observations` (n=5) | Elides all but 5 observations ⇒ large savings in long runs, but it is *transcript* elision, it cannot be attributed to the ACI, and its own docstring says it **breaks prompt caching** | **Real but out of scope, and harmful under a byte-stable-prefix discipline** |

**Conclusions.** (1) The claim is **plausible but conditional**: it is true as a *per-result byte cap* effect for large files and broad searches, and false as a general per-task context reduction — a full-file read through windows saves nothing, and a narrow search saves nothing. (2) The reduction is bought with **turns**: every `scroll`/`goto` is a model round-trip, and every edit re-prints a window; SWE-agent's design accepts this because a turn is cheap relative to a 40 KB dump in a 100-step run. (3) The numbers that *are* in the code are caps, not ratios: 100 lines, 2 overlap, 100 files/lines search abort, 16,000 chars per editor response, 100,000 chars per observation. (4) For HorizonCode the honest framing is therefore **not** "90% less context" but "a bounded window with an orientation header and an explicit truncation contract", i.e. exactly `R-tools-42/43` plus the Phase-1 additions in §6: orientation (`moreAbove/moreBelow`), a persistent cursor, summary search, and recovery hints. Those are cheap, they are testable, and they do not require promising a percentage that depends on the model's reading pattern.
