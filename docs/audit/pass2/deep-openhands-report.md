# OpenHands deep dive — Agent Canvas checkout (learning pass for HorizonCode)

**Scope caveat (read first).** `/data/home/forge/repo-tour/OpenHands` is the **Agent Canvas** frontend (React/TypeScript/Electron, npm `@openhands/agent-canvas`), not the Python agent platform. `AGENTS.md` splits ownership explicitly: `OpenHands/OpenHands` owns the UI; `OpenHands/software-agent-sdk` owns "Python SDK, Agent Server, agents/tools, conversations, events, canonical REST/WebSocket API"; `OpenHands/extensions` owns skills/automations; `OpenHands/automation` owns scheduling. So runtime, sandbox, condenser algorithm and microagents live *upstream*; what this checkout does contain, and what makes it valuable, is (a) a **vendored copy of the SDK's wire types** (`src/types/agent-server/**` — the actual action/event schema, mirrored with upstream issue numbers), (b) the **client half of the session protocol**, and (c) the **full UI contract for compaction, skills, MCP, verification and delegation** — i.e. exactly the seams HorizonCode's runtime/session docs must specify. Everything below cites what is in this tree; claims about server-side internals are labelled as inferred-from-contract.

Status: SKELETON — sections filled below in order.

## 1. Repo map

Top level (`/data/home/forge/repo-tour/OpenHands`):

```
src/            React app: api/ components/ hooks/ stores/ contexts/ types/ utils/ routes/ i18n/ mocks/
src/types/agent-server/    vendored Agent Server (SDK) wire types — core/base + core/events + session-frames.ts
docs/           architecture.md, ACP_AGENTS.md, SELF_HOSTING.md, DEVELOPMENT.md, TESTING_MATRIX.md, DefenseClaw.md
electron/       desktop shell (main.mjs, preload*.cjs)
bin/, scripts/  CLI + local-stack launchers (`npm run dev` boots agent-server via uvx, Vite, ingress proxy)
docker/         Dockerfile + entrypoint + smoke-test (sandboxed deployment path)
config/defaults.json   backend compatibility pins (`compatibility.minimumAgentServer`)
.agents/skills/ project-local contributor skills (separate from product skills)
tests/e2e/      playwright suites incl. mock-llm harness (mock-llm-server.py, mock-acp-server.py)
helm/, vercel.json, electron-builder.config.mjs   deploy/packaging
```

Two levels of `src/`, abridged to what matters:

```
src/api/         agent-server-adapter.ts, event-service/, conversation-service/, settings-service/,
                 mcp-service/, mcp-health/, skills-service.ts, tool-catalog-service/, acp-service/,
                 agent-profiles-service/, profiles-service/, meta-profiles-service/, runtime-service/,
                 secrets-service.ts, backend-registry/, cloud/, provider-connections-service/
src/stores/      use-event-store.ts (the event log), conversation-store, conversation-state-store,
                 metrics-store, model-store, agent-store, optimistic-user-message-store, browser-store
src/hooks/       use-await-context-compaction.ts, use-compact-context-action.ts, mutation/use-condense-conversation.ts
src/types/       settings.ts (Settings, AgentKind, SkillInfo), agent-server/**, mcp-server.ts
src/routes/      condenser-settings.tsx, verification-settings.tsx, mcp.tsx, agent-settings.tsx, skills…
```

Read the checkout as: **contract + client behaviour for a remote agent platform**. The interesting architecture is in the seams (what crosses the wire, in which frame, with which ids), not in the UI chrome.

## 2. Subsystem table (absolute paths)

