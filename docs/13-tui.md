# 13 — Terminal UI (`hzcode tui`)
> **Permission modes (`docs/28` ruling 58).** `/mode [default|plan|accept-edits|read-only]` shows or sets the mode; a non-default mode puts a bold yellow badge (`PLAN`, `ACCEPT-EDITS`, `READ-ONLY`) before the prompt and prints one notice at chat start. `/mode yolo` is refused with the reason.

> **Print mode (`docs/28` ruling 57).** `hzcode -p` never opens the chat bar or an approval prompt, even on a TTY; stdout carries only the chosen format (`text`, `json`, `stream-json`), notices and errors go to stderr.


> **Agent presets (stage 3, `docs/28` ruling 56).** A nested child run started with a `profile` prints one `profile: <name>` line behind the dim bar before its first nested line (renderer reads the additive `profile` on `subagent.event`).
>
> **Implementation reality (read first, refreshed 2026-11-13).** Default TUI is **scrollback** chat on readline. **PARTIAL alt-screen:** `fullscreen-chat.ts` reduced loop when `HZ_TUI_MODE=fullscreen` / `fullscreen-experimental` or `--fullscreen` (rulings **193**, **221**); opt-in mouse wheel scroll (**225**); fuzzy **`fullscreen-palette.ts`** overlay on `Ctrl+P` / `/palette` (**232**); in-loop slash via **`slash-dispatch.ts`** / **`fullscreen-slash.ts`** (**240**); composer ↑/↓ history (**240**, D18 reduced); **`/copy`** with OSC 52 + platform fallbacks (**236** D17); no in-app scrollback pane, no Grok R1–R12 parity. **PARTIAL scrollback:** keymap + keybind check (164–166); slash-registry; screen-mode; **`cellbuffer.ts` (176)**; **`escape-writer.ts` (183)**; **`mouse-parse.ts` (177)**; scrollback **`/palette`** print, **`/transcript`**, **`/sessions tree`**, plan **hunk labels** (`[hunk N · path]`) + **`/apply 1,3`** or **`/apply path:1,2`** multi-file partial apply (**255** D7), clipboard fallbacks, **`HZ_TUI_UNFOLD_DIFF` / `HZ_TUI_UNFOLD_OUTPUT`** (D9, **236**), `HZ_REDUCE_MOTION` + **`HZ_SCREEN_READER`** plain status/busy/effect-unknown/approval ask (D11, **236**, **255**), turn bell + **`/notify`** config persistence (D15, **236**), **`tui-handoff.json` (177)**, **aborted-turn draft stash (184)**; **`resume-picker.ts` (196)** in fullscreen modes. Still **DESIGN ONLY:** full alt-screen renderer (R8–R12 every frame), scrollback `/` `@` popup dropdown (D6), fullscreen keymap contexts. Provenance + deferrals at end.
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

Design-only except the v0.1 slice enumerated in §10: the chat TUI (chat bar, streaming, tool cards, y/n/a approvals, history, slash sugar) and headless mode are implemented and tested (child tool cards nest under the `agent` card behind a dim bar, at most 30 lines per child; the per-turn diff renders as `· changed N file(s)` plus a diff capped at 40 lines; headless prints only the changed summary, on stderr, keeping stdout a clean transcript; `docs/28` ruling 54) - `bun test tests/tui` in `app/` currently runs 300 tests across 25 files, all passing, per `docs/28-implementation-status.md`. Every other claim here is a design claim.

Sources this document is derived from:

