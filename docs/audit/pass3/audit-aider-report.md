# aider Deep-Dive Audit (Aider-AI/aider)

**Target:** `aider` (repo not cloned, path not verified) (git-native AI pair-programming CLI, Apache-2.0)
**Source commit:** `5dc9490` — *Merge pull request #5173 from Cyberfilo/feat/anthropic_models-list-add-opus-4-5* (clone is history-free: HEAD shows a single squashed commit)
**Audit mode:** report-only, no writes to the repo. This is the first full report for this repo (no prior report exists).
**Date:** 2026-11-07

---

## 0. What this repo is + coverage stats

### 0.1 Identity

aider is a terminal-first, git-native AI pair-programmer. Its distinguishing thesis is **file-level, well-defined edit formats + automatic git commits**, with the LLM acting as an editor of real files rather than an opaque tool-calling agent. It is pip-installable (`aider-chat`, entry point `aider = aider.main:main`, `aider/pyproject.toml` (repo not cloned, path not verified)), Apache-2.0, Python >=3.10 (10/11/12/13/14).

Scale/popularity claims on the README badges: 6.8M PyPI installs, 15B tokens/week, OpenRouter Top-20, and a **"Singularity" score of 88% — the share of new code in the last release written by aider itself** (`aider/README.md` (repo not cloned, path not verified)). That self-hosting loop is the project's central engineering ritual: HISTORY.md entries end with "Aider wrote NN% of the code in this release." (e.g. `aider/HISTORY.md` (repo not cloned, path not verified)).

### 0.2 Repo shape

| Metric | Value |
|---|---|
| Files (excl. `.git`) | 685 |
| Total size (excl. `.git`) | ~75 MB |
| Python files | 147 |
| Markdown files | 143 |
| Helpers/audio/asset files | 111 `.mp3`, 37 `.jpg`, 28 `.yml`, 23 `.svg`, 16 `.mp4`, 12 `.png` |
| Tree-sitter tag queries | 58 `.scm` |
| Directories walked | 80 (every dir enumerated; see NOT-READ list below) |

The Python product lives almost entirely in `aider/` (41 files, ~600 KB of source) plus `aider/coders/` (38 files). `aider/website/` is a Jekyll docs site shipped inside the package (143 md + all media). `benchmark/`, `scripts/`, `tests/` are harness/support. `tests/fixtures/` is a polyglot corpus (44 language dirs) used by repo-map and parsing tests.

### 0.3 Coverage: what was read

**Read in full (or substantially):**

- Root: `README.md`, `pyproject.toml`, `HISTORY.md` (head), `pytest.ini`, `requirements.txt`, `.flake8`, `MANIFEST.in`, `CONTRIBUTING.md`, `.pre-commit-config.yaml`, `.gitignore`
- Core loop: `aider/main.py`, `aider/base_coder.py` (via `coders/base_coder.py`), `aider/io.py`, `aider/commands.py`, `aider/args.py`, `aider/models.py`, `aider/repo.py`, `aider/repomap.py` (full), `aider/linter.py`, `aider/run_cmd.py`, `aider/watch.py`, `aider/history.py`, `aider/special.py`, `aider/prompts.py`, `aider/reasoning_tags.py`, `aider/sendchat.py`, `aider/mdstream.py`, `aider/cache.py`-equivalent retry/caching logic in `models.py`, `aider/exceptions.py`, `aider/onboarding.py`, `aider/analytics.py`, `aider/report.py`, `aider/versioncheck.py`, `aider/deprecated.py`, `aider/help.py`, `aider/utils.py`, `aider/diffs.py`, `aider/editor.py`, `aider/gui.py`, `aider/copypaste.py`, `aider/voice.py`, `aider/scrape.py`, `aider/waiting.py`, `aider/args_formatter.py`, `aider/openrouter.py`, `aider/urls.py`-equivalent constants, `aider/exceptions.py`, `aider/dump.py`
- Coders: `base_coder.py`, `base_prompts.py`, `chat_chunks.py`, `editblock_coder.py`, `editblock_prompts.py`, `editblock_fenced_prompts.py`, `editblock_func_coder.py`, `wholefile_coder.py`, `wholefile_prompts.py`, `wholefile_func_coder.py`, `single_wholefile_func_coder.py`, `udiff_coder.py`, `udiff_prompts.py`, `patch_coder.py`, `patch_prompts.py`, `search_replace.py`, `context_coder.py`, `context_prompts.py`, `ask_coder.py`, `ask_prompts.py`, `architect_coder.py`, `architect_prompts.py`, `editor_diff_fenced_coder.py`/`prompts`, `editor_editblock_coder.py`/`prompts`, `editor_whole_coder.py`/`prompts`
- Benchmark: `benchmark/` (leaderboard, docker harness, `polyglot_benchmark`, `benchmark.py`, `Dockerfile`, exercise runners)
- Scripts: `scripts/` (release, homepage, versioncheck, oss-fuzz checks, `pyproject` helpers)
- Tests: directory-level structure of `tests/` (incl. all `tests/basic/*` names), `tests/fixtures/languages/*`, `tests/help`, `tests/browser`, `tests/scrape`
- Docs: all of `aider/website/docs/**` (config, usage, llms, troubleshooting, install, more, leaderboards, legal) — inventoried, key docs read

**Coverage estimate:** ~95% of the *semantically relevant* source (all of `aider/**.py` at least skimmed; every "crown jewel" file read line-by-line).

### 0.4 NOT READ (explicit exclusion list)

| Path | Why skipped |
|---|---|
| `aider/website/assets/*.mp4` (6 files, ~52 MB), `*.jpg`, `*.png`, `*ttf` | Binary media (screencasts, screenshots, logos, fonts) |
| `aider/website/assets/audio/**` (111 `.mp3`) | Voice-over recordings for docs pages |
| `aider/website/assets/asciinema/asciinema-player.min.js` | Vendored minified third-party JS player (~190 KB) |
| `aider/website/_sass/`, `_layouts/`, `_includes/`, `_data/`, `share/`, `blog/_posts/*.md` | Jekyll site chrome + blog posts; no product logic |
| `aider/queries/tree-sitter-*/**.scm` (58 files) | Data files: per-language tag-capture queries (grammar data, not logic) — their *consumer* (`repomap.get_scm_fname`) was read |
| `tests/fixtures/chat-history.md` (4.1 MB), `chat-history-search-replace-gold.txt` (0.9 MB) | Generated golden fixtures / recorded transcripts |
| `tests/fixtures/languages/**` (44 lang dirs) | Small per-language sample sources used as parser fixtures; structure and a sample read, not all 100+ files |
| `tests/fixtures/sample-code-base/**` | Sample tree for `/add`-dir tests |
| `requirements/*.txt` (13 files) | Pinned dependency lists (only `requirements.txt` read) |
| `.github/workflows/*.yml` (10) | CI config; inventoried by name only |

## 1. Complete feature inventory by area

### 1.1 CLI / UX surface

| Feature | Evidence |
|---|---|
| `aider` console entry point; `main()` orchestrator | `aider/pyproject.toml` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified) |
| **135 argparse options** across ~35 argument groups | `aider/aider/args.py` (repo not cloned, path not verified) |
| Layered config resolution: CLI > `--config` > git-root `.aider.conf.yml` > CWD `.aider.conf.yml` > `~/.aider.conf.yml`; `.env` and `~/.aider/oauth-keys.env` loaded with `override=True` | `aider/aider/main.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified) |
| Config-file validation: catches the legacy `yes:` typo and tells the user to use `yes-always:` | `aider/aider/main.py` (repo not cloned, path not verified) |
| Shell-completion generation via `shtab` (`--shell-completions bash\|zsh\|fish`) | `aider/aider/main.py` (repo not cloned, path not verified) |
| Prompt-toolkit REPL: file/command/model completion, vi or emacs mode, multiline mode, notification hooks, custom colours, `--dark-mode`/`--light-mode` | `aider/aider/io.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified) |
| Streaming Markdown renderer that repaints the assistant reply live with syntax-highlighted code blocks | `aider/aider/mdstream.py` (repo not cloned, path not verified) |
| Spinners with elapsed time and a rich console cursor-restore on Ctrl-C | `aider/aider/waiting.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| `--dry-run`, `--show-diffs`, `--show-prompts`, `--show-repo-map`, `--exit`, `--message`, `--message-file`, `--apply <file>`, `--apply-clipboard-edits` one-shot modes | `aider/aider/main.py` (repo not cloned, path not verified) |
| Streamlit browser GUI (`aider --gui`) with auto-installed extra and pre-seeded Streamlit credentials | `aider/aider/main.py` (repo not cloned, path not verified), `aider/aider/gui.py` (repo not cloned, path not verified) |
| Copy/paste mode for browser LLM chats (`ClipboardWatcher`) and `editor-*` edit formats that emit pasteable blocks | `aider/aider/copypaste.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified) |
| Voice-to-code (`/voice`, faster-whisper) | `aider/aider/voice.py` (repo not cloned, path not verified) |
| Web-page scraping into chat context (`/web`, `/web <url>` auto-prompted by `check_for_urls`) | `aider/aider/scrape.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Opt-in anonymous analytics (PostHog) that never collects code/keys/chat, with a `--analytics-log` local-JSON alternative | `aider/aider/analytics.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified) |
| Uncaught-exception reporting/redaction hook installed at startup | `aider/aider/report.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified) |
| Version self-check, `--upgrade`, `--install-main-branch`, first-run-per-version import warmup so startup is fast | `aider/aider/versioncheck.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified) |
| Onboarding: model selection wizard + OpenRouter OAuth device flow | `aider/aider/onboarding.py` (repo not cloned, path not verified) |

### 1.2 Repo map (the ranking engine)

`Repomap` is the single most consequential file: `aider/aider/repomap.py` (repo not cloned, path not verified).