| # | Subsystem | Where it actually is here | Load-bearing files |
|---|---|---|---|
| a | Agent framework / agents | Not here (upstream `software-agent-sdk`). Locally: agent *profiles* and agent *kinds* | `/data/home/forge/repo-tour/OpenHands/src/types/settings.ts` (`AgentKind = "openhands" | "acp"`), `/data/home/forge/repo-tour/OpenHands/src/api/agent-profiles-service/`, `/data/home/forge/repo-tour/OpenHands/src/api/meta-profiles-service/` |
| b | Conversation / event stream | Vendored schema + client store | `/data/home/forge/repo-tour/OpenHands/src/types/agent-server/core/base/event.ts`, `.../core/base/action.ts`, `.../core/base/observation.ts`, `.../core/events/*.ts`, `/data/home/forge/repo-tour/OpenHands/src/types/agent-server/session-frames.ts`, `/data/home/forge/repo-tour/OpenHands/src/stores/use-event-store.ts`, `/data/home/forge/repo-tour/OpenHands/src/api/event-service/event-service.types.ts` |
| c | Runtime / sandbox | Not here. Only the terminal *actions* and their metadata; docker/ + dev scripts launcher | `/data/home/forge/repo-tour/OpenHands/src/types/agent-server/core/base/common.ts` (`CmdOutputMetadata`), `/data/home/forge/repo-tour/OpenHands/docker/Dockerfile`, `/data/home/forge/repo-tour/OpenHands/bin/` |
| d | Action space / ACI | Complete action+observation union vendored | `/data/home/forge/repo-tour/OpenHands/src/types/agent-server/core/base/base.ts` (the `ActionEventType` / `ObservationEventType` unions), `.../core/base/action.ts`, `.../core/base/observation.ts` |
| e | Condenser / context compaction | UI contract + SDK-declared schema keys (algorithm upstream) | `/data/home/forge/repo-tour/OpenHands/src/hooks/use-await-context-compaction.ts`, `/data/home/forge/repo-tour/OpenHands/src/hooks/use-compact-context-action.ts`, `/data/home/forge/repo-tour/OpenHands/src/types/agent-server/core/events/condensation-event.ts`, `/data/home/forge/repo-tour/OpenHands/src/utils/sdk-settings-field-metadata.test.ts` (schema keys/descriptions), `/data/home/forge/repo-tour/OpenHands/src/routes/condenser-settings.tsx`, `/data/home/forge/repo-tour/OpenHands/src/api/settings-service/settings-service.api.ts` (`L536-L556`) |
| f | Microagents → skills | Skill catalog, skills service, `InvokeSkill` action | `/data/home/forge/repo-tour/OpenHands/src/api/skills-service.ts`, `/data/home/forge/repo-tour/OpenHands/src/types/settings.ts` (`SkillInfo`), `/data/home/forge/repo-tour/OpenHands/src/utils/skill-scope.ts`, `/data/home/forge/repo-tour/OpenHands/src/types/agent-server/core/base/action.ts` (`InvokeSkillAction`) |
| g | MCP | Service + health probes + credential redaction | `/data/home/forge/repo-tour/OpenHands/src/api/mcp-service/mcp-service.api.ts`, `.../mcp-service/mcp-redacted-credentials.ts`, `/data/home/forge/repo-tour/OpenHands/src/api/mcp-health/probe-mcp-server-health.ts`, `/data/home/forge/repo-tour/OpenHands/src/routes/mcp.tsx` |
| h | Security / verification | Confirmation mode + security analyzer + critic | `/data/home/forge/repo-tour/OpenHands/src/routes/verification-settings.tsx`, `/data/home/forge/repo-tour/OpenHands/src/api/event-service/event-service.types.ts` (`ConfirmationResponseRequest`), `Settings.confirmation_mode` / `security_analyzer` in `/data/home/forge/repo-tour/OpenHands/src/types/settings.ts` |
| i | LLM abstraction | Provider/model settings, model store, profile-scoped LLM; switching as an *action* | `/data/home/forge/repo-tour/OpenHands/src/stores/model-store.ts`, `/data/home/forge/repo-tour/OpenHands/src/api/settings-service/`, `SwitchLLMAction` / `ClassifyAndSwitchLLMAction` in `.../core/base/base.ts` |
| j | Delegation | Sub-agents (`TaskAction`), child conversations, sub-conversation tree | `/data/home/forge/repo-tour/OpenHands/src/hooks/query/use-sub-conversations.ts`, `/data/home/forge/repo-tour/OpenHands/src/api/launch-child-conversation-client-tool.ts`, `/data/home/forge/repo-tour/OpenHands/src/constants/profile-tools.ts` (`DELEGATION_TOOLS`) |
| — | Boundary enforcement | A test that forbids bypassing the adapter | `/data/home/forge/repo-tour/OpenHands/src/api/no-direct-agent-server-calls.test.ts` |