- source: [`grok-build/crates/codegen/xai-grok-pager/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager) (the reference fullscreen TUI: alt-screen policy, mouse handling, scrollback blocks, inline "minimal" mode, slash registry, theming, doctor).
- source: [`grok-build/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md), [`04-slash-commands.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md), [`06-theming.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/06-theming.md), [`14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md), [`21-terminal-support.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/21-terminal-support.md).
- source: [`opencode/packages/tui/src/config/keybind.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/config/keybind.ts) (leader-key + named-action keymap), [`packages/tui/src/theme/system.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/theme/system.ts) (terminal-derived palette), [`packages/tui/src/feature-plugins/system/diff-viewer.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/feature-plugins/system/diff-viewer.tsx) (diff viewer keys), [`packages/theme`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/theme) (theme tokens).
- source: [`codex/codex-rs/tui/src/`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src) (chat widget, transcript view, status indicator widgets, diff render, theme picker, keymap config in [`codex-rs/config/src/tui_keymap.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/config/src/tui_keymap.rs)).
- source: [`oh-my-pi/packages/tui/src/`](https://github.com/can1357/oh-my-pi/tree/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src) (differential rendering library, tool renderers, overlays, composer).
- source: `arch_V1/contracts-v2/ui-stream-event-v2.schema.json` of the ancestor project (not cloned, path not verified) (the `durable`/`ephemeral` UI event lane split this design adopts).
- In-repo decisions: `../README.md`, `02-decisions.md`, `_conventions.md`.

## 2. Rules

Rule IDs are stable and individually testable. `MUST` fails a gate; `SHOULD` is reported by the gate but does not fail until the next ratchet bump; `MAY` is free.

### 2.1 Rendering model and screen modes

> **Rules R1 to R12 describe Grok-derived fullscreen parity.** A **reduced** alt-screen chat ships behind `HZ_TUI_MODE=fullscreen` / `fullscreen-experimental` or `--fullscreen` (ruling **221**); default remains scrollback. R2, R4, R8, R9, R12 and most of R1–R12 are still **not** met. Per-rule status and deferral note D1 are in the Provenance section. Do not treat unshipped rules as product behaviour.

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

> **DESIGN ONLY: NOT IMPLEMENTED.** No component tree exists in code; `app/src/tui/interactive.ts` is a single chat loop over pure rendering functions. The names below (`App`, `ModalHost`, ...) are a target, not a description.

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

> **DESIGN ONLY: NOT IMPLEMENTED.** The shipped scrollback mode never enables mouse reporting (and must not: capture would take native selection and scrolling away, R5). These rules apply to a future fullscreen mode. Deferral note D3 has the upstream references and a suggested build order.

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

> **PARTIAL (2026-11-12):** `tui/keymap.ts`, `hzcode keybind check`, user `keybindings.json` (rulings 164–166). Still DESIGN ONLY for fullscreen contexts: modes/presets matrix, mouse-bound actions, debug HUD. Scrollback ships readline + Esc cancel / Ctrl+C two-step / Ctrl+D / approval keys. **R40/R45 still contradict designed fullscreen keymap** — needs a ruling before “fixing” either side. See Provenance + D4.

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

> **PARTIAL — TESTED (2026-11-13).** Shipped: `slash-registry.ts` + Tab completion (89); fuzzy scrollback `/palette` + fullscreen cellbuffer overlay on `Ctrl+P` / `/palette` (**177**, **232**). **Still open (D5/D6):** MRU palette ranking, keymap-generated `/help`, scrollback `/` and `@` popup dropdown under readline (D6 deferral). See Provenance D5/D6.

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

> **PARTIAL.** Shipped: diff gutters in `turn.diff` and previews, whole-set `/changes`, `/apply`, `/discard` (rulings 37, 86). **DESIGN ONLY: NOT IMPLEMENTED:** the navigable viewer and per-hunk accept (R75 to R86). Deferral note D7.

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

> **PARTIAL.** Shipped: the single-key approval card (ruling 85) and the guardian line (ruling 60). **DESIGN ONLY: NOT IMPLEMENTED:** exact-effect rendering bound to the intent digest. Deferral note D8.

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

> **DESIGN ONLY** beyond `NO_COLOR`, `TERM=dumb`, ASCII glyph fallbacks and the narrow-terminal ladder. Deferral note D11.

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

> **DESIGN ONLY.** The only enforced budget is the startup-latency gate in `ops/gates.sh` (ruling 72). Deferral note D12.

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

> **DESIGN ONLY: NOT IMPLEMENTED.** Deferral note D15.

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
| `UiEventV1` | envelope (`eventId`, `cursor`, `lane: "durable" \| "ephemeral"`, `kind`, `timestamp`, `payload`) | Local TUI type, named per `_conventions.md` §7; the lane split is adopted from source: `arch_V1/contracts-v2/ui-stream-event-v2.schema.json` of the ancestor project (not cloned, path not verified), which is a reference schema and is not declared in `docs/05` |
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
│ │ cwd         `repo` (repo not cloned, path not verified)        ask expires in 108s                                             ││
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

> **DESIGN ONLY: NOT IMPLEMENTED.** No keybindings file is read by any code.

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

**Levels are owned by `docs/28-implementation-status.md`** (RC-13). Rows marked TESTED + VERIFIED (v0.1 subset) record the slice that exists and is tested; every row marked DESIGNED is **NOT IMPLEMENTED** (the Provenance section at the end lists each with its deferral note); every other row starts at `DESIGNED` and claims nothing above it until the named evidence exists (`_conventions.md` §8).

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

Known inherited limitation that this document MUST NOT paper over: the ancestor kernel refuses two edits to the same file inside one message (`stale_preimage`), which is why R83 mandates sequential application with explicit preimage recomputation rather than a silent bulk apply (source: `HANDOFF.md` of the ancestor project (not cloned, path not verified)).

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

Superseded by the **Provenance (whole TUI)** section at the end of this document, which covers Parts 1, 2 and 3 and the design rules with exact upstream URLs at pinned commits. Short form: Part 3 is a clean adaptation of the BEHAVIOUR of Grok Build's minimal mode and its prompt widgets (no code copied; the reference is Rust, HorizonCode is zero-runtime-dependency TypeScript). Bracketed paste is the standard xterm mode 2004 contract through Node readline's `paste-start` and `paste-end` keypresses; the approval card, diff gutter, thinking fold and subagent cell are adapted from the Grok look; tab completion and ghost text are adapted behaviour; `/theme` extends the Part 2 role table. The earlier note that the upstream paths were unverified is obsolete: they were checked against the pinned clone.

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
- Suggested fixes for each gap above, with files to touch, are in deferral note D18 (and D6 for the dropdown, D10 for `/theme` persistence) in the Provenance section.

---

## Provenance (whole TUI: Parts 1 to 3 and the design rules)

This section records, for the whole terminal UI, which designs and which bytes came from other repositories, with exact GitHub URLs at the commit that was read, and which parts of this document are design only. It is a handoff aid and changes no status level; `docs/28-implementation-status.md` is the only place that may claim a level above DESIGNED. It covers Parts 1, 2 and 3 of the polish work (rulings 54 to 58, 84 to 91 in `docs/28`) and the 201 design rules of section 2. It replaces the earlier text of 'Part 3 provenance', which said the Grok paths had not been verified: they have now been checked.

Reading the tables:

- URLs point at a file at the full 40 character SHA from [`research/upstream-pins.md`](research/upstream-pins.md). Each path was checked with `git ls-files` in the read-only clone before it was written. Anything not checkable is written `path not verified`.
- **Relation**: **copied verbatim**, **ported**, **adapted**, or **idea only**, as defined in the Provenance section of [`08-runtime.md`](08-runtime.md). In this document nothing is copied verbatim and nothing is ported: HorizonCode is zero-runtime-dependency TypeScript and the references are Rust (Grok Build, codex) or other TypeScript frameworks; every shipped item is an adaptation of BEHAVIOUR (what the user sees). The colour values in `style.ts` were re-typed from the study notes, not copied from source files.
- Judged from the header comments of the HorizonCode files, the docs/28 rulings, `research/grok-tui-deep.md` and reading both sides.
- Licences found: cline, codex Apache-2.0; oh-my-pi, opencode MIT; grok-build and claude-code have their own `LICENSE` files not analysed here. The worktree has no `LICENSE` or `NOTICE`; attribution for any verbatim or ported row would be an OPEN item for the human owner. Since nothing here is copied or ported, no attribution is currently owed for this document, but a future port of oh-my-pi `packages/tui` or of Grok code WOULD owe it.
- The Claude Code clone pinned here ([`anthropics/claude-code`](https://github.com/anthropics/claude-code/tree/0ed94698aa0aeee471465fc9c867c2e8434c4d68)) contains plugins, workflows and a devcontainer, not the product's TUI source; behaviour attributed to Claude Code below is product behaviour and carries no file link.
- The ancestor project referred to in older text (`horizoncode` / `repo-tour`) is an earlier private codebase that is not available in this sandbox; its paths cannot be verified.
- Research: [`research/grok-tui-deep.md`](research/grok-tui-deep.md) (the Part 2 spec is its section 10), [`research/compare-codex-grok.md`](research/compare-codex-grok.md), [`28-implementation-status.md`](28-implementation-status.md) rulings 54 to 58 and 84 to 91, and [`30-steal-list.md`](30-steal-list.md) sections 5.5 and 5.12.

### What shipped, and where it came from

Shipped means TESTED per `docs/28`; evidence is in `app/tests/tui/`. The shipped TUI is **scrollback-only**: one screen mode, readline owns the prompt, no alternate screen, no mouse capture.

| # | HorizonCode file(s) | Upstream exact URL(s) at the pinned SHA | Relation | Notes |
|---|---|---|---|---|
| 1 | `app/src/tui/live.ts` (`composeStatusBar`, idle status line, spinner footer, `createLive`), `app/src/tui/banner.ts` | [`crates/codegen/xai-grok-pager/src/views/turn_status.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/turn_status.rs)<br>[`crates/codegen/xai-grok-pager/src/views/status_line/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/status_line/mod.rs)<br>[`crates/codegen/xai-grok-pager-minimal/src/live.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/live.rs)<br>[`crates/codegen/xai-grok-pager/src/tips/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/tips/mod.rs) | adapted (behaviour only) | Part 1 (v0.1): the dim status line above the prompt, the one-line spinner footer with elapsed time and `esc to cancel`, the compact banner with a rotating tip. Grok's minimal mode is a pinned live region over native scrollback; HorizonCode keeps readline owning the prompt line and draws nothing below it (R5), so only the LOOK and the information order were taken. No Rust was ported (zero-runtime-dependency TypeScript). Evidence: `app/tests/tui/live.test.ts`, `banner.test.ts`. |
| 2 | `app/src/tui/render.ts` (shaded user block with `HH:MM`, turn footer `. 12.4s . 3 tools . up 1.2k tok`) | [`crates/codegen/xai-grok-pager/src/scrollback/blocks/user.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/user.rs) | adapted (behaviour only) | The shaded full-width user block and the dim end-of-turn footer. Grok's marker wording is `Worked for 12.4s`; HorizonCode keeps its own footer wording (a deferred item, see the Part 2 deferral list). Plain mode (pipes, `-p`, headless) is pinned byte for byte by `app/tests/tui/fixtures/plain-events.expected.txt`. |
| 3 | `app/src/tui/style.ts` (`detectColorLevel`, role table, `visibleWidth`, `truncate`, glyph ladder) | [`crates/codegen/xai-grok-pager-render/src/theme/color_support.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/color_support.rs)<br>[`crates/codegen/xai-grok-pager-render/src/theme/groknight.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/groknight.rs)<br>[`crates/codegen/xai-grok-pager-render/src/theme/grokday.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/grokday.rs)<br>[`crates/codegen/xai-grok-pager-render/src/render/color.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/color.rs)<br>[`crates/codegen/xai-grok-pager-render/src/glyphs.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/glyphs.rs) | adapted (concepts and palette shape) | Four-level colour ladder (0 none, 1 basic-16, 2 256, 3 truecolor), a role table mapping each semantic role to RGB, a 256 index and a basic SGR, RGB blend then quantize for pulses, light/dark selection, and same-width ASCII fallbacks for every glyph. The `research/grok-tui-deep.md` section 5 palette (GrokNight/GrokDay) informed the role values; the numbers are re-typed into `style.ts`, not copied from the Rust files. Display-width counting (CJK and emoji are 2, combining marks 0) is original (Grok uses a Rust unicode-width crate). Licence of the Grok crates is their own `LICENSE`; see the licence note above. |
| 4 | `app/src/tui/live.ts` (synchronized frames, 40 ms clock, narrow ladder, cursor hide and restore) | [`crates/codegen/xai-grok-pager/src/app/event_loop.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/event_loop.rs)<br>[`crates/codegen/xai-grok-pager-minimal/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/lib.rs)<br>[`crates/codegen/xai-grok-pager/src/views/turn_status.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/turn_status.rs) | adapted (technique) | DEC 2026 synchronized output around every live frame (skipped under tmux), identical consecutive frames write nothing, one timer that runs only while something animates (Grok `TickDemand`), the spinner glyph slower than the frame clock, the truecolor `sin^2` pulse, and the narrow-terminal drop order (below 80 columns `esc` only, below 60 phase timer, below 40 label and clock, below 24 spinner). Grok's `Presenter` frame coalescing and writer-stall detection (`event_loop.rs`) were NOT taken: HorizonCode writes to a stream it does not own the backpressure of; recorded as a deferral below (R63 to R74). |
| 5 | `app/src/tui/cards.ts` (tool cards, shell card, folded runs), `app/src/tui/render.ts` | [`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/mod.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/read.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/read.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/search.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/search.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/execute.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/execute.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/web_fetch.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/web_fetch.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/state/verb_group.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/state/verb_group.rs) | adapted (formats and verb vocabulary) | One-line `Verb object (detail)  0.2s` cards, the shell card (`$ cmd`, first 2 and last 3 output lines, `... +N lines`, `exit N` footer), and folding four or more consecutive read-only cards into one `Read 5 files, Searched 2 patterns` line. Differences that are deliberate: HorizonCode times every card (Grok does not), folds at COMMIT time only because scrollback cannot be rewritten (Grok folds in its own pane), and counts come from the additive `tool.card.detail` contract field rather than parsing a summary. Pure functions, golden-tested in `app/tests/tui/cards.test.ts`. |
| 6 | `app/src/tui/cards.ts` (subagent group and cells), `app/src/tui/live.ts` (live subagent rows) | [`crates/codegen/xai-grok-pager/src/scrollback/blocks/subagent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/subagent.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/agent.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/agent.rs)<br>[`crates/codegen/xai-grok-pager/src/app/acp_handler/subagent_lifecycle.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/acp_handler/subagent_lifecycle.rs)<br>[`crates/codegen/xai-grok-pager/src/app/acp_handler/subagent_activity.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/acp_handler/subagent_activity.rs) | adapted (behaviour only) | `Subagent running`, `Subagent completed in 20s`, `failed in 12s (reason)` cells and the live `Subagents N` rows with up to five entries and a `show N more` line. HorizonCode binds child events to `agent` calls by `agentId`, with the additive `subagent.start\|end` events (contract C2, ruling 88) as the exact source and a FIFO first-sight binding as the fallback for an older runtime. No mouse `[stop]` button (needs mouse capture, see the deferral for R23 to R36). Tests: `app/tests/tui/subagent-cells.test.ts`. |
| 7 | `app/src/tui/markdown.ts` | [`crates/codegen/xai-grok-markdown/src/streaming.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/streaming.rs)<br>[`crates/codegen/xai-grok-markdown/src/render.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/render.rs)<br>[`crates/codegen/xai-grok-markdown/src/hyperlinks.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-markdown/src/hyperlinks.rs)<br>[`crates/codegen/xai-grok-pager-render/src/render/highlight.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/highlight.rs)<br>[`crates/codegen/xai-grok-pager-render/src/render/osc8.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/osc8.rs) | adapted (behaviour only), original implementation | A line-oriented streaming markdown renderer that is independent of chunk boundaries (fuzz-tested by splitting a document at every byte offset), model text sanitized first, a 150 ms release of a slow plain line, OSC 8 links only on terminals known to support them (or `HZ_HYPERLINKS=1`), pipe tables only when they fit, and a small regex highlighter (js/ts, python, shell, rust, go, json, yaml, toml, diff). Grok's crate is 19k lines with a real markdown parser and syntect-class highlighting; HorizonCode's is a few hundred lines by design. Not shipped from Grok: LaTeX, mermaid, inline images, source maps for selection. |
| 8 | `app/src/tui/paste.ts` | [`crates/codegen/xai-grok-pager/src/app/agent_view/paste.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/paste.rs)<br>[`codex-rs/tui/src/bottom_pane/paste_burst.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/paste_burst.rs)<br>[`packages/tui/src/bracketed-paste.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/bracketed-paste.ts) | adapted (standard xterm mode 2004 contract) | Ruling 84. Bracketed paste via readline's `paste-start` and `paste-end` keypresses, a multi-line paste collapses to `[pasted N lines]`. Grok's 2 ms burst coalescing fallback (for terminals without bracketed paste) was not taken. Safety: a paste during an approval card is ignored (ruling 91). |
| 9 | `app/src/tui/approval-card.ts`, `app/src/tui/approval.ts` | [`crates/codegen/xai-grok-pager/src/views/permission_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/permission_view.rs)<br>[`codex-rs/tui/src/bottom_pane/approval_overlay.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/approval_overlay.rs) | adapted (behaviour only) | Ruling 85. Bordered `Approve ...?` card with tool, argument summary, risk and single keys `y`/`n`/`a`/`Esc`. The 250 ms type-ahead guard and the paste guard are HorizonCode additions (Grok's card is mouse and keyboard in a fullscreen pane). Not taken: the exact-effect rendering of R87 to R98 (deferred). |
| 10 | `app/src/tui/diff.ts` | [`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs)<br>[`codex-rs/tui/src/diff_render.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/diff_render.rs)<br>[`packages/tui/src/chrome/diff.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/chrome/diff.ts) | adapted (behaviour only) | Ruling 86. Line-number gutter, coloured +/- rows, folded unchanged context, an `... N more lines` footer in rich `turn.diff` and in previews. This is display only; there is NO per-hunk accept (R75 to R86, deferred). |
| 11 | `app/src/tui/render.ts` (thinking fold), `app/src/tui/interactive.ts` (`/think`) | [`crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs) | adapted (behaviour only) | Ruling 87 with additive contract C3 (`assistant.thinking`). Collapsed to `Thought for Ns . N lines`; `/think` expands the last block of the current process. Thinking is never persisted. NOT tested end to end against a real reasoning provider (stated in the Part 3 safety properties). |
| 12 | `app/src/tui/completion.ts` | [`crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs)<br>[`crates/codegen/xai-grok-pager/src/views/completion_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/completion_dropdown.rs)<br>[`packages/tui/src/autocomplete.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/autocomplete.ts)<br>[`packages/tui/src/component/prompt/autocomplete.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/prompt/autocomplete.tsx) | adapted (behaviour only) | Ruling 89. Tab completes `/commands` and `@paths` through readline's completer and shows a dim ghost suffix after the cursor. The popup dropdown of Grok, codex (`command_popup.rs`, `file_search_popup.rs`) and opencode is NOT built because readline repaints erase anything drawn below the prompt (research section 10.1); deferred. |
| 13 | `app/src/tui/style.ts` (`/theme`), `app/src/tui/interactive.ts` (`/theme`) | [`crates/codegen/xai-grok-pager/src/slash/commands/theme.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/theme.rs)<br>[`codex-rs/tui/src/theme_picker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/theme_picker.rs)<br>[`packages/tui/src/component/dialog-theme-list.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/dialog-theme-list.tsx) | adapted (behaviour only) | Ruling 90. `dark\|light\|auto\|mono` for the session through the role table; `NO_COLOR` always wins. Session scope only, not persisted (named gap). |
| 14 | `app/src/tui/print.ts`, `app/src/tui/headless.ts` | [`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)<br>[`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/exec/src/cli.rs)<br>Claude Code `-p --output-format json\|stream-json`: product behaviour, the pinned claude-code clone has no CLI source (path not verified) | idea only (flag shapes) | Ruling 57. `hzcode -p` sends one turn and exits; stdout carries only `text`, `json` or `stream-json`, notices go to stderr, headless approvals fail closed. The header of `print.ts` names Claude Code and `codex exec --json` as the references. Parity JSONL spec (`tui/headless-parity.spec`) is not written. |
| 15 | `app/src/core/permission-mode.ts`, `app/src/tui/interactive.ts` (`/mode` badge) | [`crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md)<br>[`docs/approval-mode.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/approval-mode.md)<br>Claude Code default/acceptEdits/plan modes: product behaviour (path not verified) | idea only (mode names), original policy layer | Ruling 58. `default \| plan \| accept-edits \| read-only`, a bold yellow badge for any non-default mode, `/mode yolo` refused with a reason. The policy semantics are in docs/11 and `permission-mode.ts`, not in the TUI. |
| 16 | `app/src/tui/interactive.ts` (`/copy`), `app/src/core/convo.ts` (`osc52`) | [`crates/codegen/xai-grok-pager-render/src/clipboard/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/clipboard/mod.rs)<br>[`codex-rs/tui/src/clipboard_copy.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/clipboard_copy.rs) | idea only | OSC 52 copy of the last answer. Grok and codex also fall back to `pbcopy`, `wl-copy`, `xclip`, tmux and WSL paths (R32); HorizonCode has OSC 52 only, so a terminal that ignores OSC 52 silently copies nothing. Named gap, with the fallback chain as a deferral below. |
| 17 | `app/src/tui/interactive.ts` (history file under the state root) | [`crates/codegen/xai-grok-pager/src/views/history_search.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/history_search.rs)<br>[`codex-rs/tui/src/bottom_pane/chat_composer_history.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/chat_composer_history.rs) | idea only | Readline history is persisted to an owner-only file (`historyFilePath`, mode tightened on every open). Reverse search (`Ctrl+R`), draft stash and durable-across-quit semantics of Grok and codex are not built. |
| 18 | `app/src/tui/interactive.ts` (`/sessions`, `/fork`, `/rewind`, `/retry`, `/rename`, `/export`, `/stats`, `/context`, `/files`) | see Provenance in [`12-sessions-state.md`](12-sessions-state.md) and [`08-runtime.md`](08-runtime.md) | n/a here | The session verbs are runtime features with a TUI front; their upstream sources (opencode revert and sessions, codex rollout, oh-my-pi session manager, Grok rewind and fork, forgecode conversation verbs T-12) are recorded in the docs/12 Provenance section so they are not duplicated. |
| 19 | `app/src/tui/interactive.ts` (custom `/commands` loaded from files), `app/src/core/commands.ts`, `app/src/core/doctor.ts` | see Provenance in [`09-tools.md`](09-tools.md) and [`10-cognition.md`](10-cognition.md) | n/a here | Custom commands as files (ruling 77, forgecode take T-13), skills (ruling 78), `/memory` and `/init` (docs/10 row 8) and `hzcode doctor` (ruling 71, Grok `/doctor`, forgecode T-10) are sourced in those documents. |


### Shipped scrollback mode versus the design in sections 2 and 3 (read this first)

> **Section 2 is largely DESIGN ONLY** (specification claims under `_conventions.md` §8). **Exception:** a reduced alt-screen chat (`fullscreen-chat.ts`, rulings **193**, **221**) is PARTIAL — TESTED; it is not the full R1–R12 fullscreen mode. The mouse model, overlay palette, and fullscreen keymap contexts are still not implemented. Default product: scrollback chat (Parts 1–3) plus `-p` and headless.

Where a design rule and the shipped behaviour disagree, the shipped behaviour is what users get today, and the disagreement is listed here so the next agent does not "fix" the code to match a rule that was never built, or the rule to match the code without a ruling:

- **R40 versus Esc.** R40 says `Esc` MUST NOT cancel a running turn. The shipped chat DOES cancel the running turn on a bare `Esc` where raw keypress events exist (`interactive.ts`, `key.name === "escape"` while busy), and the footer says `esc to cancel`. Grok's own policy is the opposite (it shows a 'Press Ctrl+c' toast). Decide in the keymap work (D4): keep the shipped convenience and amend R40, or follow R40.
- **R45 versus Ctrl+C.** R45 specifies a graded Ctrl+C (once interrupt, twice cancel the batch, three times exit 130 with a cancel panel when an effect may be unknown). Shipped: Ctrl+C stops the current answer and a second Ctrl+C leaves (`rl.on("SIGINT")`). There is no cancel panel and no graded third press.
- **R5 versus the multi-line live region** (see the R1 to R12 table).
- **R49/R53 versus `/help`.** `/help` prints a static table; it is not generated from live registries.
- **Section 2.2 component names** (`App`, `ModalHost`, ...) do not exist in code.
- **Section 3.3 layout at 120x36** is a fullscreen layout; the shipped screen is a scrolling transcript with a status line, a live footer and a prompt.

#### R1 to R12 (screen modes and rendering): status of each rule

R1 to R12 are the rendering rules derived from Grok's fullscreen pager (alternate screen, cell-diffed frames, mouse). **Reduced alt-screen chat is PARTIAL (rulings 176, 183, 193, 196, 221);** full Grok parity is still open. Default scrollback corresponds to Grok `--minimal` in spirit only.

| Rule | Text (short) | Status (2026-11-12) |
|---|---|---|
| R1 | Exactly two screen modes, fullscreen and inline | **PARTIAL.** Scrollback default + optional reduced alt-screen (`fullscreen-chat.ts`, ruling **221**). Not the full dual-mode layout engine. |
| R2 | Fullscreen is the default on a TTY | **NOT MET.** Scrollback is the default; fullscreen is opt-in via flag/env. |
| R3 | `--fullscreen` / `--minimal`, `HZ_TUI_MODE`, `[terminal] alt_screen` | **PARTIAL — TESTED** (`screen-mode.ts`, ruling **129**, **221**). `--fullscreen` and `HZ_TUI_MODE=fullscreen` run reduced alt-screen; `--minimal` conflict still exit 2. Config `alt_screen` not wired. |
| R4 | Mode switch relaunches the process | **PARTIAL.** `tui-handoff.json` + `hzcode tui relaunch` (ruling **177**); no in-place `/fullscreen` toggle. |
| R5 | Inline mode uses scrollback writes only, no cursor-addressed painting, no alt screen, no mouse capture | MOSTLY HONOURED, with one deviation. No alt screen, no mouse capture. BUT since Part 2 the live region can span several lines (subagent rows above the footer) and is redrawn with relative cursor movement and erase-to-end (`live.ts`), which is cursor-addressed painting within a few rows. R5 allows a `\r` overwrite of a single line only. The docs/13 text should be read as: R5 holds for transcript output, and the live region is a bounded exception. |
| R6 | Alt-screen entered before the first frame and left on every exit path | NOT APPLICABLE (no alt screen). The analogous guarantee that IS implemented: the cursor is shown again and bracketed paste is turned off on dispose, normal exit and process exit (`CURSOR_SHOW`, `PASTE_OFF`). |
| R7 | Restore order: mouse, bracketed paste, cursor, alt screen, raw mode | PARTIAL: bracketed paste off and cursor shown. Mouse and alt screen do not exist. Restore on SIGHUP, SIGTERM and panic paths is not separately tested. |
| R8 | Differential painting from a previous-frame cell buffer | **PARTIAL.** `cellbuffer.ts` + `encodeBufferFull` in fullscreen chat (rulings **176**, **193**); scrollback live region still not cell-diffed every frame. |
| R9 | All escape sequences through one writer queue | **PARTIAL.** `escape-writer.ts` on alt-screen path (**183**); scrollback still uses direct writes + `beforeWrite` hook. |
| R10 | No partial escape sequence on interruption | PARTIAL by construction: every live frame is one `write`. Not proven under resize. |
| R11 | Resize invalidates layout and hit rects and repaints | PARTIAL: the live region is erased on `resize` and redrawn on the next tick. There is no layout version and no hit-test rects. Grok reprints committed history at the new width after a debounce; HorizonCode does not (terminal reflow handles text). |
| R12 | `--render-probe` headless frame for goldens | **NOT MET.** `cellbuffer` goldens without TTY (**176**); no `--render-probe` CLI. PTY tests cover reduced fullscreen exit paths. |


### Where each design rule family came from (all DESIGN ONLY unless marked)

The rule families of section 2 were derived from the references below (see also the 'Sources this document is derived from' list in section 1). 'Status' says what exists in `app/src/tui/` today.

| Rules | Upstream exact URL(s) at the pinned SHA | Status in the shipped TUI | Notes |
|---|---|---|---|
| R1 to R12 (two screen modes, differential cell renderer, relaunch, restore on every exit path, render-probe) | [`crates/codegen/xai-grok-pager/src/app/terminal_restore.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/terminal_restore.rs)<br>[`crates/codegen/xai-grok-pager/src/app/event_loop.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/event_loop.rs)<br>[`crates/codegen/xai-ratatui-inline/README.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-ratatui-inline/README.md)<br>[`codex-rs/tui/src/custom_terminal.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/custom_terminal.rs)<br>[`codex-rs/tui/src/tui.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/tui.rs)<br>[`docs/tui-core-renderer.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/tui-core-renderer.md)<br>[`docs/tui-runtime-internals.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/tui-runtime-internals.md) | **PARTIAL** reduced alt-screen (rulings **176**, **183**, **193**, **196**, **221**); Grok R1–R12 parity open | See the R1 to R12 table below. |
| R13 to R22 (component tree, `ModalHost`, components render only) | [`crates/codegen/xai-grok-pager/src/app/app_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/app_view.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/mod.rs)<br>[`packages/tui/src/context/prompt.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/context/prompt.tsx)<br>[`packages/tui/src/components/layout/stack.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/components/layout/stack.ts) | NOT IMPLEMENTED | There is no component tree. `interactive.ts` (1504 lines) owns the whole chat loop and the pure modules (`cards.ts`, `markdown.ts`, `diff.ts`, `completion.ts`, `approval-card.ts`) are functions, not components. The table in section 2.2 names components (`App`, `ModalHost`, ...) that do not exist. |
| R23 to R36 (mouse: DEC 1000/1002/1006, hit-test rects, wheel routing, scrollbar drag, drag-select, copy, capture re-assertion, X10 repair, doctor) | [`crates/codegen/xai-grok-pager/src/app/mouse.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/mouse.rs)<br>[`crates/codegen/xai-grok-pager/src/app/x10_filter.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/x10_filter.rs)<br>[`crates/codegen/xai-grok-pager/src/app/csi_filter.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/csi_filter.rs)<br>[`crates/codegen/xai-grok-pager-render/src/input/mouse.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/input/mouse.rs)<br>[`crates/codegen/xai-grok-pager-render/src/input/terminal_support.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/input/terminal_support.rs)<br>[`crates/codegen/xai-grok-pager-render/src/render/scrollbar.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/scrollbar.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/text_selection.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/text_selection.rs)<br>[`crates/codegen/xai-grok-pager/src/slash/commands/toggle_mouse_reporting.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/toggle_mouse_reporting.rs)<br>[`crates/codegen/xai-grok-pager-pty-harness/src/scenarios/x10_mouse_leak.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/scenarios/x10_mouse_leak.rs)<br>[`codex-rs/tui/src/bottom_pane/chat_composer/mouse.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/chat_composer/mouse.rs)<br>[`packages/tui/src/mouse.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/mouse.ts) | NOT IMPLEMENTED (design only) | Mouse capture is never enabled. The scrollback-only mode must NOT enable it (R5) because capture steals native text selection and scrollback. |
| R37 to R52 (keymap registry, precedence stack, modes, graded Ctrl+C, vim/emacs presets, keybindings file, debug HUD) | [`packages/tui/src/config/keybind.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/config/keybind.ts)<br>[`codex-rs/config/src/tui_keymap.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/config/src/tui_keymap.rs)<br>[`codex-rs/tui/src/chatwidget/keymap_picker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/chatwidget/keymap_picker.rs)<br>[`crates/codegen/xai-grok-pager/src/actions/defaults.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/actions/defaults.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md)<br>[`packages/tui/src/keybindings.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/keybindings.ts)<br>[`docs/keybindings.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/keybindings.md) | NOT IMPLEMENTED (design only) | Keys are handled by readline plus three raw listeners in `interactive.ts` (Esc while busy, SIGINT, bracketed paste). See the keymap note below for the places where the shipped behaviour CONTRADICTS the design text. |
| R53 to R62 (slash registry, palette, `/help` from live registries) | [`crates/codegen/xai-grok-pager/src/slash/registry.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/registry.rs)<br>[`crates/codegen/xai-grok-pager/src/app/command_catalog.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/command_catalog.rs)<br>[`packages/tui/src/component/command-palette.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/command-palette.tsx)<br>[`codex-rs/tui/src/bottom_pane/slash_commands.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/slash_commands.rs)<br>[`codex-rs/tui/src/chatwidget/slash_dispatch.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/chatwidget/slash_dispatch.rs) | PARTIAL: static table and Tab completion only; no palette | `interactive.ts` holds a static `[name, description]` table that `/help` prints, plus custom commands from files. There is no registry object, no palette overlay, no fuzzy ranking, no `hzcode keybind` CLI. |
| R63 to R74 (streaming renderer, backpressure, degradation ladder) | [`crates/codegen/xai-grok-pager/src/app/event_loop.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/event_loop.rs)<br>[`crates/codegen/xai-grok-pager/src/app/event_loop_stall.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/event_loop_stall.rs)<br>[`crates/codegen/xai-grok-pager/src/app/reader_thread.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/reader_thread.rs) | PARTIAL (v0.1 subset TESTED); ladder not built | Coalescing and synchronized frames exist; the writer-stall detector, frame budget and degradation ladder do not. |
| R75 to R86 (diff viewer, per-hunk accept through the kernel, sequential application with preimage recomputation) | [`packages/tui/src/feature-plugins/system/diff-viewer.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/feature-plugins/system/diff-viewer.tsx)<br>[`packages/tui/src/component/patch-diff.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/patch-diff.tsx)<br>[`codex-rs/tui/src/diff_render.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/diff_render.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs) | PARTIAL: gutters only; no viewer, no per-hunk accept | Staged changes are applied or discarded whole with `/apply` and `/discard`. |
| R87 to R98 (approval prompts with exact-effect rendering) | [`crates/codegen/xai-grok-pager/src/views/permission_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/permission_view.rs)<br>[`crates/codegen/xai-grok-pager/src/views/plan_approval_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/plan_approval_view.rs)<br>[`codex-rs/tui/src/bottom_pane/approval_overlay.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/approval_overlay.rs) | PARTIAL: single-key card shipped; exact-effect rendering not built | Needs `tui/approval-exactness.spec`. |
| R99 to R112 (transcript folds, search, copy, links, media protocols) | [`crates/codegen/xai-grok-pager-minimal/src/full_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/full_view.rs)<br>[`codex-rs/tui/src/chatwidget/transcript.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/chatwidget/transcript.rs)<br>[`codex-rs/tui/src/app/transcript_export.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/app/transcript_export.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/sticky.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/sticky.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/state/timeline.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/state/timeline.rs) | PARTIAL: commit-time run folding and OSC 8 links; no search, no `/transcript` pager, no media |  |
| R113 to R124 (theming tokens, quantization, high contrast, no-color) | [`crates/codegen/xai-grok-pager-render/src/theme/osc11.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/osc11.rs)<br>[`crates/codegen/xai-grok-pager-render/src/theme/env_appearance.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/env_appearance.rs)<br>[`crates/codegen/xai-grok-pager-render/src/theme/system_appearance.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/system_appearance.rs)<br>[`packages/tui/src/theme/system.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/theme/system.ts)<br>[`codex-rs/tui/src/theme_picker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/theme_picker.rs) | PARTIAL: role table, ladder, `/theme`, `NO_COLOR`; no theme files, no OSC 11 background query, no high-contrast theme |  |
| R125 to R136 (screen reader, reduced motion, IME, breakpoints, minimum size, bidi) | [`crates/codegen/xai-grok-pager/docs/user-guide/21-terminal-support.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/21-terminal-support.md)<br>[`crates/codegen/xai-grok-pager-render/src/render/bidi.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/bidi.rs) | NOT IMPLEMENTED beyond ASCII glyph fallback, `NO_COLOR` and the narrow ladder |  |
| R137 to R146 (performance budgets, `tui/perf.gate`) | [`crates/codegen/xai-grok-pager-pty-harness/benches/pty_bench.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/benches/pty_bench.rs)<br>[`crates/codegen/xai-grok-pager/src/views/fps_hud.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/fps_hud.rs)<br>[`crates/codegen/xai-grok-pager/src/views/scroll_debug_hud.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/scroll_debug_hud.rs) | NOT IMPLEMENTED; only the startup-latency gate of `ops/gates.sh` (ruling 72) exists |  |
| R147 to R156 (session-management UI: picker, resume, fork, rewind, tree, cost) | [`crates/codegen/xai-grok-pager/src/app/dashboard_session_picker.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/dashboard_session_picker.rs)<br>[`crates/codegen/xai-grok-pager/src/views/rewind.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/rewind.rs)<br>[`codex-rs/tui/src/resume_picker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/resume_picker.rs)<br>[`packages/tui/src/component/dialog-session-list.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/dialog-session-list.tsx)<br>[`packages/tui/src/apps/session-picker.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/apps/session-picker.ts)<br>[`apps/cli/src/tui/components/dialogs/checkpoint-picker.tsx`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/apps/cli/src/tui/components/dialogs/checkpoint-picker.tsx) | PARTIAL: `/sessions`, `/fork`, `/rewind`, `/retry`, `/rename`, `--resume`; no picker, no tree, no cost |  |
| R157 to R166 (status surfaces) | [`crates/codegen/xai-grok-pager/src/views/status_bar.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/status_bar.rs)<br>[`crates/codegen/xai-grok-pager/src/views/status_line/segments.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/status_line/segments.rs)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/25-status-line.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/25-status-line.md) | PARTIAL: Part 1 status line only |  |
| R167 to R176 (errors, `UNKNOWN`, receipt inspector) | none claimed (original to the kernel receipt design in docs/11) | NOT IMPLEMENTED in the TUI | `/export html` shows the receipt chain status; there is no inspector. |
| R177 to R184 (notifications: bell, desktop, webhook) | [`crates/codegen/xai-grok-pager/src/notifications/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/notifications/mod.rs)<br>[`crates/codegen/xai-grok-pager/src/notifications/focus.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/notifications/focus.rs)<br>[`crates/codegen/xai-grok-pager/src/notifications/tmux.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/notifications/tmux.rs)<br>[`packages/tui/src/desktop-notify.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/desktop-notify.ts) | NOT IMPLEMENTED |  |
| R185 to R196 (non-interactive output modes) | [`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)<br>[`codex-rs/exec/src/event_processor.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/exec/src/event_processor.rs) | PARTIAL (v0.1 subset TESTED): `-p` text/json/stream-json and headless |  |
| R197 to R201 (composer queue editing, language hints, attachments, completion summary) | [`crates/codegen/xai-grok-pager/src/app/agent_view/queue.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/queue.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/prompt_stash.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/prompt_stash.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/media.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/media.rs)<br>[`crates/codegen/xai-grok-pager/src/wrap_clipboard_image.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/wrap_clipboard_image.rs) | NOT IMPLEMENTED | There is no queue panel; one prompt is processed at a time. |


### Sources that could not be linked

The ancestor `horizoncode` TUI contract `arch_V1/contracts-v2/ui-stream-event-v2.schema.json` (the `durable`/`ephemeral` lane split adopted in section 3.1), `HANDOFF.md` (the `stale_preimage` limitation cited under section 10) and the other 'ancestor' paths in this document belong to an earlier private codebase that is not cloned here; they stay as text and are marked 'path not verified'. aider, mini-swe-agent, hermes-agent, OpenHands, SWE-agent, wshobson-agents, DeepSeek-Reasonix and opencode-v2 are not cloned; see the 'Not cloned' table in [`research/upstream-pins.md`](research/upstream-pins.md).


### Deferred or not started: detailed notes for the next agent

Each note gives: what is deferred, why, the upstream reference, whether to adopt as is or adapt, a suggested design, and the files to touch. 'Adapt' is the default because the references are Rust or a different UI framework. No note below changes a status level. Paths are given from the repository root.

#### D1. Fullscreen alt-screen mode with a differential cell renderer (R1 to R12)

- **Status (2026-11-12).** **PARTIAL — TESTED (rulings 176, 183, 193, 196, 221):** `cellbuffer.ts`, `escape-writer.ts`, `fullscreen-chat.ts`, `resume-picker.ts`; `--fullscreen` / `HZ_TUI_MODE=fullscreen` enter reduced alt-screen (doctor ok). **Still open:** in-app scrollback pane, mouse/hit-test, differential paint on every frame, full keymap, render-probe CLI (R1–R12 target).
- **What is deferred (remainder).** Full Grok fullscreen: in-app scrollback pane, layout engine, hit-testing, rich cards/diff gutters in alt-screen, and `--render-probe` goldens. The reduced slice exists; the screenshot parity mode does not.
- **Why.** HorizonCode ships a scrollback-native chat on readline (ADR-001 makes the TUI the primary surface, but the v0.1 slice chose the smaller, pipe-safe design first). A fullscreen mode needs its own line editor, a layout engine, hit-testing and a test harness, and it would replace readline's prompt ownership; that is a rewrite of `interactive.ts`, not a polish item. `research/grok-tui-deep.md` section 11 prices the nearest rewrite (own the raw stdin and the line editor, a retained frame buffer with cell diff, a pinned bottom viewport) at 2.5k to 4k lines of TypeScript plus a VT-emulator test harness, and recommended NOT doing it until the readline path was exhausted. Its recommended successor, if readline limits are hit, is Grok's MINIMAL-mode architecture (pinned viewport, commit frontier, print-once scrollback), not the fullscreen pane.
- **Upstream reference.** [`crates/codegen/xai-ratatui-inline/README.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-ratatui-inline/README.md)<br>[`crates/codegen/xai-grok-pager/src/app/event_loop.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/event_loop.rs)<br>[`crates/codegen/xai-grok-pager/src/app/terminal_restore.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/terminal_restore.rs)<br>[`crates/codegen/xai-grok-pager/src/app/app_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/app_view.rs)<br>[`codex-rs/tui/src/custom_terminal.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/custom_terminal.rs)<br>[`codex-rs/tui/src/tui.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/tui.rs)<br>[`docs/tui-core-renderer.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/tui-core-renderer.md)<br>[`docs/tui-runtime-internals.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/tui-runtime-internals.md)<br>[`packages/tui/src/index.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/index.ts)
- **Adopt as is or adapt.** ADAPT. Grok and codex are Rust on ratatui; they cannot be reused in a zero-runtime-dependency TypeScript runtime. The oh-my-pi `packages/tui` is TypeScript with a differential renderer and is MIT licensed, so its DESIGN (component tree, overlay stack, frame scheduler, differential diff) is the closest model; copying its code would introduce a licence obligation and an attribution requirement (see the licence note above) and a large surface to keep. Prefer a clean re-implementation of the algorithm described in its `docs/tui-core-renderer.md`.
- **Suggested design.** Recommended order: first the scrollback-native inline-viewport rewrite (the research's 'Part 3 rewrite': own stdin and the line editor, pinned live region, commit frontier; it removes the readline limits behind D5, D6, D16 and D18(h) and keeps native selection and scrollback), and only then a true alternate-screen mode. Steps for the fullscreen part: (1) Add a `ScreenMode` ('scrollback' | 'fullscreen') resolved once in `main.ts` from flag, `HZ_TUI_MODE`, config, then TTY detection (R2/R3). (2) Write a pure `cellbuffer.ts` (cells with grapheme, style, width; `diff(prev, next) -> Run[]`; golden-tested without a terminal, which also gives the R12 render-probe). (3) A single `EscapeWriter` with a queue (R9) that is the ONLY writer in fullscreen mode, installed with idempotent terminal restore for SIGINT, SIGTERM, SIGHUP, uncaughtException and exit (R6/R7). (4) Reuse the existing pure modules (`cards.ts`, `markdown.ts`, `diff.ts`, `style.ts`) as cell producers: they already return styled strings, which a `parseAnsiToCells` helper can turn into cells. (5) Do NOT start with the mouse. Ship fullscreen with keyboard only, behind `HZ_TUI_MODE=fullscreen`, and keep scrollback the default until the PTY harness (D12) can drive both.
- **Files to touch.** new `app/src/tui/screen.ts`, `cellbuffer.ts`, `escape-writer.ts`; `app/src/main.ts` (flag and env parsing, listed in `--help`); `app/src/tui/interactive.ts` (split the chat loop from the readline front); `app/src/tui/live.ts` (the live region becomes a pane); tests under `app/tests/tui/`. Contracts are untouched (`contracts.ts` additive only).

#### D2. In-process mode switch / relaunch (R3, R4, `hzcode tui relaunch`)

- **What is deferred.** Switching between fullscreen and scrollback while keeping the session, draft text and event cursor.
- **Why.** Depends on D1. The design text chose relaunch (preserve session id, workspace, draft, cursor; no re-admission) for safety. Grok switches in place with `/fullscreen` and `/minimal`, which is simpler for the user but means the whole component tree must survive a screen change.
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/app/event_loop.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/event_loop.rs)<br>[`crates/codegen/xai-grok-pager-minimal/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/lib.rs)<br>[`crates/codegen/xai-grok-pager/src/minimal/api.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/minimal/api.rs)<br>[`crates/codegen/xai-grok-pager/src/minimal/hook.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/minimal/hook.rs)
- **Adopt as is or adapt.** ADAPT (the design's relaunch is safer than Grok's in-place switch).
- **Suggested design.** Write the draft and the last-read event cursor to `<state root>/tui-handoff.json` (0600, atomic rename, removed on read), exec the same binary with `--resume <id> --mode <m>`, and assert in a test that no admission row is created by the relaunch (use the admission queue in `core/admission.ts` as the oracle).
- **Files to touch.** `app/src/tui/interactive.ts`, `app/src/main.ts`, new `app/src/tui/handoff.ts`, `app/tests/tui/relaunch.test.ts`.

#### D3. Mouse: capture, hit-testing, wheel, scrollbar, drag-select, capture re-assertion, X10 repair (R23 to R36)

- **What is deferred.** Everything in section 2.3. DESIGN ONLY; the shipped scrollback mode never enables mouse reporting and must not (R5), because capture disables the terminal's native selection and scroll.
- **Why.** A mouse model only makes sense inside a fullscreen pane (D1). In scrollback mode the terminal owns the wheel, the selection and the copy, which is the feature users of a scrollback TUI want. Also the live `[stop]` button idea from Grok is replaced by `Esc` and `Ctrl+C`.
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/app/mouse.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/mouse.rs)<br>[`crates/codegen/xai-grok-pager/src/app/x10_filter.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/x10_filter.rs)<br>[`crates/codegen/xai-grok-pager/src/app/csi_filter.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/csi_filter.rs)<br>[`crates/codegen/xai-grok-pager-render/src/input/mouse.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/input/mouse.rs)<br>[`crates/codegen/xai-grok-pager-render/src/input/terminal_support.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/input/terminal_support.rs)<br>[`crates/codegen/xai-grok-pager-render/src/render/scrollbar.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/scrollbar.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/text_selection.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/text_selection.rs)<br>[`crates/codegen/xai-grok-pager/src/slash/commands/toggle_mouse_reporting.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/toggle_mouse_reporting.rs)<br>[`crates/codegen/xai-grok-pager-pty-harness/src/scenarios/x10_mouse_leak.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/scenarios/x10_mouse_leak.rs)<br>[`codex-rs/tui/src/bottom_pane/chat_composer/mouse.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/chat_composer/mouse.rs)<br>[`packages/tui/src/mouse.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/mouse.ts)
- **Adopt as is or adapt.** ADAPT the ALGORITHMS (SGR 1006 parse, X10 reassembly within a 50 ms gap, cached last-frame rects tagged with a layout version, drag capture, multi-click timing). Do not copy the Rust. The oh-my-pi `mouse.ts` is TypeScript and could be read as a reference implementation, subject to the licence note.
- **Suggested design.** Land it in this order, each behind fullscreen mode only: (1) `mouse-parse.ts`, a pure SGR/X10 parser with a fuzz test that feeds degraded sequences and asserts that a non-mouse byte stream is never swallowed (R35); (2) `hit-test.ts` over rects cached per painted frame with a layout version (R25, R26); (3) wheel routing to the pane under the pointer, 3 lines per notch (R29); (4) scrollbar drag and page-toward-click (R30); (5) selection with word/line granularity and `Selectable` spans that exclude gutters (R31, Grok `text_selection.rs`); (6) copy through OSC 52 then platform fallbacks, never blocking the loop (R32, see D17); (7) capture re-assertion on focus-gained via the writer queue (R34); (8) `/doctor` reporting of capture state (R36), extending `core/doctor.ts`. Keep a `/mouse` toggle like Grok's `toggle_mouse_reporting.rs`.
- **Files to touch.** new `app/src/tui/mouse-parse.ts`, `hit-test.ts`, `selection.ts`; `app/src/core/doctor.ts`; `app/tests/tui/mouse-*.test.ts`.

#### D4. Keymap registry, input precedence stack, modes, presets, keybindings file (R37 to R52)

- **What is deferred.** One registry of named actions with descriptions, defaults and contexts; a documented precedence stack (modal, palette, diff, search, selection, navigate/insert); `vim` and `emacs` presets as data; `~/.config/horizon/keybindings.toml` narrowed by a workspace file; `hzcode keybind list|check`; the debug HUD on F12. DESIGN ONLY.
- **Why.** The shipped chat is a readline line editor, which owns its own emacs-style keys. A registry is needed once there is more than one input context (fullscreen panes, overlays). Adding it to readline mode would mean intercepting keys readline already handles.
- **Upstream reference.** [`packages/tui/src/config/keybind.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/config/keybind.ts)<br>[`codex-rs/config/src/tui_keymap.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/config/src/tui_keymap.rs)<br>[`codex-rs/config/src/tui_keymap_chord_tests.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/config/src/tui_keymap_chord_tests.rs)<br>[`codex-rs/tui/src/chatwidget/keymap_picker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/chatwidget/keymap_picker.rs)<br>[`crates/codegen/xai-grok-pager/src/actions/defaults.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/actions/defaults.rs)<br>[`crates/codegen/xai-grok-pager/src/actions/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/actions/mod.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md)<br>[`packages/tui/src/keybindings.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/keybindings.ts)<br>[`packages/tui/src/keybinding-matchers.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/keybinding-matchers.ts)<br>[`docs/keybindings.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/keybindings.md)
- **Adopt as is or adapt.** ADAPT. opencode's leader-key plus named-action model and codex's chord parsing (with its chord tests) are the best fits. All are data-driven; copy the SHAPE of the schema (action id, description, default, contexts, source) which docs/13 R44 already specifies.
- **Suggested design.** (1) `keymap.ts`: `ActionDef { id, description, default, contexts }`, a parser for chords including `repeat: 1|2|3` (R48), a resolver with the layer stack (R38). (2) Port the three existing raw listeners in `interactive.ts` to registered actions (`turn.interrupt`, `app.quit`, `turn.cancel-esc`). (3) Validation: unknown action ids, unknown keys and duplicate bindings fail at startup via `hzcode keybind check` (R48); a workspace file may only NARROW and may not shadow `Ctrl+C` or approval keys (R47). (4) `hzcode keybind list --json` with `source` per binding (R44). (5) Per-terminal overrides as data (R52).
- **Files to touch.** new `app/src/tui/keymap.ts`, `keymap-presets.ts`; `app/src/main.ts` (`keybind` subcommand, dispatched before the chat arg parse like `doctor`); `app/src/tui/interactive.ts`; `app/tests/tui/keymap.test.ts`; a new gate row in `ops/gate-catalogue.md` when `tui/keymap.spec` exists.

#### D5. Slash registry and command palette (R53 to R62)

- **What is deferred.** MRU-ranked palette, `?` chord, `/help` generated from the live keymap plus tool registry (R49), skills/MCP prompt rows in one table. **Reduced (rulings 177, 232):** `slash-registry.ts`, `fuzzy.ts`, scrollback `/palette` print, fullscreen `fullscreen-palette.ts` overlay (`Ctrl+P`, `/palette` Enter) sharing `rankPaletteCommands`.
- **Why (residual).** Scrollback still has no overlay without readline hacks (D6); generated help and MRU need keymap registry work (R49–R62).
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/slash/registry.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/registry.rs)<br>[`crates/codegen/xai-grok-pager/src/slash/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/mod.rs)<br>[`crates/codegen/xai-grok-pager/src/app/command_catalog.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/command_catalog.rs)<br>[`crates/codegen/xai-grok-pager/src/slash/commands/help.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/help.rs)<br>[`packages/tui/src/component/command-palette.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/command-palette.tsx)<br>[`codex-rs/tui/src/bottom_pane/slash_commands.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/slash_commands.rs)<br>[`codex-rs/tui/src/bottom_pane/command_popup.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/command_popup.rs)<br>[`packages/tui/src/fuzzy.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/fuzzy.ts)
- **Adopt as is or adapt.** ADAPT. Take Grok's registry shape (one table that feeds completion, `/help` and the palette) and opencode's palette interaction.
- **Suggested design.** Move the `[name, description]` table in `interactive.ts` (lines ~170 to 200) into `app/src/tui/slash-registry.ts` as `SlashCommand { name, aliases, description, args, availability(ctx) }`. Make `completion.ts` and `/help` read it (this alone removes the duplicated list). Then add `fuzzy.ts` (subsequence score with prefix bonus, no dependency) and the palette overlay once D1 exists.
- **Files to touch.** `app/src/tui/interactive.ts`, `app/src/tui/completion.ts`, new `slash-registry.ts`, `fuzzy.ts`, `app/tests/tui/slash-registry.test.ts`, `app/src/core/commands.ts` (custom commands register into it).

#### D6. Popup completion dropdown for `/` and `@`

- **What is deferred.** A dropdown under the scrollback prompt with up to 8 rows (6 for `@` files), selected row highlight, scrollbar beyond the cap. Part 3 shipped Tab completion and a ghost suffix only. **Alt-screen reduced (ruling 232):** fullscreen fuzzy command palette is not the `/`-prefix popup; use `Ctrl+P` or `/palette` there.
- **Why.** readline's `_refreshLine` runs `clearScreenDown` on edits (backspace, history, wrap), erasing anything drawn below the prompt; every keypress would need a repaint hook, and wrapping and resize make it fragile (`research/grok-tui-deep.md` section 10.1 and P3).
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs)<br>[`crates/codegen/xai-grok-pager/src/views/completion_dropdown.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/completion_dropdown.rs)<br>[`codex-rs/tui/src/bottom_pane/command_popup.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/command_popup.rs)<br>[`codex-rs/tui/src/bottom_pane/file_search_popup.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/file_search_popup.rs)<br>[`packages/tui/src/component/prompt/autocomplete.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/prompt/autocomplete.tsx)
- **Adopt as is or adapt.** ADAPT the layout numbers (label column at most 40 chars and 60 percent of width, 2-space gap, `>` prefix on the selected row).
- **Suggested design.** Behind `HZ_POPUP=1` only: reserve rows by writing N newlines then moving up N, repaint after each keypress in a `setImmediate` after readline updated `rl.line`, erase on Enter/Esc. Ship only after the PTY harness (D12) can assert the screen after each key. The cleaner route is D1.
- **Files to touch.** `app/src/tui/completion.ts` (pure layout function), `app/src/tui/interactive.ts` (keypress hook), `app/tests/tui/completion.test.ts`, `pty.test.ts`.

#### D7. Diff viewer with per-hunk accept through the kernel (R75 to R86)

- **What is deferred.** A navigable viewer (file tree, hunks, accept/reject per hunk), applying accepted hunks through the guard and effect path with preimage recomputation between sequential applications. Today staged changes are applied or discarded whole.
- **Why.** Needs an interactive surface (D1) and a kernel path that applies a partial change; the kernel is a policy and audit prototype that does not execute effects (docs/28). Also the known inherited limit that two edits to one file in one message are refused (`stale_preimage`) shapes R83.
- **Upstream reference.** [`packages/tui/src/feature-plugins/system/diff-viewer.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/feature-plugins/system/diff-viewer.tsx)<br>[`packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx)<br>[`packages/tui/src/component/patch-diff.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/patch-diff.tsx)<br>[`codex-rs/tui/src/diff_render.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/diff_render.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs)<br>[`packages/tui/src/apps/git/diff-pane.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/apps/git/diff-pane.ts)
- **Adopt as is or adapt.** ADAPT. opencode's viewer keys and file tree are the reference for interaction; the apply semantics are HorizonCode's (guard, approval, journal, sha256 preimage check, ruling 63 file lock).
- **Suggested design.** First a non-interactive step that fits scrollback: `/changes <n>` shows hunk numbers and `/apply 1,3` applies selected hunks by re-running `plan.ts` staging with a filtered hunk set (the unified-diff hunks already exist in `core/plan.ts` and `core/turn-diff.ts`). Then the interactive viewer in fullscreen mode.
- **Files to touch.** `app/src/core/plan.ts` (hunk-level apply), `app/src/tui/interactive.ts` (`/changes`, `/apply`), `app/src/tui/diff.ts`, new `diff-viewer.ts`, `app/tests/tui/diff-apply.test.ts`.