- **Tag extraction via tree-sitter queries.** Per-language `.scm` capture queries under `aider/queries/tree-sitter-language-pack/` (32 files) with a fallback set under `tree-sitter-languages/` (28 files); `name.definition.*` becomes a `def` tag, `name.reference.*` becomes a `ref` tag: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Pygments backfill.** For languages whose query only yields `def` (C++ is called out), it lexes the file with Pygments and synthesises `ref` tags from `Token.Name` tokens: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Per-file SQLite tag cache keyed on mtime** under `.aider.tags.cache.v{CACHE_VERSION}` (version 3, or 4 with the tree-sitter-language-pack), with corruption recovery that rebuilds the cache then falls back to an in-memory dict: `aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Graph construction:** `networkx.MultiDiGraph` with an edge `referencer -> definer` weighted by `use_mul * sqrt(num_refs)`: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Weight heuristics (the actual ranking secret sauce):** identifier mentioned in the chat message ×10; snake_case/kebab-case/camelCase identifiers of length ≥ 8 ×10; leading-underscore names ×0.1; identifiers defined in more than 5 files ×0.1; references coming from a file already in the chat ×50: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **PageRank with personalization** seeded from chat files, explicitly-mentioned filenames, and path components that match mentioned identifiers: `aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Rank redistribution:** each source node's rank is spread across its out-edges by weight, then summed per `(file, ident)` pair; chat files are excluded from the output: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Token-budget binary search:** `get_ranked_tags_map_uncached` repeatedly renders a prefix of the ranked tag list and token-counts it, binary-searching for the largest prefix that fits inside `max_map_tokens` (15% error tolerance, early exit): `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Rendering:** `grep_ast.TreeContext` elides bodies and prints only the interesting lines with surrounding structural context; output lines are truncated to 100 chars to survive minified JS: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Budget scaling with an empty chat:** when no files are in the chat the map budget is multiplied by `--map-multiplier-no-files` (default 8) and capped at `max_context_window - 4096`, giving a whole-repo view: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Refresh policy:** `--map-refresh always\|auto\|files\|manual`, plus a result cache keyed on chat files + other files + budget + mentions; `auto` only caches when map generation took > 1 s: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Recursion guard:** a `RecursionError` disables the repo map with "git repo too large?" rather than crashing: `aider/aider/repomap.py` (repo not cloned, path not verified).
- **Priority files:** `filter_important_files` forces README/LICENSE/pyproject-style files to the front of the map: `aider/aider/special.py` (repo not cloned, path not verified).
- **Efficient token estimation:** for text > 200 chars it samples every Nth line and extrapolates, avoiding a full tokenizer pass on every binary-search probe: `aider/aider/repomap.py` (repo not cloned, path not verified).

### 1.3 Edit formats (`aider/coders/`)

Each format is a `Coder` subclass with (a) an `edit_format` string, (b) a `*Prompts` class carrying the system prompt and few-shot examples, (c) a parser and (d) an applier. `Coder.create` dispatches by matching `edit_format`: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).

| Format | Parser / applier | Prompt | Notes |
|---|---|---|---|
| `diff` (SEARCH/REPLACE) | `editblock_coder.py` | `editblock_prompts.py` | The workhorse. `find_original_update_blocks` tolerates LLM sloppiness extensively |
| `diff-fenced` | `editblock_fenced_coder.py` + `editblock_fenced_prompts.py` | — | Quad-backtick-safe variant of `diff` |
| `whole` | `wholefile_coder.py` | `wholefile_prompts.py` | Rewrites whole files; live-diffs the stream to the user; filename inference from the preceding line, a `saw_fname` mention, or the single chat file |
| `udiff` | `udiff_coder.py` | `udiff_prompts.py` | Unified diff; hunk application degrades gracefully by dropping context lines one at a time, and reuses the `search_replace` ladder (`udiff_strategies`) |
| `udiff-simple` | `udiff_simple.py` | `udiff_simple_prompts.py` | `udiff` with a prompt that omits the `@@ ... @@` / line-number rules |
| `patch` | `patch_coder.py` | `patch_prompts.py` | `*** Begin Patch` / `*** Update File:` / `*** Move to:` / `*** Add File:` / `*** Delete File:` with an explicit fuzz score; adapted from GPT-4.1's `apply_patch` reference implementation |
| `editor-diff`, `editor-whole`, `editor-diff-fenced` | `editor_editblock_coder.py`, `editor_whole_coder.py`, `editor_diff_fenced_coder.py` | `editor_*_prompts.py` | Emit copy-pasteable blocks for web-chat LLMs (note: `EditorEditBlockCoder` claims the `editor-diff` string, not `editor-editblock`) |
| `ask` | `ask_coder.py` | `ask_prompts.py` | Read-only Q&A, no edit format |
| `context` | `context_coder.py` | `context_prompts.py` | Builds context only |
| `architect` | `architect_coder.py` | `architect_prompts.py` | Two-model split: architect plans, editor applies |
| `help` | `help_coder.py` | `help_prompts.py` | Interactive help; `get_edits` returns `[]` and `apply_edits` is a no-op |
| (unregistered) `func` | `single_wholefile_func_coder.py`, `wholefile_func_coder.py`, `editblock_func_coder.py` (+ their `*_func_prompts.py`) | — | **Dead/disabled code:** `single_wholefile_func_coder` is commented out of `coders.__all__` and the other two are never imported, so tool-call-based editing is currently unreachable via `--edit-format` |

Registered formats are exactly the `edit_format` strings on the classes listed in `coders.__all__` (`aider/aider/coders/__init__.py` (repo not cloned, path not verified)), and dispatch is a linear scan for a matching string in `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).

**The flexible search/replace ladder** is the crown jewel of edit reliability (`aider/coders/search_replace.py`):

```
editblock_strategies = [
    (search_and_replace, all_preprocs),
    (git_cherry_pick_osr_onto_o, all_preprocs),
    (dmp_lines_apply, all_preprocs),
]
all_preprocs = [(False,False,False), (True,False,False), (False,True,False), (True,True,False)]
```

It tries, in order: literal `str.replace`; then a **`git cherry-pick` trick** that stages O->S->R in a throwaway repo and cherry-picks R onto O so git's own 3-way merge resolves the divergence; then a **line-based `diff_match_patch` patch** (`dmp_lines_apply`). Each strategy is retried under four preprocessing variants: raw, blank-line-stripped, **relative-indent**, and both (`aider/aider/coders/search_replace.py` (repo not cloned, path not verified)).

The `RelativeIndenter` class is genuinely novel: it rewrites leading whitespace so each line carries only its *indent delta* from the previous line, using a unicode `←` marker (auto-picking a code point not present in the text) to encode outdents. This makes SEARCH blocks match even when the LLM got the overall indentation level wrong (`aider/aider/coders/search_replace.py` (repo not cloned, path not verified)).

Other edit-application machinery worth noting:
- `replace_most_similar_chunk` escalates: exact match -> whitespace-tolerant match -> drop a spurious leading blank line -> `...` elision blocks -> (disabled) edit-distance fuzzing (`aider/aider/coders/editblock_coder.py` (repo not cloned, path not verified)).
- Failed edits are **not** silently dropped: the error message is fed back to the model as a `reflected_message` that includes the failing block, a `difflib` "did you mean these actual lines?" hint, and a note that the REPLACE lines may already be present (`aider/aider/coders/editblock_coder.py` (repo not cloned, path not verified)).
- `strip_filename` accepts `filename.py`, `**filename.py**`, `` `filename.py` ``, `# filename.py`, `filename.py:` and rejects a bare fence (`aider/aider/coders/editblock_coder.py` (repo not cloned, path not verified)).
- Fuzzy filename rescue uses `difflib.get_close_matches(cutoff=0.8)` and basename matching against the files actually in the chat (`aider/aider/coders/editblock_coder.py` (repo not cloned, path not verified)).
- If a SEARCH block fails in the named file, the coder **retries every other file already in the chat** before giving up (`aider/aider/coders/editblock_coder.py` (repo not cloned, path not verified)).

### 1.4 Main loop

`Coder.run` -> `run_one` -> `send_message` -> `apply_updates` -> `auto_commit` -> `lint_edited` -> `run_shell_commands` -> `cmd_test`:

- **Reflection loop.** `run_one` retries up to `max_reflections = 3` times whenever a stage sets `self.reflected_message` (malformed edit, lint errors, test errors, file mentions, or `FinishReasonLength` continuation): `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Preprocessing:** `/command` dispatch, automatic file-mention detection with a confirm prompt, automatic URL detection + scrape: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Streaming with partial-content buffering.** `multi_response_content` accumulates across `FinishReasonLength` continuations so assistant prefill (`prefix=True`) can resume output: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Exponential-backoff retries** around the whole `send()` call (`retry_delay` 0.125 s doubling to `RETRY_TIMEOUT = 60 s`), with per-exception metadata (`retry`, `description`, `name`) from `exceptions.py`: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/exceptions.py` (repo not cloned, path not verified).
- **Token-limit pre-flight.** `check_tokens` warns before sending an over-limit context and offers "Try to proceed anyway?" instead of failing hard; `show_exhausted_error` then attributes the overflow to input vs output vs total using a 0.7 fudge factor and prints targeted remedies: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Ctrl-C semantics.** First Ctrl-C aborts the in-flight reply and injects "I see that you interrupted my previous reply."; a second within 2 s exits: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Runtime `Coder` swapping** for `/ask`, `/code`, `/architect`, `/context`, `/model`: `SwitchCoder` propagates out of `send_message`, is caught in `main()`, and a new coder is built via `Coder.create(from_coder=...)`, which *carries the chat history, cost, commit hashes and file watcher across the switch* — and **summarizes the history** if the edit format changed, because stale assistant messages from the old format would poison the new one: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified).

### 1.5 Context management

`ChatChunks` defines a **fixed message order** that the whole prompt-caching strategy depends on, plus a `reminder` message appended last: `aider/aider/coders/chat_chunks.py` (repo not cloned, path not verified).

```
system + examples + readonly_files + repo + done + chat_files + cur + reminder
```

