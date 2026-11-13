# Repo-take steal wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register and implement the `99-SYNTHESIS` backlog (#1–#16; #17–#18 later) by adapting concrete files under `repo_take/`, not designing from scratch; keep docs/28·30·33 honest.

**Architecture:** Docs first register each item with upstream paths (docs/30 §8). Implementation adapts mechanisms into zero-dep TS / Rust kernel style. Sequence follows synthesis impact order: session FTS → handoffs/memory → trust UX → loop rails.

**Tech Stack:** Bun + `bun:sqlite` FTS5, existing SessionStore / TUI scrollback, kernel guard unchanged.

**Spec:** `repo_take/notes/99-SYNTHESIS.md`, `repo_take/notes/HZ-DOCS-VS-NOTES.md`, docs/12 F8, docs/33 §5.x

## Global Constraints

- Zero runtime deps in `app/` (no new packages).
- `contracts.ts` additive only.
- ADAPT only — no vendoring Engram/mnemopi/CBM.
- Docs/28 ruling + docs/30 Status in the same commit as code.
- No em dashes in new prose.
- Honest sandbox/egress reporting unchanged.

## Review Focus

- FTS index lag vs transcript privacy
- Handoff/MEMORY writes staying ask-gated
- Doom-loop false positives
- Interjection races with cancel
- Saved-allows never widening kernel deny

## Upstream map (learn here first)

| # | Steal | Primary `repo_take/` paths (read before coding) | HZ landing |
|---|---|---|---|
| 1 | Session FTS + resume list | `grok-build/crates/codegen/xai-grok-session-search/src/{lib,fts,manager,doc,db}.rs`; `codex/codex-rs/tui/src/resume_picker.rs` + `resume_picker_transcript_preview.rs`; `oh-my-pi/packages/tui/src/apps/session-picker.ts`; `opencode/packages/tui/src/component/dialog-session-list.tsx` | `app/src/core/session-search.ts`, `/sessions [q]` |
| 2 | MITM egress | `grok-build/.../xai-grok-egress-proxy/src/*.rs`; `codex/codex-rs/network-proxy/src/*.rs` | docs/33 §5.2 stages; kernel later |
| 3 | Engram handoffs | `engram-mcp/src/tools/handoff.rs` (+ tests named in `01-engram-mcp.md`) | native or MCP `handoff_*` |
| 4 | remember/recall banks | `oh-my-pi/packages/mnemopi/**`; Codex memories tools in `01-codex.md` | extend `memory/store.ts` + tools |
| 5 | Credential flock | `opencode/packages/core/src/credential.ts` (+ handlers) | `app/src/core/auth/` |
| 6 | Permission presentation | `opencode/packages/tui/src/util/permission.ts` | `app/src/tui/approval*.ts` |
| 7 | Doom-loop + length fail | `grok-build/.../turn.rs` IdenticalToolCall; `pi` stopReason length (see `01-pi.md`) | `app/src/core/guards/` + loop |
| 8 | Interjection | `grok-build/crates/common/xai-interjection-core/**` | steering buffer |
| 9 | Sandbox deepen | `grok-build/.../xai-grok-sandbox/**`; Codex `sandboxing/` | `hz-sandbox-exec` residuals |
| 10 | Two-step MEMORY | `claude-code-src/memdir/memdir.ts`, `findRelevantMemories.ts` | `.hz/MEMORY.md` + `.hz/memory/*.md` |
| 11 | Subagent isolation | Codex `codex_delegate` (note paths); Grok subagent coordinator | `agent` tool / profiles |
| 12 | Failure codes | `deepseek-harness` provider errors (note) | `contracts.ts` union |
| 13 | Repo map / CBM paging | `aider` RepoMap; `codebase-memory-mcp` cursor tools | `repo_map` + MCP proxy |
| 14 | AutoMode | `plandex` AutoMode (note) | config presets |
| 15 | Tool paging | CBM `query_graph` cursor / max_output | heavy tools schema |
| 16 | LSP/DAP | `oh-my-pi/.../dap/**` | docs/33 §5.1 |
| 17–18 | Foreign / collab | Grok foreign-sessions; OpenCode session-ui | SKIP until spine done |

## Tasks

### Task 1: Docs register (§8 + stale §7 banner + 33 pointer)

- [x] Add docs/30 §8 with table above
- [x] Banner on §7: post-2026-11-11 status owned by docs/28/33
- [x] docs/33 §5.20 steal-wave backlog pointing at §8
- [x] Plan + notes index

### Task 2: #1 Session FTS + `/sessions <query>` (v1 list+search, no alt-screen picker)

- [x] Read Grok `fts.rs` schema + Codex picker list/filter behaviour
- [x] Failing test: index user prompts → search returns session + snippet
- [x] `session-search.ts` sidecar FTS5 (mirror memory/store.ts + Grok doc shape)
- [x] Upsert on SessionStore create/append/touch
- [x] Wire Runtime + `/sessions [query]` + slash-registry usage
- [x] docs/12 F8 + docs/28 ruling + docs/30 §8 status

### Task 3: #10 + #4 MEMORY two-step + banks (after #1)

- [x] Read Claude memdir + mnemopi tool schemas
- [x] Pointer index + topic files + dual caps; FTS seeds topics
- [x] Docs/33 §5.4 Status sync
- [x] mnemopi banks/shared_* (ruling 170: partitioned banks + `shared_recall`)

### Task 4: #3 Engram handoffs

- [ ] Read `handoff.rs`; ADAPT 7-section create/resume/search
- [ ] Ask-gated writes; optional MCP profile trim later

### Task 5: #7 + #8 loop rails

- [x] Grok identical-call tiers; Pi length fail-all; interjection buffer (ruling 171–172)

### Task 6: #5 #6 trust UX; #2/#9 remain staged per 33

- [ ] OpenCode credential flock + permissionPresentation
- [ ] Egress/sandbox: docs honesty only until kernel stages

### Task 7: #11–#16 as capacity allows

- [ ] Each starts with upstream file read listed above