#### D8. Approval prompts with exact-effect rendering (R87 to R98)

- **Status (2026-11-13).** **PARTIAL — TESTED (rulings 250, **254**):** rich `ToolCallCard` lines show EffectHost linkage (`effect <id8>`, `r#<seq>` or receipt prefix) when `tool.card` events carry `effectId` / `receiptSeq` (`cards.ts` `formatToolEffectLinkage`, `render.ts`, `loop.ts`). The single-key approval card prints a dim `effect · lease · tool` row when `ApprovalRequest` carries optional `effectId` / `leaseId` / `tool` (`approval-card.ts` `formatApprovalLinkage`, `loop.ts` on guard ask). **Still deferred:** exact effect bytes argv/path/origin bound to intent digest; inspector (`Ctrl+I`).
- **What is deferred.** Showing the exact bytes, argv, path set and network origin the effect will use, bound to the intent digest, in the approval card. The card shows tool, argument summary, risk and the guardian line.
- **Why.** Exact-effect rendering needs the kernel's intent digest and effect host (docs/11 section 7.3.2), which are DESIGNED, not built. Rendering something that is not what will run would be worse than the summary.
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/views/permission_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/permission_view.rs)<br>[`crates/codegen/xai-grok-pager/src/views/plan_approval_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/plan_approval_view.rs)<br>[`codex-rs/tui/src/bottom_pane/approval_overlay.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/approval_overlay.rs)
- **Adopt as is or adapt.** ADAPT the layout; the exactness contract is HorizonCode's.
- **Suggested design.** Render from the same `GuardAction` the kernel evaluated (never from the model's prose); show the resolved (symlink-followed) path, the full argv for shell with control characters visible (already done for shell), the origin triple for `net.fetch`. Add `tui/approval-exactness.spec` comparing the card text to the action JSON.
- **Files to touch.** `app/src/tui/approval-card.ts`, `approval.ts`, `app/src/core/loop.ts` (`GuardGate.approve` request fields), `app/tests/tui/approval-card.test.ts`.

#### D9. Transcript folds, search, `/transcript` pager, links and media (R99 to R112)

- **Status (2026-11-13).** **PARTIAL — TESTED (ruling 236):** long shell output and diff context stay folded by default; **`HZ_TUI_UNFOLD_DIFF=1`** expands rich diff context and lifts the turn-diff cap; **`HZ_TUI_UNFOLD_OUTPUT=1`** expands shell output panels (`fold-lines.ts`, `diff.ts` `expandContext`, `render.ts`). Read-only tool run folding unchanged (`cards.ts`). **Still deferred:** per-block fold/unfold in scrollback, search, media.
- **What is deferred.** Folding any block, searching the transcript, a full-history pager, file links, and image protocols (kitty, iTerm, sixel) with a text fallback. Only commit-time run folding and OSC 8 links ship.
- **Why.** Scrollback cannot be rewritten after printing, so folds and search need either a pager or fullscreen. Media needs an out-of-process decoder for untrusted bytes (R112).
- **Upstream reference.** [`crates/codegen/xai-grok-pager-minimal/src/full_view.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-minimal/src/full_view.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/sticky.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/sticky.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/state/timeline.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/state/timeline.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/media.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/media.rs)<br>[`codex-rs/tui/src/chatwidget/transcript.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/chatwidget/transcript.rs)<br>[`codex-rs/tui/src/app/transcript_export.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/app/transcript_export.rs)
- **Adopt as is or adapt.** ADAPT. For scrollback mode the useful piece is the minimal-mode `/transcript` pager: re-render the stored history through the same pure renderers into a pager.
- **Suggested design.** A `/transcript` verb that formats `SessionStore.history()` with `cards.ts` and `markdown.ts` and pipes it to `$PAGER` (or `less -R`) when stdout is a TTY. Search is then the pager's. Media stays deferred.
- **Files to touch.** `app/src/tui/interactive.ts`, `app/src/core/convo.ts` (shares the export formatter), `app/tests/tui/transcript.test.ts`.

#### D10. Theme files, OSC 11 background detection, high-contrast theme, persisted `/theme` (R113 to R124)

- **Status (2026-11-13).** **PARTIAL — TESTED (ruling 250):** `/theme` writes `theme` to user config (`persistThemeMode`); `createRuntime` applies it on startup. **Still deferred:** user theme files, OSC 11 query, high-contrast theme.
- **What is deferred.** User theme files, a startup OSC 11 query to pick dark or light, and a high-contrast theme. Built-in role table, `HZ_THEME`, `COLORFGBG`, `/theme`, and persisted user `theme` ship.
- **Why.** The OSC 11 query must run strictly before the input stream starts and has a 500 ms timeout (Grok); doing it under readline needs care. Persistence needs a config write path with the same merge rules as docs/11 section 7.6.
- **Upstream reference.** [`crates/codegen/xai-grok-pager-render/src/theme/osc11.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/osc11.rs)<br>[`crates/codegen/xai-grok-pager-render/src/theme/env_appearance.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/env_appearance.rs)<br>[`crates/codegen/xai-grok-pager-render/src/theme/system_appearance.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/theme/system_appearance.rs)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/06-theming.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/06-theming.md)<br>[`packages/tui/src/theme/system.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/theme/system.ts)<br>[`packages/theme`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/theme)<br>[`codex-rs/tui/src/theme_picker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/theme_picker.rs)
- **Adopt as is or adapt.** ADAPT. opencode's terminal-derived palette is the closest model to a role table.
- **Suggested design.** Add `theme` to the user config file (never a workspace file) and read it in `style.ts` before `HZ_THEME`; add `osc11.ts` with a 500 ms timeout used only when `COLORFGBG` is absent and stdin is a TTY; validate theme files against the role names with a clear error (as `hzcode config check` does, ruling 81).
- **Files to touch.** `app/src/tui/style.ts`, `app/src/core/config.ts`, new `app/src/tui/osc11.ts`, `app/tests/tui/theme.test.ts`.