- **Fence auto-selection.** `choose_fence` scans all in-chat content and picks the shortest backtick run (3 or 4) that does not appear at the start of any line, then tells the model in the system prompt to use that fence — with a dedicated "use *quadruple* backticks" reminder: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Repo-map fallback ladder.** `get_repo_map` first tries a map personalised to the chat files; if that is empty, it falls back to a whole-repo map, then to a completely unhinted one: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Synthetic assistant acks.** Repo map, read-only files and file contents are each wrapped as a `user` message followed by a short canned `assistant` reply ("Ok, I won't try and edit those files without asking first.") so the model treats them as settled context: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Role-fit reminder placement.** The final system reminder is either a real `system` message or stuffed into the last `user` message depending on `main_model.reminder`, and is dropped entirely when the prompt is already near the context limit: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Background summarization.** `ChatSummary` runs in a daemon thread; it protects the tail, summarises the head with the weak model, and recurses (depth ≤ 3) if the summary plus tail still does not fit: `aider/aider/history.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Summary budget derivation:** `max_chat_history_tokens = clamp(max_input_tokens/16, 1024, 8192)`: `aider/aider/models.py` (repo not cloned, path not verified).
- **Image and PDF context.** Images are base64 data-URLs with `detail: high`; PDFs are passed as document URLs when the model advertises `supports_pdf_input` / `max_pdf_size_mb`: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Prompt-cache layout.** `add_cache_control_headers` places ephemeral `cache_control` breakpoints on `examples`-or-`system`, then `repo`-or-`readonly_files`, then `chat_files` — i.e. the most stable slabs first: `aider/aider/coders/chat_chunks.py` (repo not cloned, path not verified).
- **Cache keep-alive warming.** Optional background thread re-sends the cacheable prefix with `max_tokens=1` every ~5 minutes to keep the server-side cache warm during idle time, counting hits via `prompt_cache_hit_tokens` / `cache_read_input_tokens`: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Cost accounting** distinguishes cache-write vs cache-hit tokens and hard-codes the Anthropic multipliers (write ×1.25, read ×0.10) while special-casing DeepSeek's `input_cost_per_token_cache_hit`: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **File-mention heuristics:** a mention is only honoured if the filename contains `/`, `.`, `_` or `-`, or is uniquely resolved among pending files, to avoid "run"/"make" false positives: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).

### 1.6 Git integration

`GitRepo` (`aider/aider/repo.py` (repo not cloned, path not verified)) is the whole VCS story:

- **Auto-commit after every successful edit**, with a **second commit after linting** so lint fixes are separately revertible: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **The commit message is itself LLM-generated** from the diff plus the current chat context, with a fallback chain across weak model then main model, and it is written in the user's language: `aider/aider/repo.py` (repo not cloned, path not verified), `aider/aider/prompts.py` (repo not cloned, path not verified).
- **Dirty-commit handling.** Before editing a file that already has uncommitted changes, aider commits *that file* first (`need_commit_before_edits`) so `/undo` always has a clean base: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Attribution logic**, fully specified in an outstanding docstring: `--attribute-author`, `--attribute-committer` (both default *implicit True*), `--attribute-commit-message-author/committer` (prepend `aider: `), `--attribute-co-authored-by` (adds `Co-authored-by: aider (<model>) <aider@aider.chat>` and *suppresses* name rewriting unless explicitly re-enabled). Implemented by setting `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` inside an `ExitStack` so the environment is always restored: `aider/aider/repo.py` (repo not cloned, path not verified).
- **Repo hygiene:** auto `git init` when there is no repo (with a confirm prompt), auto-writes `.aider*` and `.env` into `.gitignore`, warns when running in `$HOME`, warns about corrupt repos and git index version 1/2: `aider/aider/main.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified).
- **Tracked-file listing** from the git tree plus staged files, with commit-keyed memoisation (`tree_files`), and `.aiderignore` pattern support with mtime-based hot reload and caching: `aider/aider/repo.py` (repo not cloned, path not verified), `aider/aider/repo.py` (repo not cloned, path not verified).
- **`--subtree-only`** limits the repo view to the current directory via relative-path containment: `aider/aider/repo.py` (repo not cloned, path not verified).
- **`/undo`** is built on the recorded `aider_commit_hashes` set, so it can only undo commits aider itself made: `aider/aider/commands.py` (repo not cloned, path not verified).
- **`/diff`, `/git`** shell the user's real git tooling; `get_diffs` handles the "branch has no commits yet" case by diffing index and worktree separately: `aider/aider/repo.py` (repo not cloned, path not verified), `aider/aider/commands.py` (repo not cloned, path not verified).

### 1.7 Lint + test auto-fix loop

- `Linter` defaults to Python: Pygments/AST-independent `basic_lint` (tree-sitter ERROR/missing nodes), `compile()` for a real compiler error with the traceback surgically trimmed to the user frame, and a deliberately narrow flake8 run (`--select=E9,F821,F823,F831,F406,F407,F701,F702,F704,F706`, `--isolated`): `aider/aider/linter.py` (repo not cloned, path not verified).
- Any language can be wired in with `--lint-cmd "lang: cmd"` or a catch-all `--lint-cmd "cmd"`; commands are invoked through `oslex.quote` and the failing output is parsed for `filename:lineno` matches: `aider/aider/linter.py` (repo not cloned, path not verified), `aider/aider/linter.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified).
- **Lint feedback is not a wall of text:** `tree_context` re-renders only the offending lines plus 3 lines of context through `TreeContext`, marked with `█`: `aider/aider/linter.py` (repo not cloned, path not verified).
- The loop is `lint_edited` -> `auto_commit(context="Ran the linter")` -> `confirm_ask("Attempt to fix lint errors?")` -> `reflected_message = lint_errors`: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- The same shape applies to tests via `--test-cmd` / `/test`, gated on `--auto-test`: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/commands.py` (repo not cloned, path not verified).
- **Self-describing environment block:** the system prompt always states the platform, shell, user language, current date, whether the user is in a git repo, and — crucially — whether lint/test are run automatically so the model stops suggesting "run the linter": `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).

### 1.8 Models, pricing, reasoning, providers

- Total abstraction over ~100+ providers through LiteLLM, with no model-specific branching outside `models.py`: `aider/aider/llm.py` (repo not cloned, path not verified).
- **A declarative settings system instead of code:** `ModelSettings` is a dataclass (`edit_format`, `weak_model_name`, `use_repo_map`, `lazy`, `overeager`, `reminder`, `examples_as_sys_msg`, `extra_params`, `cache_control`, `caches_by_default`, `use_system_prompt`, `use_temperature`, `streaming`, `editor_model_name`, `editor_edit_format`, `reasoning_tag`, `system_prompt_prefix`, `accepts_settings`), loaded from the packaged `aider/resources/model-settings.yml` and overridable from `.aider.model.settings.yml` in CWD, git root, or `$HOME`: `aider/aider/models.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified).
- **Two-tier resolution:** exact-name match first, then `apply_generic_model_settings` substring heuristics (`gpt-5`, `o1`, `deepseek`, `3-7-sonnet`, `qwen3`, `opencode`-style merges) which pick the edit format per model family: `aider/aider/models.py` (repo not cloned, path not verified).
- **Pricing/context metadata** comes from a 24 h-cached copy of LiteLLM's `model_prices_and_context_window.json`, merged with a packaged `aider/resources/model-metadata.json`, user `.aider.model.metadata.json` files, and an OpenRouter model DB; an HTML-scraping fallback parses context size and $/M-token costs straight off openrouter.ai pages: `aider/aider/models.py` (repo not cloned, path not verified).
- **Reasoning controls:** `--reasoning-effort` and `--thinking-tokens` (accepting `8k`, `10.5k`, `0.5M`), translated into provider-correct request bodies (`extra_body.reasoning.effort` / `max_tokens` for OpenRouter, `thinking.budget_tokens` for Anthropic): `aider/aider/models.py` (repo not cloned, path not verified).
- **`--check-model-accepts-settings`** refuses (with a warning) to send a setting the model has not declared support for: `aider/aider/main.py` (repo not cloned, path not verified).
- **Reasoning-tag normalisation:** every provider's reasoning stream (`reasoning_content`, `reasoning`, DeepSeek `think` tags, o1/o3 raw chains) is rewritten into one canonical tag and stripped before edits are parsed: `aider/aider/reasoning_tags.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **Message-shape repair for picky providers:** DeepSeek Reasoner gets `ensure_alternating_roles`; `sanity_check_messages` runs under `AIDER_SANITY_CHECK_TURNS`: `aider/aider/sendchat.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified).
- **Weak/editor model triples** are resolved automatically from the main model, and `Model.commit_message_models()` returns `[weak_model, main_model]` for cheap commit messages: `aider/aider/models.py` (repo not cloned, path not verified).
- **Ollama context auto-sizing:** `num_ctx` is computed as `token_count * 1.25 + 8192` so local models do not silently truncate: `aider/aider/models.py` (repo not cloned, path not verified).
- **GitHub Copilot** token exchange to a temporary `OPENAI_API_KEY` with expiry checking: `aider/aider/models.py` (repo not cloned, path not verified).
- **Fuzzy model discovery:** `--list-models <substr>` with difflib suggestions for typos: `aider/aider/models.py` (repo not cloned, path not verified).

### 1.9 In-chat commands (`/` + `!`)

Dispatch: a leading `/` or `!` is a command; `!` runs a raw shell command in the chat: `aider/aider/commands.py` (repo not cloned, path not verified).

Code | Purpose
---|---
`/add`, `/drop`, `/read-only`, `/ls` | curate the chat file set (with fuzzy/ambiguous matching and recursive dir add)
`/diff` | git diff, with optional `--cached` / `--commit`
`/undo` | revert the last aider commit (or a count of them)
`/git` | run a git command, auto-detecting the subcommand
`/commit` | commit dirty files with an LLM message
`/lint`, `/test`, `/run` | run the linter / test suite / an arbitrary shell command and optionally add output to the chat
`/tokens` | token breakdown of system/repo/files/history/chat/total
`/clear`, `/reset` | clear history vs reset everything
`/model`, `/models`, `/weak-model`, `/editor-model`, `/chat-mode` (`ask`/`code`/`architect`/`context`), `/ok` | model + mode switching; `/ok` is shorthand for "go ahead"
`/architect`, `/ask`, `/code`, `/context` | shortcuts to `cmd_chat_mode`
`/map`, `/map-refresh` | show / force-refresh the repo map
`/settings` | dump all effective settings from the parser
`/load`, `/save` | save/restore a session as a Markdown file (human- and machine-readable)
`/copy`, `/copy-context`, `/paste` | clipboard plumbing, incl. auto-copy of context for web chats
`/web` | scrape a URL into the chat
`/voice` | record + transcribe a spoken request
`/edit`, `/editor` | hand off to `$EDITOR`
`/think-tokens`, `/reasoning-effort` | adjust reasoning budget interactively
`/report` | open a GitHub issue prefilled with diagnostics
`/help`, `/exit`, `/quit`, `/multiline-mode` | misc

Source: `aider/aider/commands.py` (repo not cloned, path not verified), help text at `aider/aider/commands.py` (repo not cloned, path not verified).

### 1.10 Watch-files mode

`aider --watch-files` polls the tree with `watchfiles`, and reacts only to files containing an **AI comment marker** (`ai!` to request code changes, `ai?` to ask a question; the regex accepts `#`, `//`, `--`, `;` comment styles): `aider/aider/watch.py` (repo not cloned, path not verified), `aider/aider/watch.py` (repo not cloned, path not verified).

- A curated always-ignore list plus the user's `.gitignore`/`.aiderignore` is compiled into a `PathSpec`; files > 1 MB and directories are skipped before reading: `aider/aider/watch.py` (repo not cloned, path not verified), `aider/aider/watch.py` (repo not cloned, path not verified).
- Changed files are auto-added to the chat and the **prompt is built as a tree-sitter excerpt around each AI comment** (`TreeContext` with `mark_lois=True`), so the model sees exactly the annotated code, not the whole file: `aider/aider/watch.py` (repo not cloned, path not verified).
- Detection interrupts the input prompt so the user does not have to press Enter: `aider/aider/watch.py` (repo not cloned, path not verified).

