# 13 — Terminal UI (`hzcode tui`)
> **Permission modes (`docs/28` ruling 58).** `/mode [default|plan|accept-edits|read-only]` shows or sets the mode; a non-default mode puts a bold yellow badge (`PLAN`, `ACCEPT-EDITS`, `READ-ONLY`) before the prompt and prints one notice at chat start. `/mode yolo` is refused with the reason.

> **Print mode (`docs/28` ruling 57).** `hzcode -p` never opens the chat bar or an approval prompt, even on a TTY; stdout carries only the chosen format (`text`, `json`, `stream-json`), notices and errors go to stderr.


> **Agent presets (stage 3, `docs/28` ruling 56).** A nested child run started with a `profile` prints one `profile: <name>` line behind the dim bar before its first nested line (renderer reads the additive `profile` on `subagent.event`).
>
> The TUI is the primary product surface (ADR-001). This document fixes its rendering model, component tree, input model, streaming rules, diff/approval surfaces, theming, accessibility, performance budgets and statuses. It does not describe the agent; it describes the glass.

---

## 1. Purpose

This document decides:

1. How `hzcode` paints a terminal: two screen modes (fullscreen alt-screen, inline/scrollback), differential rendering, and the relaunch contract that switches between them.
2. The named component tree that every TUI feature must attach to, and the rule that components render only.
3. The mouse model (capture, hit-testing, click-to-focus, scrollbars, drag-select, capture re-assertion after ConPTY relays).
4. The keyboard model (modes, default keymap, vim/emacs presets, custom keybindings, discoverability).
5. The slash-command and palette system.
6. Streaming rendering rules and backpressure.
7. The diff viewer and approval prompts, including the *show the exact effect* rule and apply-through-kernel semantics.
8. Transcript features, theming, accessibility, performance budgets, session-management UI, status surfaces, error/`UNKNOWN` display, notifications and the non-interactive output modes that share this renderer's data model.

Design-only except the v0.1 slice enumerated in §10: the chat TUI (chat bar, streaming, tool cards, y/n/a approvals, history, slash sugar) and headless mode are implemented and tested (child tool cards nest under the `agent` card behind a dim bar, at most 30 lines per child; the per-turn diff renders as `· changed N file(s)` plus a diff capped at 40 lines; headless prints only the changed summary, on stderr, keeping stdout a clean transcript; `docs/28` ruling 54) — `bun test tests/tui` → 48 pass, per `docs/28-implementation-status.md`. Every other claim here is a design claim.

Sources this document is derived from:

- `source: grok-build /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager` (the reference fullscreen TUI: alt-screen policy, mouse handling, scrollback blocks, inline "minimal" mode, slash registry, theming, doctor).
- `source: grok-build /data/home/forge/repo-tour/grok-build/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md`, `04-slash-commands.md`, `06-theming.md`, `14-headless-mode.md`, `21-terminal-support.md`.
- `source: opencode /data/home/forge/repo-tour/opencode/packages/tui/src/config/keybind.ts` (leader-key + named-action keymap), `.../packages/tui/src/theme/system.ts` (terminal-derived palette), `.../packages/tui/src/feature-plugins/system/diff-viewer.tsx` (diff viewer keys), `.../packages/theme` (theme tokens).
- `source: codex /data/home/forge/repo-tour/codex/codex-rs/tui/src` (chat widget, transcript view, status indicator widgets, diff render, theme picker, keymap config in `codex-config/src/tui_keymap.rs`).
- `source: oh-my-pi /data/home/forge/repo-tour/oh-my-pi/packages/tui/src` (differential rendering library, tool renderers, overlays, composer).
- `source: horizoncode /data/home/forge/repo-tour/horizoncode/arch_V1/contracts-v2/ui-stream-event-v2.schema.json` (the `durable`/`ephemeral` UI event lane split this design adopts).
- In-repo decisions: `/data/home/forge/HorizonCode/README.md`, `/data/home/forge/HorizonCode/docs/02-decisions.md`, `/data/home/forge/HorizonCode/docs/_conventions.md`.

## 2. Rules

Rule IDs are stable and individually testable. `MUST` fails a gate; `SHOULD` is reported by the gate but does not fail until the next ratchet bump; `MAY` is free.

### 2.1 Rendering model and screen modes

| # | Rule |
|---|---|
| R1 | The TUI MUST have exactly two screen modes: `fullscreen` (alternate screen, mouse-interactive) and `inline` (scrollback-native, no alt-screen). There MUST NOT be a third rendering path; features add cells to one of these two layouts. |
| R2 | `fullscreen` is the default when the process has a TTY, `TERM` is not `dumb`, `$CI` is unset, and stdout is not a pipe. Otherwise `inline` is the default. |
| R3 | Mode selection inputs are, in precedence order: `--fullscreen` / `--minimal` (mutually exclusive, both present ⇒ exit code 2), the `HZ_TUI_MODE` environment variable, `[terminal] alt_screen = "always" \| "never" \| "auto"` in `~/.config/horizon/config.toml`, then R2. |
| R4 | Switching modes at runtime MUST relaunch the process (`hzcode tui relaunch --mode <mode>`), preserving session id, workspace, draft composer text and the last-read event cursor. The relaunch MUST NOT fork, re-admit or re-run a turn. |
| R5 | Inline mode MUST render through ordinary scrollback writes and MUST NOT use cursor-addressed painting, alternate screen, or mouse capture. It MAY use `\r`-overwrite for a single live status line. |
| R6 | Fullscreen mode MUST enter the alternate screen before the first frame and MUST leave it on every exit path: normal exit, `SIGINT`, `SIGTERM`, `SIGHUP`, panic, and supervisor kill. Terminal restore is installed before the first frame and MUST be idempotent. |
| R7 | The TUI MUST restore, in order: mouse capture, bracketed paste, cursor visibility, alternate screen, raw mode. Restore MUST be attempted even when a previous step failed. |
| R8 | All painting MUST be differential: the renderer keeps a previous-frame cell buffer and emits only changed runs. A frame that changes nothing MUST emit zero bytes. |
| R9 | Escape sequences MUST be serialized through a single escape writer queue. No component may write to stdout directly. |
| R10 | Every byte the TUI writes MUST be a full escape sequence or a complete grapheme cluster; the renderer MUST NOT emit a partial sequence from a frame that is interrupted by resize or mode switch. |
| R11 | A resize MUST invalidate the layout version, invalidate all cached hit-test rectangles (R25), re-layout, and repaint the full frame. Sequences arriving mid-resize MUST be dropped, not queued. |
| R12 | The renderer MUST be usable headless: a `--render-probe` mode renders one frame of a captured session to a text grid and exits, for golden-frame tests (§9, `tui/render-probe.golden`). |

### 2.2 Component tree

| # | Rule |
|---|---|
| R13 | The TUI MUST be built from the named components in the table below. A new visual concept MUST either map to an existing component or be added to this table in the same change. |
| R14 | Components MUST be pure renderers: `render(props) -> cells` plus a declarative event/action callback. A component MUST NOT call the Controller, the kernel client, the filesystem or the network. |
| R15 | A component that needs new data MUST receive it as a prop derived from a projection. If the data does not exist, the component MUST render an explicit `UNKNOWN` cell (R169), never a blank or a plausible guess. |
| R16 | Component state that affects layout MUST be owned by `App` (active pane, modal stack, mode, layout version) so that hit-testing (R25) and key routing (R38) read one source of truth. |
| R17 | Every component MUST render correctly at every width in `{40, 52, 72, 100, 120, 200}` and at heights `{10, 24, 36, 60}`. Narrow-layout reflow is defined per component (R129). |
| R18 | Every component MUST accept a `no-color` render mode (R121) and a `reduced-motion` mode (R127) as props, and MUST degrade structurally, not cosmetically, when they are set. |
| R19 | Any component that displays model-authored text MUST render it as untrusted: no escape sequences from model output are honored (R107), and any media render happens out of process (R112). |
| R20 | Any component that displays a receipt, a cost, a token count, or a policy revision MUST render the value plus its provenance key (receipt id, ledger id, or `incomplete`/`UNKNOWN` marker). A bare number without provenance is a bug. |
| R21 | `ToolCallCard` MUST be driven by the tool declaration (`ToolDeclarationV1`: name, capability ID, effect class, renderers), not by a switch on tool name strings in the TUI. |
| R22 | The TUI MUST render every state the Controller can be in; a Controller state without a renderer MUST fail the parity ratchet (R196). |

#### Component table

| Component | Planned path (`[planned]`) | Responsibility |
|---|---|---|
| `App` | `packages/tui/src/app.tsx` | Owns mode, layout, active pane, modal stack, keymap instance, theme, and the subscription to the event stream. The only component allowed to hold a mutation-capable reference (to the *client*, never to domain logic). |
| `ThemeProvider` | `packages/tui/src/theme/provider.tsx` | Resolves semantic tokens to the detected color level; provides `useTheme()`. |
| `SessionView` | `packages/tui/src/routes/session/index.tsx` | Lays out header, transcript, composer, status bar for one `hz://session/<id>`. |
| `Transcript` | `packages/tui/src/component/transcript.tsx` | Windowed list of blocks; scrolling, selection, folding, search, sticky turn headers. |
| `MessageBlock` | `packages/tui/src/component/message-block.tsx` | One assistant/user/system message; owns streaming accumulator, thinking fold, markdown/syntax highlighting, copy of block content. |
| `ToolCallCard` | `packages/tui/src/component/tool-call-card.tsx` | One tool call: arguments, progress, result, elapsed, capability ID, receipt id, effect class chip. |
| `DiffView` | `packages/tui/src/component/diff-view.tsx` | Unified/side-by-side rendering, hunk navigation, per-hunk accept/reject, apply status (R75–R86). |
| `ApprovalPrompt` | `packages/tui/src/component/approval-prompt.tsx` | The blocking ask card (R87–R98); renders the exact effect and the decision buttons. |
| `Composer` | `packages/tui/src/component/composer.tsx` | Multi-line input, paste chips, slash menu, `@` mention menu, history, IME, draft persistence. |
| `Palette` | `packages/tui/src/component/palette.tsx` | Fuzzy command/action/resource search, MRU ranking, argument hints. |
| `StatusBar` | `packages/tui/src/component/status-bar.tsx` | Right-aligned and left-aligned status segments: progress, tokens, cost, budget, model, posture, kernel health (R157–R166). |
| `SessionPicker` | `packages/tui/src/component/session-picker.tsx` | Session list, resume, fork, delete, tree view entry (R147–R150). |
| `ModalHost` | `packages/tui/src/component/modal-host.tsx` | The single stack for help, receipt inspector, session tree, cost dashboard, settings, theme picker, doctor report, and toasts. Owns keyboard capture while a modal is on top. |

### 2.3 Mouse