#### D11. Accessibility: screen-reader mode, reduced motion, IME, breakpoints, minimum size (R125 to R136)

- **Status (2026-11-13).** **PARTIAL — TESTED (rulings 177, 236):** `HZ_REDUCE_MOTION` slows spinner/footers (`a11y.ts`, `live.ts`); **`HZ_SCREEN_READER=1`** / **`HZ_A11Y_PLAIN=1`** emit plain idle status and busy announcements without braille. **Still deferred:** IME, breakpoints, minimum-size gate, assistive-tech validation.
- **What is deferred.** A screen-reader mode that disables animation and redraws, a reduced-motion flag, IME composition handling, named layout breakpoints and a minimum terminal size message. Only the ASCII glyph fallback, `NO_COLOR`, `TERM=dumb` and the narrow ladder ship.
- **Why.** No user research or assistive-technology test has been done; claiming these without testing would be false. Readline already handles IME input for the single line.
- **Upstream reference.** [`crates/codegen/xai-grok-pager/docs/user-guide/21-terminal-support.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/21-terminal-support.md)<br>[`crates/codegen/xai-grok-pager-render/src/input/terminal_support.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/input/terminal_support.rs)<br>[`crates/codegen/xai-grok-pager-render/src/render/bidi.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/render/bidi.rs)
- **Adopt as is or adapt.** ADAPT (Grok's terminal-support table is the starting data).
- **Suggested design.** An `HZ_REDUCE_MOTION=1` (and `prefers-reduced-motion` equivalent where detectable) that makes `live.ts` print the footer once per second as a plain line instead of animating; a `--plain` that equals the non-rich path. Test with the existing plain fixture.
- **Files to touch.** `app/src/tui/live.ts`, `app/src/tui/style.ts`, `app/tests/tui/live.test.ts`.

#### D12. PTY and render-probe test harness, performance budgets and the debug HUD (R12, R51, R137 to R146, section 9)

- **What is deferred.** A harness that runs the real binary in a PTY, feeds the output through a headless terminal emulator, asserts what the user sees, measures frame times from DEC 2026 markers, and scripted-provider scenarios (streaming, large code block, resize storm, idle cost, approval flow). `tui/perf.gate` in CI. Today there is `tests/tui/pty.test.ts` through util-linux `script` (skips where `script` is missing) and byte-pinned goldens.
- **Why.** Needs a terminal emulator in TypeScript (no dependency allowed in the runtime; a dev-only dependency would need an exception to the zero-dependency rule, which is a decision for the owner).
- **Upstream reference.** [`crates/codegen/xai-grok-pager-pty-harness/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/lib.rs)<br>[`crates/codegen/xai-grok-pager-pty-harness/src/screen.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/screen.rs)<br>[`crates/codegen/xai-grok-pager-pty-harness/src/timing.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/timing.rs)<br>[`crates/codegen/xai-grok-pager-pty-harness/src/content.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/content.rs)<br>[`crates/codegen/xai-grok-pager-pty-harness/src/scenarios/resize_storm.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/src/scenarios/resize_storm.rs)<br>[`crates/codegen/xai-grok-pager-pty-harness/benches/pty_bench.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-pty-harness/benches/pty_bench.rs)<br>[`crates/codegen/xai-grok-pager/src/views/fps_hud.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/fps_hud.rs)
- **Adopt as is or adapt.** ADAPT the layering (spawn real binary, emulate, mock inference server with scripted SSE, named scenarios). The scripted provider (`core/providers/scripted.ts`) already plays the mock inference role.
- **Suggested design.** Write a ~300 line VT parser for the sequences HorizonCode emits (SGR, CSI cursor moves, erase, DEC 2026, ?25, ?2004) as a TEST helper under `app/tests/tui/vt.ts` (not in `src/`), then assertions on the final screen grid. Add a `perf` scenario that counts bytes per frame and asserts identical frames write nothing.
- **Files to touch.** new `app/tests/tui/vt.ts`, `app/tests/tui/harness.ts` (extend), `ops/gates.sh` and `ops/gate-catalogue.md` for a `tui-perf` gate (CI workflow edits go through a PR).