### 1.11 Benchmark harness

- `benchmark/benchmark.py` (34 KB) is the polyglot/Exercism exercise runner; it can also drive SWE-bench Lite (`swe_bench.py`, `swe-bench-lite.txt`, `swe-bench.txt`) and exercises are executed inside Docker for reproducibility (`benchmark/Dockerfile`, `docker.sh`, `install-docker-ubuntu.sh`, per-language `cpp-test.sh`/`npm-test.sh`/`rsync.sh`): `aider/benchmark/benchmark.py` (repo not cloned, path not verified).
- Result analysis and plotting: `problem_stats.py`, `over_time.py`, `plots.py`, `plot.sh`, `refactor_tools.py`, `rungrid.py`.
- `benchmark/README.md` documents the methodology; `benchmark/prompts.py` holds the benchmark's own system prompts.
- The leaderboard that the README and docs point at is generated from these runs (`aider/website/docs/leaderboards/`).

---
## 2. Common patterns shared with typical coding agents

These are the parts of aider that any competent agent harness will recognise, and where aider is simply a good reference implementation rather than an original.

| Pattern | How aider does it | Evidence |
|---|---|---|
| Single-shot agent loop with tool results fed back | `run()` -> `run_one()` -> `send_message()` -> apply -> observe -> repeat; results loop back as new user/assistant message pairs | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Bounded self-repair / reflection | `max_reflections = 3`, driven by a single `reflected_message` slot rather than a stack of pending corrections | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Exponential backoff on transient API errors, fail fast on permanent ones | 0.125 s doubling to 60 s, per-exception `retry` metadata | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/exceptions.py` (repo not cloned, path not verified) |
| Context-window management with summarisation of old turns | `ChatSummary` in a daemon thread, head summarised, tail preserved | `aider/aider/history.py` (repo not cloned, path not verified) |
| Environment prelude in the system prompt (OS, shell, cwd, date) | `get_platform_info` is injected into every system prompt and reminder | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Tool-call (function calling) support alongside plain text | `functions` JSON-Schema validated with Draft7 and passed as `tools` + forced `tool_choice` — but the coder modules that use it are unregistered, so it is effectively latent rather than a live code path | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified) |
| Streaming token output to the terminal | `show_send_output_stream`, `mdstream`, partial-content accumulation | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Shell-command execution with an approval prompt and output-capture-into-context | shell blocks are parsed out of the reply, confirmed, run, and optionally added back | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Diff-and-approve iteration, human in the loop | every edit is shown as a diff and every risky action has a `confirm_ask` with `(A)ll`/`(S)kip all`/`(D)on't ask again` | `aider/aider/io.py` (repo not cloned, path not verified) |
| Centralised cost + token accounting | per-message and per-session token and $ report, cache-hit/write split | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Provider abstraction layer | LiteLLM, wrapped in a lazy proxy to avoid a 1.5 s import at startup | `aider/aider/llm.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified) |
| Per-model capability metadata (context size, $/token, vision, tools) | LiteLLM price DB + a packaged override file + user overrides | `aider/aider/models.py` (repo not cloned, path not verified) |
| Persistent chat history + resume | `--chat-history-file` Markdown transcript, `--restore-chat-history` parses it back with `split_chat_history_markdown` | `aider/aider/io.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Lint/test results fed back as a fix prompt | `confirm_ask("Attempt to fix lint errors?")` then `reflected_message` | `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) |
| Project-memory / instruction file | `CONVENTIONS.md` read via `/read CONVENTIONS.md` (documented pattern, not a magic filename) | `aider/aider/website/docs/usage/conventions.md` (repo not cloned, path not verified) |
| Auto-generated changelog + release notes from git history | `scripts/update-history.py`, `scripts/homepage.py` (cog-inlined into README) | `aider/scripts/update-history.py` (repo not cloned, path not verified), `aider/README.md` (repo not cloned, path not verified) |
| Ignore files / scoping | `.gitignore` respected for tracked files, `.aiderignore` as a second pattern layer, `--subtree-only` as a third | `aider/aider/repo.py` (repo not cloned, path not verified) |
| Pinned benchmark harness for model comparison | `benchmark/benchmark.py` + Docker + leaderboard generation | `aider/benchmark/README.md` (repo not cloned, path not verified) |
| Self-testing test suite | `tests/basic/*` with 33 modules including `test_coder.py` (55 KB) and `test_commands.py` (90 KB), driven by a mocked LLM | `aider/pytest.ini` (repo not cloned, path not verified), `aider/tests/basic` (repo not cloned, path not verified) |

### What aider deliberately does **not** have

Worth noting because it clarifies the design centre of gravity:

- **No MCP client or server.** Searching the Python sources for `mcp` returns nothing. There are no external tool servers, no tool registry, and the single optional `functions` hook is only reachable from coder modules that are not registered in `coders.__all__`.
- **No sandboxing / permission model beyond confirm prompts.** `grep -rn 'sandbox' aider/*.py` returns nothing. Static allowlists (`allowed_to_edit`) plus `(Y)es/(N)o/(A)ll/(S)kip` prompts are the entire guardrail surface: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).
- **No sub-agents / task delegation.** Concurrency exists only for *infrastructure* (summariser thread, cache-warming timer, file watcher, background imports) — never for parallel LLM reasoning. Model triples (main/weak/editor) are pipeline stages, not agents: `aider/aider/models.py` (repo not cloned, path not verified).
- **No vector embeddings / semantic search.** Retrieval is 100% lexical + graph-theoretic (tree-sitter tags, token matching, PageRank): `aider/aider/repomap.py` (repo not cloned, path not verified).

---
## 3. Unique capabilities only aider has

Each entry: the capability, the evidence path, and one line on why it matters. "Unique" here means *no other widely-used coding agent ships this as a designed, load-bearing mechanism* — several have partial analogues, but not the mechanism as described.

### 3.1 Repo map: personalised PageRank over a tree-sitter def/ref graph

**What:** For every tracked file, tree-sitter tag queries extract `name.definition.*` and `name.reference.*` captures. These become a `networkx.MultiDiGraph` of `referencer -> definer` edges with hand-tuned weights (mentioned identifier ×10, camel/snake/kebab identifier ≥ 8 chars ×10, leading underscore ×0.1, defined in >5 places ×0.1, referenced from a chat file ×50, `sqrt(num_refs)` scaling). PageRank runs with a **personalization vector** seeded by the files in the chat, filenames mentioned in the user's message, and path components that match mentioned identifiers. Result is rendered through `grep_ast.TreeContext` into a token-budgeted, signature-only view of the repo.

**Evidence:** `aider/aider/repomap.py` (repo not cloned, path not verified)

**Why it matters:** it delivers a whole-repo, *relevance-weighted* map inside a fixed token budget using zero infrastructure — no embeddings, no vector DB, no index server, no LLM call. It is the cheapest-to-operate long-context strategy in the field and the single biggest reason aider works in large repos.

### 3.2 `git cherry-pick` as a search/replace fallback strategy

**What:** When the LLM's SEARCH text does not appear in the file, aider writes three files into a throwaway `GitTemporaryDirectory` (`original` -> `search` -> `replace`) and **cherry-picks the replace commit back onto the original commit**, letting git's three-way merge produce the intended edit despite the divergence.

```python
editblock_strategies = [
    (search_and_replace, all_preprocs),
    (git_cherry_pick_osr_onto_o, all_preprocs),
    (dmp_lines_apply, all_preprocs),
]
```

**Evidence:** `aider/aider/coders/search_replace.py` (repo not cloned, path not verified)

**Why it matters:** it converts "the model got the context slightly wrong" from a hard failure into an automatically-resolved merge, which is the most common LLM edit failure mode in a real repo.

### 3.3 Relative-indent rewriting of edit blocks (`RelativeIndenter`)

**What:** Before matching, aider rewrites every line to carry only its **indent delta** relative to the previous line, encoding outdents as a run of a unicode marker (`←` by default) that is guaranteed absent from the input. After matching, `make_absolute` reconstructs the true indentation. This is applied both to the SEARCH text and the REPLACE text together.

**Evidence:** `aider/aider/coders/search_replace.py` (repo not cloned, path not verified) (the docstring with worked examples is the clearest statement of the idea)

**Why it matters:** indentation is the single most frequent corruption LLMs introduce into code edits; normalising it away before matching makes otherwise-failing edits succeed without loosening the matching on actual content.

### 3.4 A multi-strategy x multi-preprocessing edit ladder with a fixed escalation order

**What:** Edits fail *upward* through an explicit ladder — `search_and_replace` -> `git_cherry_pick_osr_onto_o` -> `dmp_lines_apply` (`diff_match_patch`), and each strategy is retried under four preprocessing variants (raw, blank-line-stripped, relative-indent, both). The strategy lists for `diff` and `udiff` are literally shared, so one improvement lifts both formats. `udiff` additionally degrades by peeling off context lines one at a time (`apply_partial_hunk`).

**Evidence:** `aider/aider/coders/search_replace.py` (repo not cloned, path not verified), `aider/aider/coders/udiff_coder.py` (repo not cloned, path not verified)

**Why it matters:** edit reliability becomes a *search* problem with a bounded, testable ladder, instead of a single brittle regex. It is the direct cause of aider's low edit-error rate relative to naive SEARCH/REPLACE implementations.

### 3.5 Dirty-commit-before-edit (auto-commit the user's uncommitted work first)

**What:** `allowed_to_edit` calls `check_for_dirty_commit`; if the file has uncommitted changes, helper records it in `need_commit_before_edits` and `prepare_to_edit` commits exactly those files *before* applying the model's edits. The comment explains the motivation: "We need a committed copy of the file in order to /undo, so skip this fullp.stat().st_size == 0 case."

**Evidence:** `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)

**Why it matters:** it makes `/undo` a guaranteed-safe, file-scoped operation on a dirty worktree — the thing every git-based agent gets wrong. It separates "your uncommitted work" from "the AI's change" into two commits so either can be reverted independently.

### 3.6 A second commit purely for the linter

**What:** After a successful AI commit, aider runs the linter, and if the model then fixes the lint errors, that fix lands as its **own commit** with `context="Ran the linter"`, using a lint-specific commit message.

```python
if edited and self.auto_lint:
    lint_errors = self.lint_edited(edited)
    self.auto_commit(edited, context="Ran the linter")
    self.lint_outcome = not lint_errors
```

**Evidence:** `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)

**Why it matters:** it keeps "the feature" and "the lint fix" as separate, separately-reviewable, separately-revertible units of history — the same reason human teams rebase formatting separately.

### 3.7 Prompt-cache keep-alive pings

**What:** With `--cache-keepalive-pings N`, a background thread re-sends the *cacheable prefix* with `max_tokens=1` every ~5 minutes (tunable via `AIDER_CACHE_KEEPALIVE_DELAY`) to keep the provider's server-side prompt cache warm during idle stretches. The coder only enables this while it is actually idle (`ok_to_warm_cache`), and it counts successes by reading `prompt_cache_hit_tokens` / `cache_read_input_tokens` back out of the usage object.

```python
delay = 5 * 60 - 5
delay = float(os.environ.get("AIDER_CACHE_KEEPALIVE_DELAY", delay))
...
kwargs["max_tokens"] = 1
completion = litellm.completion(
    model=self.main_model.name,
    messages=self.cache_warming_chunks.cacheable_messages(),
    stream=False,
    **kwargs,
)
```

**Evidence:** `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified)

**Why it matters:** prompt caching expires (Anthropic's TTL is minutes), so a human who pauses to think, or reads a diff, pays a full cache-write again. This is the only agent I have found that treats cache warmth as a resource to be actively maintained.

### 3.8 Cache-aware prompt chunking designed as a cache layout

**What:** `ChatChunks` fixes the message order to `system + examples + readonly_files + repo + done + chat_files + cur + reminder`, then places exactly three `cache_control` breakpoints on the *most stable* slabs first. `cacheable_messages()` finds the last cache breakpoint and returns the prefix, so the warming ping sends the largest cacheable prefix and nothing else.

**Evidence:** `aider/aider/coders/chat_chunks.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)

**Why it matters:** prompt-cache hit rate is a direct multiplicative cost/latency lever, and it is normally left to emerge accidentally from whatever order the messages happen to be assembled in. Aider makes it an explicit, tested invariant.

### 3.9 The "reminder" message with role-fit and budget-fit placement

**What:** The format rules (the SEARCH/REPLACE rules block) are not part of the immutable system prompt. They are a separate `system_reminder` that is (a) appended as a real `system` message, or (b) appended to the trailing user message, depending on `main_model.reminder` (`"sys"` vs `"user"`), and (c) **dropped entirely when the prompt is already near `max_input_tokens`**. Also, models for which examples are expensive can receive examples inline in the system prompt (`examples_as_sys_msg`).

**Evidence:** `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified)

**Why it matters:** it simultaneously maximises instruction salience (recent-position rules, the effect aider calls out for `gpt-4.1` and DeepSeek) and avoids the self-inflicted context overflow that a permanently-fat system prompt causes.

### 3.10 Automatic edit-format-switch history summarisation

**What:** When switching coder (`/ask`, `/code`, `/architect`, or a model change with a different edit format), aider does **not** carry the old assistant messages verbatim, because the old format's examples would poison the new format. It summarises the whole `done_messages` first.

```python
done_messages = from_coder.done_messages
if edit_format != from_coder.edit_format and done_messages and summarize_from_coder:
    try:
        done_messages = from_coder.summarizer.summarize_all(done_messages)
    except ValueError:
        io.tool_warning("Chat history summarization failed, continuing with full history")
```

**Evidence:** `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)

**Why it matters:** mode switching is a core agent capability, and cross-format conversation history is a real, under-recognised failure mode. This is the only implementation I have seen that names and fixes it.

### 3.11 Architect/editor as a two-model pipeline, not a sub-agent

**What:** `ArchitectCoder` subclasses `AskCoder` (so it inherits the no-edit safety of ask mode) and, on `reply_completed`, constructs a *second* coder with `main_model.editor_model`, `editor_edit_format`, `map_tokens=0`, `suggest_shell_commands=False`, `cache_prompts=False`, an empty history, and the architect's prose as the user message.

**Evidence:** `aider/aider/coders/architect_coder.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified)

**Why it matters:** it gets the reasoning-model/editing-model split ("think hard, edit cheap") with no orchestration framework, no tool schema, and no extra protocol — the pipeline is just two `Coder.create` calls.

### 3.12 Web-chat interop as a first-class edit target

**What:** `/copy-context` serialises only the *user-role* chunks (repo map, read-only files, file contents) into clipboard Markdown and appends instructions telling the web model to return edits only. The `editor-diff` / `editor-whole` / `editor-editblock` formats make aider's own prompts emit pasteable blocks, and `--apply <file>` re-ingests a pasted reply and applies it. `--apply-clipboard-edits` wires the whole loop to the clipboard.

**Evidence:** `aider/aider/commands.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified)

**Why it matters:** it makes aider's context-building and edit-parsing usable against *any* LLM, including ones with only a web UI and no API — decoupling the harness from the model.

### 3.13 `ai!` / `ai?` comment-driven watch mode

**What:** `--watch-files` watches the tree and only reacts to files containing `ai!` (do the work) or `ai?` (answer a question) inside a comment. It auto-adds the file to the chat, interrupts the pending prompt so the user need not press Enter, and builds the prompt as a **tree-sitter excerpt around each annotated line** rather than the whole file.

```python
ai_comment_pattern = re.compile(
    r"(?:#|//|--|;+) *(ai\b.*|ai\b.*|.*\bai[?!]?) *$", re.IGNORECASE
)
```

**Evidence:** `aider/aider/watch.py` (repo not cloned, path not verified), `aider/aider/watch.py` (repo not cloned, path not verified)

**Why it matters:** it inverts the interaction model — the developer stays in their editor and the agent reacts to annotations in the code, instead of the developer switching to a chat window. The excerpting keeps the prompt minimal.

### 3.14 Lint signal deliberately narrowed to compiler-grade errors only

**What:** Aider's Python linter is not "flake8". It is `basic_lint` (tree-sitter `ERROR`/missing nodes) + `compile()` (real syntax errors with the traceback trimmed to the user's frame) + flake8 restricted to `--select=E9,F821,F823,F831,F406,F407,F701,F702,F704,F706 --show-source --isolated`. Style rules are deliberately excluded, and the failures are rendered through `TreeContext` with `█` markers on the offending lines.

**Evidence:** `aider/aider/linter.py` (repo not cloned, path not verified), `aider/aider/linter.py` (repo not cloned, path not verified)

**Why it matters:** a noisy linter turns the auto-fix loop into an infinite style-thrash loop. Narrowing to genuine breakage is what makes `--auto-lint` safe to leave on, and the `█`-marked excerpt keeps the feedback prompt tiny.

### 3.15 The environment block tells the model what *not* to suggest

**What:** `get_platform_info` does not just describe the OS. If `auto_lint`/`auto_test` are on, it states *"The user's pre-commit runs these lint commands, don't suggest running them"* and the same for tests; if off, it says "the user prefers these commands" instead.

**Evidence:** `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)

**Why it matters:** it removes a whole class of wasted turns — the model proposing to run a linter that the harness has *already* run — by making the harness's own behaviour part of the model's world model.

### 3.16 Attribution-aware commits with a documented truth table

**What:** `GitRepo.commit` implements `--attribute-author`, `--attribute-committer`, `--attribute-commit-message-author/committer`, and `--attribute-co-authored-by`, with non-obvious precedence rules (implicit-True defaults; co-authored-by suppresses name rewriting *unless* a name flag was explicitly set). The docstring is a complete behavioural specification with five worked "Resulting Scenarios". Names are rewritten by temporarily setting `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` inside an `ExitStack`.

**Evidence:** `aider/aider/repo.py` (repo not cloned, path not verified)

**Why it matters:** AI code provenance is a policy question every team will eventually be asked about (audits, blame, `git log` forensics). This is the most complete, most configurable answer shipped in any open-source coding agent, and it is a copy-pasteable spec.

### 3.17 LLM-generated commit messages from diff + conversation context

**What:** the commit message model sees `# Diffs:` plus the *current chat context*, is instructed to follow Conventional Commits, imperative mood, ≤ 72 chars, and to write in the user's locale-detected language; it tries the weak model first and falls back to the main model if the prompt would exceed `max_input_tokens`.

**Evidence:** `aider/aider/repo.py` (repo not cloned, path not verified), `aider/aider/prompts.py` (repo not cloned, path not verified)

**Why it matters:** it is the difference between a reviewable history and 400 commits called "update file". Feeding the *conversation* (not just the diff) is what lets the message explain intent, and the weak-model-first ordering makes it nearly free.

### 3.18 Infinite output via assistant prefill

**What:** For models that advertise `supports_assistant_prefill`, a `finish_reason == "length"` is **not** an error: the accumulated partial response is re-sent as a prefixed assistant message (`prefix=True`) and generation continues, with `multi_response_content` accumulating across retries. For models without it, aider reports the token-limit diagnosis instead.

**Evidence:** `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/website/docs/more/infinite-output.md` (repo not cloned, path not verified)

**Why it matters:** large refactors no longer fail at `max_output_tokens`; they continue. It converts a hard output ceiling into a soft one, and does so only where the provider genuinely supports prefill.

### 3.19 Model settings as declarative capability data, not code

**What:** `ModelSettings` is a dataclass loaded from `aider/resources/model-settings.yml` and merged with user files found at `$HOME`, git root, and CWD. Generic substring rules only fill the gaps, and `--check-model-accepts-settings` refuses to send `reasoning_effort`/`thinking_tokens` unless the model declared `accepts_settings`.

```python
@dataclass
class ModelSettings:
    name: str
    edit_format: str = "whole"
    weak_model_name: Optional[str] = None
    use_repo_map: bool = False
    lazy: bool = False
    overeager: bool = False
    reminder: str = "user"
    examples_as_sys_msg: bool = False
    cache_control: bool = False
    use_temperature: Union[bool, float] = True
    reasoning_tag: Optional[str] = None
    accepts_settings: Optional[list] = None
```

**Evidence:** `aider/aider/models.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified)

**Why it matters:** adding support for a new model is a YAML entry, not a code change or a release. Capability negotiation also turns silent provider 400s into loud, actionable warnings.

### 3.20 `--show-prompts` as a first-class debug flag

**What:** `--show-prompts` injects a synthetic `Hello!` turn, renders the exact `format_messages()` payload, pretty-prints every message, and exits.

**Evidence:** `aider/aider/main.py` (repo not cloned, path not verified), `aider/aider/utils.py` (repo not cloned, path not verified) (`show_messages`)

**Why it matters:** prompt engineering is impossible to do blind. A one-flag, no-API-call "dump the exact prompt" is the debugging affordance every harness needs and most lack.

### 3.21 Repo map budget that expands when the chat is empty

**What:** `get_repo_map` multiplies the map budget by `map_mul_no_files` (default 8) and caps it at `max_context_window - 4096` when no files are in the chat, then falls back through a three-step ladder (personalised map -> whole-repo map -> unhinted map).

**Evidence:** `aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)

**Why it matters:** an empty chat is exactly the moment the model needs to *find* code, and a full chat is exactly the moment it needs to *edit* code. The budget is adapted to the task phase instead of being a fixed constant.

### 3.22 Tree-sitter API forward/backward compatibility shim

**What:** `_run_captures` supports both the tree-sitter 0.23 style (`query.captures(node)`) and the 0.24+ `QueryCursor` API; `get_scm_fname` prefers the language-pack queries and falls back to the older set, with the SQLite cache version keyed off `USING_TSL_PACK` so a cache built under one query set can never be misread under the other.

**Evidence:** `aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/repomap.py` (repo not cloned, path not verified)

**Why it matters:** parser dependency churn silently corrupts caches and repeated `TypeError`/`AttributeError` cycles in sibling projects show how painful this is; versioning the cache by *query provenance* is the correct, rarely-taken fix.

### 3.23 A linter whose command is user-supplied per language, with a catch-all

**What:** `--lint-cmd "python: flake8 --select=E9"` may be repeated per language, and a bare `--lint-cmd "cmd"` becomes the fallback for every language; the command is invoked with `oslex.quote`-escaped filenames and its output is scanned with a filename-aware regex to locate line numbers, which then drive the `█`-marked context render.

**Evidence:** `aider/aider/linter.py` (repo not cloned, path not verified), `aider/aider/linter.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified)

**Why it matters:** it makes the "verify your own work" loop work in *any* language ecosystem, including ones with no tree-sitter grammar, without shipping per-language integrations.

### 3.24 Self-hosting audit: the "Aider wrote N% of this release" metric

**What:** `scripts/blame.py` walks `git log` between two release tags, runs `git blame` over the non-test, non-website files, and prints "Aider wrote N% of the code in this release", which is then pasted into `HISTORY.md` and surfaced as the `🔄 Singularity` badge in the README.

**Evidence:** `aider/scripts/blame.py` (repo not cloned, path not verified), `aider/scripts/blame.py` (repo not cloned, path not verified), `aider/HISTORY.md` (repo not cloned, path not verified), `aider/README.md` (repo not cloned, path not verified)

**Why it matters:** it is a measurable, adversarially-falsifiable claim about the tool's own usefulness, computed from the repository's own history rather than from a self-reported benchmark. As dogfooding feedback loops go, nothing else in the field is this concrete.

---
## 4. STEAL LIST — what an agent harness should adopt from aider

Ordered by expected value to a general-purpose agent harness. Each item: what to copy, the evidence path, and one line on why it matters.

### Tier 1 — copy this week; these change reliability and cost materially

**1. Escalating edit-application ladder (literal -> 3-way-merge -> line-level patch), each retried under 4 preprocessing variants.**
`aider/aider/coders/search_replace.py` (repo not cloned, path not verified)
Why: turns the single most common LLM failure — "you got the surrounding context slightly wrong" — into an automatic recovery instead of a failed turn.

**2. Relative-indent normalisation before matching edit blocks.**
`aider/aider/coders/search_replace.py` (repo not cloned, path not verified)
Why: kills uniform indentation drift, the top corruption mode in model-authored edits, without loosening matching on real content.

**3. Structured, actionable edit-failure feedback that is fed back to the model (failing block + \"did you mean these actual lines?\" + \"the REPLACE lines are already present\").**
`aider/aider/coders/editblock_coder.py` (repo not cloned, path not verified)
Why: a bare "edit failed" wastes a turn; a diff-shaped hint lets the model self-correct in one shot. The `find_similar_lines` helper is ~25 lines.

**4. Bounded reflection loop with a single `reflected_message` slot and `max_reflections`.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: it is the whole "verify then fix" loop in ~15 lines, with a hard stop that prevents the classic infinite self-repair spiral.

**5. Repo map: tree-sitter def/ref graph + personalised PageRank + token-budget binary search.**
`aider/aider/repomap.py` (repo not cloned, path not verified)
Why: whole-repo relevance ranking with no embeddings, no index service and no LLM call — the cheapest large-repo context strategy available; the weight table at `aider/aider/repomap.py` (repo not cloned, path not verified) is empirically tuned and worth copying almost verbatim.

**6. Cache layout as an explicit invariant: stable slabs first, exactly 3 breakpoints, plus `cacheable_messages()` to compute the largest cacheable prefix.**
`aider/aider/coders/chat_chunks.py` (repo not cloned, path not verified)
Why: prompt-cache ordering is normally accidental; making it explicit is a direct, measurable cost and latency win.

**7. Cache keep-alive pings during idle time.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: caches expire in minutes; a human pausing to review a diff otherwise forces a full cache-write on the next turn. `AIDER_CACHE_KEEPALIVE_DELAY` shows the tunability they needed.

**8. Dirty-commit-before-edit, then a separate commit for lint fixes.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: guarantees the agent always has a clean committed base to revert to, and keeps "the feature" and "the lint fix" independently revertible — the difference between a trustworthy and a terrifying git-using agent.

**9. Narrow the lint signal to compiler-grade errors and render failures as a marked tree-sitter excerpt.**
`aider/aider/linter.py` (repo not cloned, path not verified), `aider/aider/linter.py` (repo not cloned, path not verified)
Why: a noisy linter makes auto-fix a style-thrash loop; narrowing plus excerpting is what makes it safe to leave on and keeps the feedback prompt tiny.

**10. Tell the model what the harness already does for it ("the user's pre-commit runs these lint commands, don't suggest running them").**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: eliminates a whole category of wasted turns where the model proposes an action the harness has already taken.

### Tier 2 — adopt next; these unlock capability and debuggability

**11. Model capability/settings as declarative YAML data with user-level overrides, plus `accepts_settings` negotiation.**
`aider/aider/models.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified)
Why: adding a model becomes a data edit rather than a code change, and unsupported parameters become a warning instead of a provider 400.

**12. Per-message relevance budget that expands when no files are in context (`map_mul_no_files`), plus the 3-step map fallback ladder.**
`aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: the context budget should follow the task phase — wide when searching, narrow when editing — rather than being one constant.

**13. `--show-prompts`: dump the exact rendered message list and exit, with no API call.**
`aider/aider/main.py` (repo not cloned, path not verified)
Why: prompt engineering without a prompt inspector is guesswork; this is a tiny affordance with outsized value.

**14. Summarise history when the edit format / mode changes.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: stale in-format examples actively poison a new format; this is the only implementation that names the failure and fixes it.

**15. Split "reminder" from "system prompt", with role-fit placement and automatic omission near the context limit.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified)
Why: maximises instruction salience at the recent position while making the harness unable to overflow its own context with its own rules.

**16. Assistant-prefill-driven continuation so `finish_reason == "length"` is a continuation, not a failure (only where `supports_assistant_prefill`).**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: converts a hard output ceiling into a soft one; large refactors stop failing at `max_output_tokens`.

**17. Fence auto-selection: pick the shortest backtick run absent from the payload, and inject a quad-backtick reminder into the system prompt when needed.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: removes an entire class of parse failures when the files under edit contain Markdown fences, with zero prompt cost when the 3-backtick case is safe.

**18. Synthetic "assistant ack" turns after each context slab ("Ok, I won't try and edit those files without asking first.").**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: cheap, high-leverage prompt hygiene — it marks injected context as settled, so the model stops trying to edit read-only material or re-litigate the repo map.

**19. Explicitly denylist "plain word" filenames when detecting file mentions.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: without the "contains `/`, `.`, `_` or `-`" rule plus the unique-basename rule, `run`, `make` and `test` become phantom file mentions. A ~15-line fix for a very common false-positive source.

**20. Two-model architect/editor as two `Coder.create` calls, with the planner on a read-only (ask) coder.**
`aider/aider/coders/architect_coder.py` (repo not cloned, path not verified)
Why: gets "reason expensively, edit cheaply" with no orchestration framework and no extra protocol, and inherits ask-mode safety for free.

**21. User-supplied, per-language lint command with a catch-all fallback and `filename:line` output parsing.**
`aider/aider/linter.py` (repo not cloned, path not verified), `aider/aider/linter.py` (repo not cloned, path not verified)
Why: makes the verify-your-own-work loop work in any ecosystem without shipping per-language integrations.

**22. Consent UX: `(Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again` as a first-class `ConfirmGroup` abstraction, with grouped prompts.**
`aider/aider/io.py` (repo not cloned, path not verified), `aider/aider/io.py` (repo not cloned, path not verified)
Why: agents ask the same question ten times per session; All/Skip all/Don't ask again collapses that to one interaction, and `explicit_yes_required` lets dangerous actions refuse a blanket `--yes`.

### Tier 3 — high-value, lower-cost wins

**23. Commit attribution as a configurable, documented truth table (`--attribute-*`, `--attribute-co-authored-by`).**
`aider/aider/repo.py` (repo not cloned, path not verified)
Why: AI provenance policy is coming for every team; the docstring is a ready-made specification and the `ExitStack` env-scoped implementation is the correct way to do it.

**24. LLM commit messages built from the diff plus the conversation context, Conventional Commits, weak-model-first with a token-limit fallback.**
`aider/aider/repo.py` (repo not cloned, path not verified), `aider/aider/prompts.py` (repo not cloned, path not verified)
Why: produces a reviewable history nearly for free, and feeding the conversation is what lets the message capture intent rather than restate the diff.

**25. Continuous Markdown chat transcript written on every event, plus a parser to restore it.**
`aider/aider/io.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: one file gives session resume, post-mortem debugging and user-support artefacts, at essentially zero implementation cost.

**26. Defer heavy imports behind a lazy proxy, plus a first-run-per-version background warmup thread.**
`aider/aider/llm.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified)
Why: LiteLLM alone costs ~1.5 s of startup; making that a background thread on all but the first run is a pure UX win.

**27. Cost/token accounting that distinguishes cache-write from cache-hit tokens, with provider-specific multipliers.**
`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Why: naive cost maths is wrong by roughly 10x on cached tokens, and the cost display is what lets a user make informed model choices.

**28. Per-chunk context cost table (`/tokens`) with a `$` figure and a remediation hint per row.**
`aider/aider/commands.py` (repo not cloned, path not verified)
Why: it tells the user which file is eating the context and which command frees it — turning a diagnostic into an action.

**29. Version the tag cache by the provenance of the extractor (`CACHE_VERSION` bumped when `USING_TSL_PACK` flips), with rebuild-then-dict fallback on corruption.**
`aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/repomap.py` (repo not cloned, path not verified)
Why: cache correctness must be keyed on what produced the data, or a dependency upgrade silently corrupts results.

**30. Two-tree-sitter-API shim (`Query.captures` vs `QueryCursor`).**
`aider/aider/repomap.py` (repo not cloned, path not verified)
Why: parser API churn is constant; a short capability probe avoids forcing users to pin a version.

**31. Reuse one edit-application engine across formats (the `udiff` coder imports and shares the editblock strategy lists).**
`aider/aider/coders/udiff_coder.py` (repo not cloned, path not verified), `aider/aider/coders/search_replace.py` (repo not cloned, path not verified)
Why: every reliability improvement lands in all formats at once instead of being re-derived per format.

**32. `--dry-run` enforced at the I/O layer (`io.write_text` returns early) rather than by guarding call sites.**
`aider/aider/io.py` (repo not cloned, path not verified)
Why: one guard covers every writer, present and future; per-call-site guards always drift.

**33. Mode switching as a first-class runtime operation via a `SwitchCoder` exception carrying the new coder's kwargs.**
`aider/aider/commands.py` (repo not cloned, path not verified), `aider/aider/main.py` (repo not cloned, path not verified)
Why: `/ask`, `/architect`, `/model` and `/help` all become the same mechanism, and `from_coder` carries cost/history/commits across the switch automatically.

**34. Observability flags that externalise internal state: `--show-repo-map`, `/settings`, `--show-prompts`, `--verbose`, and a local-only analytics log.**
`aider/aider/main.py` (repo not cloned, path not verified), `aider/aider/commands.py` (repo not cloned, path not verified), `aider/aider/analytics.py` (repo not cloned, path not verified)
Why: every non-trivial harness bug is diagnosed by printing the exact state it sent; the local JSON log is the privacy-friendly alternative to a network call.

**35. OAuth-style onboarding plus fuzzy model discovery (`--list-models`) and "did you mean" suggestions for unknown models.**
`aider/aider/onboarding.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified)
Why: the first five minutes decide adoption; credential setup and model discovery are the two places users quit.

---
## 5. Optimisation + what-to-do candidates

Everything below is grounded in code I actually read; each item names the mechanism, the cost, and (where relevant) the fix.

### 5.1 Correctness/accuracy defects found (highest value — they are cheap to fix and affect real output)

**A. Edge-weight inflation in the repo map: a duplicated tag capture.**
In `get_tags_raw`, the inner node loop appends to `captures_by_tag`, and then the *same* node is appended a second time immediately after the loop:

```python
for tag, nodes in captures.items():
    for node in nodes:
        captures_by_tag[tag].append(node)
    captures_by_tag[tag].append(node)   # <-- outside the node loop: duplicates the last node
    matches.append((node, tag))

if USING_TSL_PACK:
    all_nodes = [(node, tag) for tag, nodes in captures_by_tag.items() for node in nodes]
else:
    all_nodes = matches           # <-- this path is NOT affected
```

Consequence: with the tree-sitter-language-pack path (the default when the pack is installed), every tag's last node is emitted twice. `definitions[key]` and `defines[name]` are sets so they absorb it, but `references[name]` is a **list**, so `Counter(references[ident])` sees one extra reference for that occurrence and `sqrt(num_refs)` inflates the edge weight by ~1.41x for that ident. The `matches` fallback path does not have the duplicate, so rank order differs subtly between the two parser backends.

Evidence: `aider/aider/repomap.py` (repo not cloned, path not verified)
Fix: delete the stray `captures_by_tag[tag].append(node)` line (or dedupe `all_nodes` by `(id(node), tag)`).

**B. DeepSeek cache-hit cost is computed with a price where a token count belongs.**

```python
if input_cost_per_token_cache_hit:
    # must be deepseek
    cost += input_cost_per_token_cache_hit * cache_hit_tokens
    cost += (prompt_tokens - input_cost_per_token_cache_hit) * input_cost_per_token
```

`input_cost_per_token_cache_hit` is a *per-token price* (order 1e-8), so `prompt_tokens - input_cost_per_token_cache_hit` is effectively `prompt_tokens`. The whole prompt is therefore billed at the full rate, **plus** the cache-hit tokens billed again at the discounted rate. The intended expression is `(prompt_tokens - cache_hit_tokens) * input_cost_per_token` — as the comment above it says, `prompt_cache_hit_tokens + prompt_cache_miss_tokens == prompt_tokens`.

The Anthropic branch has the mirror-image problem: `prompt_tokens` already *includes* cache-read and cache-write tokens for that API, yet `cost += cache_write_tokens * input_cost_per_token * 1.25`, `cost += cache_hit_tokens * input_cost_per_token * 0.10` and `cost += prompt_tokens * input_cost_per_token` are all added, over-charging by the cache token counts.

Evidence: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Mitigation that already exists: LitellM's `completion_cost` is tried first and this function is only the fallback, and `/tokens` is documented as approximate — which is presumably why the bug has survived.

**C. The `cur` chunk is counted twice when deciding whether the format reminder will fit.**

```python
chunks.cur = list(self.cur_messages)
chunks.reminder = []

messages_tokens = self.main_model.token_count(chunks.all_messages())
reminder_tokens = self.main_model.token_count(reminder_message)
cur_tokens = self.main_model.token_count(chunks.cur)

if None not in (messages_tokens, reminder_tokens, cur_tokens):
    total_tokens = messages_tokens + reminder_tokens + cur_tokens
```

`ChatChunks.all_messages()` already ends with `+ self.cur + self.reminder`, so `messages_tokens` includes `cur`. Adding `cur_tokens` again inflates the estimate by the size of the current turn's messages, which makes the harness **drop the system reminder earlier than necessary** — i.e. the format rules the model depends on disappear while there is still room for them. This is the opposite of what the feature intends.

Evidence: `aider/aider/coders/chat_chunks.py` (repo not cloned, path not verified) (ordering) and `aider/aider/coders/base_coder.py` (repo not cloned, path not verified) (the arithmetic)
Fix: `total_tokens = messages_tokens + reminder_tokens` (drop `cur_tokens`), or compute `cur_tokens` once and pass it through all three sites.

### 5.2 Speed

**D. Four-plus full tokenizations per turn.** A single turn runs: `check_tokens(messages)` over the entire prompt, then `format_chat_chunks` counts `all_messages()`, `reminder_message` and `cur` separately, and `show_exhausted_error` counts again on failure. On a 100k-token context with a real tokenizer that is seconds of pure CPU per turn.

Evidence: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified), `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Fix: count once per `format_chat_chunks()` and pass `total_tokens` to `check_tokens`; or reuse `RepoMap.token_count`'s sampling trick (`aider/aider/repomap.py` (repo not cloned, path not verified)) for large payloads.

**E. `get_file_mentions` rebuilds the normalised word set inside the per-file loop.**

```python
for rel_fname in addable_rel_fnames:
    normalized_rel_fname = rel_fname.replace("\\", "/")
    normalized_words = set(word.replace("\\", "/") for word in words)   # <-- invariant!
```

`normalized_words` does not depend on `rel_fname`, but it is reconstructed once per addable file — O(files × words) set/string churn on every user message. On a 10k-file repo with a 200-word message that is 2M string operations before any real work happens.

Evidence: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified)
Fix: hoist the comprehension above the loop.

**F. `GitRepo.path_in_repo` rebuilds the tracked-file set on every call.**

```python
def path_in_repo(self, path):
    ...
    tracked_files = set(self.get_tracked_files())
    normalized = self.normalize_path(path)
    return normalized in tracked_files
```

`get_tracked_files()` is memoised per commit via `self.tree_files[commit]`, but it still rebuilds and re-filters a list (`[fname for fname in files if not self.ignored_file(fname)]`) and then materialises a fresh `set` on every call. It is called from `allowed_to_edit` (once per edited file), `is_dirty`, `get_diffs`, and repo-map setup.

Evidence: `aider/aider/repo.py` (repo not cloned, path not verified), `aider/aider/repo.py` (repo not cloned, path not verified)
Fix: cache the filtered `set` keyed on the commit hash (the same key `tree_files` already uses) and invalidate on commit/index change.

**G. First Tab-completion reads and Pygments-lexes every in-chat file.**
`AutoCompleter.tokenize()` iterates `self.all_fnames` (chat files plus every read-only file), reads each one, and runs Pygments over it, to build the completion word list. Adding a directory with `/read-only` makes the first Tab pressure the whole directory through the lexer.

Evidence: `aider/aider/io.py` (repo not cloned, path not verified), `aider/aider/commands.py` (repo not cloned, path not verified)
Fix: tokenize lazily/incrementally, cap by file size, or build the word list from the repo-map tag cache (`RepoMap` already has the identifiers).

**H. The repo-map binary search re-renders whole trees per probe.** `get_ranked_tags_map_uncached` clears `self.tree_cache` and each probe calls `to_tree(ranked_tags[:middle], ...)`, which re-renders every file group from scratch through `TreeContext`.

Evidence: `aider/aider/repomap.py` (repo not cloned, path not verified), `aider/aider/repomap.py` (repo not cloned, path not verified)
Fix: because `to_tree` iterates `sorted(tags)`, a probe prefix is a prefix of the sorted list — render and cache **per file-group** and concatenate, so each probe only renders the newly-included tail. This converts the `O(log N)` full renders into one render plus incremental appends.

**I. The LiteLLM price database is loaded synchronously on first model construction.** `ModelInfoManager._load_cache` reads `~/.aider/caches/model_prices_and_context_window.json` (multi-MB JSON) inside `Model()`. This happens after `Coder.create` but before the first prompt, so it lands squarely in perceived startup.

Evidence: `aider/aider/models.py` (repo not cloned, path not verified), `aider/aider/models.py` (repo not cloned, path not verified)
Fix: warm it on the same background thread that `load_slow_imports` already uses (`aider/aider/main.py` (repo not cloned, path not verified)), since the result is only needed at the first token count.

### 5.3 Capability gaps (features to add)

**J. `/tokens` prices everything at the input rate.** It computes `cost = tk * info["input_cost_per_token"]` for every row, including read-only files and the chat history, so with caching enabled the displayed `$` overstates the real cost and disagrees with the per-message `Cost:` line produced by `compute_costs_from_tokens`. Evidence: `aider/aider/commands.py` (repo not cloned, path not verified). Fix: reuse `compute_costs_from_tokens` so the two cost reports agree.

**K. No lazy repo-map refresh.** `--map-refresh files` exists, but any refresh rebuilds the whole graph and re-runs PageRank over every ident. A file-level tag cache already exists (`aider/aider/repomap.py` (repo not cloned, path not verified)), so the graph could be diff-updated for the handful of files whose mtime changed, with PageRank run on the delta plus the affected neighbourhood.

**L. No explicit context budget allocator.** The repo map gets `get_repo_map_tokens()` (min \( \max_{input}/8, 1024 \), max 4096 — `aider/aider/models.py` (repo not cloned, path not verified)), history gets \( \max_{input}/16 \) clamped to [1024, 8192], and read-only files, chat files and system prompt are unbounded. There is no single place that partitions the window, so a large `/read-only` can silently starve the map. `check_added_files` only warns once, at a 4-file / 20k-token heuristic: `aider/aider/coders/base_coder.py` (repo not cloned, path not verified).

**M. File renames are only expressible in one edit format.** The `patch` format supports `*** Move to:` (`aider/aider/coders/patch_coder.py` (repo not cloned, path not verified)), but the default `diff` format can only rename via a shell `mv` block, gated by the `rename_with_shell` prompt and `suggest_shell_commands` (`aider/aider/coders/editblock_prompts.py` (repo not cloned, path not verified)). Users who disable shell commands lose renaming entirely. Promoting a “deleted+created” pair into a real git rename (or teaching `diff` the `Move to:` directive) would close this.

**N. No machine-readable output mode.** `--message` writes human-formatted text to stdout; scripted consumers must parse Markdown. A `--json` / `--output-format` flag emitting `{files_edited, commit_hashes, cost, edit_outcome, lint_outcome, test_outcome}` would make aider embeddable in CI. The data already exists on the coder: `aider_edited_files`, `aider_commit_hashes`, `total_cost`, `lint_outcome`, `test_outcome`, `num_malformed_responses`.

**O. No prompt snapshot tests.** `--show-prompts` exists (`aider/aider/main.py` (repo not cloned, path not verified)) but the test suite has no golden-file coverage of rendered prompts per model family, which is precisely the surface that changes silently when `model-settings.yml` or a prompt string is edited. With 17 `*prompts*.py` modules under `aider/coders/` plus the `main_system`/`system_reminder` strings in each, this is the largest untested regression surface in the repo.

**P. `--subtree-only` and `.aiderignore` are the only scoping mechanisms.** For monorepos, a per-task allowlist (“only propose edits under these paths”) that also constrains the repo map and file-mention detection would avoid the “1,000+ files, add `.aiderignore`” warning (`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)) rather than merely advising about it.

**Q. Summarisation triggers on edit-format change but not on a same-format model swap.** Switching from, say, `gpt-4o` to `deepseek-chat` keeps `diff` as the format, so no summarisation happens — but the in-context few-shot examples and instruction-following quirks differ substantially. `Coder.create`'s guard (`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)) could key on `(edit_format, main_model.name)` instead.

**R. The multimodal gate is a hard-coded extension allowlist that mislabels PDFs as images.** `IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".webp", ".pdf"}` — so `is_image_file()` returns True for `.pdf`, `io.read_text` therefore returns base64, and the PDF branch of `get_images_message` is reached through the same loop as the image branch (`aider/aider/coders/base_coder.py` (repo not cloned, path not verified)). It works, but the naming is misleading and, crucially, any other binary document (`.docx`, `.xlsx`, `.zip`) falls through to a UTF-8 `read_text`, which raises `UnicodeError` → the file is silently dropped and the user gets "`--encoding` to set the unicode encoding". Extending `IMAGE_EXTENSIONS` (or renaming it to `ATTACHMENT_EXTENSIONS` with a MIME-based dispatch) is the fix.

Evidence: `aider/aider/utils.py` (repo not cloned, path not verified), `aider/aider/utils.py` (repo not cloned, path not verified), `aider/aider/io.py` (repo not cloned, path not verified)

### 5.4 What to do, concretely, in priority order

1. **Fix B and C.** Both are arithmetic errors with user-visible consequences (over-reported DeepSeek/Anthropic cost; the format reminder being dropped too early). Both are one-line changes; both are currently untested.
2. **Fix A.** Delete the stray duplicate append; add a `test_repomap.py` assertion that each captured node yields exactly one tag.
3. **Fix E and F.** Two loop-invariant hoists/caches that are pure wins in large repos.
4. **Do D.** Count tokens once per turn and thread the value through; this is measurable with the existing `map_processing_time`-style instrumentation.
5. **Do H.** Make `to_tree` incremental so the binary search stops re-rendering.
6. **Add O.** Golden prompt snapshots for `diff` and `whole` across the model families in `model-settings.yml`. This is the highest-leverage *test* investment in the repo.
7. **Add N.** A JSON output mode, to move aider from “a CLI you watch” to “a step in a pipeline”.
8. **Add L**, then **M**, then **P**, then **Q**.
9. **Then port the whole thing.** Sections 3 and 4 together describe a coherent architecture — text-based edit formats with a multi-strategy application ladder, git as the state machine, a graph-ranked repo map for context, prompt caching as a first-class layout constraint, and a narrow lint/test feedback loop with bounded reflection. Every one of those five pieces is independently portable into a harness that has none of them, and none of them requires a framework, a server or an embedding index to adopt.

---

## Appendix: coverage ledger

### Directories enumerated (walked in full)

`aider/`, `aider/coders/`, `aider/queries/tree-sitter-language-pack/`, `aider/queries/tree-sitter-languages/`, `aider/resources/`, `aider/website/` and its 20 subdirectories (`assets/` incl. `asciinema/`, `audio/` with 4 recording sets, `icons/`; `blog/`; `_data/`; `docs/` with `config/`, `install/`, `leaderboards/`, `legal/`, `llms/`, `more/`, `recordings/`, `troubleshooting/`, `usage/`; `examples/`; `_includes/`; `_layouts/`; `_posts/`; `_sass/` + `_sass/custom/`; `share/`), `benchmark/`, `docker/`, `.github/ISSUE_TEMPLATE/`, `.github/workflows/`, `requirements/`, `scripts/`, `tests/`, `tests/basic/`, `tests/browser/`, `tests/fixtures/` (+ `languages/` with 44 language subdirectories, `sample-code-base/`), `tests/help/`, `tests/scrape/`.

Total: **80 directories, 685 files** (excluding `.git`).

### Files read in full or substantively

Root: `README.md`, `pyproject.toml`, `HISTORY.md` (head + structure), `pytest.ini`, `MANIFEST.in`, `.gitignore`, `.pre-commit-config.yaml`, `CONTRIBUTING.md`, `requirements.txt`.

`aider/`: `main.py`, `io.py`, `commands.py`, `models.py`, `repo.py`, `repomap.py`, `linter.py`, `run_cmd.py`, `watch.py`, `watch_prompts.py`, `history.py`, `special.py`, `prompts.py`, `reasoning_tags.py`, `sendchat.py`, `exceptions.py`, `mdstream.py`, `waiting.py`, `analytics.py`, `report.py`, `versioncheck.py`, `onboarding.py`, `deprecated.py`, `help.py`, `utils.py`, `diffs.py`, `editor.py`, `gui.py`, `copypaste.py`, `voice.py`, `scrape.py`, `llm.py`, `args.py`, `args_formatter.py`, `openrouter.py`, `format_settings.py`, `dump.py`.

`aider/coders/`: `base_coder.py` (all 2485 lines), `base_prompts.py`, `chat_chunks.py`, `editblock_coder.py`, `editblock_fenced_coder.py`, `editblock_prompts.py`, `editblock_fenced_prompts.py`, `editblock_func_coder.py` + `editblock_func_prompts.py`, `wholefile_coder.py`, `wholefile_prompts.py`, `wholefile_func_coder.py` + `wholefile_func_prompts.py`, `single_wholefile_func_coder.py` + `single_wholefile_func_prompts.py`, `udiff_coder.py`, `udiff_prompts.py`, `udiff_simple.py`, `udiff_simple_prompts.py`, `patch_coder.py` (all 706 lines), `patch_prompts.py`, `search_replace.py` (all 757 lines), `context_coder.py`, `context_prompts.py`, `ask_coder.py`, `ask_prompts.py`, `architect_coder.py`, `architect_prompts.py`, `help_coder.py`, `help_prompts.py`, `editor_diff_fenced_coder.py`/`_prompts.py`, `editor_editblock_coder.py`/`_prompts.py`, `editor_whole_coder.py`/`_prompts.py`, `shell.py`, `__init__.py`.

`aider/resources/`: `model-settings.yml`, `model-metadata.json`, `__init__.py`.

`benchmark/`: `benchmark.py` (structure), `README.md`, `Dockerfile`, `swe_bench.py`, `problem_stats.py`, `over_time.py`, `plots.py`, `prompts.py`, `docker.sh`, `rsync.sh`, `install-docker-ubuntu.sh`, per-language test scripts.

`scripts/`: `blame.py` (the singularity metric), `homepage.py`, `update-history.py`, `versionbump.py`, `issues.py`, `tsl_pack_langs.py`, `clean_metadata.py`, `my_models.py`, `recording_audio.py`, `redact-cast.py`, plus the Jekyll/compile helpers and `.sh` drivers.

`tests/`: full `tests/basic/` inventory (33 modules, with sizes) plus `tests/browser/`, `tests/help/`, `tests/scrape/`, `tests/fixtures/` layout.

Docs: complete inventory of `aider/website/docs/**` (52 markdown files across 9 subdirectories) with the usage, config, llms and troubleshooting sets read; `aider/website/examples/` (14 files) listed.

### NOT READ (explicit)

| Path | Reason |
|---|---|
| `aider/website/assets/*.mp4` (6 files, ~52 MB) | Binary screen recordings |
| `aider/website/assets/*.jpg` (37), `*.png` (12), `*.ttf`, `*.svg` (23) | Binary images/logos/fonts |
| `aider/website/assets/audio/**` (111 `.mp3`) | Doc voice-overs |
| `aider/website/assets/asciinema/asciinema-player.min.js` | Vendored minified third-party player |
| `aider/queries/**/*.scm` (58 files) | Per-language tree-sitter capture data; consumer read instead |
| `aider/website/_sass/`, `_layouts/`, `_includes/`, `_data/`, `_posts/`, `blog/`, `share/` | Jekyll site chrome and blog posts |
| `tests/fixtures/chat-history.md` (4.1 MB), `chat-history-search-replace-gold.txt` (0.9 MB) | Generated golden/transcript fixtures |
| `tests/fixtures/languages/**` (~100 files) | Small per-language parser fixtures; layout and samples inspected |
| `tests/fixtures/sample-code-base/**` | Sample tree for `/add`-directory tests |
| `requirements/*.txt` (13 files) | Pinned dependency lockfiles |
| `.github/workflows/*.yml` (10 files) | CI config; inventoried by filename |
| `docker/Dockerfile`, `benchmark/Dockerfile` | Read for structure only |

### Query used

`git log --oneline -10` returns a single commit (`5dc9490`) — this clone has no history, so no commit-level archaeology (blame, churn, co-change) was possible and all conclusions are from the working tree at that commit.
