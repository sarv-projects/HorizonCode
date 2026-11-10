# Grok Build TUI: deep analysis and HorizonCode TUI Part 2 spec

Source studied: [`xai-org/grok-build`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) (xai-org/grok-build, Rust), crates under `crates/codegen/`.
HorizonCode side studied: `app/src/tui/` (branch `feat/tui-polish`, commit `d1838f8`).
Short crate names below: `pager` = `xai-grok-pager/src`, `render` = `xai-grok-pager-render/src`, `minimal` = `xai-grok-pager-minimal/src`, `inline` = `xai-ratatui-inline/src`.
Everything marked "(verified)" was read in source. Items marked "(inferred)" are conclusions from the code, not direct reads. No repository was modified; this file is the only output.

---

## 0. The one thing to understand first: Grok has TWO TUIs

Your screenshot is the **fullscreen** mode (alternate screen, own scrollback pane, mouse, dock, hint bar). Grok also ships a **minimal** mode (`grok --minimal`, crate `xai-grok-pager-minimal`) that is a scrollback-native inline viewport. They share the same block renderers (`EntryRenderer`, `BlockContent` impls) and the same theme/glyph code. HorizonCode is architecturally a *minimal-mode-like* design (scrollback + a small live region), so the minimal mode is the closest reference. The fullscreen mode is where most of the screenshot chrome lives (header, hint bar, bordered input with caption, `▼ Subagents` dock).

| Concern | Fullscreen (screenshot) | Minimal (`--minimal`) |
|---|---|---|
| Screen | alternate screen (`alt_screen = auto/always/never`; `--no-alt-screen` still counts as fullscreen, inline) | main screen, native scrollback |
| History | in-app `ScrollbackPane` (scroll, fold, select, mouse) | printed once into terminal scrollback via `Terminal::insert_before_rows` |
| Live area | whole screen | pinned viewport: tail + todos + status + prompt (+ info row) |
| Prompt | rounded box `╭─╮│╰─╯`, caption on borders | borderless (`show_borders: false`), info row under it |
| Theme | 6 RGB themes | fixed terminal-native palette (`Reset` + ANSI-16), no theming |
| Switch | `/minimal` | `/fullscreen` (in place, no restart) |

(verified: `pager/README.md`, `docs/user-guide/04-slash-commands.md:163`, `05-configuration.md:183-190`, `minimal/src/lib.rs`.)

---

## 1. Overall architecture

### 1.1 Redraw model

- **Elm-style**: `Action -> dispatch -> Effect -> state`, then a pure draw into a ratatui `Buffer` (`pager/app/event_loop.rs`, `pager/app/dispatch/`, `pager/app/app_view.rs`). The terminal layer diffs the new buffer against the previous one and writes only changed cells (ratatui double buffer; forked `Terminal` in `inline/terminal.rs`, 1602 lines).
- **Event loop** (`pager/app/event_loop.rs`, 6159 lines): a tokio `select!` over input events, ACP (agent) messages, task results, an animation timer, a resize debounce timer, a deferred-draw timer, a status-line refresh timer. Input is read on a dedicated thread (`app/reader_thread.rs`).
- **`Presenter`** (`event_loop.rs:500`): coalesces draw requests (`dirty`, `request(false)`), keeps at most one frame in flight (`in_flight_target`, acknowledged when the writer thread reports progress), and detects a blocked writer (`WriterProgress::{Flowing,Stalled,Recovered}`). This is how they avoid queueing frames behind a slow terminal.
- **Demand-driven animation clock** (`app/app_view.rs:248-258, 5552`): `TickDemand::{None, Slow, Fast}`.
  - `None`: nothing animates, the loop parks with **zero wakeups**.
  - `Slow`: `SLOW_TICK_INTERVAL = 83 ms` (~12 fps), for the welcome-logo shimmer etc.
  - `Fast`: configured `animation.fps`, default **30** (`render/appearance/config.rs:334-356`, `tick_interval = 1000/fps` = 33 ms).
  - `schedule_tick` (`event_loop.rs:3067`) arms the next tick only if something needs it. One shared integer `tick` drives every animation.
- **Resize**: `RESIZE_DEBOUNCE = 16 ms` (`event_loop.rs:34`). A pending resize blocks intermediate-size paints (`resize_debounce, if input_rx.is_empty()`).
- **Paste detection**: `PASTE_DETECT_TIMEOUT = 2 ms`, `PASTE_CONTINUE_TIMEOUT = 10 ms` (`event_loop.rs:3438-3440`): bursts of key events are coalesced into a paste when bracketed paste is not available.

### 1.2 Flicker avoidance (the techniques that matter)

1. **DEC 2026 synchronized output**: every frame is wrapped in `BeginSynchronizedUpdate` / `EndSynchronizedUpdate` (`ESC[?2026h` ... `ESC[?2026l`). Skipped only when tmux is the immediate terminal (`render/terminal/tmux.rs:55 should_emit_synchronized_output`) because tmux already syncs its own output. Their PTY harness measures frame time from these markers (`pty-harness/src/timing.rs`).
2. **Cell diffing**, not full repaint. Only changed cells are emitted.
3. **One batch per frame**: in minimal mode the commit-to-scrollback and the live-region redraw happen inside the same sync block (`minimal/lib.rs::draw`, doc comment explains: "without it a multi-block commit flickers as separate presents").
4. **Size adoption before the sync begins**: `terminal.autoresize()` runs before `BeginSynchronizedUpdate`, because a cursor-position query inside the update stalls until it ends.
5. **Stable heights across the commit boundary**: a block must have the same height in the live tail and in scrollback, otherwise the prompt jumps (`minimal/commit.rs`, `minimal_commit_display_mode`, `MINIMAL_BLOCK_GAP`).

### 1.3 How the inline viewport keeps output in real scrollback (minimal mode)

`xai-ratatui-inline` (README + `scrollback.rs::emit_to_scrollback`):

1. Move the cursor to the **top of the viewport** (`MoveTo(0, viewport.y)`), clear to end of display (`ESC[J`).
2. **Print the finished content as ordinary text**; the terminal wraps and scrolls it into native scrollback. ANSI-aware, zero-copy line segmentation (`segment.rs`, `anstyle-parse`) is used so wrapping does not split an escape sequence.
3. Print `viewport.height` newlines to **reserve room** for the live region.
4. `MoveTo(0, new_viewport_y)`, `ESC[J`, reset the back buffer, repaint the live region.

No alternate screen, no scroll regions needed (there is a `scrolling-regions` cargo feature, the pager builds without it). A wrap-aware variant `insert_before_rows` keeps soft-wrapped rows joined (omits `\r\n` mid-wrap so the terminal marks the row as wrapped, which keeps copy/paste and reflow correct; a full-width hard break disables autowrap temporarily so the "xenl" pending-wrap state cannot join the next line).

**The commit frontier** (`minimal/commit.rs`): a block is printed to scrollback exactly once, only when it is final.
- `is_committable`: pending-permission blocks never commit; mid-turn only `!is_running` entries commit; an agent message stays live until a later non-thinking entry proves its stream closed.
- The "tail" of uncommitted entries is drawn in the live region (`live.rs::draw_tail`) so streaming text is visible, and it migrates into scrollback as it finalizes.