#### D13. Session UI: picker, tree, cost (R147 to R156)

- **Status (2026-11-13).** **PARTIAL — TESTED (rulings **196**, **262**):** `HZ_TUI_MODE=fullscreen-experimental` runs `resume-picker.ts` (cellbuffer list, type-to-filter on `Runtime.searchSessions`, ↑↓, Enter → `switchSession`, Esc → new chat; startup Esc keeps the auto-created session). List rows show relative `updated` + message count when enriched from `SessionStore`; selected row preview adds fork lineage + user-turn snippet. Scrollback unchanged: `/sessions [query]` text list + snippets; `/sessions tree` reduced tree. Keymap action `session.picker` default `Ctrl+R`. **Still deferred:** transcript preview pane, alt-screen tree, per-session USD cost.
- **What is deferred.** Transcript preview in the picker, a session tree for forks in alt-screen, per-session cost with provenance. Scrollback `/sessions` lists recent sessions with `(fork of <id> at message <k>)`.
- **Why.** Cost needs the price table (docs/10 R50 to R54, deferred). A tree needs the fork lineage to be queryable beyond the immediate parent (it is stored: `forked_from`, `fork_index`, `fork_seq`).
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/app/dashboard_session_picker.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/dashboard_session_picker.rs)<br>[`codex-rs/tui/src/resume_picker.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/resume_picker.rs)<br>[`packages/tui/src/component/dialog-session-list.tsx`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/tui/src/component/dialog-session-list.tsx)<br>[`packages/tui/src/apps/session-picker.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/apps/session-picker.ts)<br>[`docs/session-tree-plan.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/session-tree-plan.md)<br>[`sdk/packages/core/src/session/fork-metadata.ts`](https://github.com/cline/cline/blob/5413dc180c10700ce2e26547ab75991360dd0486/sdk/packages/core/src/session/fork-metadata.ts)
- **Adopt as is or adapt.** ADAPT (oh-my-pi's session tree plan and cline's fork metadata are the closest to HorizonCode's parent pointer model).
- **Suggested design.** `/sessions tree` prints an indented tree from `listSessions` by following `forkedFrom`; `/sessions <query>` filters by title. Fullscreen picker ships reduced (no preview); extend with transcript preview when alt-screen renderer matures.
- **Files to touch.** `app/src/tui/resume-picker.ts`, `app/src/tui/fullscreen-chat.ts`, `app/src/tui/interactive.ts`, `app/tests/tui/resume-picker.test.ts`, `app/src/core/session.ts` (a `children(id)` query), `app/tests/tui/fork.test.ts`.

#### D14. Status line rework (Part 2 P2-1) and the contextual hint segment

- **What is deferred.** `used / window` tokens with a colour ramp, the mode flag colours, a contextual hint segment (idle, typing, busy, approval), and the narrow drop order. Part 1's status line (`mode . model . provider . ctx% . path . branch`) ships.
- **Why.** Listed as deferred at the end of Part 2. Low risk, cosmetic.
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/views/status_line/segments.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/status_line/segments.rs)<br>[`crates/codegen/xai-grok-pager/src/views/status_bar.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/status_bar.rs)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/25-status-line.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/25-status-line.md)
- **Adopt as is or adapt.** ADAPT (spec in `research/grok-tui-deep.md` P2-1).
- **Suggested design.** Extend `composeStatusBar` in `live.ts`; `context.usage` already carries `estimatedInput` and `window`. Keep the print-once policy (do not repaint with save/restore cursor).
- **Files to touch.** `app/src/tui/live.ts`, `app/tests/tui/live.test.ts`.

