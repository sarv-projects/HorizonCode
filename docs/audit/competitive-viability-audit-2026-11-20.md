# Competitive viability audit — HorizonCode (2026-11-20)

> **Goal: NOT COMPLETE.** Nothing **RELEASED**. Never claim shell-net egress **`enforced`**.
>
> Companion ruling: **`docs/28` §3 ruling 737**. Prior audit: [`competitive-viability-audit-2026-11-08.md`](competitive-viability-audit-2026-11-08.md) (wave-12 era — **stale on feature counts**; keep for history). Stop-of-day: [`../STOP-OF-DAY-2026-11-20.md`](../STOP-OF-DAY-2026-11-20.md). Deep code↔docs honesty: [`deep-audit-2026-11-20.md`](deep-audit-2026-11-20.md).

## 0. Method and confidence

| Source | Role | Confidence |
|---|---|---|
| HorizonCode tree + `docs/28` through **739** + STOP-OF-DAY / GOAL | What **we** actually ship | **HIGH** |
| Public docs fetched 2026-11-20 | Competitor product claims | **MEDIUM** (docs lag binaries; marketing tone) |
| Head-to-head SWE-bench / identical-task bake-off | Pass rate / cost / latency | **NOT RUN** — do not invent win rates |

**Competitors in scope (user brief):** Claude Code, Cursor Agent CLI, OpenCode, Codex CLI. **Also referenced:** Aider (git-native open classic). Out of scope for scoring: IDE-only agents without a first-class CLI (unless the CLI is the product).

**Public doc pins used this audit:**