### Doc-level anchor points
- `docs/architecture.md` — Agent Canvas is *not* responsible for executing actions, sandboxing, credentials, or scheduling; it renders, holds frontend state, and translates UI into Agent Server calls.
- `runtime_services` from the backend's `/server_info` is **forwarded into new conversations as an agent context suffix** so agents use correct URLs instead of guessing ports (`/data/home/forge/repo-tour/OpenHands/docs/architecture.md`).

## 3. Conversation / event model vs HorizonCode event log (doc 12)

### 3.1 What the model actually is (verified)

Event-sourced, with a **strict split between the durable log and the live socket protocol**.

1. **Durable record** — every event extends `BaseEvent` (`/data/home/forge/repo-tour/OpenHands/src/types/agent-server/core/base/event.ts`): `id` (ULID/UUID, doc'd as “Unique event id”), `timestamp` (ISO string), `source`. The conversation is a sequence of these; the UI's whole display is a projection of it.
2. **Action/Observation pairing is compile-time, via string-template unions** — `.../core/base/base.ts` defines `ActionEventType` as `` `${EventType}Action` `` over `EventType = MCPTool | Finish | Think | ExecuteBash | Terminal | FileEditor | StrReplaceEditor | TaskTracker | PlanningFileEditor | InvokeSkill | SwitchLLM | ClassifyAndSwitchLLM`, plus `ActionOnlyType` (9 `Browser*` verbs), `Glob`, `Grep`, `TaskAction` (subagent), and four client-tool kinds. Observations mirror it: `` `${ObservationOnlyType}Observation` `` (browser), `TerminalObservation`, `GlobObservation`, `GrepObservation`, `TaskObservation`, `CanvasUIObservation`, `ClientToolObservation`. So the pairing is *structural*, and each action type has exactly one observation type.
3. **Live protocol is separate from the log** — `/data/home/forge/repo-tour/OpenHands/src/types/agent-server/session-frames.ts` is the client mirror of the server's `session_protocol.py` for the websocket `/sockets/session/{conversation_id}`:
   - `sync` — sent once before any replay, declaring the range about to be sent (`from_seq`, `through_seq`).
   - `durable` — `{ seq, event }`, “one persisted event, after it is safely on disk”; **`seq` is its log index**.
   - `transient` — an event “published but never persisted, so it carries no `seq`”.
   - `item_started` — opens a streaming slot with the `item_id` **that the durable event will later be built with**, plus `attempt` and `anchor_seq`.
   - `delta` — “one **masked** increment of a stream”, `order` monotonic per `(item, attempt)`, `kind: "text" | "reasoning"`, `chunk_id`, `choice_index`.
   - `item_aborted` — stream ended without producing a durable event, with a `reason`.
   - `error` — a socket-level problem, explicitly “distinct from a durable conversation error”.
   The file states the envelope “is deliberately not an `Event`”, **the URL is the protocol version and there is no handshake**, and **unknown frame types must be ignored** because “the envelope is allowed to grow”.
4. **Client log store** — `/data/home/forge/repo-tour/OpenHands/src/stores/use-event-store.ts` keeps `events` + an `eventIds: Set` for O(1) dedupe on insert, a separate `uiEvents` array, and streaming slots **only inside `uiEvents`**. The comment is the design rationale: keeping provisional slots out of `events` “means their id — which is the id the durable event will carry — can never be mistaken for one already seen and dedupe the real message away”. Slot API: `openStreamingSlot`, `appendStreamingDeltas`, `abortStreamingSlot`, `clearStreamingSlots(isFromPlanningAgent?)`.
5. **Ordering and backfill** — `addEvents` bulk-inserts (initial REST history + “scroll up to load older”), de-dupes, then **re-sorts by `timestamp`** as ISO strings; `needsSorting` only sorts when a new event is older than the last, and events without timestamps sort to the end.
6. **Store-invariant bookkeeping** — `loadedConversationId` + `loadedConversationScope`, with a dedicated `clearEventsForConversation(conversationId, scope)` that clears and stamps in a single `set`. The stated reason: distinguish “a genuine conversation switch” from “a remount of the *same* conversation (e.g. navigating to Settings and back)”, and keep the invariant true even on a standalone `clear`.
7. **Paging contract** — `/data/home/forge/repo-tour/OpenHands/src/api/event-service/event-service.types.ts`: `EventSearchOptions { limit (server caps at 100), pageId, sortOrder: "TIMESTAMP" | "TIMESTAMP_DESC", timestampGte, timestampLt, excludeFullState, strictPagination }` → `EventSearchPage { items, next_page_id }`. Note two deliberate fields: `excludeFullState` (“omit full state snapshots from Cloud display history when supported”) and `strictPagination` (“surface unsupported cloud pagination instead of degrading to an empty page… so a partial history is never mistaken for exhaustion”).
8. **Human responses are events too** — `ConfirmationResponseRequest { accept: boolean, reason?: string }` is the only mutation in the event namespace; approval/rejection with a **reason** flows back as a recordable answer, not as an out-of-band command.

### 3.2 Comparison with HorizonCode doc 12

| Concern | OpenHands / Agent Canvas | HorizonCode doc 12 | Verdict |
|---|---|---|---|
| Durable unit | `BaseEvent {id, timestamp, source}`; action/observation typed unions | `hz.*` events, append-only log as sole truth | Equivalent; HC is broader (R-rules on write path/seq). |
| Log index | `seq` = log index, transported in the `durable` frame; `anchor_seq` on stream open | log index in the write path (§2.2) | Same idea; OpenHands exposes it to *clients* explicitly, HC keeps it server-side. |
| Streaming | `item_started` → N × `delta` → durable event with the same `id`; slots retired by `event.id === item_id`; `item_aborted` for abandoned streams | “messages and parts” (§2.6) | **Gap in HC**: the *retirement rule* (provisional item id becomes the durable event id, abort path named) is not stated. |
| Transient vs durable | First-class frame distinction; transient events deliberately have no `seq` | not distinguished explicitly | **Idea to steal**: two durability classes, one stream, no separate channel. |
| Socket errors | `error` frame explicitly “distinct from a durable conversation error” | HC has `hz.error.raised` in-log | **Idea**: separate *transport* problems from *agent* errors — a socket drop must not become a session error event. |
| Protocol versioning | Carried by the URL; no handshake; unknown frames ignored by contract | compatibility pins live in config (`minimumAgentServer`) | OpenHands' “grow-only envelope” is a cheaper compatibility story than a negotiation. |
| Replay/resume | `sync` frame declares `from_seq`/`through_seq` *before* replay | recovery at start (§6.2), projection rebuild (§6.3) | **Idea**: a declared-range preamble lets the client prove it received a contiguous window. |
| Client-side ordering | dedupe by `id`, then sort by `timestamp`; ISO string compare | server owns ordering | Fine for a UI projection; HC should not adopt timestamp-sorting as truth (HC's log order is authoritative). |
| Paging | cursor `page_id`, cap 100, `strictPagination` | retention/archive rules (§4.7–4.9) | **Worth copying**: an explicit “fail rather than silently return a partial history” flag (exports/reindex must never see truncation as exhaustion). |
| Human approval | accept/reject + reason | pending permission asks must survive compaction (R112) | Convergent; OpenHands' `reason` on rejection is worth stating in HC. |
| Snapshot-in-history | `excludeFullState` flag for display history | projections/rebuild + content-addressed blobs | **Idea**: the log carries full state snapshots that a *display* client can drop — HC should keep snapshot events out of the human transcript by default. |

### 3.3 Concrete gaps/ideas for doc 12

- **G12.1 — Provisional→durable retirement rule.** State: a streaming part is opened with the id of the durable event it will become; deltas are masked increments with `order` monotonic per (item, attempt); the durable event retires the slot; an aborted stream never leaves a phantom part. Also state that a *display* layer keeps provisional parts in a separate collection so an id collision cannot dedupe the real event away.
- **G12.2 — Two durability classes on one stream** (`durable` with `seq` vs `transient` without) instead of a second channel for progress/pings.
- **G12.3 — Transport errors are not session errors.**
- **G12.4 — Sync preamble** declaring the replay window before the replay (`from_seq`/`through_seq`) so the consumer can assert contiguity and request the missing range.
- **G12.5 — Paging must fail loudly when incomplete** (`strictPagination`), because “empty page” and “unsupported cursor” must never be conflated for export/reindex.
- **G12.6 — Per-conversation capability token.** Conversations here carry `conversation_url` + `session_api_key` and every request is made through an adapter (enforced by `/data/home/forge/repo-tour/OpenHands/src/api/no-direct-agent-server-calls.test.ts`), so a client can hold a scoped credential per session rather than ambient authority. Same shape as HC's gate, but enforced *mechanically* by a repo test.
- **G12.7 — Cache identity must include the backend.** `use-sub-conversations.ts` keys every query by `(ids, backend.id, orgId)` with an explicit comment about a `null` result captured on cloud “bleeding through” to local. Generalise: any projection cache key in a multi-runtime world needs the runtime identity in it.

## 4. Condenser, in detail — for doc 10 compaction

### 4.1 What is verifiable here (and what is not)

The **algorithm** is upstream (`software-agent-sdk`). This checkout fixes four things: the **condensation event exists in the durable log**, the **knobs and their documented semantics**, the **trigger UX** (automatic + explicit), and the **completion-detection contract**. Nothing here states the summary prompt or the eviction boundary arithmetic — do not invent those.

### 4.2 Trigger

Two triggers, both visible:

- **Automatic, token-budget based.** The SDK-declared schema (`/data/home/forge/repo-tour/OpenHands/src/utils/sdk-settings-field-metadata.test.ts`) has `condenser.max_tokens` described as *“Maximum number of tokens allowed **before** the condenser runs”* and `condenser.condenser_kind` as *“Discriminator for the condenser settings union. `'llm_summarizing'` selects the default LLM summarizing condenser”* with `choices: ["llm_summarizing", "no_op"]`; `condenser.keep_first` = *“Minimum number of initial events to preserve before condensation”*; `condenser.minimum_progress` = *“Minimum fraction of events that must be condensed”*; `condenser.hard_context_reset_max_retries` and `condenser.hard_context_reset_context_scaling` bound the hard-reset fallback.
- **Explicit, user-triggered.** `/data/home/forge/repo-tour/OpenHands/src/hooks/use-compact-context-action.ts` — a manual "compact now" CTA (Usage panel + composer context-window popover). It is **disabled while the agent is busy** (`RUNNING|LOADING`) and while a compaction is already pending — compaction never races a live turn. `(completed by Forge after agent crash: sections 4.3-8 continue below, verified by direct reads)`

### 4.3 The recipe path, and the race it encodes

1. Capture the **baseline** — `baselineEventIdsRef.current = new Set(useEventStore.getState().eventIds)` — *before* firing the condense request. The code comment is explicit: *“The condense POST can return only after the server already emitted its Condensation event, so the await baseline must be captured before the request fires, not when the post-ack effect starts.”*
2. POST condense; on success show “compaction started”.
3. `useAwaitContextCompaction` watches for the Condensation event relative to the baseline set; formats `before/after/saved` token counts.
4. Outcomes: `timeout` → error toast; `savedToken > 0` → success with numbers; else → explicit “complete (no change)” — never a silent no-op.

### 4.4 The three condensation events (durable, `source: "environment"`)

`/data/home/forge/repo-tour/OpenHands/src/types/agent-server/core/events/condensation-event.ts`:

- `CondensationEvent { forgotten_event_ids: EventID[], summary?: string, summary_offset?: number }` — condensation **removes events from the LLM's *View*, not from the log**. The durable history keeps everything; only the window shown to the model changes. `summary_offset` positions the summary within the resulting view.
- `CondensationRequestEvent` — a request to condense (manual or automatic).
- `CondensationSummaryEvent { summary }` — the summary text as its own event, separable from the forgetting record.

### 4.5 What HorizonCode should take from this (doc 10 compaction)

- **G10.1 — Forgetting as an event, on a view, not a rewrite.** HorizonCode's checkpoint should record exactly which event ids left the provider view, so `hzcode session verify` can reconstruct both true history and every historical view. (Doc 12 already separates log from projections; this makes compaction auditable in the same way.)
- **G10.2 — The bounds ladder for “compaction itself overflows”.** summarize → retry with stricter budget → **hard reset with scaling, bounded retries** (`hard_context_reset_max_retries` × `hard_context_reset_context_scaling`) → refuse and stop the turn loudly. Doc 10's compaction failure section should name this ladder explicitly (it answers audit-5 question 2).
- **G10.3 — Trigger visibility.** Compaction is user-visible with before/after/saved metrics and a manual trigger; the busy-guard prevents mid-turn races. Adopt both.
- **G10.4 — `keep_first` + `minimum_progress` are good knobs**: preserve the opening framing (task statement) unconditionally, and refuse to condense a too-small delta (anti-thrash).

## 5. Microagents → skills mapping (doc 15)

Skill scopes are real and ordered: `/data/home/forge/repo-tour/OpenHands/src/utils/skill-scope.ts` declares `SkillScope = "project" | "personal" | "public"` with `SKILL_SCOPE_ORDER = [project, personal, public]` — i.e. **project wins over personal wins over public**, the same precedence shape as HorizonCode doc 15's discovery order, and the same shape as AGENTS.md hierarchy in doc 10. Legacy directories (`.openhands/microagents/`) are mapped for backward compatibility with an explicit warning comment: *“Dropping it would silently misfile legacy skills as 'public'.”* **Lesson: legacy source-path mapping is a correctness concern, not polish** — our skill discovery spec should state what happens to skills found in retired paths (map with a marker + surface in `/doctor`, never silently re-scope).

## 6. Action space vs HorizonCode tools (doc 09)

The action/observation pairing is **structural**: `.../core/base/base.ts` builds each action type as `` `${EventType}Action` `` over `EventType = MCPTool | Finish | Think | ExecuteBash | Terminal | FileEditor | StrReplaceEditor | TaskTracker | PlanningFileEditor | InvokeSkill | SwitchLLM | ClassifyAndSwitchLLM`, plus browser-only actions, `Glob`, `Grep`, `TaskAction` (subagent), and client-tool kinds; observations mirror with exactly one observation type per action. HorizonCode's equivalent property is the tool-declaration completeness gate (every tool declares schema in/out); the OpenHands lesson is the **typed pairing**: one action kind ↔ one observation kind, enforced at the type level, so an unpaired result is unrepresentable. Our `ToolCall → ToolResult` pairing in doc 05/06 should state the same invariant explicitly (a ToolResult with no matching ToolCall and vice-versa is invalid — fail-closed at the log).

## 7. Sandbox / runtime learnings (doc 08)

This checkout does **not** contain the runtime/sandbox (Agent Canvas renders and translates; execution, sandboxing and credentials are upstream — per its own `docs/architecture.md`). Verified here only: the docker deployment path (`docker/Dockerfile`, entrypoint, smoke test), the launcher's `uvx`-based local stack (`bin/`, `scripts/`), and one very transferable device — **`runtime_services` from `/server_info` is forwarded into new conversations as an agent context suffix so agents use correct URLs instead of guessing ports**. HorizonCode analogue: the web/server surface should inject its actual bound URLs into session context the same way (never let the model guess a preview/dev-server port).

## 8. Top adopt recommendations

| # | Adopt | Target doc |
|---|---|---|
| A1 | Compaction = evented view-substitution (`forgotten_event_ids` + summary as events) | `docs/10`, `docs/12` |
| A2 | Hard-reset fallback ladder with bounded retries + scaling | `docs/10` (audit-5 gap) |
| A3 | Baseline-before-request capture for compaction completion detection | `docs/10`, `docs/12` flows |
| A4 | `keep_first` + `minimum_progress` knobs (anti-thrash, framing preservation) | `docs/10` |
| A5 | Compaction UX: before/after/saved metrics, manual CTA, busy-guard | `docs/13`, `docs/14` |
| A6 | Skill scopes project>personal>public with legacy-path markers | `docs/15` |
| A7 | Typed action↔observation pairing as an invariant | `docs/05`, `docs/06` |
| A8 | Two durability classes on one stream (`durable` with seq / `transient` without) | `docs/07` (§4.4 stream framing) |
| A9 | Sync preamble (`from_seq`/`through_seq`) before replay; `strictPagination` never conflates empty with unsupported | `docs/12`, `docs/07` |
| A10 | Scoped per-conversation capability token + adapter-enforcement repo test | `docs/11`, `docs/14` |
| A11 | Transport errors are not session errors | `docs/06`, `docs/07` |
| A12 | Runtime identity in projection cache keys (multi-runtime world) | `docs/12` |

*(Sections 4.3–8 completed by Forge on 2026-11-06 after the diving agent died; all cited files re-read directly. §4.1–4.2 authored by the original agent.)*