#### D15. Notifications: bell, desktop, webhook, terminal title (R177 to R184)

- **Status (2026-11-13).** **PARTIAL — TESTED (rulings 177, 236):** turn-end bell after configurable threshold (`notify.ts`); **`HZ_NOTIFY_*`** env; user `config.json` **`notify`** + **`/notify`** persist (`persistNotifyConfig`). **Still deferred:** focus-aware desktop notify, webhooks, title updates.
- **What is deferred.** A bell or desktop notification when a long turn ends or an approval is waiting while the terminal is unfocused; a webhook; terminal title updates.
- **Why.** Needs focus reporting (DEC 1004) and an egress-visible webhook (docs/11 section 7.13). Not started.
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/notifications/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/notifications/mod.rs)<br>[`crates/codegen/xai-grok-pager/src/notifications/focus.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/notifications/focus.rs)<br>[`crates/codegen/xai-grok-pager/src/notifications/title.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/notifications/title.rs)<br>[`crates/codegen/xai-grok-pager/src/notifications/tmux.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/notifications/tmux.rs)<br>[`packages/tui/src/desktop-notify.ts`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/tui/src/desktop-notify.ts)
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** Bell only first (`\x07` when a turn ends after more than 30 s and stdout is a TTY), controlled by `notify` in the user config. Webhooks must go through the egress decider (`net.fetch`) and be visible in the receipt log.
- **Files to touch.** `app/src/tui/live.ts` or new `notify.ts`, `app/src/core/config.ts`, `app/tests/tui/notify.test.ts`.

#### D16. Composer queue, draft stash, reverse history search, attachments (R197 to R201)

- **Status (2026-11-12).** **PARTIAL — TESTED (ruling 184):** `composer-draft.ts` stashes non-empty readline text when a turn aborts and restores it on the next idle prompt if the line is empty. **Still deferred:** queue editing, `Ctrl+S` stash, `Ctrl+R` history search, attachments.
- **What is deferred.** Queue editing and reordering, `Ctrl+S` stash, `Ctrl+R` history search, image and file chips, a pinned completion summary.
- **Why.** One prompt is processed at a time; the durable admission FIFO (`core/admission.ts`) exists but `loop.ts` does not dispatch through it (docs/08 status). Attachments need the artifact store (docs/12, deferred).
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/app/agent_view/queue.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/queue.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/prompt_stash.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/prompt_stash.rs)<br>[`crates/codegen/xai-grok-pager/src/views/history_search.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/history_search.rs)<br>[`crates/codegen/xai-grok-pager/src/app/agent_view/media.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/agent_view/media.rs)<br>[`codex-rs/tui/src/bottom_pane/chat_composer/history_search.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/bottom_pane/chat_composer/history_search.rs)
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** Order of work: wire the loop to the admission FIFO (docs/08), then a `/queue` verb listing queued inputs, then type-ahead during a turn lands in the FIFO instead of being dropped. Stash and reverse search are small readline hooks.
- **Files to touch.** `app/src/core/loop.ts`, `app/src/core/admission.ts`, `app/src/tui/interactive.ts`.