| # | Rule |
|---|---|
| R23 | In fullscreen mode the TUI MUST enable the DEC private modes `1000` (click), `1002` (button drag), `1006` (SGR encoding), and `2004` (bracketed paste). It MUST NOT enable `1003` (any-motion) by default; hover tracking is opt-in per component. |
| R24 | Mouse capture MUST be tracked as an explicit boolean (`MOUSE_CAPTURED`) in `App`. Every enable/disable path MUST go through one function pair so that an unbalanced capture cannot occur. |
| R25 | Hit-testing MUST read rectangles cached from the **last painted frame**, tagged with the layout version. A click whose cached rect carries a stale layout version MUST be dropped, not applied to a guessed target. |
| R26 | Hit-test order MUST be: modal stack (top to bottom) → blocking cards → status strip segments → active pane's internal targets (scrollbar thumb, block headers, buttons) → transcript body → composer → background. The first hit wins; a component MUST NOT receive an event when an occluder covers that cell. |
| R27 | Click-to-focus MUST be implemented for every focusable region: transcript, composer, status segments that open panels, side panels (tasks, queue, todo, goal, workflows), and diff view. Focus change MUST be reflected in the status bar within one frame. |
| R28 | Click targets MUST have a minimum 1×1 cell area and MUST NOT be inferred from whitespace: a target exists only if the component registered a rect. |
| R29 | Wheel events MUST be routed to the pane under the pointer, not to the focused pane, and MUST scroll that pane by 3 lines per notch unless the pane declares a different step. Wheel over the composer MUST scroll composer history only when the composer has more lines than its box. |
| R30 | Scrollbar thumbs MUST be draggable: pointer-down on the thumb captures the drag until pointer-up; pointer-down on the track pages toward the click. While dragging, the scroll position MUST be mapped from pointer row to a proportion of the content, clamped so the thumb never leaves the bar. |
| R31 | Drag-select MUST produce a text selection with cell-accurate start/end, word granularity on double click and line granularity on triple click, within `MULTI_CLICK_TIMEOUT_MS`. Selection MUST survive a repaint that does not change the underlying text, and MUST be cleared on scroll, resize, or new content in the selected block. |
| R32 | Copy MUST prefer `OSC 52` (with the terminal's clipboard write enabled) and fall back to `pbcopy`/`wl-copy`/`xclip`/`clip.exe` per platform. Copy MUST NOT block the event loop; failure MUST surface as a toast, never as a silent no-op. |
| R33 | Pressing `Shift` (or the terminal's bypass modifier) while dragging MUST hand selection to the terminal emulator: the TUI MUST NOT capture selection when the modifier is held. The active modifier MUST be discovered from terminal support detection (R131) and shown in `/help`. |
| R34 | Capture re-assertion: on every focus-gained event the TUI MUST re-emit the mouse-capture + bracketed-paste enable sequence through the escape writer queue, unless the user deliberately disabled capture. These sequences MUST ride the writer queue so a re-assertion cannot interleave with a frame. |
| R35 | The input reader MUST repair SGR-mouse reports degraded to X10 form by ConPTY-backed relays (SSH/tmux/Windows terminals): a mouse event whose shape is impossible for the current terminal size must be held as a candidate and reassembled with the immediately following byte if it arrives within `X10_MAX_COMPLETION_GAP` (50 ms); otherwise it MUST be forwarded as typed input. Reconstruction MUST only ever see mouse-shaped candidates. |
| R36 | `hzcode doctor` and in-TUI `/doctor` MUST report mouse state: capture enabled/disabled, last capture re-assertion time, whether the terminal was observed to strip DEC modes, the detected bypass modifier, and the terminal's name/version. |

### 2.4 Keyboard

| # | Rule |
|---|---|
| R37 | The keyboard MUST be routed through one keymap registry: every binding is a named action with a description, a default binding, and the contexts it applies to. There MUST NOT be a raw key comparison outside the keymap registry. |
| R38 | Routing precedence MUST be a documented stack: `modal` → `palette` → `diff` → `search` → `selection` → `navigate`/`insert`. A lower layer MUST NOT observe a key consumed by a higher layer with a matching binding. |
| R39 | Modes: `insert` (composer focused), `navigate` (transcript focused), `diff`, `search`, `palette`, `modal`. The active mode MUST be visible in the status bar. |
| R40 | `Esc` MUST step out of the innermost pending thing (clear a filter, then leave a card, then clear the draft, then leave the mode). `Esc` MUST NOT cancel a running turn; `Ctrl+C` does (R45). |
| R41 | Blocking cards (approval, question, cancel-turn, elicitation) MUST capture `Tab`/`Shift+Tab` for row walking with wrap-around and MUST NOT let focus leave the card while it is topmost. |
| R42 | A blocking card MUST publish a key hint line; the TUI MUST NOT rely on users remembering card keys. |
| R43 | The default preset is `simple` (arrows + `Tab` + `Ctrl+*`). `vim` and `emacs` are selectable presets (R46). Presets MUST be data, and MUST be listed by `hzcode keybind list`. |
| R44 | `hzcode keybind list --json` MUST print every action with `id`, `description`, `default`, `effective`, `source` (`default`/`preset`/`user`/`workspace`) and `contexts`. |
| R45 | `Ctrl+C` semantics MUST be explicit and graded: once = interrupt the current turn (receipted as a cancel decision), twice within 2 s = cancel the batch and return to idle, three times = exit with code 130 after terminal restore. While a turn is at risk of an unknown effect the TUI MUST show the cancel panel listing what will be interrupted. |
| R46 | Presets: `vim` MUST provide `j/k` navigate, `h/l` fold, `g/G` first/last, `/[n]` search, `y` copy, `e` expand, `i`/`Tab` focus composer, `Ctrl+W` window commands via leader; `emacs` MUST provide `Ctrl+A/E` line ends, `Ctrl+K/U` kill, `Ctrl+Y` yank, `Alt+B/F` word motion, `Ctrl+S` search, and MUST NOT shadow `Ctrl+C` (R45). |
| R47 | A user keybindings file MUST load from `~/.config/horizon/keybindings.toml` and MAY be narrowed (never widened) by `.hz/keybindings.toml` in the workspace (ADR-008). Workspace bindings that would shadow `Ctrl+C` interrupt or the approval card's keys MUST be refused with a diagnostic. |
| R48 | The keybindings file MUST be validated against the action registry; unknown action ids, unknown keys and duplicate bindings MUST fail loudly at startup (`hzcode keybind check`) and MUST NOT be silently ignored. **Graded repeat bindings are not duplicates:** the schema's `repeat: 1 \| 2 \| 3` field makes the same key express a graded action (R45), so `Ctrl+C` ×1 = `turn.interrupt` and ×3 = `app.quit` is one graded binding, valid in a user file and validated as such. |
| R49 | `/help` MUST open `ModalHost`'s help page generated from three live registries: the keymap, the slash registry, and the available commands/tools for the current session. It MUST be searchable and MUST show only bindings effective in the current context first. |
| R50 | Any key that reaches the composer with no binding MUST be inserted as text, never swallowed. Any key in `navigate` with no binding MUST be ignored (and counted in the debug HUD). |
| R51 | The TUI MUST expose a debug HUD (toggle `F12` by default) showing: last input latency, frame time, dropped frames, event queue depth, layout version, hit-test rect count, and keyboard layers active. |
| R52 | Terminal-protocol divergence MUST be handled as data, not code branches: the keymap declares per-terminal overrides (for example a newline chord of `Alt+Enter` when the `Cmd` modifier cannot be delivered over SSH). The composer footer MUST show the chord that will actually work in this terminal. |

#### Default keymap (preset `simple`, abbreviated)

| Action id | Default | Context | Description |
|---|---|---|---|
| `turn.interrupt` | `Ctrl+C` (repeat 1) | global | Interrupt the current turn (receipted) |
| `app.quit` | `Ctrl+C` (repeat 3 — the same key, graded per R45) | global | Exit, restoring terminal state |
| `composer.submit` | `Enter` | insert | Send the draft |
| `composer.newline` | `Alt+Enter` / `\`+`Enter` | insert | Insert a newline |
| `palette.show` | `Ctrl+P` | global | Command palette |
| `help.show` | `F1` / `/help` | global | Help modal |
| `transcript.next` | `Down` / `j`(vim) | navigate | Next block |
| `transcript.prev` | `Up` / `k`(vim) | navigate | Previous block |
| `transcript.expand` | `Right` / `l`(vim) | navigate | Expand block |
| `transcript.collapse` | `Left` / `h`(vim) | navigate | Collapse block |
| `transcript.toggle_fold` | `e`(vim) | navigate | Toggle fold (pins it) |
| `transcript.fold_all` | `Shift+E`(vim) | navigate | Expand/collapse all |
| `transcript.copy` | `y`(vim) / `Ctrl+Shift+C` | navigate | Copy block content |
| `transcript.view` | `Enter` | navigate | Open block in the fullscreen viewer |
| `transcript.search` | `Ctrl+F` | global | In-transcript search |
| `transcript.jump_turn` | `Shift+Up/Down` | navigate | Previous/next user turn |
| `pane.focus_toggle` | `Tab` | global | Switch transcript ⇄ composer |
| `diff.open` | `Ctrl+D` | global | Open the diff viewer for the last change set |
| `diff.next_hunk` | `]` | diff | Next hunk |
| `diff.prev_hunk` | `[` | diff | Previous hunk |
| `diff.accept_hunk` | `a` | diff | Accept this hunk |
| `diff.reject_hunk` | `r` | diff | Reject this hunk |
| `diff.accept_all` | `A` | diff | Accept every pending hunk (one confirmation) |
| `diff.layout` | `s` | diff | Toggle unified ⇄ side-by-side |
| `session.picker` | `Ctrl+R` | global | Session picker |
| `session.tree` | `Ctrl+T` | global | Session tree |
| `session.rewind` | `Ctrl+Z` | global | Rewind by turn |
| `session.fork` | `Ctrl+G` | global | Fork from here |
| `receipt.inspect` | `Ctrl+I` | global | Inspect the focused receipt |
| `approval.allow_once` | `1`/`a` | approval | Allow this one effect |
| `approval.allow_session` | `2`/`s` | approval | Allow for this session |
| `approval.allow_workspace` | `3`/`w` | approval | Allow for this workspace (grant) |
| `approval.deny` | `4`/`d` | approval | Deny |
| `approval.inspect` | `i` | approval | Show the full intent + digest |
| `mode.toggle_fullscreen` | `F11` | global | Relaunch in the other screen mode |
| `theme.picker` | `/theme` | global | Theme picker modal |
| `debug.hud` | `F12` | global | Toggle the debug HUD |

### 2.5 Slash commands and the palette

| # | Rule |
|---|---|
| R53 | The slash registry MUST be the single source of truth for `/…` commands and MUST be composed at startup from: built-ins, bundled and user skills, custom commands (`~/.config/horizon/commands/*.md` and `.hz/commands/*.md`), MCP prompts, plugin commands, and session-local commands created by the agent (for example an approved plan). |
| R54 | Every registry entry MUST declare: `name`, `aliases`, `description`, `argumentSchema`, `executionKind ∈ {prompt, local, rich}`, `surfaces` (which of the eight surfaces support it), `requiresApproval` (boolean), `receiptClass`, and `source`. An entry missing a field MUST fail the build, not render a degraded menu item. |
| R55 | A slash command MUST NOT execute side effects itself. `local` commands must call a Controller command; `prompt` commands must be admitted through the prompt inbox; `rich` commands must render a TUI view whose mutations happen through tool calls. |
| R56 | Any slash command whose effect class is not `read-only` MUST be receipted with its `invocation` recorded, and MUST be visible in the session's receipt chain. |
| R57 | The inline slash menu MUST open when the composer text starts with `/` and MUST show: match list (fuzzy), the selected entry's description, its argument hint, its `source` badge (`built-in`, `skill`, `mcp`, `plugin`, `user`, `workspace`), and a warning badge when the entry requires approval. |
| R58 | Slash-menu ranking MUST be: exact prefix match, then fuzzy score, then MRU, then declaration order. Recency MUST be stored per workspace, not globally. |
| R59 | The palette (`Ctrl+P`) MUST search the union of: slash registry entries, keymap actions, sessions, receipts, artifacts, memory entries, files (through the same walker the agent uses), and `hz://` resources. Each result MUST be typed and MUST render its type badge. |
| R60 | Palette results MUST be actionable: selecting a session opens it; selecting a receipt opens the inspector; selecting a file inserts an `@path` reference; selecting a keymap action runs the action. A palette result that is not actionable MUST NOT be listed. |
| R61 | The palette and slash menu MUST each render at most 200 rows, with virtualization; searching MUST NOT block input for longer than 50 ms for a 100 k-item corpus on the reference machine. |
| R62 | Discoverability: `/help`, the palette, and the status bar's hint line MUST be generated from the live registries. There MUST NOT be a hand-maintained help text that can drift from the registry. |

**Reduced v1 (implemented in `app/src/tui/interactive.ts`).** The shipped interactive TUI has a fixed built-in set, listed by `/help`: `/help`, `/new`, `/model [name]`, `/files`, `/context`, `/plan [on|off]`, `/changes`, `/apply`, `/discard`, `/rewind [n]`, `/memory` (alias `/instructions`), `/init` and `/exit`. The instruction-related ones:

- `/memory` (alias `/instructions`) prints every project instruction file the next request carries, least to most specific (later wins; the user's messages win over all), each with its kind and size, plus truncations, skips and `.mdc` rules that were not applied. It is read-only. Nested `AGENTS.md`/`CLAUDE.md` below the working directory are not listed until a tool successfully reads or edits a file there (`read`, `write`, `edit`, `apply_patch`, `ast_edit`; `grep`/`glob`/list do not count). They then load lazily, a notice names them, they stay for the life of the process (a restart or resume drops them until a tool touches the directory again), and `/memory` lists them. The call that first touches a directory runs without its rules; they apply from the next request. A file skipped because the 64 KB lazy budget is used up gets a notice and a `/memory` line.
- `/init` runs an ordinary model turn that inspects the repository with read-only tools and proposes `AGENTS.md` through the normal `write` tool (or `edit` when an `AGENTS.md` already exists). Plan mode is switched on for that turn when the runtime supports it, so the write is staged, not landed: review it with `/changes`, write it with `/apply` (through the normal guard) or drop it with `/discard`. Plan mode returns to its prior state afterwards. `/init` itself never writes.
- `/plan`, `/changes`, `/apply` and `/discard` are the staging surface `/init` relies on; staged changes are per-session.

### 2.6 Streaming rendering and backpressure

| # | Rule |
|---|---|
| R63 | The TUI MUST consume `hz.step.llm.delta` events (lane `ephemeral`) and `hz.part.updated` (lane `durable`) as a single ordered stream per session, reconciled by part id; a durable part update MUST win over a stale ephemeral delta for the same part. |
| R64 | Deltas MUST be accumulated into per-part text buffers and painted at a bounded frame rate: at most one paint per 16 ms window, and at least one paint per 100 ms while any part is streaming. |
| R65 | Every frame MUST have a parse budget: markdown re-parse, syntax highlighting and wrapping together MUST NOT exceed 4 ms per frame on the reference machine for a 4 000-line transcript. Exceeding it MUST degrade the block, not the frame rate (R68). |
| R66 | Repaint MUST be structural-first: when a streamed delta extends a block by whole lines below the viewport bottom, the TUI MUST append without re-rendering the block above. Blocks above the viewport MUST NOT be re-laid-out on append. |
| R67 | Backpressure: the renderer MUST maintain a queue of at most 2 pending frames. If the pending work exceeds 250 ms of render time, the TUI MUST escalate degradation in this order: (1) disable syntax highlighting, (2) coalesce to line-granular appends, (3) suspend markdown reflow and show raw text with a `coarse` badge, (4) stop painting non-visible blocks entirely. All four levels MUST preserve input responsiveness. |
| R68 | Degradation MUST be visible and reversible: a `coarse` badge MUST appear in `StatusBar`, MUST count the degraded blocks, and MUST clear automatically when the queue drains below 50 ms. |
| R69 | The TUI MUST never drop input under load. The input reader MUST run separately from rendering; a synthetic 1 000 lines/s stream for 60 s with continuous typing MUST produce zero lost keystrokes (R187). |
| R70 | The TUI MUST never drop durable content. If the display cannot keep up, the transcript MUST show a summary line `… N lines hidden; full text at hz://session/<id>/part/<id>` and the durable event MUST remain in the log. |
| R71 | Token-level display fidelity MUST be secondary to order: a delta's text MUST be appended in arrival order and MUST NOT be re-ordered by the renderer, even when frames are coalesced. |
| R72 | Thinking/reasoning deltas MUST render into a folded `ThinkingBlock` by default, MUST be counted (tokens + duration) in the collapsed header, and MUST be expandable mid-stream with the fold pinned (R103). |
| R73 | The context-window indicator MUST update from `hz.usage.recorded` only, never from client-side estimates, and MUST mark `incomplete` when the ledger reports incomplete usage (R163). |
| R74 | A stream that ends without a terminal event MUST render as an explicit interrupted state with the last observed cursor and the reason code from `hz.error.raised`; it MUST NOT render as a completed assistant message. |

### 2.7 Diff viewer

| # | Rule |
|---|---|
| R75 | `DiffView` MUST support `unified` and `side-by-side` layouts with a persistent per-user default and a per-view toggle; the toggle MUST NOT lose the selected hunk or the scroll anchor. |
| R76 | Hunks MUST be navigable (`]`/`[`, `next_hunk`/`prev_hunk`) with wrap-around, and the hunk list MUST be visible as a gutter rail showing per-file hunk counts and accept state. |
| R77 | Every hunk MUST carry an explicit state: `pending`, `accepted`, `rejected`, `applied`, `apply_failed`, or `unknown`. The states MUST be mutually exclusive and MUST be rendered with a distinct glyph plus a text label (no color-only signalling, R122). |
| R78 | The diff viewer MUST be able to accept or reject a single hunk, a file, or the whole change set. Bulk actions MUST show the count of hunks and files affected before applying. |
| R79 | Apply-through-kernel: accepting a hunk MUST issue a `files.patch` effect request to `hzk` with the hunk's exact preimage digest and intent; the TUI MUST NOT write a file, MUST NOT shell out to `git apply`, and MUST NOT compute the result itself. |
| R80 | The viewer MUST display, for each apply attempt: the capability ID (`files.patch`), the lease id, and the receipt id once settled. An apply with no receipt MUST render as `pending` and MUST NOT read as success. |
| R81 | A denied or failed apply MUST render the kernel's `reason_code` and keep the hunk `pending` (denied) or `apply_failed` (executed and failed). The user MUST be able to retry, edit the hunk and re-submit, or reject. |
| R82 | A hunk whose preimage no longer matches the live file MUST be re-fetched and re-diffed; a stale preimage MUST render a conflict banner with three options: re-read and re-diff, skip, or open the file externally. The kernel's `stale_preimage` denial MUST be shown verbatim. |
| R83 | Two hunks touching the same file MUST be submitted as separate effects (the inherited preimage rule); the viewer MUST detect this and warn before multi-accept, and MUST precompute the post-first-hunk preimage for the second. |
| R84 | The diff viewer MUST be usable while the agent keeps working: hunks may arrive while the user reviews; new hunks append to `pending` without moving the selected hunk or the viewport, and the rail MUST show `+N new`. |
| R85 | Performance: a 10 000-line diff MUST first paint in ≤250 ms, scroll at ≤16 ms per frame, and search (`/`) in ≤100 ms. Files above 5 000 changed lines MUST be rendered lazily with a `render-lazily` marker. |
| R86 | The viewer MUST offer `export hunk bundle` producing a patch with the same digests it would submit to the kernel, so an out-of-band reviewer can reproduce the apply exactly. The exported bundle MUST be recorded as an artifact (`hz://artifact/<sha256>`). |

### 2.8 Approval prompts

| # | Rule |
|---|---|
| R87 | An approval prompt MUST be triggered by `hz.permission.asked` and MUST render, at minimum: capability ID, effect class, origin kind, workspace-relative target, the sandbox mode that will confine the effect, the policy revision digest, the reason code from the `GuardDecisionV1`, the exact effect body (R88), the expiry of the ask, and the decision buttons with a description of what each persists. |
| R88 | **Show the exact effect.** The prompt MUST render the same normalized effect the kernel will evaluate, byte-for-byte where the effect is a command or a diff: |
| | · `Shell` — the exact argv after shell-AST normalization, the cwd, the environment keys added (values redacted), and the resolved binary path. Never a prose summary; if the command is dynamic (substitution, `eval`, `-c`, parse failure) the prompt MUST say `dynamic — cannot be shown exactly` and MUST default to deny on `enter`. |
| | · `Edit`/`files.patch` — the unified diff with digests, plus a count of lines added/removed and a link to the full `DiffView`. |
| | · `Network` — scheme, host, port, path, method, the egress proxy that will carry it, and the byte size if known. |
| | · `Credential` — the credential *handle*, the vault key id, the requesting origin, and the scope; the secret value MUST NEVER be rendered, logged, or put in the transcript. |
| | · `Remote`/`external-effect` — the endpoint, the payload digest, and whether the effect is idempotent by declaration. |
| R89 | If the TUI cannot render the effect exactly (missing renderer, unknown effect class, truncated body above the display limit), it MUST show `effect not renderable` and the allow options MUST be disabled; only deny and inspect-receipt remain enabled. Fail closed. |
| R90 | Decisions and what they persist: |
| | · `allow once` — nothing persists; the lease is one-use. |
| | · `allow session` — writes a session-scoped rule bound to the capability ID **and** the normalized effect digest; MUST NOT generalize to a family unless the effect itself is a family pattern the user explicitly typed. |
| | · `allow workspace` — writes a workspace grant (policy rule or `DirectSessionGrant`) with an explicit expiry, the workspace path, the policy revision it was created under, and the digest of the effect it was shown for. It MUST be listed in `hzcode policy list --grants`. |
| | · `deny` / `deny always` — a deny persists as an explicit deny rule (highest precedence, `deny > ask > allow`) and MUST be shown in `/doctor` and in the posture indicator. |
| R91 | The prompt MUST state plainly which of the four decisions is reversible and how (`/grants revoke <id>`, `hzcode policy revoke`). |
| R92 | `credential`-class asks MUST NOT offer `allow workspace`; the maximum persistence allowed is session-scoped, and the option MUST be absent rather than disabled-looking. |
| R93 | A batch (multiple tool calls in one step) MUST render as one card listing every effect, with per-effect decisions and a batch action; approving the batch MUST produce one decision per effect, never a synthetic umbrella decision. |
| R94 | The prompt MUST show a countdown when the ask expires, and MUST render the terminal state (`expired`, `cancelled`, `answered`) rather than disappearing silently. |
| R95 | Every decision MUST be recorded as `hz.permission.answered` with the decision, the scope, the effect digest, and the `posture.revision` it produced; the TUI MUST render the resulting posture change in the status bar immediately. |
| R96 | The approval card MUST be keyboard-complete: approve, deny, inspect the full intent digest, open the receipt inspector, and copy the effect to the clipboard. Nothing in an approval MUST require a mouse. |
| R97 | An approval that arrives while the user is typing MUST NOT steal the draft: it may take keyboard focus (it is blocking) but the composer draft MUST be preserved byte-for-byte and restored on close. |
| R98 | The TUI MUST NOT offer "always allow" from anywhere except this card, and MUST NOT persist any decision the user did not make in this card (no implicit upgrades from repeated `allow once`). |

### 2.9 Transcript

| # | Rule |
|---|---|
| R99 | The transcript MUST be a windowed list over the session projection; the TUI MUST NOT hold the whole transcript in memory. The window MUST be configurable with a default of 5 000 materialized blocks and MUST support jumping to any turn without materializing the rest. |
| R100 | Blocks MUST have a default fold policy declared per block type (`thinking` collapsed, `edit` diff expanded or collapsed per config, `shell` output collapsed beyond N lines, `search` collapsed). The policy MUST be data, not code branches. |
| R101 | A manual fold MUST be pinnable: with `respect_manual_folds` enabled, streaming updates and finish events MUST NOT reset a hand-folded block. Expanding a manually folded block while auto-follow is on MUST stop auto-follow. |
| R102 | Auto-follow MUST resume on: new user prompt, `G`/`End`, scrolling past the bottom, or selecting the last block. The "following" state MUST be visible in the status bar. |
| R103 | Sticky turn headers: the current user turn MUST stay pinned at the top of the viewport while its blocks scroll, showing turn index, elapsed time and cost-to-date. |
| R104 | Search MUST be incremental over the session's search index (BM25/FTS5 over blocks, with the session log as authority), with in-place match highlighting, `n`/`N` navigation, a match count, and a "search the whole session, not just the window" rule. |
| R105 | Copy: block content (`y`), block metadata such as the command (`Shift+Y`), a selection (R31), and the whole turn as Markdown. Copy MUST record no event and MUST NOT be receipted (it is read-only), but MUST be listed in the debug HUD counter. |
| R106 | Paste MUST use bracketed paste (mode `2004`). A paste MUST NOT auto-submit. A paste above the chip threshold (default 20 lines or 4 000 bytes) MUST collapse to a chip showing line/byte counts and a hash, expandable in place, and MUST be sent whole. |
| R107 | Model-authored text MUST be rendered with escape sequences escaped; OSC/CSI/APC sequences in model output (including `OSC 52`, `OSC 8`, title-setting and clipboard writes) MUST be neutralized and shown as literal text with a marker. |
| R108 | Links: URLs MUST be rendered with `OSC 8` hyperlinks when the terminal supports it and as a link-mapped region otherwise; the link map MUST be hit-testable for mouse open. Opening a link MUST go through the OS opener as a declared effect (`net.fetch` or an opener capability) with its own approval policy — never a silent browser launch. |
| R109 | Link text MUST NOT be trusted over its target: the rendered label and the real target MUST both be shown on hover/selection, and a mismatch MUST be visibly flagged. |
| R110 | Attachments and images MUST display through the best available terminal graphics protocol in this order: Kitty graphics, iTerm2 inline images, Sixel, then a text placeholder card. Detection MUST be reported by `/doctor`. |
| R111 | The fallback card MUST show: kind, dimensions or duration, byte size, sha256, the `hz://artifact/<sha256>` URI, and the producing receipt. It MUST be copyable and MUST be openable in the OS viewer as a declared effect. |
| R112 | Untrusted media MUST NOT be decoded in-process: image/video/diagram rendering MUST happen in a short-lived child process with a wall-clock timeout and a memory cap, and the TUI MUST render only the returned frame. A renderer crash MUST degrade to the placeholder card (R111) and MUST NOT take down the TUI. |

### 2.10 Theming

| # | Rule |
|---|---|
| R113 | Theming MUST use semantic tokens, never raw colors at call sites. The token set MUST include at minimum: `background`, `backgroundPanel`, `backgroundElement`, `text`, `textMuted`, `textInverted`, `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info`, `border`, `borderSubtle`, `selection`, `diffAddedBg`, `diffAddedFg`, `diffRemovedBg`, `diffRemovedFg`, `diffContextBg`, `diffLineNumberBg`, `scrollbarTrack`, `scrollbarThumb`, `statusOk`, `statusWarn`, `statusBad`, `statusUnknown`, `chip`, `chipActive`. |
| R114 | A component MUST reference only tokens. A literal color in a component MUST fail the theme lint. |
| R115 | Color capability MUST be detected at startup and re-checked on `SIGWINCH` and on terminal-focus: `truecolor` (24-bit), `256`, `16`, `none`. Detection order: `NO_COLOR` ⇒ none; `COLORTERM=truecolor|24bit` or `TERM` matching `*-truecolor*` ⇒ truecolor; `TERM` matching `*-256color*` ⇒ 256; else 16. Overrides: `--color`, `HZ_COLOR`, config `[terminal] color = auto|truecolor|256|16|none`. |
| R116 | All theme colors MUST be authored as RGB and quantized at startup through one pipeline to the detected level (nearest indexed entry for 256; nearest ANSI name for 16). Runtime-generated colors (syntax highlighting, diff tints) MUST pass through the same pipeline. |
| R117 | Light/dark MUST be derived from the terminal's reported default background luminance (`0.299R + 0.587G + 0.114B > 0.5` ⇒ light) when the terminal reports it; otherwise from `[theme] mode = auto|dark|light` with `auto` defaulting to dark. Theme selection MUST be upgradeable at runtime without restarting the session. |
| R118 | A `high-contrast` theme MUST exist whose tokens use only 16-color-safe values, no background tints for diffs (uses `+`/`-`/`~` prefixes and underline instead), and no alpha blending. It MUST be selectable by name and by the `--contrast` flag, and MUST be the default when `16`-color capability is detected with `[theme] high_contrast_on_16 = true`. |
| R119 | Theme files MUST be TOML, MUST be validated against the token set, MUST support inheritance (`extends = "horizon-dark"`), and MUST fail loudly on unknown tokens. |
| R120 | Themes MUST be distributable as plugins and through the marketplace, signed, with a declared minimum color level and a `preview` grid the picker renders without applying. |
| R121 | `no-color` mode MUST emit no SGR color escapes at all (attributes such as bold/underline MAY remain, gated by `[theme] attributes_in_no_color`). All meaning carried by color MUST be carried by a glyph or word in this mode: diff states (R77), statuses (R162), error severities, and selection (inverse video instead of a color). |
| R122 | Color MUST NOT be the only channel for any meaning, in any mode. A test MUST scan the component registry for color-only semantics. |
| R123 | Syntax highlighting MUST be provided by an in-process tokenizer with a token budget per frame (R65) and MUST degrade to plain text under load or in `no-color` mode, naming the language in the block header so the reader is not misled. |
| R124 | The theme picker MUST preview by re-rendering a fixed sample (a transcript excerpt, a diff, an approval card, a status bar) and MUST list each theme's detected compatibility (`truecolor only`, `256+`, `16-safe`, `no-color safe`). |

### 2.11 Accessibility and layout

| # | Rule |
|---|---|
| R125 | A `screen-reader` mode MUST exist, enabled by `--screen-reader`, `HZ_SCREEN_READER=1`, or a config setting. It MUST force `inline` mode (R5), disable alt-screen, disable mouse capture by default, disable animations, and disable in-place repainting of anything above the current line. |
| R126 | In screen-reader mode every state change MUST be announced as exactly one new, complete line with a stable prefix grammar: `turn <n> start`, `tool <capability> start <target>`, `tool <capability> done <status> <duration>`, `ask <capability> <effect-class>`, `barrier <kind>`, `error <capability> <reason-code>`, `unknown <receipt-id>`. Spinners, progress animations and partial repaints MUST NOT be emitted. |
| R127 | Reduced motion MUST be honored from `[animation] enabled = false`, `HZ_REDUCED_MOTION=1`, and the platform's reduced-motion preference where detectable. In reduced motion the TUI MUST NOT animate spinners, wave/blend effects or typewriter text; progress MUST be shown as a step counter. |
| R128 | Layout MUST be responsive with documented breakpoints: `wide ≥120`, `standard 100–119`, `compact 72–99`, `narrow 52–71`, `minimal 40–51`. Each component table entry (R13) MUST declare its behavior at each breakpoint (side-by-side diff collapses to unified at `compact`; the status bar drops segments in a declared priority order at `compact` and below). |
| R129 | Status-bar segment drop order MUST be declarative and documented, and the dropped information MUST remain reachable from the palette or the status detail modal. Dropping MUST NOT hide: posture, kernel health, or an unreconciled `UNKNOWN` (these three MUST compress, not disappear). |
| R130 | Below the minimum size (40 columns × 10 rows) the TUI MUST NOT attempt an interactive layout: it MUST print one line naming the required minimum and the current size, then either (a) offer inline mode if the terminal could fit it, or (b) exit with code 2. It MUST NOT render a broken frame. |
| R131 | Terminal support detection MUST produce a capability record: name/version, color level, unicode width behavior, mouse modes honored, bracketed paste, `OSC 8` links, `OSC 52` clipboard, graphics protocol, notification protocol, bypass modifier, alt-screen honored, and known-stripping relays (ConPTY). The record MUST be visible in `/doctor` and MUST be saved in the session's diagnostics attachment on demand. |
| R132 | Grapheme handling MUST be correct for combining marks, emoji sequences (ZWJ, variation selectors, skin tones, flags) and CJK/wide characters: wrapping MUST be cluster-based and the composer cursor MUST move by cluster, never by code unit. |
| R133 | RTL text MUST render with correct visual ordering within a line and MUST NOT be reordered across lines; a bidi isolation rule MUST apply to embedded LTR spans (paths, commands, URLs). A known-limitation notice MUST be shown by `/doctor` when the terminal's bidi handling is unknown. |
| R134 | IME composition MUST be supported: composition text MUST be shown in the composer with a distinct underline, MUST be cancelable with the IME's own cancel chord, and MUST NOT submit until the composition commits. Keys arriving mid-composition MUST reach the IME, not the keymap. |
| R135 | Every interactive affordance MUST have a keyboard path (no mouse-only feature) and an accessible name (the string a screen reader would announce). A test MUST assert every registered action has a name and a binding in the `simple` preset. |
| R136 | The composer MUST support voice dictation as an input source when `hz_voice` is available, with streaming partial text marked as provisional, and MUST route transcribed text through the ordinary draft path (never auto-submit). |

### 2.12 Performance budgets

| # | Rule |
|---|---|
| R137 | Input latency: keystroke → visible glyph MUST be < 16 ms at p50 and < 33 ms at p99, measured in the process from input event to frame write, with the streaming load of R69 applied. |
| R138 | First paint: process start → first complete frame MUST be < 100 ms at p50 and < 150 ms at p95 on the reference machine, with a warm session store. Anything non-essential to the first frame MUST be deferred past it with an explicit deadline. |
| R139 | Deferred work MUST NOT block input once the first frame is up; a startup scan that exceeds its deadline MUST be abandoned with a diagnostic and retried in the background. |
| R140 | Sustained streaming: 1 000 lines/s for 60 s MUST NOT drop a keystroke, MUST NOT drop a durable event, and MUST keep p99 input latency < 33 ms (degradation per R67 is allowed and MUST be visible). |
| R141 | Memory: steady-state RSS MUST be ≤ 250 MB with a 100 000-line session loaded and 5 000 materialized blocks; the ceiling MUST be enforced by windowing (R99) and MUST be asserted by a soak test that fails above 300 MB. |
| R142 | Frame cost: a full repaint of a 120×36 screen MUST be ≤ 3 ms; a differential repaint of one streaming block MUST be ≤ 1 ms; a resize repaint MUST be ≤ 16 ms. |
| R143 | Scroll costs MUST be O(visible): a 16 ms frame budget MUST hold while scrolling a 100 000-line session at 20 notches/s. |
| R144 | The TUI MUST NOT write to disk in the render path or the input path. Draft persistence, MRU updates and diagnostics MUST be debounced (≥250 ms) and off the critical path. |
| R145 | The TUI MUST NOT perform network I/O in-process; all model, web and server traffic goes through the Controller or the local server, so a slow network cannot stall a frame. |
| R146 | Budgets MUST be measured by a committed benchmark harness that runs in CI in a PTY, and MUST be reported in `hzcode bench tui`; a regression above 20 % MUST fail the gate. |

### 2.13 Session-management UI

| # | Rule |
|---|---|
| R147 | `SessionPicker` MUST list sessions with: title (agent-generated, editable), workspace path, last-activity age, turn count, token totals, cost (with an `incomplete` marker when the ledger is partial), model(s), git branch, and whether it is live (attached to a running leader). |
| R148 | The picker MUST support: resume, fork-at-turn, rewind-to-turn, rename, archive, delete (with a receipt), and export (JSONL/Markdown). Fork and rewind MUST preview the affected turn range and MUST be receipted. |
| R149 | Rewind MUST be turn-granular (`hz.session.rewound`), MUST show what will be discarded (messages, tool results, file snapshots), and MUST state whether workspace snapshots will be restored or left as-is. It MUST NOT silently restore files. |
| R150 | The session tree view MUST render parent/child sessions (subagents, fleets, teams) with per-node status, depth, capability narrowing summary, budgets consumed, and cost rolled up to the root. A child whose authority was widened MUST be impossible by construction; if the projection disagrees, the tree MUST render `authority mismatch` and block further dispatch. |
| R151 | Cost display MUST show session, tree and (when configured) currency; MUST mark partial ledgers; and MUST NOT zero-fill unknown costs (an unknown cost renders as `UNKNOWN`, never `$0.00`). |
| R152 | Budget display MUST show each active budget (tokens, steps, wall clock, cost, triage, web search) with remaining quantity and the action taken at exhaustion; a budget that has been exceeded MUST render its terminal state. |
| R153 | Context display MUST show: tokens used against the model's window, the compaction trigger ratio, last compaction event and strategy, and the projected tail size. |
| R154 | All of R147–R153 MUST be reachable from the TUI, from `--print` output modes (R185), and from the local server (doc `14-surfaces.md`); there MUST NOT be a session-management capability only the mouse can reach. |
| R155 | Deleting or archiving a session MUST go through the Controller and MUST be receipted; the TUI MUST NOT unlink files itself. |
| R156 | `hz://session/<id>` MUST be the canonical identity shown everywhere (status bar, notifications, share links); display names are labels, never identity. |

### 2.14 Status surfaces

| # | Rule |
|---|---|
| R157 | `StatusBar` MUST be composed of segments with declared priority: `posture`, `kernel`, `progress`, `model`, `tokens`, `cost`, `budget`, `barrier`, `coarse/mode`, `hints`. |
| R158 | `posture` MUST show the effective posture (`allow`/`ask`/`deny`), the policy revision digest (short form), and whether the posture was narrowed by a workspace config or a grant; hovering/selecting it MUST open the policy modal with the compiled rule list. |
| R159 | `kernel` MUST show kernel health: `ok`, `absent (read-only)`, `version-mismatch`, `crashed (restarting)`, plus the count of unreconciled `UNKNOWN` effects. A non-`ok` kernel MUST be rendered with a text label, not just a glyph, and MUST be present at every breakpoint (R129). |
| R160 | `progress` MUST show the current phase (thinking, streaming, tool `<capability>`, waiting-approval, compacting, idle) and, during tools, the tool's target; a completed step MUST leave a one-line trace in the transcript rather than being erased from the bar. |
| R161 | `model` MUST show planner and executor models separately when dual-model routing is active, with the routing decision (`executor-only`, `light`, `full`, `plan-for-approval`, `plan-only`) as a chip. |
| R162 | `barrier` MUST be rendered when the run cannot proceed without a human: approval pending, question pending, budget exhausted, plan awaiting approval, or `UNKNOWN` awaiting reconciliation. A barrier MUST change the bar's leading glyph and the hint line, and MUST NOT be dismissable. |
| R163 | Every numeric status value MUST carry its provenance: tokens from `hz.usage.recorded` with the ledger id, cost from the ledger with a partial marker, budget from the budget scope with its id. A number whose provenance is unavailable MUST render `UNKNOWN`. |
| R164 | The status bar MUST be clickable per segment (mouse) and keyboard-reachable (`Tab` into it from the composer), with the focused segment's detail modal on `Enter`. |
| R165 | Status updates MUST be rate-limited to one repaint per 100 ms for volatile segments (tokens, elapsed) and immediate for state transitions (posture, kernel, barrier). |
| R166 | A status value MUST NOT be able to lie by omission: a hidden or dropped segment (R129) MUST leave a marker (`…`) in the bar. |

### 2.15 Errors, `UNKNOWN`, and receipts

| # | Rule |
|---|---|
| R167 | Every error rendered MUST include: capability ID (when an effect was involved), `reason_code`, a human sentence, the receipt id if one exists, and an explicit `retryable: yes/no`. A bare "something went wrong" is a bug. |
| R168 | Errors MUST be rendered at the place they belong (in the `ToolCallCard`, in the composer for admission errors, in the status bar for system errors) and MUST also be listed in a `/errors` modal with stable ordering by time. |
| R169 | `UNKNOWN` MUST be a first-class visual state, never styled as an error and never auto-retried: it renders as a distinct chip (`UNKNOWN` + receipt id + effect class) with three actions: `Inspect receipt`, `Reconcile now`, `Export evidence bundle`. |
| R170 | The `UNKNOWN` chip MUST persist in the status bar until reconciliation completes (`hz.effect.reconciled`), and MUST block any new effect that would depend on the same resource, with an explanation of which resource and why. |
| R171 | `UNKNOWN` MUST NOT be summarized away by a generated completion message: if the session contains an unreconciled `UNKNOWN`, the completion banner MUST say so and `verify` MUST be runnable from the banner. |
| R172 | The receipt inspector MUST render a receipt's full structure: `receipt id`, capability ID, origin kind, intent digest, policy revision, lease id, timestamps, observation (stdout/stderr digests, exit code, file digests), terminal state rendered as the RC-7 value verbatim (`succeeded`, `failed`, `denied`, `cancelled`, `unknown`, `budget_exhausted`, `timeout`, `interrupted` — a `cancelled` or `timeout` receipt MUST NOT display as `failed` or `unknown`), reconciliation attempts, and links to the parent session, the tool call, the artifacts and the child receipts. |
| R173 | The inspector MUST be reachable from: the `ToolCallCard` (`Ctrl+I`), the `UNKNOWN` chip, the palette (`hz://receipt/<id>`), the CLI (`hzcode receipt show <id>`), and any surface that displays a receipt id (doc `14-surfaces.md`). |
| R174 | The inspector MUST offer `verify receipt chain` for the session, rendering the independent-evidence gate result (claims that were lowered, with the contradicting receipt). |
| R175 | The TUI MUST NOT render a tool result as success when the terminal state is not `succeeded`; a `denied` effect renders as denied with the reason code, and a tool that returned data while the effect was denied MUST render both facts. |
| R176 | Truncated content MUST be labelled with what was truncated, the original size, and where the full content lives (`hz://session/<id>/part/<id>` or `hz://artifact/<sha256>`). Silent truncation is a bug. |

### 2.16 Notifications

| # | Rule |
|---|---|
| R177 | The TUI MUST support three notification channels, independently configurable: terminal bell (`\a`), desktop notification (via terminal notification protocol where supported, else the platform notifier), and webhook. |
| R178 | Default policy: bell off, desktop notification on for the events `turn complete`, `approval needed`, `budget exhausted`, `UNKNOWN raised`, `run failed`, and only when the terminal or window is unfocused. All other events MUST be opt-in by name. |
| R179 | Notifications MUST be rate-limited (default: one per event kind per 10 s) and MUST coalesce repeats into a count. |
| R180 | Every notification body MUST be minimal and non-sensitive by default: session id, event kind, state, elapsed, cost if available. Transcript content, file contents, command text and credential context MUST NOT be included unless the user enables `include_content` explicitly. |
| R181 | Webhooks MUST be opt-in, MUST sign the body (HMAC-SHA256 with a vault-stored secret), MUST include a timestamp and a nonce, MUST retry with bounded backoff, and MUST log every delivery attempt (including failures) to the session's operations log. |
| R182 | Egress MUST be visible and disableable (ADR-013): `hzcode config show egress` MUST list every outbound notification destination, and `--offline` MUST disable all of them. |
| R183 | A notification MUST NOT be the only place a fact appears: anything notified MUST also be a visible state in the TUI and an event in the log. |
| R184 | Notification delivery failure MUST NOT block the run and MUST NOT be silent: it renders a one-line warning in the transcript. |

### 2.17 Non-interactive output modes

| # | Rule |
|---|---|
| R185 | The same renderer pipeline MUST serve `--print`, `--output json`, `--output jsonl` and `--output plain`. Non-interactive modes select a render target, not a second code path: the block model, the diff model and the error model are identical to the TUI's. |
| R186 | Output channels: the selected format writes to stdout; every diagnostic, warning, progress and log MUST go to stderr. A non-interactive run MUST NOT write an escape sequence to stdout when stdout is not a TTY. |
| R187 | `--print` (alias `-p`) MUST accept the prompt, run the turn, print the final assistant text to stdout, and exit with the codes in §5. |
| R188 | `--output plain` MUST stream assistant text as it arrives, with tool activity rendered as single lines to stderr. It MUST be pipeable and MUST NOT emit control sequences. |
| R189 | `--output json` MUST print exactly one JSON object on stdout at the end, matching the schema `HeadlessResultV1` in §3.5. Errors MUST print an error object of the same schema family with `"type": "error"` and MUST set a non-zero exit code. |
| R190 | `--output jsonl` MUST print one JSON object per line, each with a `type` discriminator, in causal order, and MUST always terminate with an `end` line (or an `error` line). The event kinds are fixed in §3.5. |
| R191 | Every spend number in non-interactive output MUST carry the same provenance rules as the TUI: cache buckets separate from uncached input, `incomplete` markers, and cost omitted (not zero-filled) when partial. |
| R192 | `--json-schema <path>` MUST constrain the model's structured output and MUST be echoed in the result object as `structured_output`; a schema violation MUST be an error with the validation failure attached, not a silently empty result. |
| R193 | The non-interactive JSON MUST include `sessionId` and `hz://session/<id>`, so a caller can resume, inspect receipts or open the web app on the same session. |
| R194 | Tool approval in non-interactive modes MUST be explicit policy, never an interactive prompt: `--posture allow|ask|deny`, `--allow <rule>`/`--deny <rule>`, or a config posture. An `ask` decision in a non-interactive mode MUST resolve to `deny` (fail closed) and MUST be reported in the result as a denial with its reason code. |
| R195 | Exit codes are canonical (`docs/14-surfaces.md` §3.2): `0` success; `1` error; `2` usage, configuration or environment error (bad flags, invalid keybindings/theme, terminal too small, unusable workspace); `3` fail-closed — an outcome that cannot be proven or guaranteed (kernel absent or mismatched, an `ask` with no answerer, an unreconciled `UNKNOWN`); `4` policy denial (`Guard` returned `DENY` and the run stopped); `5` budget exhaustion; `130` SIGINT; `143` SIGTERM. |
| R196 | The parity ratchet (doc `14-surfaces.md` §2.11 (j)) MUST treat "renders in the TUI" and "is emitted in `--output jsonl`" as one capability with two projections: adding a UI-only state fails the build. |

### 2.18 Composer queue, rich input, and completion surfaces

| # | Rule |
|---|---|
| R197 | The queue panel MUST allow editing and reordering of queued prompts before dispatch (NF-062): reorder via move-up/move-down or drag, delete with confirmation. A queue edit MUST be recorded as an input mutation (doc 08 admission rules); reordering changes scheduling order only and MUST NOT bypass the Safe Step Boundary — steering semantics are unchanged. |
| R198 | An item under admission MUST be visually locked (`dispatching`) and MUST NOT be editable or reorderable while its admission is in flight; if the user edits during admission, the edit applies to the next admission attempt, never to the in-flight one. Each queued item MUST show when it will be delivered (next safe step boundary, next turn start, or after the running turn). |
| R199 | Fenced code blocks in transcript and composer preview MUST render with a language header: an explicit info string wins; absent one, the TUI MAY apply content heuristics (shebang, keywords, filename hints) and MUST render the detected language as a hint (`lang:rust?`) distinct from the declared form. Detection is display-only: it MUST NOT alter content, affect tool inputs, or claim authority. RTL/LTR bidi rules (R133) apply inside code blocks unchanged. |
| R200 | Composer attachments: pasted images and files MUST become chips showing kind, byte size, sha256, and a preview thumbnail rendered per the R110 protocol order; untrusted media follows R112 (out-of-process decode). Sending MUST reference the stored `hz://artifact/<sha256>` URI — binary content MUST NOT be inlined into the message text, and an attachment's ingestion MUST be visible in the debug HUD counter. |
| R201 | A completed run MUST leave a one-line completion summary pinned at the end of its turn (files touched, receipts settled, spend, and any `UNKNOWN` pending reconciliation), jumpable via `G` and by the turn header. The summary MUST be derived from receipts and the ledger, never from model prose; an `UNKNOWN` item in the summary MUST link to the reconciliation flow (R169–R170) and block a green "complete" state. |

---

## 3. Interfaces

### 3.1 Types owned by this document

All are `[planned]` in `packages/tui/src/types.ts` and generated from schemas where a wire contract is involved (`packages/protocol`).

| Type | Shape (abridged) | Notes |
|---|---|---|
| `TuiMode` | `"fullscreen" \| "inline"` | R1; persisted per workspace. |
| `ScreenMode` | `{ mode: TuiMode; reason: "flag" \| "env" \| "config" \| "auto"; colorLevel: ColorLevel; isTty: boolean }` | R3, R115, R131. |
| `LayoutVersion` | opaque integer | Bumped on resize, mode switch, breakpoint change; invalidates hit rects (R25). |
| `HitRect` | `{ region: RegionId; x; y; w; h; layoutVersion; occludedBy?: RegionId; action: KeymapActionId \| MouseAction }` | Registered per frame; the *only* source for hit-testing. |
| `MouseState` | `{ captured: boolean; requested: boolean; lastReassertAt: number; degradedX10Seen: boolean; bypassModifier: "shift" \| "alt" \| "none" }` | R24, R34, R35, R36. |
| `TerminalCaps` | see R131 field list | Produced by `detectTerminalCaps()`; serializable for `hzcode doctor --json`. |
| `ThemeToken` | union of the R113 token names | A literal color fails lint (R114). |
| `ColorLevel` | `"truecolor" \| "256" \| "16" \| "none"` | Quantization pipeline input. |
| `KeyBinding` | `{ id: KeymapActionId; keys: KeyStroke[]; repeat?: 1 \| 2 \| 3; contexts: Context[]; description: string; source: "default" \| "preset" \| "user" \| "workspace" }` | R37, R44, R48 (graded repeats). |
| `KeyStroke` | `{ name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean; super?: boolean }` | Order-insensitive, canonicalized for display. |
| `SlashEntry` | `{ name; aliases; description; argumentSchema; executionKind; surfaces: SurfaceId[]; requiresApproval: boolean; receiptClass; source }` | R54. |
| `BlockView` | `{ id; kind: BlockKind; foldState: "expanded" \| "collapsed" \| "pinned"; streamState: "idle" \| "streaming" \| "interrupted" \| "complete"; coarse: boolean; provenance: ProvenanceKey }` | R99–R103, R68, R163. |
| `HunkView` | `{ id; file; preimageDigest; postimageDigest; linesAdded; linesRemoved; state: HunkState; receiptId?: string; reasonCode?: string }` | R77–R82. |
| `ApprovalView` | `{ approvalId; capabilityId; effectClass; originKind; target; sandboxMode; policyRevision; reasonCode; effectBody: EffectBody; expiresAt; options: ApprovalOption[] }` | R87–R98. |
| `EffectBody` | tagged union: `Shell \| FilePatch \| Network \| Credential \| Remote \| Unrenderable` | R88–R89; `Unrenderable` disables allows. |
| `UnknownChip` | `{ receiptId; capabilityId; effectClass; resourceKey; since; reconcileAttempts }` | R169–R171. |
| `StatusSegment` | `{ id; priority; render(props): Cells; provenance: ProvenanceKey }` | R157–R166. |
| `UiEventV1` | envelope (`eventId`, `cursor`, `lane: "durable" \| "ephemeral"`, `kind`, `timestamp`, `payload`) | Local TUI type, named per `_conventions.md` §7; the lane split is adopted from `source: /data/home/forge/repo-tour/horizoncode/arch_V1/contracts-v2/ui-stream-event-v2.schema.json`, which is a reference schema and is not declared in `docs/05` |
| `HeadlessResultV1` | see §3.5 | Output contract R189. |

### 3.2 Event → render table (every TUI-relevant event)

Lane: `D` = durable (from the log, replayable), `E` = ephemeral (UI only, droppable and re-derivable). Column *Default* describes what the user sees with default settings.

| Event | Lane | Renders as | Default | Rule |
|---|---|---|---|---|
| `hz.session.created` | D | session header line + `SessionPicker` row | visible | R147 |
| `hz.session.prompt.admitted` | D | user `MessageBlock` + queue/steer chip in `Composer` | visible | R55 |
| `hz.session.claim.acquired` | D | nothing (debug HUD counter) | hidden | R51 |
| `hz.session.claim.released` | D | debug HUD counter | hidden | R51 |
| `hz.session.busy.entered` | D | `StatusBar.progress = busy`; `running` marker in picker | visible | R160 |
| `hz.session.busy.left` | D | `StatusBar.progress = idle`; turn trace line | visible | R160 |
| `hz.step.started` | D | turn header phase `step N`; sticky header update | visible | R103 |
| `hz.step.llm.requested` | D | `ThinkingBlock` header spinner + model chip | visible | R72 |
| `hz.step.llm.delta` | E | appended text into the streaming `MessageBlock` (coalesced ≤16 ms) | visible | R63–R71 |
| `hz.step.llm.completed` | D | finalize block (markdown reflow, token count, duration) | visible | R66, R73 |
| `hz.step.tool.requested` | D | new `ToolCallCard` with capability chip + effect-class chip | visible | R21 |
| `hz.step.tool.completed` | D | `ToolCallCard` result + status glyph + receipt id | visible | R80, R175 |
| `hz.part.created` | D | new `MessageBlock`/part (thinking, text, tool, media) | visible | R14 |
| `hz.part.updated` | D | patch the part in place (streaming reconciliation) | visible | R63 |
| `hz.plan.updated` | D | plan panel + `plan` chip; plan-approval barrier when gated | visible | R162 |
| `hz.todo.updated` | D | todo panel with counts; `StatusBar` task counter | visible | R157 |
| `hz.goal.updated` | D | goal chip in status; goal detail panel | visible | R164 |
| `hz.effect.decision.made` | D | posture/last-decision chip; policy modal history | visible | R95, R158 |
| `hz.effect.lease.issued` | D | `ToolCallCard` lease line | visible | R80 |
| `hz.effect.settled` | D | `ToolCallCard` terminal state + receipt link; diff hunk state | visible | R175 |
| `hz.effect.unknown` | D | **`UNKNOWN` chip** in status + barrier + block chip | visible, persistent | R169–R171 |
| `hz.effect.reconciled` | D | clears the chip; appends a reconciliation trace block | visible | R170 |
| `hz.session.compacted` | D | compaction trace block (strategy, tokens before/after) | visible | R153 |
| `hz.session.checkpoint.created` | D | rewind entry in the session picker / rewind list | visible | R148 |
| `hz.session.rewound` | D | transcript truncation banner + receipt link | visible | R149 |
| `hz.session.forked` | D | new session banner + picker row; old session marked `forked` | visible | R148 |
| `hz.agent.spawned` | D | child session appears in tree + inline `task` card | visible | R150 |
| `hz.agent.completed` | D | child card terminal state + cost roll-up update | visible | R150, R151 |
| `hz.agent.message.sent` | D | message chip on the child card (expandable) | collapsed | R100 |
| `hz.memory.retained` | D | memory trace block; memory browser badge count | collapsed | R100 |
| `hz.memory.recalled` | D | `RecalledBlock` listing facts with provenance | collapsed | R100 |
| `hz.skill.invoked` | D | skill card (name, source, arguments digest) | visible | R53 |
| `hz.skill.installed` | D | toast + `/skills` list update | visible | R53; `15-extensibility.md` §4.2 |
| `hz.learn.trajectory.recorded` | D | debug HUD counter; learn panel row | hidden | R51 |
| `hz.learn.proposal.created` | D | proposal card with `review` action (never auto-applied) | visible | R162 |
| `hz.learn.eval.completed` | D | eval panel row (pass/fail counts, regression flag) | collapsed | R100 |
| `hz.permission.asked` | D | **`ApprovalPrompt`** (blocking card) + barrier + notification | visible, blocking | R87–R98 |
| `hz.permission.answered` | D | card closes; posture chip updates; decision line in transcript | visible | R95 |
| `hz.policy.revision.changed` | D | posture chip flashes; policy modal diff view | visible | R158 |
| `hz.error.raised` | D | inline error cell (capability, reason code, retryable) + `/errors` | visible | R167 |
| `hz.usage.recorded` | D | token/cost segments with provenance; context bar | visible | R73, R163 |
| `ui.present` (**capability, not an event**) | — | the affordance a tool or plugin asks the TUI to show; it arrives as the tool-call result, not as a log event | visible if permitted | R14, R21 |

**Client-local UI frames (`[planned]`, lane `U`).** The rows below are frames of the front-end, not facts of record: they never enter the log, they are not in `_conventions.md` §6's 44-event catalogue, and their names are `[planned]` until a UI lane is registered there (RC-11). A front-end that dies mid-frame loses nothing durable.

| Event | Lane | Renders as | Default | Rule |
|---|---|---|---|---|
| `[planned]` `ui.toast` | U | toast stack in `ModalHost` | visible | R183 |
| `[planned]` `ui.focus.changed` | U | focus indicator; mouse capture re-assertion check | visible | R27, R34 |
| `[planned]` `ui.resize` | U | full repaint; layout version bump; hit-rect invalidation | visible | R11, R25 |
| `[planned]` `ui.caps.changed` | U | re-detect caps; requantize theme; may downgrade graphics | visible | R115, R131 |
| `[planned]` `ui.mode.switch.requested` | U | relaunch handshake (draft + cursor preserved) | visible | R4 |
| `[planned]` `ui.degradation.changed` | U | `coarse` badge with counts | visible | R68 |
| `[planned]` `ui.input.latency` | U | debug HUD only | hidden | R51 |
| `[planned]` `ui.render.frame` | U | debug HUD only (frame time, dropped frames) | hidden | R51 |

Rule: a new event kind MUST add a row to this table in the same change; an event with no renderer MUST fail the ratchet (R22, R196).

### 3.3 Layout: the default screen at 120×36

Column ruler (`1`–`120` in tens) is not part of the frame; it is shown to make annotations checkable.

```text
        10        20        30        40        50        60        70        80        90       100       110       120
┌ HorizonCode ────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ feat/parser · hz://session/4d61c9a8 · turn 12 · 6m14s · kernel ok · ask r12.3f9c ──────────────────── 47.2k/200k │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ turn 12 · you · 16:42                                                                                $0.0812    │
│   refactor the tokenizer to reject unterminated strings, keep the error message exact                                │
│                                                                                                                       │
│ ▾ assistant · step 3 of ≤40 · claude-… (planner: off)                                                                │
│   Discarded the old scanner; the new tokenizer raises `UnterminatedString` at the opening quote.                     │
│                                                                                                                       │
│   ▸ thinking · 412 tokens · 2.4s                                                        [e] toggle  [Ctrl+E] all     │
│                                                                                                                       │
│   ▾ tool · read · files.read · read-only · 0.03s · receipt 9f41…c2                          ✓ SUCCEEDED               │
│     src/tokenizer.ts  (1–240)   hz://artifact/6b1e…                                                                   │
│                                                                                                                       │
│   ▾ tool · edit · files.patch · workspace-write · 0.21s · receipt 3a77…10                                   ⋯ APPLIED │
│     ├ +14 −6  src/tokenizer.ts     ] next hunk  [ previous hunk  a accept  r reject  s side-by-side  Ctrl+D view      │
│     │ @@ -88,7 +88,9 @@                                                                                               │
│     │   if (ch === '"') {                                                                                             │
│     │ -   return this.scanString();                                                                                   │
│     │ +   const start = this.pos;                                                                                    │
│     │ +   const s = this.scanString();                                                                               │
│     │ +   if (s.unterminated) throw new UnterminatedString(start);                                                    │
│     │   }                                                                                                             │
│     │                   1 of 3 hunks accepted · 2 pending · rail ▮▮▯                                                   │
│                                                                                                                       │
│ ┌─ ASK · Shell ────────────────────────────── policy r12.3f9c · reason rule_ask ─────────────────────────────────────┐│
│ │ capability  terminal.run      effect class  process        origin  SessionBatch (model)   sandbox  workspace-write ││
│ │ cwd         /data/home/forge/repo-tour/repo        ask expires in 108s                                             ││
│ │ exact effect                                                                                                       ││
│ │   argv    ["bun","test","src/tokenizer.test.ts"]                                                                   ││
│ │   binary  /usr/local/bin/bun   env-keys  TEST_SEED=… (redacted)   dynamic?  no                                     ││
│ │ [1] allow once   [2] allow session   [3] allow workspace (expires 24h)   [4] deny   [i] inspect digest             ││
│ └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ › fix the fixture too, then re-run the suite                                                                          │
│                                                                                                                       │
│ chord: Alt+Enter = newline · Tab = transcript · Esc = clear · 1–4 decide when an ask is focused · paste: bracketed   │
│ thinking 412 · try 2 · execute 3 · tool 5/5 · queue 0                                                                 │
│ ◐ running · executor gpt-…  · tokens 118k (cache 41k) · cost $0.0812 (complete) · budget steps 3/40                    │
│ ⎇ ask · policy r12.3f9c · kernel ok · UNKNOWN 1 · barrier ASK                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Region table (row numbers are 1-based, top of frame = row 1):

| Rows | Region/component | Notes |
|---|---|---|
| 1 | Frame top + title | Title left, environment right. |
| 2 | Header line | `SessionView` header: branch, canonical `hz://session/<id>`, turn index, elapsed, kernel health, posture + policy revision, context usage with provenance (R73, R158, R159, R163). |
| 3 | Rule | Separator; doubles as the resize-safe boundary (R11). |
| 4–29 | `Transcript` | Sticky turn header (row 4) per R103; blocks: user message, assistant message, `ThinkingBlock` (folded), `ToolCallCard` ×2, inline `DiffView` hunk with the accept/reject hint line and the rail (R76, R77). |
| 19–26 | `ApprovalPrompt` (inside `ModalHost`) | Blocking card: capability, effect class, origin, sandbox, policy revision, reason code, exact argv, binary, redacted env keys, dynamic-marker, the four decisions with persistence text, countdown, inspect action (R87–R98). Background rows are unpainted in the card's columns, so occlusion is structural (R26). |
| 30–32 | `Composer` | Multi-line draft, paste chips, slash menu when the first character is `/`; row 32 is the chord hint for this terminal (R52). |
| 33 | `StatusBar` (activity) | Thinking/tool/try counters, queue depth, `coarse` badge when degrading (R68, R160). |
| 34 | `StatusBar` (work) | Phase, executor model, tokens with cache breakdown, cost with `complete`/`incomplete`, budget remaining (R151, R152, R161, R163). |
| 35 | `StatusBar` (authority) | Posture + policy revision, kernel health, `UNKNOWN` count, active barrier (R158, R159, R162, R169). |
| 36 | `KeyHintBar` | Contextual keys for the focused surface, generated from the keymap registry (R42, R62). |

Breakpoint behavior of this frame (R128): at `standard` the diff hint line collapses to the glyph rail; at `compact` the second tool card collapses to one line and `DiffView` forces unified; at `narrow`/`minimal` the header drops branch/elapsed, the status bar collapses to rows 34–35 only, and the approval card's `exact effect` block scrolls within the card (it never truncates silently, R176).

### 3.4 Keybindings file

```toml
# ~/.config/horizon/keybindings.toml   (workspace .hz/keybindings.toml may only narrow)
[preset]
name = "simple"          # simple | vim | emacs
leader = "ctrl+x"        # opt-in leader for multi-stroke actions

[bindings]
"transcript.next"        = ["down", "ctrl+n"]
"transcript.prev"        = ["up", "ctrl+p"]
"palette.show"           = "ctrl+shift+p"     # overrides the default ctrl+p
"composer.newline"       = ["alt+enter", "ctrl+j"]
"command.reload"         = ["ctrl+shift+r"]      # overrides the default
"not.an.action"          = ["ctrl+alt+x"]       # fails loudly: unknown_action (R48)

[unbound]
"debug.hud" = "none"                          # explicit unbind, distinct from unset
```

Validation (`hzcode keybind check`) MUST report, per binding: `id`, `keys`, `contexts`, `source`, and either `ok` or an error code (`unknown_action`, `unknown_key`, `duplicate_binding`, `forbidden_override`).

### 3.5 Non-interactive output schemas

`HeadlessResultV1` (one JSON object on stdout for `--output json`):

| Field | Type | Notes |
|---|---|---|
| `text` | string | Final assistant text. |
| `stopReason` | string | `end_turn`, `max_tokens`, `budget_exhausted`, `denied`, `cancelled`, `incomplete`, `error`. `incomplete` is the step outcome of `06` and `12` §4.8(f) (a provider failure never silently resumed); `error` is a run-level failure and carries the doc 11 error class (`provider`, `tool`, `kernel`, `sandbox`, `policy`, `storage`, `protocol`) rather than inventing a second taxonomy. |
| `sessionId` | string | Also `hz://session/<id>` in `sessionUri`. |
| `sessionUri` | string | R193. |
| `requestId` | string | Correlates with OTel traces and the receipt chain. |
| `numTurns` | integer | Main-agent completed steps. |
| `usage` | object | `input_tokens` (uncached only), `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`, `reasoning_tokens`, `total_tokens`, `usage_is_incomplete` when applicable (R191). |
| `modelUsage` | object | Per-model `{ inputTokens, outputTokens, cacheReadInputTokens, modelCalls, costUSD? }`. |
| `totalCostUsd` | number, omitted when partial | Never zero-filled (R151, R191). |
| `totalCostUsdTicks` | string (integer ticks) | Exact accounting; `1 USD = 10^10` ticks. Same emission condition as `totalCostUsd`. |
| `costIsPartial` | boolean | When true, all cost floats are omitted. |
| `structuredOutput` | object, optional | Present only with `--json-schema` (R192). |
| `denials` | array | Each `{ capabilityId, reasonCode, receiptId? }` — the machine-readable form of an `ask` resolved to `deny` (R194). |
| `unknowns` | array | Each `{ receiptId, capabilityId, effectClass }` — unreconciled effects (R169). A non-empty `unknowns` MUST NOT be reported as success in CI (R171). |

`--output jsonl` event kinds (one object per line, `type` discriminator; `end` or `error` is always last):

| `type` | Payload keys | Maps to |
|---|---|---|
| `thought` | `data` | `hz.part.created/updated` (thinking) |
| `text` | `data` | `hz.step.llm.delta` |
| `tool_call` | `toolCallId`, `toolName`, `capabilityId`, `effectClass`, `kind`, `status`, `rawInput`, `locations` | `hz.step.tool.requested` |
| `tool_call_update` | `toolCallId`, `status`, `rawOutput`, `content`, `locations`, `receiptId` | `hz.step.tool.completed` |
| `plan` | `entries` | `hz.plan.updated` |
| `permission` | `approvalId`, `capabilityId`, `decision`, `reasonCode`, `scope` | `hz.permission.asked`/`answered` |
| `unknown` | `receiptId`, `capabilityId`, `effectClass`, `resourceKey` | `hz.effect.unknown` |
| `usage` | `messageId`, `stopReason`, `usage` | `hz.usage.recorded` |
| `error` | `message`, `capabilityId?`, `reasonCode?`, `retryable` | `hz.error.raised` |
| `end` | `stopReason`, `sessionId`, `sessionUri`, `requestId`, `usage`, `numTurns`, `modelUsage`, `costIsPartial?` | terminal |

Non-interactive parity rule: every kind above MUST be derivable from the same event stream the TUI consumes, so `--output jsonl` is a *rendering* of the session, not a separate implementation (R185, R196).

## 4. Data

| Store | Location | Contents | Retention |
|---|---|---|---|
| TUI settings | `~/.config/horizon/config.toml` (`[terminal]`, `[ui]`, `[theme]`, `[scrollback]`, `[animation]`, `[notifications]`) | Mode, color level override, breakpoint overrides, fold defaults, animation, notification channels | user-managed |
| Workspace narrowing | `.hz/config.toml` | May only narrow: e.g. force `inline`, disable notifications, forbid `allow workspace` | per repo |
| Keybindings | `~/.config/horizon/keybindings.toml`, `.hz/keybindings.toml` | R47–R48 | user-managed |
| Themes | `~/.config/horizon/themes/*.toml` | R119 | user-managed |
| Draft state | `~/.local/state/horizon/drafts/<session>.json` | Composer draft, paste chips, cursor | debounced ≥250 ms (R144), cleared on send |
| UI state | `~/.local/state/horizon/ui/<session>.json` | Active pane, folds, scroll anchor, layout version, coarse flags, MRU palette entries | session lifetime |
| Terminal caps cache | `~/.local/state/horizon/ui/terminal-caps.json` | R131, keyed by `TERM`+`TERM_PROGRAM`+version | invalidated on `/doctor` |
| Diagnostics bundle | `~/.local/state/horizon/diag/<ts>.json` | Caps, keymap, theme resolution, render probe frames, latency histograms | on demand, explicit |

The TUI MUST NOT own any domain state: no messages, no receipts, no grants, no policy, no session metadata. Everything above is presentation state that can be deleted without corrupting a session.

## 5. Errors and failure modes

| Failure | Behaviour | Exit / status |
|---|---|---|
| Not a TTY, no usable terminal | Inline mode if possible, else `--print` semantics; never alt-screen | 2 if interactive mode was requested explicitly |
| Terminal below minimum size | One-line message; inline offer or exit | 2 (R130) |
| `hzk` absent | **Fail closed**: read-only posture, banner + `kernel absent (read-only)` in status; mutating tools refuse with reason code | run continues read-only, exit 3 if the prompt required mutation |
| `hzk` version mismatch | Fail closed read-only, offering `hzcode kernel doctor` | 3 |
| `hzk` crash mid-run | Status shows `crashed (restarting)`; in-flight effects resolved as `UNKNOWN` if observation was lost; resume offered | run continues, barrier shown |
| Unreconciled `UNKNOWN` | Persistent chip + barrier; dependent effects blocked; completion banner cites it | 3, or 0 only if the caller opts in via `--allow-unknown` and the result marks `unknowns` |
| Renderer crash (child media process) | Placeholder card; TUI unaffected | — |
| Escape-writer failure (closed stdout) | Restore terminal, print the last N transcript lines as plain text to stderr, exit | 1 |
| Mouse capture lost (terminal stripped modes) | Auto re-assert (R34); if twice in 30 s, show a persistent hint with the terminal's manual toggle path | — |
| X10-degraded reports | Reassembly filter; if rate > 5% of events, hint to switch terminal or enable the encoding fix in `/doctor` | — |
| Theme references unknown token | Refuse to load, keep the previous theme, print the token name | 2 if from CLI flag |
| Keybindings invalid | Refuse to start the TUI with `--print`-style diagnostic naming the file/line | 2 |
| Approval needed with no TTY (non-interactive) | Resolve `ask` → `deny`, record the reason code | 3 (R194) |
| Budget exhausted mid-stream | Render terminal state in the block, status shows budget, no auto-continue | 5 |
| Clipboard unavailable | Toast naming the attempted backends; offer file-based export (`hzcode session export`) | — |

Every fail-closed path MUST produce: a `reason_code`, a receipt when an effect was involved, a visible surface in the TUI, and an entry in non-interactive output.

## 6. Flows

### 6.1 Interactive launch → first frame → prompt → stream → approval → diff apply

1. `hzcode` parses argv; `--fullscreen`/`--minimal` conflict ⇒ exit 2 (R3). `detectTerminalCaps()` runs; the color level decides theme quantization (R115–R116).
2. The CLI host starts the Controller (or attaches to a leader / `hzcode serve` for this workspace), opens the session (new, `--resume`, or `--fork`), and hands the TUI a read-only event subscription plus command dispatch.
3. The TUI installs terminal restore, enters raw mode, and (fullscreen) enters the alternate screen + mouse capture + bracketed paste (R6–R7, R23).
4. First frame paints the header, the tail of the transcript window and the composer (R138 budget), then deferred work (session search index warmup, theme picker samples, palette corpus) runs with deadlines (R139).
5. The user submits a prompt: the TUI dispatches `session.prompt` with `steer`/`queue`; admission is durable before any model work (ADR-011 companion rule in `docs/02-decisions.md`); the block renders on `hz.session.prompt.admitted`.
6. Stream: `hz.step.llm.delta` accumulates; frames are coalesced at ≤16 ms; under load the degradation ladder engages and the `coarse` badge appears (R63–R67).
7. A tool requests an effect needing approval: `hz.permission.asked` opens the card (R87). The card shows the exact effect; `[1]` allows once. The decision is recorded as `hz.permission.answered`, the posture chip updates, and the lease is issued (R95).
8. The tool edits two files: `DiffView` shows pending hunks; the user presses `a` on hunk 1 of 3; the TUI submits `files.patch` with that preimage digest; the receipt settles `succeeded`; the hunk goes `applied` and shows its receipt (R79–R80). Hunk 2 shows a stale-preimage conflict after another writer touched the file and offers re-diff (R82).
9. Turn ends; the completion banner shows cost with provenance, the turn's traces, and any `UNKNOWN` barrier (R171).
10. Exit: terminal restored on every path; session remains durably resumable (`hz://session/<id>`).

### 6.2 Mode switch by relaunch (R4)

1. `F11`/`/fullscreen`/`/minimal` writes a relaunch request to UI state (draft, cursor, scroll anchor, session id, event cursor, notification pref).
2. The TUI paints a one-line notice, restores the terminal, and exits `0` with `HZ_RELAUNCH` set in the environment describing the request.
3. The launcher (`@horizoncode/cli`) sees `HZ_RELAUNCH`, re-execs `hzcode tui relaunch --mode <mode>` with the same session, and the new process re-attaches at the stored event cursor.
4. The relaunch MUST NOT re-admit a prompt, MUST NOT re-run a turn, and MUST NOT mint a new session id; a half-typed draft MUST survive byte-for-byte (R97).

### 6.3 Capture re-assertion after a ConPTY relay (R34–R35)

1. The relay (ssh → tmux → ConPTY → Windows Terminal) strips DEC private modes when the client reattaches; the terminal stops sending SGR mouse reports and may downgrade them to X10.
2. On focus-gained the TUI enqueues `EnableMouseCapture` + bracketed-paste enable through the escape writer (R9, R34).
3. If a mouse-shaped event arrives whose encoding cannot be explained by the current size, the reader holds it as an X10 candidate and waits ≤50 ms for the displaced row byte; the pair is reassembled into a proper event (R35). Otherwise the event is forwarded as input so typed characters are never lost.
4. `/doctor` reports the observed downgrades and offers the terminal-specific fix (for example the terminal's own "allow mouse reporting" toggle).

### 6.4 Rewind

1. `/rewind` or `Ctrl+Z` lists checkpoints with turn boundaries, tokens, and file snapshots.
2. Selecting a turn shows the diff that would be discarded and states explicitly whether workspace files will be restored (default: no file restore).
3. Confirming dispatches the rewind through the Controller; `hz.session.rewound` renders a truncation banner; the abandoned turns remain in the log and are reachable through `hzcode session history`.

## 7. Security and authority

| Aspect | Rule |
|---|---|
| Capability IDs used by the TUI | `ui.present` (rendering affordances requested by tools/plugins), `session.manage` (create/resume/fork/rewind/delete), `files.read` (diff source reads), `artifact.write` (exported hunk bundles), `net.fetch` (link open), `terminal.run` (opening a shell pane) — each requested through the Controller, never directly. |
| The TUI is not an authority | The TUI MUST NOT call `hzk` for effects except through the Controller's tool path, MUST NOT widen policy, MUST NOT persist grants except through the approval card's declared options (R90, R98). |
| Rendering is not permission | A rendered affordance MUST NOT imply authorization: a disabled/absent action MUST be absent, and every action's real gate is the kernel. |
| Untrusted content | Model text, tool output, file contents and web content are untrusted: escapes neutralized (R107), media rendered out of process (R112), links shown with real targets (R109). |
| Secrets | Credential asks render handles only (R88); notifications exclude content by default (R180); diagnostics bundles MUST redact secrets and MUST be opt-in. |
| Clipboard | Copy is read-only data flow *out*; the TUI MUST NOT honor `OSC 52` from model output (R107) and MUST NOT read the clipboard except on explicit paste. |
| Egress | Link open, notifications and webhooks are the TUI's only outbound paths, all visible in `hzcode config show egress` and disabled by `--offline` (R182). |
| Grants lifetime | A workspace grant created from the approval card MUST expire (default 24 h) and MUST be revocable from `/grants` and `hzcode policy revoke` (R90–R91). |
| Unknown effects | Never retried by the TUI; only reconciled, with the receipt chain as the evidence (R169–R171). |

## 8. Performance budgets (summary)

| Metric | Budget | Rule | Gate |
|---|---|---|---|
| Keystroke → glyph, p50 | < 16 ms | R137 | PTY benchmark, fails >20 % regression |
| Keystroke → glyph, p99 (under 1 000 lines/s) | < 33 ms | R137, R140 | PTY benchmark |
| Process start → first frame, p50 | < 100 ms | R138 | startup probe |
| Process start → first frame, p95 | < 150 ms | R138 | startup probe |
| Dropped keystrokes at 1 000 lines/s × 60 s | 0 | R69, R140 | soak test |
| Dropped durable events | 0 | R70 | replay diff test |
| Full repaint 120×36 | ≤ 3 ms | R142 | golden-frame benchmark |
| Streaming block repaint | ≤ 1 ms | R142 | benchmark |
| Resize repaint | ≤ 16 ms | R142 | benchmark |
| Scroll frame (100 k-line session) | ≤ 16 ms | R143 | benchmark |
| Diff first paint (10 k lines) | ≤ 250 ms | R85 | benchmark |
| Diff search | ≤ 100 ms | R85 | benchmark |
| Palette search (100 k items) | ≤ 50 ms | R61 | benchmark |
| Steady-state RSS (100 k-line session) | ≤ 250 MB (fail > 300 MB) | R141 | soak test |
| Frame parse budget | ≤ 4 ms | R65 | benchmark |
| Pending frame queue | ≤ 2 frames | R67 | unit test |

## 9. Tests

Paths use the single planned convention `packages/<pkg>/test/<file>` (`_conventions.md` §10): the short form `tui/x` below means `[planned]` `packages/tui/test/x`. The suite that exists today is `app/tests/tui/` (8 files, 48 tests, real PTY scenarios) plus `app/tests/core`, `app/tests/tools` and `app/tests/providers`.

| Gate | Proves | Kind |
|---|---|---|
| `tui/render-probe.golden` | First-frame golden images at 120×36, 100×24, 72×20, 40×10 for fullscreen and inline, and for each of `truecolor/256/16/none` | golden (R12, R17, R115) |
| `tui/hit-test.spec` | Click-to-focus, occlusion, stale-layout drop, scrollbar drag mapping, threshold-free targets | unit + PTY (R25–R30) |
| `tui/x10-reassembly.spec` | Mangled SGR→X10 repair within 50 ms; typed characters never swallowed | unit with scripted byte batches (R35) |
| `tui/mouse-reassert.spec` | Focus-gained re-asserts capture; deliberate disable is never undone; sequences ride the writer queue | unit (R34) |
| `tui/keymap.spec` | Every action has a description and a `simple`-preset binding; preset vim/emacs coverage; forbidden overrides refused | unit + lint (R37, R45–R48, R135) |
| `tui/slash-registry.spec` | Registry fields complete; surfaces declared; approvals flagged; prompt commands admitted through the inbox | unit (R54–R56) |
| `tui/streaming-backpressure.spec` | Degradation ladder engages in order and clears; input never lost; durable events intact | PTY soak (R63–R70) |
| `tui/diff-apply.spec` | Accept emits `files.patch` with the shown preimage; no direct file write; receipt id surfaces; stale preimage flows to the conflict banner | integration against a test kernel (R79–R83) |
| `tui/approval-exactness.spec` | Rendered effect equals the kernel's normalized effect for shell/edit/network/credential cases; unrenderable ⇒ allows disabled | integration (R88–R89) |
| `tui/permission-persistence.spec` | Each decision persists exactly what it claims; credential asks never offer workspace scope | integration (R90–R92) |
| `tui/no-color.spec` | No SGR color escapes; all meaning encoded by glyph/word | byte-level PTY assertion (R121–R122) |
| `tui/screen-reader.spec` | Announcement grammar, one line per change, no spinners, inline mode forced | PTY with a scripted reader (R125–R126) |
| `tui/ime.spec` | Composition does not submit; cluster-correct cursor; RTL ordering | PTY with scripted composition events (R132–R134) |
| `tui/headless-parity.spec` | Every `jsonl` kind maps to a rendered state and vice versa | cross-surface parity (R185, R196) |
| `tui/unknown-display.spec` | `UNKNOWN` chip persists, blocks dependents, never auto-retries, appears in `json` output | integration (R169–R171) |
| `tui/perf.gate` | All budgets in §8 within 20 % | CI benchmark (R146) |
| `tui/parity.ratchet` | No UI-only state; no state without a renderer | linter (R22, R196) |
| `tui/theme-tokens.lint` | No literal colors in components; token set complete | lint (R113–R114) |
| `tui/escape-neutralization.spec` | OSC/CSI/APC in model output never reaches the terminal | fuzz (R107) |

## 10. Status

**Levels are owned by `docs/28-implementation-status.md`** (RC-13). Four rows below record the v0.1 slice that exists and is tested; every other row starts at `DESIGNED` and claims nothing above it until the named evidence exists (`_conventions.md` §8).

| Capability | Level | Evidence required to advance |
|---|---|---|
| Fullscreen alt-screen mode with differential rendering | DESIGNED | `tui/render-probe.golden` green; PTY capture of a real frame; `CODE_PRESENT` when `packages/tui` exists |
| Inline/scrollback mode | DESIGNED | inline goldens + pipe-safety test |
| Relaunch mode switch | DESIGNED | relaunch preserves draft/cursor/session; no re-admission (test) |
| Mouse (focus, wheel, scrollbar, drag-select) | DESIGNED | `tui/hit-test.spec`, `tui/mouse-reassert.spec`, `tui/x10-reassembly.spec` |
| Keyboard model, presets, custom keybindings | DESIGNED | `tui/keymap.spec` |
| Slash registry and palette | DESIGNED | `tui/slash-registry.spec` |
| Streaming renderer with backpressure | TESTED + VERIFIED (v0.1 subset) | v0.1 streams and coalesces (`app/tests/tui/render.test.ts`, `pty.test.ts`; `docs/28` §1); the degradation ladder still needs `tui/streaming-backpressure.spec` |
| Diff viewer with per-hunk accept through the kernel | DESIGNED | `tui/diff-apply.spec` against a real `hzk` build |
| Approval prompts with exact-effect rendering | TESTED + VERIFIED (v0.1 subset) | y/n/a approvals and fail-closed headless approvals (`app/tests/tui/approval.test.ts`, `headless.test.ts`); exact-effect rendering still needs `tui/approval-exactness.spec` |
| Transcript (folds, search, copy/paste, links, media) | TESTED + VERIFIED (v0.1 subset) | transcript basics and history (`app/tests/tui/render.test.ts`, `cli.test.ts`); folds, search and media still need the transcript spec + media fallback goldens |
| Theming (tokens, quantization, high contrast, no-color) | DESIGNED | `tui/theme-tokens.lint`, `tui/no-color.spec` |
| Accessibility (screen reader, reduced motion, IME, breakpoints, min size) | DESIGNED | `tui/screen-reader.spec`, `tui/ime.spec` |
| Performance budgets | DESIGNED | `tui/perf.gate` in CI on the reference machine |
| Session-management UI (picker, resume, fork, rewind, tree, cost) | DESIGNED | session UI tests + cost-provenance assertions |
| Status surfaces | DESIGNED | status golden per breakpoint + provenance lint |
| Error and `UNKNOWN` display + receipt inspector | DESIGNED | `tui/unknown-display.spec` |
| Notifications (bell, desktop, webhook) | DESIGNED | delivery tests + egress visibility test |
| Non-interactive output modes | TESTED + VERIFIED (v0.1 subset) | `--print` and headless paths (`app/tests/tui/headless.test.ts`, `cli.test.ts`); JSONL parity still needs `tui/headless-parity.spec` |
| Parity ratchet participation | DESIGNED | `tui/parity.ratchet` wired into CI |

Known inherited limitation that this document MUST NOT paper over: the ancestor kernel refuses two edits to the same file inside one message (`stale_preimage`), which is why R83 mandates sequential application with explicit preimage recomputation rather than a silent bulk apply (source: `/data/home/forge/repo-tour/horizoncode/HANDOFF.md`).

> **Session fork (`docs/28` ruling 59).** `/fork` branches the chat into a new session and switches to it (the notice names both ids); `/fork n` cuts at checkpoint n from `/rewind`; `/sessions` lists recent sessions, marks the current one with `*` and shows `(fork of <id> at message <k>)`. Both need an idle chat.

> **Guardian surfacing (`docs/28` ruling 60).** An approval prompt shows `· guardian: flag - <reason>` (or `deny`) on its own line when the guardian objects; allow shows nothing.

## Part 1 polish: status line, spinner, shaded user block (v0.1)

TTY-only (colour on, not `TERM=dumb`, no `NO_COLOR`); pipes, `-p`, headless and tests keep the exact old transcript. Design (`app/src/tui/live.ts`), consistent with R5 (readline owns the prompt line, nothing is drawn below it):

- **Idle:** a dim status line `mode · model · provider · ◑ ctx% · path · ⑂ branch` is printed once, as a normal transcript line, above the prompt. It is skipped when nothing was written since the last copy and it is unchanged. Width-aware: path, provider, branch, ctx are dropped in that order.
- **Turn running:** exactly one live line at the cursor, `⠋ Thinking… 4s · esc to cancel`, redrawn in place (`\r\x1b[2K`, one write per frame, one ~90ms timer stopped when idle and on exit). The verb follows the running tool (`Reading math.js`). It is erased before every transcript write (renderer `beforeWrite`) and steps aside while text streams, an approval is open or the human is typing. ASCII frames in non-UTF-8 locales.
- The user's message becomes a shaded block with a right-aligned `HH:MM`; each turn ends with a dim footer `· 12.4s · 3 tools · ↑1.2k tok`. The banner is compact with a rotating tip. `/help` lists `/mode`, `/fork`, `/memory`, `/init`.
- Esc cancels a running turn where raw keypress events exist (TTY stdin); Ctrl+C always does.

## Part 2 polish: colour ladder, synchronized frames, tool cards, markdown (v0.1)

Studied against Grok Build's minimal mode (`research/grok-tui-deep.md`). Everything below is rich-mode only (`liveEnabled()`: TTY, colour, not `TERM=dumb`, no `NO_COLOR`). The renderer's `rich` option defaults to false, so pipes, `-p`, headless and every existing test keep the plain two-line cards byte for byte (pinned by `tests/tui/fixtures/plain-events.expected.txt`, generated from the pre-redesign renderer).

- **Colour ladder (`style.ts`).** `detectColorLevel()`: `NO_COLOR`/`TERM=dumb`/non-TTY => 0; `FORCE_COLOR` 1-3; `COLORTERM=truecolor|24bit` or a known truecolor terminal (iTerm2, WezTerm, ghostty, VS Code, Windows Terminal, kitty, alacritty, foot) => 3; `*256color` => 2; xterm-ish => 1. A role table (`accent info ok err warn path text muted faint link h1-h3 code bgUser bgPanel bgAdd bgDel`) maps each role to RGB, a 256 index and a basic-16 SGR; backgrounds are dropped at level 1 and de-emphasis uses SGR 2 there. `HZ_THEME=light` or `COLORFGBG` selects GrokDay-derived values. The old `bold/dim/cyan/...` helpers are unchanged. `visibleWidth`/`truncate` now count display columns (CJK and emoji are 2, combining marks 0).
- **Synchronized, flicker-free frames (`live.ts`).** Every live redraw is one write wrapped in DEC 2026 (`ESC[?2026h` ... `l`), skipped under tmux; identical consecutive frames write nothing; the cursor is hidden while animating and restored on erase, dispose and process exit. One 40 ms timer (stopped when idle and on exit) drives the clock; the braille glyph advances every 100 ms, slower than the frame clock, and at truecolor pulses `sin^2` between `#bb9af7` and the base (period ~1.3 s). The footer is `⠹ Reading math.js… 12s · esc to cancel` with, when it adds information, a right-aligned `1m51s ⇣31k`; parallel tools show `Reading a + 2 more…`. Narrow ladder (terminal columns): <80 `esc` only, <60 phase timer dropped, <40 label + clock, <24 spinner alone. Only the label is ever cut.
- **Tool cards (`cards.ts`, pure functions).** `◆ Verb object (detail)   0.2s` with the bullet green/red on completion: `Read P (120 lines|10-50)`, `Search "pat" in path (14 matches)`, `Glob pat (23 files)`, `Edit P +A/-D`, `Write P +N`, `Edit N files +A/-D` (patch), `Fetch host`, `Ran name`. Counts come from the additive `tool.card.detail` (below) and are omitted when unknown. Read-only tools print once, when they finish; `shell`, `write`, `edit`, `ast_edit`, `apply_patch` and `agent` print their header at start (so an approval prompt has context) and a result line (`  └ +4 · 0.2s`) at the end. Errors add `  ✗ error: ...` wrapped under a hang. Grok does not time tool cards; HorizonCode does.
- **Shell card.** `$ cmd` (faint `$`, command word `info`; multi-line commands fold to `⏎ +N lines`), then the output as a panel (`▎` rail, `bgPanel` at 256+): first 2 lines, `… +N lines`, last 3, rows clipped to the width, ANSI stripped; footer `  └ 4.2s` or red `  └ exit 1 · 4.2s`.
- **Folded runs.** Four or more consecutive completed read-only cards with no text between them commit as one line, `◆ Read 5 files, Searched 2 patterns   1.2s`; fewer print individually; an error breaks the run. They are buffered and committed by the next event, so nothing is lost at the end of a turn.
- **Subagents.** `◆ Subagent running: “task” (profile)` at start and `◆ Subagent completed in 20s: “task”` / `failed in 12s (reason)` at the end. While one runs, the live region grows to `▾ Subagents N` plus up to five rows `⠋ label · latest activity   2m14s` (`+ ▸ show N more`), above the footer; finished rows stay 2 s as `✓`/`✗`. Child events are bound to `agent` calls FIFO by first sight of their `agentId` (contract C2 landed in Part 3: `subagent.start`/`subagent.end` now carry the exact outcome; the FIFO binding remains the fallback for an older runtime). The nested `│` lines are no longer printed in rich mode (they stay in non-rich output).
- **Streaming markdown (`markdown.ts`).** Line-oriented, chunk-boundary independent (fuzz-tested), model text sanitized first: headings, bold/italic/strike/inline code (markers hidden), links (OSC 8 only on iTerm2, WezTerm, VS Code, ghostty, kitty or `HZ_HYPERLINKS=1`), bullet/numbered/task lists, quotes, rules, pipe tables that fit (else dim raw), fenced code on a panel background with a small highlighter (js/ts, python, shell, rust, go, json, yaml, toml, diff). A slow plain line is released after 150 ms (never a block opener, never past an inline marker). Prose is not re-wrapped: the terminal soft-wraps it.
- **Contract (additive).** `tool.card.detail?: { durationMs?, output?, exitCode?, count? }` on finished cards: `durationMs` for every tool, `output` (bounded, trailing `exit N` line removed) and `exitCode` for shell tools, `count` for read/grep/glob. Old consumers ignore it; the kernel event catalogue is untouched.
- **Fallbacks.** Non-UTF-8 locales get ASCII glyphs of the same width (`*`, `x`, `|`, `` ` ``, `~`); level 1 has no backgrounds (rail bars instead); `NO_COLOR`/`TERM=dumb` is the plain transcript.

Deferred at the end of Part 2 (status after Part 3): tab completion and ghost text, bracketed paste, the approval card with single-key mode, diff gutters, the thinking display, contract C2 (`subagent.start|end`) and `/theme` all LANDED in Part 3 below. Still deferred: the P2 status-line rework with `used / window` and the contextual hint segment; the popup completion dropdown; a `/verbose` toggle for nested subagent lines; `Worked for` turn-footer wording; resize reprint of history (not needed on scrollback). `callId` on `subagent.start|end` was NOT added (binding is by `agentId`, FIFO to the `agent` card).

## Part 3 polish: Grok-derived deferred items (v0.1)

All rich-only unless noted; non-TTY output is unchanged.
- **Bracketed paste.** A multi-line paste is one input shown as `[pasted N lines]` (`src/tui/paste.ts`, ruling 84). Mode `ESC[?2004h` is on only with a TTY and off again on exit.
- **Approval card.** Bordered `⚠ Approve …?` card with tool, args, risk and keys; `y`/`n`/`a`/`Esc` without Enter (`approval-card.ts`, ruling 85). Rich TTY only; the line prompt remains the fallback.
- **Diff gutters.** Line numbers, coloured +/- rows, folded context and an `… N more lines` footer in rich `turn.diff` and previews (`diff.ts`, ruling 86).
- **Thinking.** `assistant.thinking` (additive C3) from openai-compatible and anthropic streams, collapsed to `◆ Thought for Ns · N lines`, `/think` expands (ruling 87).
- **Subagent cells.** `subagent.start`/`subagent.end` (additive C2) give exact outcome, time and tool count to the `◆ Subagent completed in 4.2s: “task” · 3 tools` cell (ruling 88).
- **Completion.** Tab completes `/commands` (built-in and custom) and `@paths`, with a dim ghost suffix after the cursor (`completion.ts`, ruling 89). Ghost is rich TTY only; Tab itself works wherever readline has a terminal.
- **/theme.** `dark|light|auto|mono` for the session via the role table; `NO_COLOR` always wins (`style.ts`, ruling 90).

### Part 3 provenance (what was taken from where)

Source study: Grok Build's minimal mode, recorded in the repo's research notes as `research/grok-tui-deep.md` (the clone and the notes live in the original author's sandbox under `externals/grok-build`, upstream org `xai-org`, see docs/30 section 5.5 and 5.12). Nothing in Part 3 is copied code. HorizonCode is zero-runtime-dependency TypeScript and the reference is Rust, so every item is a clean adaptation of the BEHAVIOUR (what the user sees), not the implementation. Exact upstream file paths for the TUI items were not re-verified when this was written (the clone is not in this worktree); the next agent should confirm them against `externals/grok-build` before citing them as links. Per item: bracketed paste is the standard xterm mode 2004 contract (adapted, Node readline `paste-start`/`paste-end` keypresses); the approval card, diff gutter, thinking fold and subagent cell are adapted from the Grok minimal-mode look; tab completion and ghost text are adapted behaviour; `/theme` extends the Part 2 role table.

### Part 3 safety properties (review pass, rulings 84-91)

- **Paste and type-ahead cannot approve.** The chat line is wiped before the card, keys in the first 250 ms are dropped, and since ruling 91 any key between `paste-start` and `paste-end` (and the marker keys themselves) is ignored while the card is open, so pasting `y`, `yes` or `a...` after the 250 ms window no longer answers. A multi-line paste during a question is an empty answer, i.e. a denial. Only a typed `y`, `n`, `a` (or the deny keys Enter, Esc, Ctrl-C) settles the card.
- **Terminal-control injection.** Model text, thinking text, subagent task text, diffs and tool names pass `sanitizeText` (ANSI and C0 stripped) before reaching the terminal; approval `detail`/`title`/`guardian` additionally make invisible and bidi characters visible as `<U+XXXX>`, and shell commands show control bytes the same way. File names offered by `@path` completion with control, C1 or bidi/invisible characters are never offered (ruling 91) because Tab and ghost text write them raw.
- **Thinking never persists.** `assistant.thinking` is forwarded by the loop for display only. It is not appended to the transcript, history, receipts or the exported chat; `/think` shows only the last block of the current process. Not tested end to end against a real reasoning provider.
- **Non-TTY output** is pinned byte for byte by `tests/tui/fixtures/plain-events.expected.txt`; none of the Part 3 events add output in plain mode.

### Part 3 known gaps and deferred work

- Cosmetic: readline may echo the pressed `y` inside the approval card before the line is wiped (`wipeLine` sends Ctrl-U after readline has already echoed). Not fixed: a clean fix needs the card to own the cursor row or to pause readline output, which is more than a one-line change. Safety is unaffected.
- Ghost text and its room check use string length, not display width, so wide (CJK, emoji) paths can mis-place the suppress threshold. Deferred.
- C1 control bytes (0x80-0x9f) are not stripped by `sanitizeText` (pre-existing); UTF-8 terminals do not interpret them as controls, 8-bit terminals might. Deferred.
- Bracketed paste of a single line without a trailing newline leaves the collector armed until the next Enter; the paste is then submitted together with anything typed after it. Deferred.
- `/theme` is session scope only (not persisted); `HZ_THEME` remains the startup knob.
- No popup completion dropdown; Tab lists matches via readline.