**Resize in minimal mode** (`inline/README.md` "Terminal Resize Strategy", [`minimal/reprint.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/minimal/reprint.rs)): terminals reflow before the app sees SIGWINCH, which corrupts a viewport border. Their answer is: after a debounce, `ESC[2J ESC[3J ESC[H` (clear screen + scrollback + home; NOT `ESC c`, which does not clear scrollback in iTerm/Terminal.app), then **reprint the committed history at the new width** (cap `REPRINT_MAX_ROWS = 4000`), then re-place the viewport. Older rows stay reachable via `/transcript`.

### 1.4 Terminal capability handling worth copying

- Legacy Windows ConHost glyph fallbacks centralised in `render/glyphs.rs` (`is_legacy_windows_console()`); every chrome glyph is a function with an ASCII/CP437 fallback of identical width.
- Terminal brand detection decides truecolor and sync-output policy (`render/terminal/*`: `xtversion.rs`, `da2.rs`, `tmux.rs`, `kitty_keyboard.rs`).
- OSC 11 background query at startup (`render/theme/osc11.rs`, 500 ms timeout, 80 ms for the tmux-wrapped retry), strictly before the input stream starts.

---

## 2. Layout

### 2.1 Fullscreen vertical stack (verified: `pager/views/agent.rs:AgentViewLayout::compute`)

Top to bottom, built as ratatui `Constraint`s inside an outer padding block:

```
StatusBar            Length(1)    <- your "/mnt/c  30K / 256K | [Dashboard]" header
[tasks]              optional
[todo]               optional
gap
Scrollback           Min(5)       <- the only flexible row (SCROLLBACK_MIN_ROWS)
[btw] [queue]        optional
[turn_status]        1 row        <- "⠋ Map Expo app project + 4 more… 1m51s   4m13s ⇣30.5k [stop]"
[banner] [plugin_cta] [follow_ups]
[dock]               <= 8 rows    <- "▼ Subagents 1" (feature-flagged `dock_enabled`)
gap
[model_notice] [voice_recording]
Prompt               prompt_height (box)
[gap] [status_line]  user script row
Shortcuts bar        1 row        <- "→:expand | Enter:open | Ctrl+l:add to chat | ..."
```

Narrow / short handling (all verified):
- `SHORT_TERMINAL_ROWS = 16`: at or below, the CTA, follow-ups, banner/tip rows and bottom padding are dropped.
- `AUTO_COMPACT_MAX_ROWS = 20`: forced compact (less vertical padding); `effective_compact()` never writes back to config, so growing the window restores the user's choice.
- Scrollback is the only `Min`, so on over-commit another row shrinks first.
- Turn status: phase timer hidden when width `< PHASE_TIMER_MIN_WIDTH = 60`; label is truncated with `…` to `available_for_label`; the right cluster (turn timer, tokens, `[stop]`) is never truncated. Rows `< 10` columns render nothing.
- Dock rows: if the meta column does not fit, it degrades to just `[stop]`, then truncates.
- Shortcuts bar: `compute_effective_hints` with `compact(max_visible, help_hint)`; **pinned** hints always survive, the rest fill remaining slots, the "all shortcuts" hint is always appended.

### 2.2 The elements in your screenshot, and where each is implemented

| Screenshot element | File / symbol |
|---|---|
| Header `/mnt/c   30K / 256K \| [Dashboard]` | `pager/app/agent_view/render.rs` ~1290-1500 (`AgentStatusBar` pushes `"context"`, `"switcher"`, `"dashboard"` items; location path + git branch laid out left of them using `left_budget`). Layout slot `status_bar` in [`views/agent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/agent.rs). Items are right-aligned with a faint `│` separator (`views/agent_status.rs:separator`, `context_bar::SEPARATOR`). `[Dashboard]` literal at `render.rs:1357`. Context text from `views/context_bar.rs::context_bar_line_for_session`. |
| `30K / 256K` | `context_bar::fmt_tokens`: `<1000` raw, `<10k` `1.2K`, `<1M` `12K`/`999K`, `<10M` `1.2M`, else `12M`. Colour ramp via `default_breakpoints`: 0% `text_primary`, 50-65% `accent_user`, 75-85% `warning`, 95% `accent_error`, linearly blended and quantised to the terminal's colour level. Hover swaps in a bar `█████ 42.0%` of identical width (no layout shift). |
| User message in a shaded full-width block, right-aligned timestamp | `scrollback/blocks/user.rs::UserPromptBlock` (`background()` returns `prompt.bg = BlockBackground::Light`, `vpad: true`, prefix `❯ ` from `glyphs::prompt_arrow`). Timestamp overlay in [`scrollback/wrappers/entry_renderer.rs:810-840`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L810-L840). |
| Assistant paragraphs with timestamps | [`scrollback/blocks/agent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/agent.rs) + `markdown_content.rs`; same timestamp overlay (message blocks reserve the right 10 columns, `timestamp_reserved`, so text wraps before the stamp). |
| `◆ Subagent completed in 20s: “Map frontend project”` | `scrollback/blocks/subagent.rs::SubagentBlock` (`SubagentBlockKind::Completed`). |
| `◆ Subagent running: “Map mobile project” · Running: List \`/mnt/c\` (grok-4.7)` | same file, `Started` arm: `"Subagent "` bold + `"running: "` + quoted description + `" · {activity_label}"` + `format_subagent_meta` => ` (persona, role, model)`. Activity label from `app/subagent.rs::format_activity_label` (`Running: {title}` clamped to 40 chars, or `{description}…`). |
| Live footer `⠋ Map Expo app project + 4 more… 1m51s   4m13s ↓30.5k [stop]` | `pager/views/turn_status.rs::render_turn_status`. Left: spinner + activity label (`Map Expo app project + 4 more…` is `format_waiting_for_subject(desc)` for a subagent wait; the "+ N more" is built in `app/agent_view/session.rs` near line 1880) + phase timer `1m51s`. Right: turn timer `4m13s` + `⇣30.5k` (`glyphs::token_arrow`, `format_tokens_short`) + `[stop]` (gray, red on hover). |
| Collapsible `▼ Subagents 1` | `pager/views/dock/mod.rs`: `Section::Subagents`, `section_header` => `" " + ▾/▸ + " " + bold(label) + " " + count`; glyphs `glyphs::disclosure_open() = ▾ (U+25BE)` / `disclosure_closed() = ▸`. (The screenshot's `▼` is the font's rendering of the disclosure glyph.) Rows: `paint_row`. |
| Bordered input `› Build anything`, model + mode on the bottom border | `pager/views/prompt_widget/mod.rs`: placeholder `"Build anything"` (line 3344), top divider `╭─╮` (3049), side `│` (3352), bottom divider `╰─╯` (3373), info line `render_info_line` (3520) writes `model_name · flag · flag` right-aligned on the bottom border, flags like `always-approve` (`PromptFlag`, line 291), `multiline` indicator on the far right. Prompt prefix is `❯ ` (`glyphs::prompt_arrow`), your screenshot shows a `›`-like glyph from the font. |
| `Grok 4.7 (low) · always-approve` | model name + `(reasoning_effort)` from `session.models`; the minimal-mode twin is `minimal/live.rs::render_prompt_info`: `{model} ({effort}) · plan|always-approve|auto · 8K / 256K (3%) · queued · /transcript`, separator ` · ` dim, `always-approve` coloured `theme.warning`, `plan` `accent_plan`, `auto` `accent_system`. |
| Hint bar `→:expand \| Enter:open \| Ctrl+l:add to chat \| Ctrl+e:expand thinking \| Ctrl+x:shortcuts` | `views/shortcuts_bar.rs::ShortcutsBar`; hints are built per focus context in `app/agent_view/render.rs::normal_pane_hints` (line 340). Format: `{key}:{label}` with key bold `text_secondary`, `:` and label dim, items separated by `"  │  "` (5 columns, dim). Pending double-press replaces the whole bar with `Ctrl+c:press again to quit`. |

---

## 3. Transcript cells and their exact visual format

Common rules (verified):
- Every cell is a `BlockContent` ([`scrollback/block.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/block.rs)) that returns `BlockOutput { lines }`, plus `accent()` (left rail colour), `bullet()` (the `◆` colour), `background()`, `default_display_mode()` (`Collapsed | Truncated | Expanded`).
- Default bullet is `◆` (`ToolBullet::Diamond`, `glyphs::diamond_filled`, ASCII fallback `♦`). Collapsed groupable bullets are dimmed to `dim_accent`; running bullets pulse; selected bullets are full brightness.
- Durations use `render/util.rs::format_duration`: `<10s` => `3.2s`; `<60s` => `20s`; `<1h` => `1m51s`; else `2h5m`.

### 3.1 User block
- Prefix `❯ ` (2 cols), whole block on `bg_light` (GrokNight `#242424`), 1 blank padded row above and below (`vpad`), right-aligned dim timestamp on the first row.
- Timestamp: short `  4:13 PM` (`%-I:%M %p`); on mouse hover over the right 10 columns it expands to `  16:13:07 | Nov 09` (`%H:%M:%S | %b %d`). Toggle with `/timestamps`.
- Folding: more than 3 visual lines collapses to 3 plus `…`; `bash` prompts (`!cmd`) and cron/interjection variants have their own prefix colours (`PromptInputMode::prefix_override`).
- Skill invocations highlight the `/skill` token (`skill_token_ranges`).

### 3.2 Assistant text and markdown (crate `xai-grok-markdown`, 19k lines)
- Streaming, checkpoint-based: `StreamingMarkdownRenderer` freezes everything before a stable boundary and re-renders only the tail (`checkpoint.rs`), so cost per token is bounded. `MarkdownContent::push_chunk_deferred` batches chunks.
- "Pretty" mode hides syntax markers: `**`, `*`, `` ` ``, fences, `#` are styled via `heading_outer`/`strong_outer`/`inline_code_outer` = `fg(..).dimmed().hidden()` (hidden = not drawn but kept for selection/copy mapping) (`render/theme/md_style.rs`).
- Styles (GrokNight): H1 teal bold `#1abc9c`, H2 blue bold `#7aa2f7`, H3 purple bold `#9d7cd8`, H4 `#787878` bold, H5 `#6c6c6c` bold, H6 `#5a5a5a`; inline code `#3A95AB` **bold**; link text `#7aa6da` underlined; quote `│ ` prefix dim; list items muted bullets; tables use box chars (`TableBorders::BOX = ─│┌┐└┘┬┴├┤┼`); task list checked green `#9ece6a`, unchecked dim; LaTeX approximated to Unicode (`E=mc²`); `mermaid` fences rendered as diagrams.
- **Code blocks**: fences hidden, body painted on `md_code_bg` (`#1c1c1c`) full block width, syntax colours from syntect with `grok-night.tmTheme` / `grok-day.tmTheme` (`render/syntax.rs`); language label style `md_heading_h3` is defined but `hidden`. Under the terminal-native lock tokens are remapped to `Reset` (near-gray) or base ANSI-16 hues (`polarity_safe_syntax_fg`).
- Links: OSC 8 hyperlinks ([`render/osc8.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/osc8.rs), `xai-grok-markdown/hyperlinks.rs`).

### 3.3 Thinking / reasoning (verified: [`scrollback/blocks/thinking.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs))
- Header while streaming: `Thinking…` (bold muted); after: `Thought for 4.2s` (`<60s` one decimal; else `{m}m{s}s`; note: its own `format_time`, not `format_duration`).
- Three display modes: **Collapsed** = header only; **Truncated** (default while streaming) = `…` then the **last 3 lines** (`truncated_lines = 3`); **Expanded** = all.
- Body is rendered with the colours blended 70% toward background (`bg_blend 0.7`), plus in minimal mode `DIM | ITALIC` (`body_dim_italic`) and a `┃ ` rail under the header's bullet (`rail_under_bullet`). Fullscreen uses an animated left accent rail (`animate: true`, travelling wave) while running.
- Toggle: `Ctrl+E` expands/collapses all thinking blocks (fullscreen: scrollback focus `Ctrl+E`; hint bar item "Ctrl+e:expand thinking"); minimal mode appends a dim `  (ctrl+e to expand)` to the collapsed header only if it fits on the row. Config `minimal_collapse_thinking`.
- Consecutive collapsed thoughts fold into the neighbouring verb group and add nothing to its label.

### 3.4 Tool calls (verified: `scrollback/blocks/tool/*.rs`)
Header shape: `◆ {Verb} {object} {dim detail}`; verb bold (muted when collapsed, primary when expanded/selected), object coloured (`path` orange `#ff9e64`, `command` yellow `#e0af68`), details in `gray_dim`.

| Tool | Collapsed header | Expanded body | File |
|---|---|---|---|
| Shell (`Execute`) | `Run {description}` (description-first) or `Run {cmd}`; `$ {cmd}` when `header_style = Shell`; user `!cmd` shows `Run (user) {cmd}`. `$ ` is dim, command is bash-highlighted (`tasks_pane::highlight_bash_command`). Default style is **Label** ("Run"). | blank row, then stdout/stderr on `bg_dark` (`#1c1c1c`) panel; truncated mode shows **first 2** lines, a dim `… +N lines` row, **last 3** lines (`ExecuteConfig { first_lines: 2, last_lines: 3 }`, `execute.rs:552`); errors in `accent_error`. Output is parsed as terminal text ([`render/terminal_output.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/terminal_output.rs), SGR preserved). Accent rail: running = animated, error = red, success = green. | [`tool/execute.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/execute.rs) |
| Read | `Read {path} ({range})` e.g. `(1-50)`, `(3 of 40)`, `(N pages)` for PDF; SKILL.md reads show `Skill {name}` | line-number gutter `{:>w}  ` + syntax-highlighted lines | [`tool/read.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/read.rs) |
| Search (grep/glob) | `Search "{pattern}" in {path} (N matches)` / `(N matches in M files)` / `(N files)` | per-file groups, `{:>4}` line numbers, `(no results)` | [`tool/search.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/search.rs) |
| List dir | `List {path} (N entries)` | indented entries | [`tool/list_dir.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/list_dir.rs) |
| Edit/Write | `Edit {path} +A/-D` (green `+`, red `-`) or `(N edits)`; "Creating"/"Editing workflow" variants | diff (see 3.5) | [`tool/edit.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs) |
| Web fetch | `Fetch {url}` + `status:`, `content_type:`, `size:` | content preview | [`tool/web_fetch.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/web_fetch.rs) |
| Web search | `Web Search {query} (N sites)` | `Sources: a, b (+N more)` | [`tool/web_search.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/web_search.rs) |
| MCP | `Search Tools ...`, `use_tool` rows | | `search_tool.rs`, `use_tool.rs` |
| Memory | `Memory Search ...` | | `memory_search.rs` |

**Durations are not printed per tool block.** `ExecuteToolCallBlock` tracks `elapsed_ms` (`execute.rs:30-111`) but the header does not show it; time appears in the live turn status (phase timer), `Thought for Xs`, `Subagent completed in Xs`, and the `Worked for 2m5s` turn marker (`session_event.rs:379`). Adding per-tool durations is therefore a place where HorizonCode can go beyond Grok.

**Verb groups** ([`scrollback/state/verb_group.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/state/verb_group.rs), `tool/mod.rs:VerbGroupKind`): a run of consecutive collapsed read-only tools (and subagent rows) folds into one header label, present tense while running, past when done:
`Reading/Read N files`, `Searching/Searched N patterns`, `Listing/Listed N dirs`, `Fetching/Fetched N websites`, `Running/Ran N subagents|commands|tools`, `Calling/Called N MCP tools`, `Editing/Edited N files`, `Sending/Sent N messages`; labels combine ("Read 10 files, Ran 2 subagents"). Commands/edits never fold eagerly. Live label repaints every tick so counts update in place.

### 3.5 Diffs (verified: [`tool/edit.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs), GrokNight theme)
- Gutter with old/new line numbers (`{:>w_old$}` `{:>w_new$}`, dual-column in "dual" mode, single in unified), hunk separators like `⋯ 3 unchanged lines` (`hunk_separator` + `format!("{} {n} unchanged lines")`).
- Insert rows on `diff_insert_bg #063806` with fg `#9ece6a`; delete rows on `diff_delete_bg #420e14` with fg `#f7768e`; equal rows `#6c6c6c`. Intra-line word highlighting and syntect syntax colouring on the changed lines; highlighting is computed off-thread (`app/edit_highlight_worker.rs`).
- Light theme: insert bg `#DAF2DC`, delete bg `#F5DADE`.

### 3.6 Errors, session events
- Tool error: accent rail and bullet `accent_error` (`#f7768e`), message lines in `accent_error`.
- Session events are single dim lines: `Worked for 2m5s`, `Turn cancelled by user in 10s.`, `Turn completed.`, `/goal` completion, `Recap`, reconnect notices (`session_event.rs`).
- Retry state in the live row: `Style fg warning`, label from `error_display::format_retry_activity_label`.

### 3.7 Permission / approval prompts ([`views/permission_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/permission_view.rs))
- Card with a title (`Allow command?`), the command (collapsed to **4 rows** with a `... Ctrl-F to expand` indicator, `PERMISSION_COLLAPSED_ROWS`), then radio rows: `(●) Yes, proceed` (cursor, bold) / `(○) Yes, and don't ask again for ...` / `(○) No`, each with number shortcuts `1-9`.
- Keys: `↑↓/jk`, `Tab` loop, `1-9`, `Enter`, `←/→` widen/narrow the scope an "always" would remember, `e` edit the pattern, `Ctrl+F` expand args, `Ctrl+O` always-approve, `Esc` parks focus (never answers), `Ctrl+C` cancels. Typing on the "No" row starts a message back to the agent.
- Pending prompts hold the commit frontier in minimal mode and show a **pulsing diamond** `◆` (`pending_diamond_color`).
- `ask_user_question` card: numbered/lettered answers, multi-select with Space, free-text row `z`.

### 3.8 Subagent cells
- Transcript row (single line, `SubagentBlock`):
  - blocking: `◆ Subagent running: “desc”` with an animated bullet; turns green/red on finish.
  - background: `◆ Subagent started: “desc”` stays (bullet goes gray) and a **separate** row is appended when done: `◆ Subagent completed in 43s: “desc”` (green bullet), `failed in 12s (error): “desc”` (red), `cancelled in 5s: “desc”` (red).
  - Description is clamped with `quoted_desc` (curly quotes `“ ”`, `…` if too narrow). Activity suffix `" · {activity}"` and meta `" ({persona}, {role}, {model})"` are included in the width budget. Label `Subagent` is bold; everything else muted; the label lifts to primary when selected.
  - Always collapsed, `Enter`/`Ctrl+F` opens a fullscreen framed view of the child transcript (`subagent_takeover.rs`).
- Live dock (flag `dock_enabled`) groups Workflows / Subagents / Tasks / Watchers / Queued, max 8 rows (`MAX_DOCK_ROWS`), each section a header `▾ Subagents N`, rows: `{dot-spinner} subagent {description} - {activity}` left, meta right (`grok-4.5 2m14s`), `[↗]` open and `[stop]` appear on hover/selection; overflow row `▸ show N more`.
- Idle-with-background-work cue in the turn status row: a pulsing `○ ◎ ◉ ◎` monitor icon + `N subagents running` (`still_running_label`).

### 3.9 Plan / todo display
- Todo pane: `□` pending (primary), `▶` in progress (warning, bold), `✓` completed (muted), `✗` cancelled (muted, crossed out); content clamped to 64 chars; overflow row `… +N more · ctrl+t to expand`; auto-hides when all done unless pinned with `Ctrl+T`; cap 8 rows (`minimal/todo.rs`).
- Plan mode: prompt border and prefix switch to `accent_plan` (`#FFDB8D`), prompt prefix `●`, placeholders `Type your comment...` / `Type revision notes...`; plan approval card [`views/plan_approval_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/plan_approval_view.rs); `plan` flag in the info line.

---

## 4. Animation

| Effect | Where | Parameters |
|---|---|---|
| Braille spinner | `render/glyphs.rs::braille_spinner_frames` | 8 frames `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧`; `SPINNER_DIVISOR = 4` ticks => 133 ms/frame = **7.5 fps** (deliberately slower than the 30 fps clock). ASCII fallback `\| / - \`. |
| Dot spinner (dock rows) | `dot_spinner_frames` | `⋅ : ⸬ ⁙` x2, same divisor |
| Idle watcher pulse | `monitor_icon_frames` | `○ ◎ ◉ ◎`, `MONITOR_PULSE_DIVISOR = 8` => 3.75 fps |
| Running bullet / rail wave | `render/theme/tokyonight.rs::wave_brightness(tick,row,wave_rows,speed)` | `sin²(tick*speed + row/wave_rows*2π)`, `WAVE_SPEED = 0.15`, `wave_rows = 32`; colour = `blend(bg, accent, brightness)`; a travelling brightness wave down the left rail, bullet synced |
| "Waiting on you" diamond | `pulse_brightness(tick, 0.08)` + `turn_status::pending_diamond_color` | `blend(bg, accent_user, 0.3 + 0.7*sin²(tick*0.08))` => full cycle ~1.3 s at 30 fps; routed through ONE function so the three call sites cannot drift |
| Welcome logo shimmer | [`views/welcome/logo.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/welcome/logo.rs) | ~12 fps (`SHIMMER_FPS`) via `TickDemand::Slow`; **there is no text shimmer on the turn-status label** |
| Elapsed timers | `turn_status.rs`, `util::format_duration` | phase timer `Xs` next to the label (hidden `<60` cols), turn timer `Xm Ys` right-aligned, plus `⇣{tokens}` (`format_tokens_short`: `<1000` raw, `1.23k`, `10.1k`, `100k`, `1.23m`) |
| Token counter | `context_bar.rs` + turn status | header `used / total` live, footer `⇣` = current context tokens (not a streaming rate) |
| Welcome toast | `WELCOME_TOAST_DURATION = 2s` | wall-clock based so it holds across Slow/Fast ticking |

What makes it feel smooth (verified): one shared tick, animation only when something is visibly animating, glyph frames that are always 1 column so labels never shift, colour *blending* (not on/off) for pulses, debounced resize, synchronized output, and "slower than the frame rate" spinner pacing.

---

## 5. Theme

### 5.1 Palette (verified: `render/theme/groknight.rs`, default theme)
Backgrounds: `bg_base #141414`, `bg_terminal #0a0a0a`, `bg_light`/`bg_highlight #242424`, `bg_dark #1c1c1c` (code/output panels), `bg_hover #2c2c2c`, `bg_visual #363636`, `paste_bg #111111`.
Text: `text_primary #e1e1e1`, `text_secondary #c8c8c8`, `gray_bright #787878`, `gray #6c6c6c`, `gray_dim #585858`.
Accents (TokyoNight Night): blue `#7aa2f7` (system/skill/H2), magenta `#bb9af7` (assistant, thinking, **running**), green `#9ece6a` (success), red `#f7768e` (error), yellow `#e0af68` (command, warning), orange `#ff9e64` (path), cyan `#7dcfff` (running label), teal `#1abc9c` (H1, model), purple `#9d7cd8` (H3), plan gold `#FFDB8D`, remember `#8BC34A`.
Chrome: `prompt_border #323237`, `prompt_border_active #505058`, `selection_border #3c3c41`, `hover_border #1e1e22`, scrollbar fg `#242424` on `#111111`.
Links `#7aa6da`. Diff: see 3.5.

Other themes: GrokDay (light: bg `#eeeeee`, fg `#262626`, blue `#2F64D2`, green `#378E23`, red `#CD3048`, magenta `#7D4BC6`, yellow `#A27612`, orange `#C3691E`), TokyoNight, RosePineMoon, OscuraMidnight (truecolor-only character), **Terminal** (all `Reset` + ANSI-16, no backgrounds; secondary text = `Reset` + `Modifier::DIM`, messages render bold instead of on a band, selection = reverse video, decoration = ANSI bright-black).

### 5.2 Degradation ladder (verified: `render/theme/color_support.rs`)
`ColorLevel::{None, Basic, Ansi256, TrueColor}`.
- `NO_COLOR` set => `None` (every colour becomes `Color::Reset`; modifiers like bold/dim still apply, which is why chrome uses `DIM` rather than colour alone).
- Otherwise `supports-color` => 16m / 256 / basic; non-TTY defaults to truecolor (a TUI always has a TTY).
- Upgrade 256 => truecolor when the terminal brand is known to support it even though `COLORTERM` was stripped (tmux/ssh): iTerm2, Ghostty, Kitty, WezTerm, Alacritty, Rio, Warp, VS Code, Windows Terminal, Foot, or any Windows.
- `quantize_color`: `Rgb -> Indexed(nearest_indexed(r,g,b))` for 256; `Rgb/Indexed -> indexed_to_ansi16` for basic (16-entry nearest-distance table, with the named ANSI colours); `None -> Reset`.
- Terminal-native lock caps at `Basic` (minimal mode and the Terminal theme).
- The GrokNight palette is designed to "survive quantization": e.g. `RED_DARK #420e14` is chosen so it maps to a 256-colour red, not gray. The docs flag TokyoNight/Rose Pine/Oscura as "loses its character when quantized".

### 5.3 Light / dark
- `theme = "auto"` follows OS appearance (`system_appearance.rs`, `env_appearance.rs`, a live `SystemAppearanceWatcher`), mapping dark => GrokNight, light => GrokDay (overridable via `auto_dark_theme`/`auto_light_theme`).
- Startup fallback: OSC 11 query (`ESC]11;?BEL`), luminance `<0.5` = dark.
- They explicitly distrust polarity detection ("OS appearance and OSC 11 both disagree with the actual canvas in edge cases"), which is why minimal/Terminal theme exists: no assumption, `Reset` + ANSI-16 only.

---

## 6. Input

Implemented across `xai-ratatui-textarea` (editor core), [`views/prompt_widget/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/prompt_widget/mod.rs) (9.4k lines), [`views/slash_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs), [`views/completion_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/completion_dropdown.rs), `views/file_search/`.

- **Editor core** (`textarea/src/editor.rs`, `editor_keys.rs`): grapheme-aware, word styles, undo/redo, emacs bindings (`Ctrl+A/E/B/F/P/N/K/U/W/Y`, `Home/End`, `Alt+←/→`), visual-row up/down on soft-wrapped lines, **atomic ranges** (a chip like `[Pasted: 12 lines]` or `@file` is a single cursor stop and deletes as a unit).
- **Multiline**: `Ctrl+M` toggles multiline mode (then `Enter` = newline, `Shift+Enter`/`Alt+Enter` sends); in normal mode `Shift+Enter` inserts a newline; the info line shows `multiline` on the border. `Ctrl+G` edits the draft in `$VISUAL`/`$EDITOR`.
- **History**: Up/Down browse, `Ctrl+R` history search ([`views/history_search.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/history_search.rs)), durable across quit (`prompt_history_durable_quit.rs` test).
- **Stash**: `Ctrl+S` stashes/pops the draft like `git stash`; double `Esc` (within 800 ms) clears and stashes; `Ctrl+Z` right after restores.
- **Paste**: bracketed paste, 2 ms burst coalescing as fallback; large pastes become chips `[Pasted: N lines]` / `[Pasted: 12 KB]`; images become `[Image #N]` chips; `Ctrl+Shift+V` inserts inline without a chip; `Ctrl+V` pastes files/screenshots (macOS/Linux; `Alt+V` on Windows).
- **Slash completion** (`slash_dropdown.rs`): dropdown above/below the prompt, max **8 visible rows** (`MAX_VISIBLE_SUGGESTIONS`), label column capped at 40 chars and ~60% of width, 2-space gap, description wrapped/truncated, optional ` [tag]` suffix, selected row `bg_visual` + bold, hover 25% blend, scrollbar beyond 8, prefix `❯ ` on the selected row.
- **`@` file mentions** (`completion_dropdown.rs`, `file_search/`): max **6 rows**, fuzzy matching (`fuzzy_accent`), renders as `@path` with `@`/`:` gray, path in `theme.path`, line range digits primary (`@foo/bar.rs:10-12`); a line viewer previews the file.
- **`!` bash mode**: `!` on an empty prompt flips the prompt prefix/placeholder (`PromptInputMode`).
- **Key policy**: `Esc` never cancels a running turn (shows a "Press Ctrl+c" toast); `Ctrl+C` clears a non-empty draft first, cancels when empty; mid-turn `Ctrl+Enter`/`Ctrl+I`(`Ctrl+L` on VS Code family) = interject; `Ctrl+P`/`?` command palette; `Ctrl+X` or `Ctrl+.` shortcut cheat sheet; terminal-specific rebinding table (VS Code family, Apple Terminal, tmux, Windows).
- The prompt hint bar shows context keys; double-press actions show `press again to quit`.

---

## 7. Minimal mode and the PTY test harness

### 7.1 Minimal mode (verified: `xai-grok-pager-minimal/src`)
Wiring: the pager lib cannot depend on this crate (cycle), so the binary calls `minimal::install()` which registers `draw` as a function-pointer hook (`pager::minimal_hook`).
Per frame (`lib.rs::draw`): adopt terminal size -> `BeginSynchronizedUpdate` -> sync pending marks -> `reprint::maybe_reprint` -> pump `/transcript` build -> welcome card commit -> plan commit -> `overlay::sync_viewport` (grows/shrinks the viewport for dropdowns) -> `commit::commit_active` (print finalized blocks) -> `commit::expand_pending` -> `live::draw_live`.
Live region layout (top to bottom): **live tail**, todos, `/btw`, **status row**, **prompt**, overlay/info row, user status-line row. Idle status row text: `minimal · /fullscreen to go back · /help`. Running: the same `render_turn_status` as fullscreen but `flat_background: true` and no mouse buttons (`[stop]`, `[↓]` suppressed on keyboard-only hosts).
Prompt info row: `{model} ({effort}) · {plan|always-approve|auto} · {used} / {total} ({pct}%) · {n} queued · /queue · ctrl+o transcript`.
Extra mechanisms: `/transcript` pager for full history, `full_view.rs`, `auth.rs` in-region sign-in, `feedback.rs` form over the live band, `panel.rs`, `overlay.rs` (prompt-anchored dropdowns).
Minimal-mode guardrails: no theme (terminal palette), `body_dim_italic` for reasoning, `rail_under_bullet`, `collapsed_expand_hint`, `MINIMAL_BLOCK_GAP = 0`.

### 7.2 PTY harness (verified: `xai-grok-pager-pty-harness`)
Layers (`lib.rs` docs):
1. `pty.rs`: spawn the **real binary** in a PTY (`portable_pty`), inject raw key bytes (`keys::ENTER = "\r"`, `UP = "\x1b[A"`, `CTRL_C = "\x03"`, `F2 = "\x1bOQ"`), resize, drain.
2. `screen.rs`: feed all PTY output through a headless `alacritty_terminal` emulator (via `ptyctl`) and query "what the user would see": text, styled lines, cursor. Terminal replies (cursor-position reports, device attributes, colour queries) are drained and **written back** to the child, otherwise startup probes hang (a missed CPR query downgrades `--minimal`).
3. `timing.rs`: a `vte` parser over the stream detects `?2026 h/l` frame markers => per-frame duration and printed-char counts.
4. `content.rs`: a **mock inference server** with scripted SSE responses (`ScriptedResponse`, `SseEvent`), so the real agent loop drives real content.
5. `scenarios/`: named workloads (`streaming_render`, `large_codeblock`, `resize_storm`, `scroll_stress`, `idle_cost`, `mixed_interaction`, `plan_approval_resume`, `x10_mouse_leak`); `results.rs` aggregates and compares against baselines ([`benches/pty_bench.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/benches/pty_bench.rs)).
6. `tests/pty_e2e_*.rs`: smoke, minimal, queue, persistence, shell tools, clipboard, scroll+selection, config UI; `scripted_scenarios.rs` + YAML under `tests/scenarios/`.
Plus unit-level: `ratatui::buffer::Buffer`-based render tests (`buffer_text`), 100+ `insta` snapshots (`*.snap`, e.g. diff variants in `scrollback/blocks/tool/snapshots/`), and a `#![deny(clippy::indexing_slicing)]` policy.

---

## 8. Other notably polished things

- **Legacy-console fallback** for every glyph, same width (see 1.4).
- **Cursor and color quantisation of animations**: pulses blend in RGB, then `quantize()` is applied at the end so 256/16-colour terminals get the nearest step, not garbage.
- **Context bar hover** swaps tokens for a progress bar of equal width.
- **Sticky headers** ([`scrollback/sticky.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/sticky.rs)): pinned/pushed user prompts at top while scrolling; **timeline rail** ([`state/timeline.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/state/timeline.rs)) replacing the scrollbar.
- **Selection model** that excludes decoration (bullets, gutters, prefixes via `Selectable::Spans`), `joiner` metadata so copied soft-wrapped text rejoins correctly.
- **OSC 8 hyperlinks** with clickable file paths (`hyperlink_route.rs`, `location_path.rs`).
- **Inline images/video** (kitty/iTerm protocols), mermaid diagram rendering.
- **Double-press confirmations** with a visible countdown hint, **toasts** with width fitting (`fit_toast_text`).
- **Writer thread + stall detector** so a blocked terminal never freezes input.
- **Tips** (`pager/tips/`), **welcome card** with logo shimmer, **`/tutorial`**, **`/doctor`** terminal diagnostics.
- **Status line scripts**: user-defined row (`[ui.status_line]`) that runs a command and renders its output, sized via `COLUMNS/LINES`.

---

## 9. HorizonCode current state (what exists on `feat/tui-polish`)

Verified from `app/src/tui/`:
- `style.ts`: 6 SGR helpers (`bold dim cyan green yellow red`), `colorEnabled()` (NO_COLOR, `TERM=dumb|unknown`, `FORCE_COLOR`, isTTY), `strip`, `visibleWidth` (**counts code points, not display columns**: CJK/emoji will misalign), `truncate`, `wrapText`, `terminalWidth`, `sanitizeText`.
- `live.ts` (new): `liveEnabled()` (TTY + colour), `spinnerLine` = `cyan(frame) + " " + verb + "… " + dim("4s · esc to cancel")`, 10 braille frames at `FRAME_MS = 90` (11 fps), `toolVerb(name,args)` (Reading/Editing/Searching/Globbing/Running shell/Running subagent/...), `composeStatusBar` (mode · model · provider · `◑ 12%` · path · `⑂ branch`, drops path, provider, branch, ctx in that order), `userBlock` (BG `48;5;236` space-padded full width + right-aligned dim `HH:MM`), `turnFooter` (`· 12.4s · 3 tools · ↑1.2k tok` + right time), `createLive` (single in-place spinner line using `\r\x1b[2K`, status printed once as a *transcript* line above the prompt via `showIdle()`, erased in `renderer.beforeWrite`, steps aside while typing or while a question is open).
- `render.ts`: tool cards `⏺ name(compact args)` / `  └ ok: summary` (or `error`), args wrap one-per-line when too long, nested subagent lines `  │ ...` capped at 30 per agent, `turn.diff` as `· changed N files` + `+green/-red/@@cyan` lines (cap 40), notices `· msg` dim, errors `⚠ msg` red. Assistant text is written **raw as it streams** (no markdown).
- `approval.ts`: `⚠ Approve {title}? {detail}` then `[y]es / [n]o / [a]lways ❯ ` read as a line via `ui.ask`.
- `interactive.ts`: `readline.createInterface({terminal:true, historySize, removeHistoryDuplicates})`, file-backed history (owner-only), slash commands (`/help /new /files /context /changes /apply /discard /sessions /memory /init /exit` etc.), **no `completer`**, Esc cancels via a `keypress` listener, messages typed mid-turn are queued.
- `RuntimeEvent` has **no thinking event** and **no subagent start/end event** (`contracts.ts:545-578`); `tool.card` carries only `summary?: string`.

Constraints to respect: zero runtime deps, raw ANSI, Bun, readline owns the prompt line, live elements TTY-only, non-TTY output byte-identical.

---

## 10. TUI PART 2 SPEC for HorizonCode

### 10.0 Design principles (distilled from Grok)
1. **Everything fancy is gated by one predicate**, `rich = liveEnabled()` (TTY + colour + not dumb). When `rich` is false, `render.ts` keeps its exact current byte output. Add a golden test that pipes a fixed event script through the renderer with `rich=false` and compares to a saved fixture before and after the change.
2. **One clock, on only while something animates** (Grok `TickDemand`). Already true for `createLive`; keep it (`setInterval` + `unref`, cleared at turn end).
3. **Wrap every live frame in DEC 2026** (`\x1b[?2026h` ... `\x1b[?2026l`), skip when `TMUX` is set and `TERM_PROGRAM` is not an embedded editor (Grok rule). Unsupporting terminals ignore the sequence.
4. **Commit once, never edit scrollback.** A transcript line is written only when final. Anything still changing lives in the live region (which is erased before every transcript write; this is already the HorizonCode design and is the same idea as Grok's commit frontier).
5. **Frames of constant width** (spinner glyphs 1 column, labels truncated with `…`, the right cluster never truncated, drop order defined) so nothing jitters.
6. **Colour is a role table with a fallback ladder**, never raw SGR in callers.
7. **Width correctness**: replace `visibleWidth` with a display-width function (see P0-3).

### 10.1 Feasibility summary: Grok techniques vs HorizonCode's raw-ANSI + readline

| Grok technique | Feasible on readline + raw ANSI? | Notes |
|---|---|---|
| Synchronized output (2026) | **Yes** | Pure escape sequence around each frame. |
| Pulsing/blended colours, truecolor->256->16 ladder | **Yes** | Pure functions; needs `rgb` blend + quantiser (small). |
| Braille spinner, elapsed timer, token counter, right-aligned cluster | **Yes** (already mostly there) | |
| Single-line live footer | **Yes** (exists) | |
| Multi-line live region above the prompt *while a turn runs* | **Yes** | While busy, `rl.setPrompt("")` and the cursor sits on the last live line; redraw with `ESC[{n-1}A \r ESC[J` then write n lines. Erase before any transcript write (existing `beforeWrite` hook). |
| Verb groups / folded runs | **Partly** | Folding history rewrites already-printed lines: impossible in scrollback. Do the folding **at commit time** (buffer consecutive quick read-only cards, emit one `Read 3 files` line when a non-group event arrives or the turn ends). |
| Per-line background panels (user block, code, shell output) | **Yes** | Use bg + `ESC[K` (erase-to-EOL fills with the bg colour on BCE terminals, resize-friendly) with a space-padding fallback. |
| Streaming markdown with code blocks | **Yes**, line-buffered | Stateful line renderer (10.3 P1-1). Cannot restyle an already-printed partial line, so hold partial lines up to ~150 ms, then flush raw. |
| Syntax highlighting | **Yes, minimal** | Hand-rolled tokenizer for a few languages (js/ts/py/sh/json/diff) with 6 colours; no dependency. Full syntect parity is not worth it. |
| Thinking display | **Only with a contract change** | No `assistant.thinking` RuntimeEvent. |
| Slash completion | **Tab completion + ghost text: yes. A popup dropdown: fragile** | readline's `_refreshLine` runs `clearScreenDown` on edits (backspace, history, wrap), wiping anything drawn below the prompt; every keypress would need a repaint hook. |
| Hint bar | **Yes, but above the prompt** | Anything below the prompt is wiped by readline refreshes. Put hints in the status line that already sits above the prompt. |
| Bordered input box with caption on the bottom border | **No (cleanly)** | Needs to own the line editor and the rows below the cursor. A top rule + `❯` prompt is possible; a real box is not. |
| `▾ Subagents` dock with `[stop]` mouse buttons | **Group yes, mouse no** | A non-interactive live group above the spinner is feasible. Clickable `[stop]` needs mouse reporting, which conflicts with terminal-native selection. Use `esc` or `/stop`. |
| Resize reprint of history | **No** (and unnecessary) | Terminal reflow handles text. Avoid trailing-space padding so reflow looks fine; erase the live region on `resize` (already done). |
| Fullscreen scrollback pane, sticky headers, timeline, mouse | **No** | Out of scope; this is what a fullscreen rewrite buys. |

### 10.2 Colour system (P0, foundation for everything else)

New in `app/src/tui/style.ts` (keep existing exports working):

```ts
export type ColorLevel = 0 | 1 | 2 | 3;   // 0 none, 1 basic16, 2 ansi256, 3 truecolor
export function detectColorLevel(env = process.env, isTTY = process.stdout.isTTY): ColorLevel
```
Detection order (first match wins):
1. `NO_COLOR` non-empty, or `TERM` in `{dumb, unknown}`, or `!isTTY` (without `FORCE_COLOR`) => **0**. (Keep current `detectColor()` semantics.)
2. `FORCE_COLOR`: `1` => 1, `2` => 2, `3` => 3, other non-zero => 1 (matches the common convention).
3. `COLORTERM` is `truecolor` or `24bit` => **3**.
4. `TERM_PROGRAM` in `{iTerm.app, WezTerm, ghostty, vscode}` or `WT_SESSION` set or `KITTY_WINDOW_ID` set or `TERM` contains `kitty|alacritty|foot|ghostty` => **3** (Grok's brand upgrade list; `Apple_Terminal` is **not** in it: it supports only 256).
5. `TERM` contains `256color` => **2**.
6. `TERM` matches `/^(xterm|screen|tmux|vt100|linux|ansi|rxvt)/` => **1**.
7. Otherwise **0**.
Cache the level; `setColorEnabled(false)` forces 0 (headless).

Role table (all values are `[r,g,b]`; produce the escape for the level):

| Role | Truecolor | 256 idx | 16 | Use |
|---|---|---|---|---|
| `accent` (brand/running) | `#bb9af7` | 141 | magenta (35) | spinner glyph, running bullet |
| `info` | `#7dcfff` | 117 | cyan (36) | `$` command word, running label |
| `ok` | `#9ece6a` | 149 | green (32) | success bullet, `+` lines |
| `err` | `#f7768e` | 211 | red (31) | errors, `-` lines |
| `warn` | `#e0af68` | 179 | yellow (33) | mode badge, `always`, ctx 75%+ |
| `path` | `#ff9e64` | 215 | yellow (33) | file paths |
| `text` | `#e1e1e1` | 253 | default fg | body |
| `muted` | `#6c6c6c` | 242 | dim (SGR 2) | secondary text |
| `faint` | `#585858` | 240 | dim (SGR 2) | `$`, separators |
| `link` | `#7aa6da` | 110 | blue (34) | URLs |
| `h1` / `h2` / `h3` | `#1abc9c` / `#7aa2f7` / `#9d7cd8` | 36 / 111 / 98 | cyan / blue / magenta | headings (bold) |
| `code` (inline) | `#3A95AB` | 37 | cyan (36) | inline code (bold) |
| `bgUser` | `#242424` | 235 | none | user block |
| `bgPanel` | `#1c1c1c` | 234 | none | code/shell output |
| `bgAdd` | `#063806` | 22 | none | diff insert rows |
| `bgDel` | `#420e14` | 52 | none | diff delete rows |

Rules for the ladder:
- Level 3: exact RGB (`38;2;r;g;b`, `48;2;r;g;b`). Level 2: the table's index (or compute `nearestIndexed` using the 6x6x6 cube `16 + 36r + 6g + b` with levels `[0,95,135,175,215,255]` plus the 24-step gray ramp `232..255`, whichever is closer by squared distance). Level 1: foreground uses the 16 column; **backgrounds are dropped** (no bg on basic16, because ANSI bg colours differ wildly per profile); use a `▌`-style left bar or bold instead (see 10.3 user block). Level 0: no escapes at all; today's plain forms.
- On level 1 use `dim`/`bold` modifiers (SGR 2/1) for de-emphasis instead of gray colours (Grok `Terminal` theme rule: never rely on bright-black for body text).
- Light terminals: read `COLORFGBG` (`fg;bg`, e.g. `0;15`): bg index `>= 7` and `!= 8` => light. Override with `HZ_THEME=light|dark`. On light: `bgUser #e4e4e4 (254)`, `bgPanel #ececec (255)`, `text` => default fg, `muted #767676`, `ok #378E23`, `err #CD3048`, `warn #A27612`, `accent #7D4BC6`, `info #0082AA`, `path #C3691E`, `bgAdd #DAF2DC (194)`, `bgDel #F5DADE (224)` (GrokDay values). If light/dark cannot be determined, prefer **no backgrounds** (use the left-bar variants), which is what Grok does for its polarity-safe theme.
- Blend helper for pulses: `blend(a,b,t)` in RGB, then quantise; at level < 3 skip animation and use the static accent (or alternate bold/dim at 2 Hz).

API sketch:
```ts
export const c = { accent: (s) => ..., ok, err, warn, info, path, muted, faint, link, ... };  // role helpers
export function bg(role, s, padTo?: number): string   // bg role with EL fill or space pad
export function blend(from: RGB, to: RGB, t: number): RGB
export function pulse(tick: number, speed = 0.08): number   // sin^2(tick*speed) in [0,1]
```
Keep `bold/dim/cyan/green/yellow/red` exported and implemented through the role table so existing callers and tests do not change; `cyan` => `info`, etc. (Verify no test pins the literal `\x1b[36m`; if one does, keep those helpers on raw SGR 3x for level 1+ and only add the new roles.)

### 10.3 Prioritised changes with exact target formats

Legend: **[T]** = TTY/rich only. Effort: S (<0.5 day), M (~1 day), L (2+ days).

#### P0-1. Display-width correctness and glyph ladder (S)
- Replace `visibleWidth` with a column-width function: strip ANSI, then for each code point: width 0 for combining marks (U+0300-036F), ZWJ/variation selectors (U+200B-200F, U+FE00-FE0F); width 2 for East Asian Wide/Fullwidth ranges (U+1100-115F, U+2E80-A4CF, U+AC00-D7A3, U+F900-FAFF, U+FE30-FE6F, U+FF00-FF60, U+FFE0-FFE6) and emoji (U+1F300-1FAFF); else 1. `truncate`/`wrapText` must use it. Add tests with CJK and emoji.
- Add `glyphs` object chosen once by `unicodeLocale()`: `bullet ◆ / *`, `ok ✓ / +`, `err ✗ / x`, `arrow ↳ / >`, `branch └ / \``, `rule ─ / -`, `ellipsis … / ...`, `tokens ⇣ / v`, spinner braille / `| / - \`. Grok fallback principle: every fallback is the same width.

#### P0-2. Live frame engine (M)  [T]
In `live.ts`:
- `frame(lines: string[])` writer: `sync(begin) + hideCursor? + eraseRegion(prevLines) + lines.join("\n") + sync(end)`. `eraseRegion(n)` = `"\r" + (n > 1 ? `\x1b[${n-1}A` : "") + "\x1b[J"`. Track `drawnLines`. `erase()` uses it, so the existing `beforeWrite` hook keeps working for multi-line.
- Hide the cursor (`\x1b[?25l`) while a turn animates and restore (`\x1b[?25h`) in `erase()` when idle, in `dispose()`, and in `process.on("exit")`/SIGINT/SIGTERM handlers (an un-restored hidden cursor is the classic polish bug).
- Frame period `FRAME_MS`: spinner glyph advances every **100 ms** (10 fps; Grok's 7.5 fps is also fine, do not go above ~12); elapsed text updates when the second changes; skip the write when the composed string equals the last frame (no-op frames cost nothing and cannot flicker).
- Colour pulse on the spinner glyph at level 3: `blend(bg-ish #141414, accent, 0.3 + 0.7*pulse(tick, 0.08))` where `tick` increments at 30 Hz of wall clock (`Math.floor((now-start)/33)`) so the pulse period (~1.3 s) is independent of the glyph rate. Level 1-2: static accent.
- Narrow ladder, applied to every footer composition, `W = terminalWidth() - 1`:
  1. `>= 80`: full.
  2. `< 80`: drop the cancel hint text (`esc to cancel`) -> keep `esc`.
  3. `< 60`: drop the phase timer (the per-tool time), keep total elapsed (Grok `PHASE_TIMER_MIN_WIDTH`).
  4. `< 40`: spinner + truncated label + total elapsed only.
  5. `< 24`: spinner only.
  The label is the only thing truncated (with `…`); the right cluster is never cut.
- Resize: on `resize` erase the region and redraw next tick (exists); debounce 16 ms.

#### P0-3. Footer content (S)  [T]
Target (busy, W=100):
```
⠹ Reading math.ts… 12s                                              1m51s ⇣31k  esc to stop
```
Format: `{pulse spinner} {verb+object}… {phase elapsed}` left; right-aligned `{turn elapsed} ⇣{input tokens}  {hint}`. Elapsed uses Grok's `format_duration`: `<10s` `3.2s`, `<60s` `20s`, `1m51s`, `2h5m`; tokens: `<1000` raw, `1.23k`, `10.1k`, `100k`, `1.23m`. Label colour: running tool = `info`, thinking/responding = `muted`, retry = `warn`, cancelling = `err`, pending approval = pulsing `warn` diamond `◆` instead of the spinner.
Phase labels (extend `toolVerb`): `Thinking`, `Responding` (after first delta), `Running shell: npm test` (first 40 chars of the command), `Editing x.ts`, `Reading x.ts`, `Searching "foo"`, `Listing src/`, `Fetching host`, `Waiting for subagent`, `Compacting` (if runtime emits a notice).

#### P1-1. Streaming markdown renderer for assistant text (L)  [T]
New `app/src/tui/markdown.ts`, pure and unit-testable: `createMarkdownStream(opts:{width,color,level}) => { push(chunk): string; end(): string }` returning ready-to-write text.
State machine, line-oriented. Buffer chunk text; when a `\n` arrives render that completed line and emit it; keep the trailing partial line pending. A `flushPartial()` timer (150 ms after the last delta) writes the pending partial as plain text **only if** the line cannot be an opening fence/heading/list (i.e. does not start with `` ` ``, `#`, `>`, `-`, `*`, digit): avoids a visible stall on prose without ever mis-styling a block opener. Streaming prose therefore appears with at most ~150 ms of extra latency and, for lines that start like block syntax, exactly at newline.
Rendering rules (fg role, modifiers):
- `# `..`###### ` heading: marker removed, text bold in `h1/h2/h3`, `h4+` bold `muted`; blank line before h1/h2 only if the previous emitted line was not blank.
- `**x**` bold, `*x*`/`_x_` italic (SGR 3, skip when level 0), `~~x~~` strike (SGR 9), `` `x` `` inline code in `code` role **bold**, no backticks (Grok hides markers). `[text](url)` => `text` in `link` underlined, then ` (url)` dim; wrap in OSC 8 (`\x1b]8;;url\x1b\\text\x1b]8;;\x1b\\`) only when `TERM_PROGRAM` is in an allowlist (iTerm.app, WezTerm, vscode, ghostty, kitty) or `HZ_HYPERLINKS=1`.
- Lists: `- x`/`* x` => `  • x` with the bullet `muted`; numbered keep their number, `muted`; continuation lines hang-indented to the text start. Task lists `[ ]`/`[x]` => `☐`/`☑` (`ok` when checked).
- Blockquote `> x` => `│ ` dim prefix + text.
- Horizontal rule `---` => `─` x min(W, 60), `faint`.
- Tables: render only if the full table fits (`min column widths` <= W); box chars `┌─┬┐│├┼┤└┴┘`, header bold, otherwise print the raw pipe rows dim.
- **Fenced code** (``` ```lang ```): the opening fence line becomes a header row `  ╭─ ts` (language name `muted`, only if given) in 256+/truecolor; body lines `  ` + highlighted text on `bgPanel`, filled to width with `ESC[K` (spaces fallback); closing fence prints nothing (or a `  ╰─` hairline). At level 1 (no bg): left bar `  ▏` in `faint` + highlighted text. Wrap code lines hard at `W - 4`, never reflow; unterminated fence at `end()` closes cleanly.
- Syntax highlighter `highlight(lang, line)`: tokenise by regex per language family (keywords `accent`, strings `ok`, numbers `warn`, comments `muted`+italic, types/functions `info`), languages `js|jsx|ts|tsx|json|py|sh|bash|zsh|rs|go|diff|yaml|toml|md`, unknown => plain `text`. 80 lines of code, no dependency. `diff` blocks use the same colours as `diffBlock` (+green/-red/@@cyan).
- Wrap prose at `W` (word wrap, ANSI-safe using `visibleWidth`), preserving the list/quote hang indent.
- `sanitizeText` runs **before** markdown parsing (model output must never inject escapes); OSC 8 is only generated by us.
- When `rich` is false, `assistant.delta` is written exactly as today (raw passthrough).
Test: golden fixtures for each construct, a chunk-boundary fuzz (split the same document at every byte offset and assert identical output), and a width test at 40/80/120.

#### P1-2. Tool cards (M)  [T]
Replace `⏺ name(args)` / `└ ok:` in rich mode with one-line cards committed in **final** form, with a duration. Bullet `◆` (`glyphs.bullet`): `accent` while running (in the live region only), `ok` on success, `err` on error. Verb bold `text`, object in role colour, detail `faint`, duration `faint` right-aligned to W when it fits else appended.

Which tools print a header at start (before the result) and which commit once:
- **Header at start + result at end**: `shell`, `shell_session`, `write`, `edit`, `ast_edit`, `apply_patch`, `agent` (these can block on approval, run long, or stream nested lines, and the approval prompt needs the context above it).
- **Commit once at completion** (card appears only when the tool finishes; the live footer shows `Reading x…` meanwhile): `read`, `grep`, `glob`, `ast_search`, `repo_map`, `lsp`, `todo`, `web*`, everything else.
Non-TTY keeps the current two-line form.

Exact formats (`P` = path shortened to basename+parent if > 40 cols, with `…/` prefix):
```
◆ Read P (120 lines)                                         0.2s
◆ Search "TODO" in src/ (14 matches)                         0.4s
◆ Glob **/*.test.ts (23 files)                               0.1s
◆ List src/tui (9 entries)                                   0.1s
◆ Fetch example.com/docs (200, 14 KB)                        1.3s
◆ Edit src/math.ts +12/-3                                    0.2s       (+ green, - red)
◆ Create src/new.ts +48                                      0.1s
◆ Edit 3 files +40/-11                                       0.5s       (apply_patch multi-file)
◆ Lsp diagnostics src/math.ts (2 errors)                     0.6s
◆ Ran todo (4 items)
```
`(120 lines)`, `(14 matches)`, `(23 files)`, `(9 entries)` are filled from `summary` when it parses (regex for `(\d+)\s+(lines|matches|files|entries)`); otherwise omit the parenthesis. Never invent numbers.
Fold at commit time (Grok verb-group vocabulary): buffer consecutive completed read-only cards (`read|grep|glob|ast_search|repo_map|list`) with no assistant text between them. If the run length is >= 4, emit ONE line `◆ Read 5 files, Searched 2 patterns   1.2s` (total time); if < 4, emit them individually. Errors always break the run and print individually. A `/verbose` toggle prints everything individually.
Errors: `  ✗ error: <first line, 200 cols, wrapped under a 4-space hang>` in `err`; the card bullet is `err`.
Parallel tool calls: each `callId` is tracked; the footer label shows the oldest running tool plus `+ N more` (exactly Grok's footer: `Map Expo app project + 4 more…`).

#### P1-3. Shell card (M)  [T]
```
◆ Run npm test                                                              (description if available, else the command)
$ npm test -- --reporter=dot                                                (command, `$ ` faint, command word `info`, args default)
  ▎ PASS  src/a.test.ts                                                     (bgPanel rows, 2 first lines)
  ▎ PASS  src/b.test.ts
  ▎ … +184 lines                                                            (muted)
  ▎ Tests: 190 passed, 190 total                                            (3 last lines)
  └ exit 0 · 4.2s
```
Simplify when no description is known: single `$ cmd` header line (`$ ` faint, then the command, truncated to `W-4` with `…`; multi-line commands show the first line plus `⏎ +N lines`). Output panel: first **2** and last **3** lines with a muted `… +N lines` row between (Grok `first_lines 2, last_lines 3`, `execute.rs:552`), lines hard-clipped to `W-4` with `…`, SGR from the command output stripped unless `HZ_RAW_OUTPUT=1`. Footer row: success `  └ 4.2s` (`faint`), non-zero `  └ exit 1 · 4.2s` (`err`). Needs output text: **contract change** (see 10.5 item C1). Until then, print only `$ cmd` and the `└ ok|error: summary` line using the same colours.

#### P1-4. Live subagent group (L)  [T]
Source events: `subagent.event {agentId, name, depth, event, profile}` and the parent's `agent` `tool.card`. While at least one subagent is running, the live region grows from 1 line to `1 + 1 + min(running+recent, 5)` lines, above the spinner line:
```
▾ Subagents 2
  ⠋ Map mobile project · Listing /mnt/c            2m14s
  ✓ Map frontend project                              20s
⠹ Map Expo app project + 1 more… 1m51s                          4m13s ⇣31k  esc to stop
```
Row grammar: `{state glyph} {label} · {latest child activity}   {elapsed}`; running glyph = dot spinner `⋅ : ⸬ ⁙` or the braille frame (the same tick), done `✓` (`ok`), failed `✗` (`err`), a completed row stays 2 s then moves to the transcript. Latest child activity comes from the last forwarded child event (`tool.card running` => `toolVerb`, `assistant.done` => `Responding`). Label = `profile` if present else the first 40 chars of the `agent` card's `description|prompt|task` argument else `subagent`. Row cap 5, extra rows collapse to `  ▸ show 3 more` (display only).
On completion, commit one transcript line in Grok's wording:
```
◆ Subagent completed in 20s: “Map frontend project”          (ok bullet)
◆ Subagent failed in 12s (timeout): “Map mobile project”      (err bullet)
```
and at start (only when `> 1` subagents are active or the run is expected to be long, i.e. always for `agent` cards): `◆ Subagent running: “Map mobile project” (explore)` with the profile in parentheses, `accent` bullet. The nested `│` lines remain available behind `/verbose` (default off in rich mode: they are what makes parallel subagent output unreadable; Grok keeps child detail in a separate view).
Contract gap (see C2): there is no start/end event and no mapping from `callId` to `agentId`. Interim heuristic: a subagent begins at the first `subagent.event` for an unseen `agentId` and ends when an `agent` tool.card `ok|error` arrives (match FIFO by first-seen order when several run).

#### P1-5. Turn end and user block polish (S)  [T]
- Turn footer keep as is but reword to Grok's marker: `· Worked for 12.4s · 3 tools · ↑1.2k tok          4:13 PM`. Cancelled: `· Turn cancelled by user in 10s.`.
- User block: keep the full-width shaded block. Level 3/2 background `bgUser` via `ESC[K` fill. Level 1/none and light-unknown: no bg; render `▍ ` (left half block, `accent`) before each line plus the text in bold. Timestamp format change to Grok's short form `4:13 PM` (locale 12h) or keep `HH:MM` if you prefer 24h; reserve 10 columns on wrapped lines so text never meets the stamp (Grok `timestamp_reserved`).
- Do **not** add assistant-message timestamps: streaming text cannot be given a right-aligned stamp after the fact; the turn footer carries the time.

#### P2-1. Status line above the prompt (S)  [T]
Current: `PLAN · model · provider · ◑ 12% · ~/proj · ⑂ main`. Target (Grok header + minimal info row merged):
```
~/proj ⑂ main  │  claude-sonnet (high) · PLAN · accept-edits  │  31K / 200K (16%)  │  /help
```
- Context as `used / window` with `fmt_tokens` (`12K`, `1.2M`) and a colour ramp: `<50%` `text`, `50-75%` `info`, `75-90%` `warn`, `>=90%` `err` (linear blend at level 3, steps at lower levels). Needs `contextPercent` plus absolute tokens (`ev.estimatedInput`, `ev.window` are already on `context.usage`).
- Mode flag colours: `plan` `warn`-gold (`#FFDB8D`), `always-approve`/`accept-edits` `warn`, `read-only` `ok`.
- Narrow ladder (drop order): provider, `/help` hint, branch, path, `used/window` -> `NN%`, mode, model stays last. Separator `  │  ` faint (Grok shortcuts-bar separator is 5 columns).
- Contextual hint segment (replaces Grok's bottom hint bar, which cannot live below a readline prompt): idle `enter send · / commands · ctrl+c exit`; typing `/...` `tab complete`; busy `esc stop · type to queue`; approval `y yes · n no · a always`. Keep it short; it is the last segment to be dropped *after* provider but before everything else is cut.
- Print policy unchanged (printed once as a transcript line before the prompt, re-printed only when it changed), so scrollback contains at most one stale copy per change. Do not repaint it in place with save/restore cursor (`\x1b[s` / `\x1b[u`): scrolling invalidates saved cursors.

#### P2-2. Input affordances within readline (M)
1. Prompt glyph `❯ ` (faint when idle, `accent` once typing starts is not possible without a repaint hook; keep `accent`). Plan mode: `plan ❯ ` in gold (exists as a badge).
2. **Tab completion** via the `completer` option: first word beginning with `/` completes from the command table with description shown in the candidate list (Node prints candidates in columns; supply `name` only, then print descriptions ourselves on double-Tab by returning the matching hits and writing a formatted list above the prompt before re-prompting). Also complete `@path` (fuzzy under the workspace, cap 200 files) and `/mode <arg>`, `/model <arg>`.
3. **Ghost suggestion** (optional, rich): after each keypress (listen on `process.stdin` `keypress`, handle in `setImmediate` after readline updated `rl.line`), if the line is a single `/word` prefix with exactly one match, write the remainder in `faint` after the cursor, then move back: `rest + "\x1b[" + rest.length + "D"`. Accept with Tab or Right arrow at end of line (`rl.write(rest)`). Clear it when the line changes (it is overwritten naturally by `\x1b[K` in the same hook). Keep behind `HZ_GHOST=1` until tested on iTerm, Terminal.app, Windows Terminal, tmux.
4. Top rule (instead of a box): print `─` x W in `faint` as the first line of the idle status block so the input visually starts under a hairline. No bottom border.
5. Multi-line input: support `\` at end of line (continuation, prompt becomes `  ` ) and bracketed paste of multi-line text: enable `\x1b[?2004h` while idle, detect `\x1b[200~ ... \x1b[201~` on `keypress` (Node emits `paste-start`/`paste-end` keys? it does for readline in recent versions: `key.name === 'paste-start'`), collect into one message, echo `[Pasted: N lines]` as the prompt text and send the full text. Without this, a multi-line paste submits line by line (a correctness and safety issue as much as polish).
6. History: keep the current file-backed history; add `Ctrl+R` reverse search only if readline's built-in is not already providing it (it is not; skip, low value).

#### P2-3. Approval card (S/M)  [T]
```
⚠ Approve shell?                                             (warn, bold)
  $ rm -rf build/                                            (command, bgPanel when level>=2)
  guardian: destructive path inside workspace               (dim, one line)
  [y] yes   [a] always for this command   [n] no   ❯         (keys bold, labels dim)
```
Keep line-based input (`ui.ask`) for safety. Optional single-key mode (`HZ_APPROVE_KEY=1`): switch off line mode for this prompt, accept `y`/`n`/`a`/`Esc`/`Enter(=no)` without Enter, **drop any bytes that arrived in the 300 ms before the card was drawn** and ignore keys for the first 250 ms after (type-ahead must never approve). Pulse the `⚠` diamond using the same `pulse()` while waiting (frame timer runs only during the wait). Diff preview stays `diffBlock`.

#### P2-4. Diff polish (S)  [T]
`diffBlock` rich variant: add a line-number gutter parsed from `@@ -a,b +c,d @@`: `  12 │ +  const x = 1;` with `bgAdd`/`bgDel` row backgrounds (levels 2-3), `+`/`-` colours only at level 1; `@@` hunk header becomes `  ⋯ lines 40-52` in `muted`; collapse long runs of unchanged context to `  ⋯ 14 unchanged lines`. Cap stays `TURN_DIFF_LINE_CAP`. Non-rich output unchanged (it is covered by existing tests).

#### P3 (only if time) 
- **Thinking display** (needs C3): live region shows the last 3 reasoning lines, dim italic, prefixed `┃ ` (Grok `truncated_lines = 3`, `bg_blend 0.7` => dim + italic); on completion collapse to `· Thought for 4.2s`; `/think` prints the last reasoning block; `/think on|off` sets the default. Until C3 exists the footer label `Thinking…` is all there is.
- **Popup dropdown for slash/@**: only behind `HZ_POPUP=1`; reserves rows by writing N `\n` then `\x1b[N A` (so a bottom-of-screen prompt does not scroll the saved cursor), repaints after every keypress via the `keypress` + `setImmediate` hook, 8 rows max, selected row `bgUser` + bold, `❯ ` prefix on the selected row, `name` column then description (Grok `slash_dropdown.rs` layout: label column <= 40 and <= 60% width, 2 space gap). Fragile around line wrapping and resizes; ship only after P2-2 proves out.
- **OSC 8 file links** in tool cards (`file://` + absolute path), same allowlist as markdown links.
- **`/theme dark|light|auto|mono`** that switches the role table at runtime and persists in config.
- **Welcome banner**: keep the current rich banner (it has one tip); add `Tip:` rotation per launch only.

### 10.4 Narrow terminal behaviour (summary)
- `< 80`: footer drops hint text; markdown tables fall back to raw; status line drops provider/hint.
- `< 60`: footer drops phase timer; tool-card durations move inline instead of right-aligned; code block language header hidden.
- `< 40`: footer = spinner + label + total; status line = model + mode; no subagent group (just the footer label with `+ N more`); user block loses the timestamp.
- `< 24`: footer = spinner; everything else plain.
Width must be re-read on every frame (`terminalWidth()`), never cached across frames (resize).

### 10.5 Contract changes the spec depends on (additive, each optional with a fallback)
- **C1** `tool.card` gains optional `detail?: { output?: string; exitCode?: number; durationMs?: number }` (shell stdout/stderr tail, exit code). Fallback: today's `summary`. The TUI can time tools itself (`callId` start/end timestamps), so `durationMs` is a nice-to-have.
- **C2** `subagent.event` gains `callId?: string` and `subagent.start|end` facade events `{agentId, callId, description, profile, ms?, status?}`. Fallback: the FIFO heuristic in P1-4. Keep the kernel catalogue untouched (these are facade events like `turn.diff`, per the comment in `contracts.ts`).
- **C3** `assistant.thinking {text}` delta/done facade events, only for providers that stream reasoning. Fallback: spinner label.
None of these may change non-TTY output; renderers ignore unknown event types already (`default: break`).

### 10.6 Test strategy (mirrors the Grok approach at HorizonCode scale)
1. **Pure-function snapshots** (existing style in `live.ts` exports): every formatter at widths {24, 40, 60, 80, 120} x levels {0,1,2,3} x {unicode, ascii}. Assert `visibleWidth(line) <= width` for every produced line.
2. **Non-TTY byte-identity**: replay a recorded `RuntimeEvent[]` script through `createRenderer({out})` with `rich=false` and compare to a stored fixture; this fixture must be created from the *current* output before any change.
3. **Tiny VT emulator** in `app/test/` (not shipped): applies `\r`, `\n`, `ESC[nA`, `ESC[nB`, `ESC[nG`, `ESC[K`, `ESC[2K`, `ESC[J`, SGR (ignored), `?2026`/`?25` (recorded) to a grid. Use it to assert the live region is fully erased before transcript writes, that a 3-line group redraw leaves no residue, and that resize mid-turn leaves a clean screen. This is the lightweight analogue of Grok's `alacritty_terminal` `ScreenTracker`.
4. **Frame accounting**: count `?2026h/l` pairs and assert one frame = one sync pair, and that identical consecutive frames emit nothing (flicker regression guard).
5. **Real-PTY smoke** (if the Bun version in use supports it, else `script -qec`): launch `hzcode` against the mock provider, send keys, resize, and diff the emulator grid; mirrors `pty_e2e_smoke.rs`.
6. **Fuzz**: markdown chunk-boundary fuzz (split at every offset), width fuzz, random ANSI in model text (`sanitizeText` invariants).

### 10.7 Implementation order (what to hand a coder)
1. P0-1, P0-2, P0-3 together (style.ts + live.ts), with tests 1-4. Deliverable: pulsing smooth spinner, multi-line capable region, colour ladder, narrow ladder. Nothing user-visible breaks in non-TTY.
2. P1-5 (user block + footer wording) and P2-1 (status line), small and visible.
3. P1-1 markdown (largest single quality jump for what the user actually reads).
4. P1-2 tool cards + P2-4 diffs, then P1-3 shell card (after C1).
5. P1-4 subagent group (after C2, or heuristic).
6. P2-2 completion and paste handling, P2-3 approval card.
7. P3 items.

---

## 11. Is a full inline-viewport rewrite worth it?

**What it would be**: stop using `readline` and implement what `xai-ratatui-inline` + `minimal/` do, in TypeScript: own the raw stdin (key parser incl. bracketed paste, CSI u / kitty keyboard), own the line editor (grapheme-aware, multi-line, undo, atomic chips), a retained frame buffer with cell diff, a pinned viewport at the bottom whose height changes (reserve rows with newlines, `insert_before`-style commits), DEC 2026 around every frame, resize reprint (`ESC[2J ESC[3J ESC[H` + replay of committed output), and widgets: bordered prompt with caption on the border, hint bar, slash/@ dropdown, approval card with radio rows, subagent dock. Estimate: 2.5-4k lines of TS plus a VT-emulator test harness; 2-3 weeks to reach parity with today's behaviour and parity bugs (IME, Windows, tmux, paste, wide chars) are the long tail. Grok needed 3.5k lines for the inline terminal alone plus 7k for the minimal crate on top of ratatui.

**What only the rewrite buys**: (a) a real bordered input box with model/mode on the border; (b) a stable hint bar and dropdowns below the prompt without readline wiping them; (c) multi-line editing with atomic chips and proper bracketed paste; (d) in-place update of lines that are already on screen below the commit frontier (live tail of streaming markdown with correct restyling, folding of tool runs, collapsible groups); (e) clickable `[stop]`.
**What it does not buy**: markdown rendering, tool-card formats, colour ladder, spinner polish, subagent live group, status line: all of that is P0-P2 above and works on readline.

**Recommendation**: **Do not rewrite now.** Ship P0-P2 on readline first; that closes ~85% of the visible gap with Grok's minimal mode (which, not the fullscreen UI, is the right reference for a scrollback chat). Re-evaluate after P2-2: if users still hit readline limits (multi-line paste/edit, dropdowns, bordered input), do the rewrite as a separate "Part 3" using exactly Grok's minimal-mode architecture: pinned viewport + commit frontier + print-once scrollback. Design P0-P2 so that rewrite stays cheap: keep markdown, tool-card, diff, role-table and width code as **pure functions returning strings** (no readline coupling) so the same renderers feed either the readline driver or a future viewport driver. A fullscreen alternate-screen UI (Grok's main mode) is not recommended: it gives up native scrollback/selection, which is the property that makes HorizonCode feel like a normal terminal tool.

---

## 12. Open items and caveats

- I did not run the Grok binary (not built here), so exact on-screen spacing was derived from source and snapshot/test strings, not from a live capture. The highest-risk values to eyeball first are: the `ESC[K`-fill block backgrounds on Terminal.app/tmux, the ghost-text hook, and OSC 8 allowlisting.
- Grok's `›` vs `❯`: source uses `❯` (`glyphs::prompt_arrow`); the screenshot glyph is the user's font.
- `▼` in the screenshot vs `▾` (U+25BE) in `glyphs::disclosure_open`: font rendering of the same glyph; use `▾` with ASCII fallback `v`.
- The hint bar separator is `  │  ` in source; the screenshot shows `|`. Same element.
- Per-tool durations are not shown by Grok; the spec adds them deliberately.
- The dock is behind a remote feature flag (`dock_enabled`) in Grok; the screenshot has it enabled.
- I did not read HorizonCode's `core/` or runtime to confirm what `tool.card.summary` contains per tool; the "parse numbers from `summary`, else omit" rule exists for that reason. A coder should confirm which tools put counts in `summary` before relying on P1-2 detail text.