#### D17. Clipboard fallbacks (R32)

- **Status (2026-11-13).** **PARTIAL — TESTED (rulings 177, 236):** `/copy` tries OSC 52 then `pbcopy` / `wl-copy` / `xclip` / `clip.exe`, plus **WSL `clip.exe`** and **`tmux load-buffer`**; scrollback and **fullscreen-experimental `/copy`** share `copyAssistantFromHistory`. **Still deferred:** `spawnOwned` wiring, visible failure UX in rich selection.
- **What is deferred.** OSC 52 first, then `pbcopy`, `wl-copy`, `xclip`, `clip.exe`, tmux and WSL paths, without blocking the event loop, with a visible failure.
- **Why.** Shipped `/copy` is OSC 52 only. Spawning clipboard helpers must go through `spawnOwned` (ruling 22) and the guard.
- **Upstream reference.** [`codex-rs/tui/src/clipboard_copy.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/clipboard_copy.rs)<br>[`codex-rs/tui/src/clipboard_copy/tmux.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/clipboard_copy/tmux.rs)<br>[`codex-rs/tui/src/clipboard_copy/wsl.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/tui/src/clipboard_copy/wsl.rs)<br>[`crates/codegen/xai-grok-pager-render/src/clipboard/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-render/src/clipboard/mod.rs)
- **Adopt as is or adapt.** ADAPT (the platform detection order).
- **Suggested design.** Detect once, try OSC 52 plus the helper, and report which route was used in the notice.
- **Files to touch.** `app/src/core/convo.ts`, `app/src/tui/interactive.ts` (`/copy`).