| Product | Docs consulted |
|---|---|
| Claude Code | [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works), [Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [Tools](https://code.claude.com/docs/en/tools) |
| Cursor Agent CLI | [CLI overview](https://cursor.com/docs/cli/overview), [Using Agent](https://cursor.com/docs/cli/using), [Parameters](https://cursor.com/docs/cli/reference/parameters), [ACP](https://cursor.com/docs/cli/acp), [Subagents](https://cursor.com/docs/subagents) |
| OpenCode | [CLI](https://opencode.ai/docs/cli/), [TUI](https://opencode.ai/docs/cli/tui), architecture write-ups citing SolidJS+OpenTUI + headless HTTP engine |
| Codex CLI | [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [Permissions](https://learn.chatgpt.com/docs/permissions.md), [Inside the Codex sandbox](https://openai.com/index/inside-the-codex-sandbox) |
| Aider | [Git integration](https://aider.chat/docs/git.html), project README feature list |

---

## 1. Executive verdict

**Viable as a trust/evidence niche prototype — not yet viable as a default daily driver against Claude Code, Cursor Agent CLI, OpenCode, or Codex CLI.**

Three load-bearing reasons:

1. **Architecture is right for a trust-first agent.** Separate Bun harness + Rust kernel, Guard → OwnerLog → hash-chained receipts, fail-closed UNKNOWN / observe-settle reductions, doctor honesty that refuses shell-net **`enforced`**. That is a real differentiator vs prompt-and-approval-only harnesses — **if** P0-1…4 close.
2. **Product polish and multi-surface still lose the “open terminal and work” contest.** Leaders ship install scripts, Plan/Ask/Agent modes, cloud handoff, polished fullscreen TUI, mature MCP/rules ecosystems, and (Codex/Cursor) OS sandbox stories users can feel. HorizonCode’s default TUI is scrollback-class; fullscreen is opt-in reduced; ACP/serve are reduced; distribution is build-from-source; Goal **NOT COMPLETE**.
3. **No rewrite required to compete — but the next wins are product + confinement, not more design corpus.** Table-stakes UX and closed P0 confinement matter more than additional DESIGNED markdown.

**One-line positioning that is honest:** *the coding agent that can prove what it did* — not yet *the coding agent that feels as fast and finished as Claude Code / Cursor / OpenCode / Codex*.

---

## 2. Scorecard (0–5) — refreshed 2026-11-20

| Dimension | 2026-11-08 | **Now** | Confidence | Why the score moved |
|---|---:|---:|---|---|
| Product experience (TUI / modes / install) | 2 | **2.5** | high | Parts 2–3 polish (cards, paste, thinking, approval card, palette, reduced fullscreen) landed; still not default alt-screen; no one-line install; Plan/Ask as first-class modes weaker than Cursor/Claude |
| Agent capability (tools / loop / MCP / context) | 3 | **3.5** | medium-high | MCP, hooks, LSP, compaction, vision path, web_search, best-of-n, Eng Brain, ~37 tools — table stakes largely present as **reduced**; live billing / live steer / live cache residual |
| Trust / evidence / sandbox | 4 | **4** | medium-high | Deep EffectHost / R170 / observe-settle / G1 / human principal honesty — still PARTIAL vs done-bars; Codex/Cursor win on *felt* OS sandbox |
| Engineering quality / gates | 4 | **4** | high | Gates 8/8, large suite, doctor honesty culture; LICENSE deferred; nothing RELEASED |
| Competitive viability (ship vs leaders) | 3 | **3** | medium (relative: low) | More parity features than Nov 8; still not a replacement daily driver; **no H2H numbers** |

**Weighted (TUI 25 / Agent 25 / Trust 20 / Eng 15 / Viability 15): ~3.3 / 5** — stronger foundation than Nov 8, same market position: **niche-ready direction, product-not-ready**.

---

## 3. Architecture comparison

```
Claude Code     Model + Anthropic harness | tools+hooks+MCP | local/cloud/remote-control | many UIs
Cursor Agent    Same modes as editor | sandbox | Cloud Agent | ACP | MCP/rules | worktrees
OpenCode        Headless HTTP engine ← SolidJS+OpenTUI / web / desktop / ACP clients (SSE)
Codex CLI       Harness + platform sandbox (Seatbelt/Landlock/Windows) + permission profiles
Aider           Python Coder loop + git-native commits + repo map (REPL-class UI)
HorizonCode     TUI/headless/serve/ACP(reduced) → Bun loop → Guard → tools
                  ↘ Rust hz-kernel (OwnerLog / effect.execute / receipts)   ← unique plane
```

| Concern | Leaders (docs) | HorizonCode (code+28) | Gap |
|---|---|---|---|
| Process split | Usually one agent process (+ sandbox child) | **Two planes:** Bun product + Rust trust kernel | Differentiator when trusted; friction when kernel missing/untrusted |
| Client/server | OpenCode: first-class; Claude/Cursor: cloud + local | `hzcode serve` single-attach; multi-client/HTTP **DESIGNED** | Lose multi-surface attach story vs OpenCode |
| Protocol surfaces | Cursor ACP documented; Claude Agent SDK; OpenCode ACP bridge | `hzcode acp` reduced (**642**/**711**) | Not an IDE-integration peer yet |
| Authority | Permission modes + sandbox (Codex/Cursor) / Auto mode (Claude) | Kernel Guard + leases + EffectHost reductions | Stronger *proof* story; weaker *default confinement feel* |
| Evidence | Transcripts / checkpoints | Hash-chained events + receipts + session verify | Unique if users care; invisible if they don’t |

**Architecture verdict:** Do **not** rewrite toward a monolith to “be like Claude.” Do **close P0** so the kernel plane is the product story, and **elevate TUI + ACP + install** so users ever reach that story.

---

## 4. TUI, animations, flows, messaging

### 4.1 TUI / animations

| Affordance | Claude / Cursor / OpenCode / Codex (docs) | HorizonCode |
|---|---|---|
| Default interactive surface | Full terminal agent UX (OpenCode: full-screen TUI + mini; others: rich interactive CLI) | **Scrollback** readline chat; fullscreen **opt-in reduced** (`docs/13` R2 unmet) |
| Streaming / spinner / motion | Polished busy states expected | Braille spinner, sync frames, `HZ_REDUCE_MOTION` — shipped rich-TTY |
| Approvals | Mode cycles (Shift+Tab), sandbox menus, Auto classifier (Claude) | Single-key card + modes (`plan`/`accept-edits`/`read-only`); no Claude-class Auto |
| Composer UX | `@` files, shell `!`, tabs, editor handoff (OpenCode); cloud `&` (Cursor) | `@`/`/` completion, paste collapse, draft stash; OpenCode-class tabs/shell-mode weaker |
| Diff / apply | Review-before-apply expected | Diff gutters + partial `/apply`; per-hunk exact-effect still DESIGNED |
| Thinking | Productized in several agents | Collapsed thinking line; not persisted; live reasoning E2E residual |
| Accessibility | Varying | Stub (`HZ_SCREEN_READER`); full a11y DESIGNED |

**UX kill-shots today (users bounce):** no one-command install; default not fullscreen; Plan/Ask not as obvious as Cursor; Cloud/background handoff absent; Windows/macOS trust paths often honesty-fail-closed vs Linux.

### 4.2 Agent flows

| Flow | Leaders | HorizonCode |
|---|---|---|
| Gather → act → verify loop | Explicit in Claude docs | Same shape in `loop.ts` |
| Interrupt / steer | Esc + queue (Claude); mid-turn steer | Interjection + Responses steer hermetic; **live GPT steer residual (C-9)** |
| Subagents | Claude Agent tool; Cursor Explore/Browser parallel; background | Nested presets + best-of-n worktrees; less productized parallel UX |
| Modes | Agent / Plan / Ask (Cursor); Auto/Manual/Accept/Plan (Claude) | Permission modes + agent profiles; not identical UX |
| Git | Aider auto-commit culture; Claude git instructions | Dirty checkpoint + commit CLI + attribution; not Aider-default auto-commit UX |
| Compaction | Claude auto-compact + `/context` | Token-fit + opt-in LLM compact; context meter weaker than Claude `/context` |

### 4.3 Events / messaging

| Layer | Leaders | HorizonCode |
|---|---|---|
| UI stream | Product-specific; Cursor ACP `session/update`; OpenCode SSE | `RuntimeEvent` + additive `session.frame` (D-6) |
| Durable audit | Transcripts / logs | Kernel event log + receipts + nested replay (R172 PARTIAL) |
| Extensibility bus | Hooks (Claude), MCP everywhere, plugins | Hooks + MCP + skills/commands; plugin host thinner than OpenCode |

**Messaging verdict:** Internally richer *evidence* bus than most CLIs; externally thinner *client* bus than OpenCode/Cursor ACP.

---

## 5. Trust, sandbox, performance

### 5.1 Trust / sandbox (the competitive hinge)

| Claim type | Codex (docs) | Cursor (docs) | Claude (docs) | HorizonCode |
|---|---|---|---|---|
| OS command sandbox | Platform Seatbelt/Landlock/Windows; permission profiles; network off defaults in `:workspace` | `/sandbox` enable/disable + network menu | Permission modes + checkpoints; Auto classifier | `hz-sandbox-exec` + Landlock/userns **when capable**; product netns prove **PARTIAL**; **never `enforced`** |
| Policy engine | TOML profiles | Allow/deny + force/yolo | settings.json rules + modes | Rust Guard + leases + G1 wire |
| Proof of effects | Limited public story | Limited | Checkpoints / transcripts | **OwnerLog + receipts + observe-settle (fs.write/edit/delete)** |
| Human vs parent mint | n/a in docs | n/a | n/a | `principal:"human"` vs `"parent"` honesty (**720**) |

**Honest takeaway:** Codex/Cursor win “I turned on sandbox and network went away.” HorizonCode wins “I can verify the chain and refuse UNKNOWN theater” — **only after** P0-1…4 stop being PARTIAL. Marketing shell-net **`enforced`** would be a **lie** on this tree.

### 5.2 Performance / context

| Topic | Leaders | HorizonCode |
|---|---|---|
| Prompt cache | Claude cache discipline; Aider keepalive culture | Anthropic breakpoints default-on; **live hit measure residual (B-4)** |
| Compaction | Claude auto + thrash guard | Token-fit + LLM opt-in; emergency shrink |
| Spend / cost UX | Product meters common | SpendLedger + `/tokens`; **live invoice truth residual** |
| Startup | Install binaries | Gates track latency; build-from-source tax |
| Kernel IPC | n/a | Historically sub-ms ping/append (Nov 8 measures); not the UX bottleneck |

Kernel is not why users abandon HC. **Install + TUI + confinement feel + model UX** are.

---

## 6. Feature-parity matrix (shipped honesty)

Labels for HorizonCode: **I** implemented+tested (possibly PARTIAL vs done-bar), **P** partial/reduced, **D** designed-only, **A** absent. Competitor cells = public-docs claims (not binary reverse-engineering).

| Capability | HC | Claude Code | Cursor Agent CLI | OpenCode | Codex CLI | Aider |
|---|---|---|---|---|---|---|
| Interactive terminal agent | **I** | yes | yes | yes (fullscreen+mini) | yes | yes (REPL) |
| One-line install | **A** | yes | yes (`curl` install) | yes | yes | pip/install |
| Plan / Ask modes | **P** | Plan + Auto/… | Plan + Ask + Agent | agents/modes | permission profiles | ask/architect |
| Cloud / remote handoff | **A** | Cloud + Remote Control | Cloud Agent (`&`) | multi-client serve | agents remote | no |
| ACP / editor bridge | **P** | IDE + SDK | `agent acp` | ACP bridge | (ecosystem) | IDE comment watch |
| MCP | **I** | yes | yes | yes | yes | no |
| Hooks / plugins | **P** | hooks+skills | rules+plugins | plugins+SSE | profiles | limited |
| Subagents / parallel | **I/P** | Agent tool | Explore/Browser bg | agents | multi-agent | no |
| OS sandbox (felt) | **P** | options | sandbox menu | weaker public story | **strong docs** | none |
| Hash-chained receipts | **I** | no | no | no | no | no |
| EffectHost / OwnerLog | **P** | no | no | no | no | no |
| Compaction | **I/P** | auto | yes | multi | yes | budgeting |
| Repo map | **I** | search tools | search | search | search | **core feature** |
| Git auto-commit UX | **P** | instructed | worktrees | yes | review flows | **core feature** |
| Vision / multimodal | **P** | images | (product) | media refs | (product) | images |
| Web search | **P** | built-in | yes | yes | via tools/MCP | web pages |
| Headless / CI | **I** | yes | `-p` stream-json | `run` | exec | flags |
| Eval / H2H harness | **P** | internal | internal | internal | internal | polyglot culture |
| License / release | **deferred** | commercial | commercial | open | commercial | Apache-2.0 |

---

## 7. Where HorizonCode can still win

1. **Provable agency** — receipts + OwnerLog + observe-settle + doctor that refuses overclaim. Nobody in the compared set markets this as the product spine.
2. **Fail-closed UNKNOWN** — competitors optimize for “keep going”; HC can own “don’t lie about what executed.”
3. **Provider-agnostic + zero runtime deps (Bun)** — closer to OpenCode/Aider philosophy than to Claude/Cursor lock-in (still needs packaging).
4. **Engineering Brain / critic rails** — differentiated harness discipline if kept honest (not theater).

## 8. Where HorizonCode loses users today (ranked)

1. **Distribution & first five minutes** — no install script; build/kernel pin; LICENSE deferred.
2. **Felt sandbox** — Codex/Cursor docs beat “PARTIAL netns + never enforced.”
3. **Default TUI** — scrollback vs OpenCode fullscreen / Claude conversational polish; R2 unmet.
4. **Mode UX** — Cursor Plan/Ask and Claude Auto are clearer than HC permission badges.
5. **Cloud / multi-surface** — Cursor `&` Cloud Agent; Claude remote/cloud; OpenCode many clients.
6. **Live product residuals** — B-4 cache-hit, C-9 steer, invoice truth — spend is granted (**735**) but evidence still missing.
7. **P0 spine still OPEN** — ambient Bun, hooks/MCP OwnerLog, shell observe-settle, alias TOCTOU.
8. **No public H2H numbers** — cannot claim “better than Codex on X” without **644**-class runs.

---

## 9. Spec-vs-reality (viability-relevant)

| Attractive claim | Reality 2026-11-20 |
|---|---|
| Fullscreen-default TUI (`docs/13` R2) | **Not met** — scrollback default |
| Universal EffectHost | **PARTIAL** (P0-1) |
| Full R170 / postimage / egress | **PARTIAL** (P0-2…4) |
| ACP peer to Cursor | **Reduced** initialize + prompt chunks |
| Shell-net enforced | **Forbidden claim** |
| Competitive with Claude/Cursor “out of the box” | **False** until install + TUI + P0 close |

---

## 10. Roadmap (viability order — not a promise)

**30 days (stop the bounce):**
1. Install path (`curl | bash` or equivalent) + honest doctor first-run.
2. Default-TUI decision: either ship fullscreen-default meeting R2 budget, or explicitly position as scrollback-native (don’t leave R2 as fiction).
3. Mode UX parity slice: Plan/Ask rotation as obvious as Cursor Shift+Tab.
4. Run live residuals under spend grant **735** (B-4, C-9, invoice/vision) and record evidence.
5. P0 next slice: shell/`fs.batch` observe-settle **or** hooks/MCP OwnerLog — pick one done-bar inch.

**90 days (become comparable):**
1. Close enough of P0-1…3 that “kernel owns effects” is demos, not footnotes.
2. ACP permission proxy + session load enough for one editor client.
3. Felt sandbox: product-default confinement path that works on a clean Linux laptop (still never market **`enforced`** without proof).
4. First same-model H2H (**644**) vs ≥2 competitors on a tiny suite.

**180 days (niche leadership or die trying):**
1. Enterprise evidence pack (exportable receipt verify, policy digests, UNKNOWN playbooks).
2. Multi-client serve like OpenCode’s engine story **or** deliberate single-surface focus with best-in-class TUI.
3. LICENSE chosen; RELEASED criteria owned by human.

---

## 11. Red-flag checklist (2026-11-20)

| Flag | Status |
|---|---|
| Spec theater without tests | **Mostly clear** for shipped rulings; design corpus still oversized vs code |
| Permission security = prompts only | **Clear** (kernel Guard) — caveat ambient Bun / incomplete EffectHost |
| No headless | **Clear** |
| No session persistence | **Clear** (resume); rewind exists reduced |
| No compaction | **Cleared since Nov 8** (reduced) |
| Single-vendor only | **Mostly clear** (multi-provider) |
| No eval harness | **Partial** — runner exists; public H2H thin |
| Success without verify | **Clear direction** — UNKNOWN/receipts; P0 gaps remain |
| Overclaim egress | **Process clear** (never `enforced`) — keep it |

---

## 12. Final recommendation

| Question | Answer |
|---|---|
| Compete on architecture? | **Yes — keep the kernel plane; finish P0.** |
| Compete on TUI/animations today? | **No — behind OpenCode/Claude/Cursor polish.** |
| Compete on trust marketing today? | **Only with honesty** — PARTIAL ≠ done; never shell-net **`enforced`**. |
| Rewrite? | **No.** |
| Ship vs leaders this quarter? | **Not as default daily driver.** Ship as **provable-agent niche** after install+TUI+P0 inch + live evidence. |

*This audit does not raise any capability to VERIFIED/RELEASED. It records competitive reality for agents and owners.*