#### D18. Remaining Part 2 and Part 3 items, with the fix for each named gap

- **What is deferred.** (a) `Worked for` turn-footer wording; (b) a `/verbose` toggle for nested subagent lines; (c) `callId` on `subagent.start|end`; (d) ghost text and its room check use string length, not display width; (e) C1 control bytes (0x80 to 0x9f) are not stripped by `sanitizeText`; (f) scrollback single-line paste without a trailing newline still relies on `PASTE_SINGLE_LINE_FLUSH_MS` (**reduced ruling 247:** fullscreen alt-screen uses `createKeypressPasteCollector` + mode `2004` with the same flush); (g) `/theme` persistence is shipped (`persistThemeMode`, ruling 90); (h) readline can echo the pressed `y` inside the approval card before the line is wiped; (i) thinking not tested against a real reasoning provider; (j) **reduced (ruling 240):** fullscreen composer ↑/↓ recalls prior lines via `fullscreen-input-history.ts` (scrollback readline history unchanged for (h)); (k) **reduced (ruling 247):** `formatIdleStatusLine` in `live.ts` + `/status` share unknown chip, permission badge, and model between scrollback idle line and fullscreen status row.
- **Why.** Each is small, cosmetic or needs an environment this sandbox lacks (a real reasoning provider key).
- **Upstream reference.** [`crates/codegen/xai-grok-pager/src/views/turn_status.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/views/turn_status.rs)<br>[`crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs) (for (a) and (i)); the rest are HorizonCode-internal
- **Adopt as is or adapt.** n/a (internal fixes).
- **Suggested design.** (d) replace `.length` with `visibleWidth` in `completion.ts`; (e) extend `sanitizeText` to drop U+0080 to U+009F; (f) arm a 50 ms timer on `paste-start` that flushes a newline-free collector; (g) see D10; (h) pause the readline output stream while the card owns the cursor (`rl.pause()` plus writing the card, then `rl.resume()`), test with the PTY harness; (i) record a real session once and add it as a fixture.
- **Files to touch.** `app/src/tui/completion.ts`, `app/src/tui/render.ts` (`sanitizeText`), `app/src/tui/paste.ts`, `app/src/tui/approval-card.ts`, with tests in `app/tests/tui/`.
