# Deep-dive (learning pass): opencode "v2" — `v2branch` @ 7a6ce05 `2.0 exploration (#22335)`

**Subject:** `/data/home/forge/repo-tour/opencode-v2` (anomalyco/opencode, branch `v2branch`, commit `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, author Dax, committed 2026-04-13).
**Reference corpus:** `/data/home/forge/repo-tour/opencode` (same repo, branch `dev`, HEAD `21eaa626a37f77d7a8d80fa01997fa7d52506c97`, 2026-11-06) — where the 2.0 concepts actually landed, and where the full `specs/v2/*` corpus lives.
**Consumer:** HorizonCode docs at `/data/home/forge/hzcode/docs` (read-only reference; primary absorb targets 06, 08, 09, 12).
**Method:** static reading only, ~15 read/grep/list calls, nothing outside this report touched. Inference is marked *(inference)*; anything I did not read myself is marked *(unverified)*. **Citation convention:** within a bullet/paragraph the first file mention carries its full `file://` URL, and later `#L…` references continue that same file; a change of file introduces a new full URL.

> **Provenance warning.** The checkout named *opencode-v2* is not "version 2 as shipped": it is a **one-commit exploration branch** seven months older than dev. Sections 1–2 map the exploration; section 3 quotes the design corpus that grew out of it; sections 4–5 are the absorb/gap analysis; section 6 lists the inference risks, including a **prior partial report found at this path** (see §6.3).

---

## §1 — Map of the branch

### 1.1 What the checkout actually is

- Exactly **one commit**: `git log --oneline -15` returns `7a6ce05 2.0 exploration (#22335)`. No ancestry is visible in this clone; `.git` is a 71-byte file (linked worktree), and `git branch -a` shows local `v2branch` + `dev`, `origin/HEAD -> origin/dev`.
- Commit date **2026-04-13** (Dax); dev clone HEAD is **2026-11-06**. The exploration precedes the shipped state by ~7 months.
- Branch layout is the **pre-split monolith plus probes**: `packages/opencode/` is still the whole product, with three new directories bolted on (`v2/`, `sync/`, `control-plane/`) and a new `session/projectors.ts` inside the legacy session package.

### 1.2 Top level, versus the dev clone

Present here but not in dev: `github/` (workflow mirror), `STATS.md`, `packages/docs`, `.opencode/`, 25 translated `README.*.md`.
Present in dev but **not here**: `CHANGELOG.md`, `salesforce/`, `services/`, `strobe.json`, and packages `{ai, cli, client, codemode, core, effect-drizzle-sqlite, gui-plugins, httpapi-codegen, http-recorder, latex, merman, patchmark, plugin-browser, plugins, process-daemon, protocol, schema, server, session-ui, simulation, stats, stories, theme, tui}`.

So on this branch there is **no `packages/core`, no `packages/schema`, no `packages/protocol`, no `packages/server`, no `packages/codemode`** — the package split HorizonCode models itself on (its `_conventions.md` §3 mirrors the dev shape) is the *later* state. The exploration is a single commit on a single monolith; the split happened on `dev`.

Packages (21): `app, console, containers, desktop, desktop-electron, docs, enterprise, extensions, function, identity, opencode, plugin, script, sdk, slack, storybook, ui, util, web`.
Workspaces (`/data/home/forge/repo-tour/opencode-v2/package.json`): `packages/*`, `packages/console/*`, `packages/sdk/js`, `packages/slack`. Bun 1.3.11; catalog pins `effect 4.0.0-beta.46`, `ai 6.0.158`, `zod 4.1.8`, `drizzle-orm 1.0.0-beta.19` — the *same* dependency generation as dev, so v2 is a re-architecture inside the same stack, not a stack change.

### 1.3 `specs/` on this branch — two files, one contradiction

| File | Lines | Job |
|---|---|---|
| `specs/project.md` | ~50 | Raw sketch of "one instance, many projects/worktrees": `GET /project -> Project[]`, per-project session routes with `directory`, `parentID`, `compact`, `revert`/`unrevert`, `permission/:permissionID`, `find/file`, `file/status`, `share`. Contains the author's own doubts inline (`// These are awkward`). |
| `specs/v2/session.md` | 17 | Newer note that **removes** the dedicated `session.init` route, because it is only a wrapper over the normal `/init` command flow. |

`project.md` still lists `POST /project/:projectID/session/:sessionID/init` (L26) while `specs/v2/session.md#L3-L16` deletes it. Exploration branches contain dated notes, not one coherent contract — read both as such.

### 1.4 `specs/` on dev — the real 2.0 corpus (1,461 lines, 7 files)

`specs/v2/README.md` classifies them and assigns authority:

- **Current Contracts:** `session.md` (118) — prompt admission, execution, instructions, compaction, recovery; `tools.md` (177) — tool construction, registration, execution, outcome laws.
- **Decision Records:** `event-stream-architecture.md` (227, *Accepted and implemented*); `provider-policy.md` (398, *Accepted and implemented*); `claude-agent-provider.md` (176, *Draft*).
- **Historical Context:** `catalog-config-plugin-lifecycle.md` (324) — the rejected-vs-selected comparison that produced replayable catalog transforms.

The README's **authority-by-concern** table (HTTP/transport → Protocol; public shapes + durable event payloads → Schema; runtime + persistence → Core; regression guardrails → root `AGENTS.md`) and its two governance rules are themselves absorbable material: *"They are not API reference or a backlog"* and *"Do not add implementation checklists here. Put actionable work in GitHub issues and package-specific contributor guidance next to the code it governs."*

### 1.5 The three probes

```
packages/opencode/src/
├── v2/       session-entry.ts (186)  ← typed, append-only session entry union (the new session model)
│             session.ts       (71)   ← SessionV2 service skeleton; create/prompt throw "Not implemented"
├── sync/     README.md (179)         ← design essay: event sourcing behind the existing Bus
│             index.ts (265)          ← SyncEvent.define/run/project/subscribeAll/init
│             event.sql.ts (16)       ← event_sequence(aggregate_id pk, seq) + event(id, aggregate_id, seq, type, data json)
│             schema.ts (13)
├── control-plane/  workspace{.ts,.sql.ts}, workspace-context.ts, adaptors/{index,worktree}.ts, sse.ts, schema.ts, types.ts
└── session/  projectors.ts (165)     ← NEW: DB mutations expressed as SyncEvent.project(...) handlers
              message-v2.ts (1057), prompt.ts, llm.ts, processor.ts, instruction.ts, compaction.ts,
              retry.ts, revert.ts, run-state.ts, status.ts, summary.ts, system.ts, todo.ts, … (legacy v1 machinery)
```

Scale tells the story: `v2/` + `sync/` + `control-plane/` ≈ 1,100 lines of probe against a ~4,300-line `session/` dir still carrying v1. `SessionV2.create` and `SessionV2.prompt` are literally `throw new Error("Not implemented")` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/v2/session.ts#L42-L51`), and `fromID` is a v1-to-v2 adapter (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/v2/session.ts#L52-L56`, `fromV1` at `file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/v2/session.ts#L66`). The path is declared, not built.

### 1.6 What grew where

*(inference)* The dev package names are the matured vocabulary of this probe: `sync/` → `packages/schema/src/{event.ts,event-manifest.ts,durable-event-manifest.ts,event-log.ts,legacy-event.ts}` plus `packages/core/src/{bus.ts,event/,event-logger.ts}`; `control-plane/` → `packages/core/src/location*.ts`; `v2/session-entry.ts` → the message/part→durable-session model now governed by `specs/v2/session.md`. I verified the dev *listings* and the dev spec corpus, not the dev implementations of those files.

## §2 — What v2 changes vs. v1/dev: architecture deltas

### 2.1 Event model: from "publish after mutating" to "record, then project"

**v2branch (`sync/`).** The probe's core idea is stated plainly in its README: *"The difference in event sourcing is events are sent **before** the mutation happens, and 'projectors' handle the effects and perform the mutations. This difference is subtle, and a necessary change for syncing to work."* (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/sync/README.md#L41`). The mechanism:

- `SyncEvent.define({type, version, aggregate, schema, busSchema?})` — a sync event carries `type, id, seq, aggregateID, data`; a bus event carries `type, properties`. Sync events **automatically re-publish as bus events**, so `Bus` stays the one subscription surface for consumers (`#L91-L101`).
- Ordering is deliberately minimal: *"only one device is allowed to write, [so] we don't need any kind of sophisticated distributed system clocks or causal ordering. We implement total ordering with a simple sequence id (a number) and increment it by one every time we generate an event"* (`#L29-L33`).
- Storage is two SQLite tables: `event_sequence(aggregate_id pk, seq)` and `event(id pk, aggregate_id fk→sequence cascade, seq, type, data json)` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/sync/event.sql.ts#L1-L16`). At this commit there is **no** global position, digest, manifest or rebuild machinery — those are dev-era additions.
- Projection is a registered list: `session/projectors.ts` exports an array of `SyncEvent.project(Event, (db, data) => …)` handlers — `Session.Event.Created/Updated/Deleted` and `MessageV2.Event.Updated/Removed/PartRemoved/PartUpdated` (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/session/projectors.ts#L65-L160`). Updates go through `toPartialRow` with a `DeepPartial` convention: **"pass `null` to clear a field instead of `undefined`"** or the projector throws (`#L26-L47`).
- Anti-pattern made explicit: `Bus.publish(SyncEvent, …)` *works but should not* — *"You should never be touching the db directly, and should not be manually handling these events… I would like to force this to be a type error in the future."* (`#L107`).

**The migration bridge is the most instructive part.** Backwards compatibility is the stated primary goal (`#L35-L47`), so sync events dual-shape: the durable `data` (changed fields only) vs the legacy bus `properties` (full object). A runtime `convertEvent` hook reshapes events before bus publication, used only for `session.updated` (`#L109-L115`), and `busSchema` carries the legacy shape at type-checking time — with a documented limitation: *"the conversion done in `convertEvent` is not automatically type-checked with `busSchema`. It's very important they match"* (`#L145-L165`). The README also records three **rejected alternatives** and why (per-event sync subscriptions blocked by `Bus` being instance-scoped; folding sync into the bus; runtime `convertSchema` failing type-checking) (`#L167-L179`).

**Dev end-state.** The durable-event plan is now specified around *facts*: `session.inbox.enqueued` → row, `session.inbox.delivered` → atomic visible-message insert; `sessions.log({sessionID, after?, follow?})` replays public durable session events with **one synchronization marker at the captured watermark** before live events; streaming text/reasoning/tool-input deltas are intentionally **live-only and absent from replay** (`file:///data/home/forge/repo-tour/opencode/specs/v2/session.md`). The event-stream decision record splits concerns: *Core owns event meaning, publication, persistence, typed observation, durable logs, replay, and transactional projection. Server owns public event selection, wire encoding, bounded connection delivery, and subscriber lifecycle* (`file:///data/home/forge/repo-tour/opencode/specs/v2/event-stream-architecture.md#L1-L21`).

### 2.2 Session model: from message+part tables to a typed entry log, then to inbox+execution contracts

**v2branch (`v2/session-entry.ts`).** One closed union replaces the message/part split — a session is an append-only log of typed **entries** (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/v2/session-entry.ts#L184-L185`):

```ts
export const Entry = Schema.Union([User, Synthetic, Request, Tool, Text, Reasoning, Complete, Retry, Compaction])
```

Details worth stealing or arguing with:

- Every entry has `{id (branded "ent", ascending), metadata?, time.created}` (`#L6-L20`).
- `User` carries `files: FileAttachment[]` and `agents: AgentAttachment[]` — attachments are *entry fields*, not separate parts (`#L48-L66`).
- `Request` (the model request marker) uses `type: Schema.Literal("start")` — a naming wart, noted for the exploration-era quality bar (`#L74-L82`).
- `Text`/`Reasoning` have `time.completed?`; `Tool` has `callID`, `name`, a `state` union `pending{input,raw} | running{input,title?,metadata?} | completed{input,output,title,metadata,attachments?} | error{input,error,metadata?,time{start,end}}`, plus `time.{created,ran?,completed?,pruned?}` (`#L104-L152`). Tool lifecycle and context pruning are **timeline facts**, not side channels.
- `Complete` is an entry carrying `cost` and `tokens{input,output,reasoning,cache{read,write}}`; `Retry{attempt,error}` and `Compaction{auto,overflow?}` are first-class entries (`#L154-L168`, `#L177-L182`).

`v2/session.ts` shows the intended facade: `PromptInput` = the `User` fields minus `time`/`type`, plus `id?` and `sessionID`; `Info{id, model?}`; `Interface = {fromID, create, prompt}`; `fromV1` currently keeps only the id — the v1/v2 seam is a placeholder (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/v2/session.ts#L14-L27`, `#L35-L37`, `#L66`).

**Dev contract (what the model became).** Admission precedes execution and is durable: `Session.prompt(...)` publishes `session.inbox.enqueued` before any advisory wake; delivery is explicit (`steer` default — enqueue order at the next Safe Step Boundary; `queue` — idle-boundary delivery); compaction and move are **control items in the same inbox** and form delivery boundaries; promoting new user input resets the agent's step allowance (a batch of steers resets it once). Idempotency is exact: reusing a Session ID adopts the session; reusing an inbox item ID is idempotent when session+type match ("the first admission wins"); cross-session or cross-type reuse fails. Execution is **process-local**, keyed by session ID, with a write-ahead claim, bounded crash recovery that appends a durable continuation instruction, and explicit non-guarantees for exactly-once provider/tool effects (`file:///data/home/forge/repo-tour/opencode/specs/v2/session.md`).

### 2.3 Tool system: values, scoped registration, codecs, canonical outcomes

Dev's `tools.md` is the sharpest part of the corpus (headings verified at `file:///data/home/forge/repo-tour/opencode/specs/v2/tools.md#L29-L177`):

- **Durable identity per call** — `{sessionID, agent, assistantMessageID, callID}` supplied by the runner; "the registry does not infer it" (`#L29-L48`).
- **Scoped registration**: a registration is Scope-owned; *"The latest active registration for a name wins. Closing a registration removes only that registration. Closing the winner reveals the next-latest active registration. Mutating the caller's registration record later does not change the captured registration."* Names are normalized (unsupported characters → `_`) and **`execute` is reserved for Code Mode** (`#L49-L83`).
- **Built-ins use the same contract** while capturing trusted Location services; permission is *formulated by the tool* (`permission.assert({sessionID, agent, source:{type:"tool", messageID, callID}, action, resources, save, metadata})`) and evaluated by a separate permission service — the registry "does not inject an `assertPermission` helper" (`#L84-L126`).
- **Request-time capture**: each model request snapshots the effective registration for every advertised name; execution uses the captured tool; the final Step keeps tool definitions with `toolChoice: "none"` "so the cached prompt prefix survives" (`#L127-L147`).
- **Boundaries**: producer caps are separate from registry bounding; model text is bounded head+tail with a middle omission marker; oversized text is retained in managed storage or **the call fails operationally rather than publishing lossy success**; metadata is measured independently and never an unbounded side channel; `execute.after` hooks re-normalize changed content; interruption is never translated into a model-visible failure (`#L148-L166`).
- **Laws** (verbatim list): single execution · codec boundary · canonical representation · metadata opt-in · durable identity · scoped registration · captured execution · per-call rejection · storage encapsulation (`#L167-L177`).

### 2.4 Code mode

The only explicit coupling visible in this corpus is the reserved `execute` name and the statement that *"Code Mode observes the validated encoded output"* — i.e. Code Mode is the consumer of the machine `output`, while the model sees `content` (`file:///data/home/forge/repo-tour/opencode/specs/v2/tools.md#L29-L48`, `#L167-L177`). Dev additionally ships `packages/codemode` as its own package. *(I did not read the dev codemode implementation.)*

### 2.5 Plugins

On the branch, `plugin/` is already a substantial subsystem on disk (`install.ts` 439, `shared.ts` 323, `index.ts` 310, `meta.ts` 188, `loader.ts` 174, plus provider-shaped plugins `codex.ts` 608, `cloudflare.ts` 67). The corpus adds the lifecycle decision: **catalog transforms beat config mutation + service reload**. The selected option keeps transforms *replayable* so disablement rematerialises the catalog instead of manually undoing edits; the rejected option ("Config Transforms, Service Reload") and both tradeoff tables are preserved in the historical record (`file:///data/home/forge/repo-tour/opencode/specs/v2/catalog-config-plugin-lifecycle.md#L18`, `#L180`, `#L191`, `#L314`). Plugin readiness is checked *before hooks on every call* in the session contract (`specs/v2/session.md`).

### 2.6 Server / SDK

This commit still ships `packages/sdk/js` + `packages/sdk/openapi.json` (generated SDK era). Dev replaces that with `packages/protocol` (endpoint definitions, `HttpApi`), `packages/server`, `packages/schema`, and generated Promise/Effect clients — the *EventV2* world: **one global subscription, encode once, one shared immutable frame, then a nonblocking offer to per-connection bounded dropping queues; overflow terminates only that connection while healthy connections continue in order** (`file:///data/home/forge/repo-tour/opencode/specs/v2/event-stream-architecture.md`, "Decision" and "Delivery Law" sections). Note for HorizonCode: your doc 07 already carries the same 4,096 figure with a *resumable* `page_end`/`resnapshot_required` policy (`file:///data/home/forge/hzcode/docs/07-apis-and-contracts.md#L65`, `#L1387`) — see §4/§5 for why that difference matters.

### 2.7 Placement: one instance, many projects and worktrees

The branch goal is verbatim: *"The goal is to let a single instance of OpenCode run sessions for multiple projects and different worktrees per project"* (`file:///data/home/forge/repo-tour/opencode-v2/specs/project.md#L3`), with the whole REST surface re-scoped to `/project/:projectID/session/...`. The machinery is `control-plane/`: `workspace.ts` (230), `workspace.sql.ts` (persisted workspaces), `workspace-context.ts`, `adaptors/worktree.ts`, `sse.ts`. Dev generalises this into **Location** (`packages/core/src/location.ts`, `location-service-map.ts`, `location-lifecycle.ts`): execution is process-local, the runner enters its Location at drain start, runner/model/tools/permissions/plugins/filesystem are Location-scoped, retry reconciliation happens before prompt preparation so an already-admitted input skips hooks, and session events stay outside the Location context "so movement does not pin them to the old Location" (`specs/v2/session.md`).


## §3 — The v2 specs' own language: goals, constraints, laws

### 3.1 v2branch: shrinking special cases, one compatibility envelope

- **Session API, verbatim:** *"The dedicated `POST /session/:sessionID/init` endpoint exists only as a compatibility wrapper around the normal `/init` command flow… V2 plan: remove the dedicated `session.init` endpoint; rely on the normal `/init` command flow instead; avoid reintroducing `Session.initialize`-style special cases in the session service layer."* (`file:///data/home/forge/repo-tour/opencode-v2/specs/v2/session.md#L3-L16`). Goal language: **delete wrapper routes; keep one real code path; don't reintroduce special cases in the service layer.**
- **Sync README, goal list verbatim** (`file:///data/home/forge/repo-tour/opencode-v2/packages/opencode/src/sync/README.md#L27-L47`): *"Introduce a new syncing abstraction to handle event sourcing and projectors; Seamlessly integrate these new events into the same existing `Bus` abstraction; Maintain full backwards compatibility to reduce risk."* Plus the constraint that motivates it: *"one device to control and modify the session, and … multiple other devices to 'sync' session data"* — hence single-writer + sequence, explicitly rejecting distributed clocks.
- **Debt stated openly:** `Bus.publish(SyncEvent)` *"works, but you shouldn't… should fail in the future"* (`#L107`); `convertEvent` *"should be avoided, but might be necessary for temporary backwards compat"* (`#L113`); the README documents three rejected alternatives and why they lost (`#L167-L179`).
- **Scope ceiling:** *"**We have upgraded many of the session events to be sync events** (all of the ones that mutate the db)"* — the migration is deliberately incomplete, only DB-mutating events, at this commit (`#L101-L107`).

### 3.2 dev corpus: governance and authority language

From `specs/v2/README.md` (whole file): *"These documents explain V2 behavior that is difficult to recover from one source file. They are not API reference or a backlog."*; the authority table (Protocol / Schema / Core / AGENTS.md); *"Generated clients follow the assembled public `HttpApi`. GitHub issues own active work; Git history preserves removed plans and scratchpads."*; *"Do not add implementation checklists here. Put actionable work in GitHub issues and package-specific contributor guidance next to the code it governs."* Document statuses are explicit per file: Accepted and implemented, Implemented, Draft, Historical.

### 3.3 dev `session.md`: the constraints, in its own words

- **"Prompt Admission Precedes Execution"**, **"Execution Is Process-Local"**, **"One Step May Have Several Physical Attempts"**, **"Retry Is Narrow And Observable"**, **"Instructions Are Value Deltas"**, **"Compaction Rebuilds Active History"**, **"Durable Events Are Session-Scoped"**, **"Recovery Boundaries Stay Explicit"** — the section titles are themselves the goal statement (`file:///data/home/forge/repo-tour/opencode/specs/v2/session.md`).
- Scheduling vs durability: *"`resume` controls scheduling, not durability"*; *"An advisory wake is not itself crash recovery."*
- Ownership, local and honest: *"Explicit resumes join the active execution for the same Session. Repeated wakes coalesce into one follow-up drain. Different Sessions run concurrently. Interruption stops locally owned execution without deleting pending input."*; *"`sessions.active()` snapshots busy periods currently owned by this process. Durable execution events and claims are historical and recovery records, not proof that this process is still live."*
- Orchestration shape: *"After a local outcome, continuation reloads projected history and begins a new Step. The runner never delegates orchestration to an in-memory tool loop."*
- Conservatism: *"it cannot prove whether an interrupted external operation already took effect and does not guarantee exactly-once provider or tool behavior"*; *"Local execution remains process-owned until clustering introduces an explicit placement and fencing protocol."*
- Instructions: *"There is no instruction registry."*; *"An instruction epoch spans completed compactions."*; *"A fork copies messages only through its selected boundary but adopts the parent's newest instruction values as its baseline."*
- Replay contract: *"Live-only text, reasoning, tool-input, and compaction deltas are intentionally absent from replay."*

### 3.4 dev `tools.md`: laws and one-liners

- *"A reusable tool value has no intrinsic name."*; *"Registration replaces unsupported name characters with `_` and reserves `execute` for Code Mode."* (`file:///data/home/forge/repo-tour/opencode/specs/v2/tools.md#L49-L83`).
- *"Sharing a tool type does not imply equal authority. Built-ins and trusted Location plugins may capture services that are not available to application tools."* (`#L84-L126`).
- *"Invalid input never executes the tool. Invalid output never produces a successful execution."* (`#L127-L147`).
- *"if complete retention fails, execution fails operationally rather than publishing lossy success"*; *"Metadata is validated and measured independently and never becomes an unbounded side channel."* (`#L148-L166`).
- The nine **Laws** (`#L167-L177`): single execution · codec boundary · canonical representation · metadata opt-in · durable identity · scoped registration · captured execution · per-call rejection · storage encapsulation.

### 3.5 dev decision records: statuses, tradeoffs, open questions

- **Event stream:** accepted and implemented; the Decision section fixes the architecture — one global subscription, encode once, shared immutable frame, independent bounded queues per connection — and the Delivery Law: *"A connection has an independent finite lag budget. Exceeding it terminates only that connection while publication and healthy connections continue in order."* (`file:///data/home/forge/repo-tour/opencode/specs/v2/event-stream-architecture.md#L1-L80`).
- **Provider policy:** accepted and implemented; the section headings show the intended shape — Purpose, Goals, Non-Goals, Statement Shape, Matching, Evaluation, ordering *within* and *across* documents, Organization-Managed Policy (delivery, failure, messages, protection), Tool Policy, Skill Integration Policy, MCP Integration Policy, Legacy Migration (`file:///data/home/forge/repo-tour/opencode/specs/v2/provider-policy.md#L5-L392`). *Detail of the rules was not read in this pass — treat as a lead, not a fact.*
- **Catalog/config/plugin lifecycle:** filed as Historical Context, preserving *"A. Rejected: Config Transforms, Service Reload"* versus *"B. Selected: Catalog Transforms"*, each with its own Tradeoffs section (`file:///data/home/forge/repo-tour/opencode/specs/v2/catalog-config-plugin-lifecycle.md#L18`, `#L180`, `#L191`, `#L314`). The lesson is as much about **keeping rejected options with their tradeoffs** as about the selected mechanism.
- **Claude Agent provider:** status Draft, and it has Limitations plus Open Questions and Concerns sections (`file:///data/home/forge/repo-tour/opencode/specs/v2/claude-agent-provider.md#L1`, `#L145`, `#L168`) — evidence that the corpus tolerates explicitly unsolved areas instead of smuggling them in as settled.


## §4 — What HorizonCode should learn/absorb (concrete, mapped to 06/08/09/12)

Primary targets are 06 (events & flows), 08 (runtime), 09 (tools), 12 (sessions & state); secondary targets are named where the material lands better elsewhere. Each row names the exact v2 evidence and a concrete change to make or verify.

| # | Absorb | v2 evidence | HZ target and concrete change |
|---|---|---|---|
| A1 | **Control items share the prompt inbox and form delivery boundaries** — compaction/move are inbox items; steers never cross them; promoting new input resets the step allowance (a steer batch resets it once) | `specs/v2/session.md` (dev), "Prompt Admission Precedes Execution" | **08 §2.5** (extend R-runtime-27..31): add control-item admission, delivery-boundary rule, and step-allowance semantics; **06** flows 6.6/6.7/6.9 get a boundary assertion |
| A2 | **First-admission-wins idempotency** — inbox item ID reuse is idempotent iff session+type match; cross-session/cross-type reuse fails; after delivery, retry reconciliation uses the projected message, not enqueue history | `specs/v2/session.md` (dev) | **08 §2.5** + **06** §3.2 append API: state the idempotency key and its conflict set |
| A3 | **Instruction value-deltas** — content-addressed blobs, `{delta hash map, text?}` event, literal `"removed"`, epoch start moves to the compaction's sequence, fork adopts parent baseline, later changes freeze rendered prose once and thereafter display changed keys | `specs/v2/session.md` (dev), "Instructions Are Value Deltas" | **10** context compiler (beside R121–R126): adopt content-addressing + delta event + epoch-as-sequence; **06** catalogue gets the instruction event; note HZ R124's session-start-only compile differs and needs reconciliation |
| A4 | **Write-ahead claim semantics and their limits** — claim at busy-period start; released on terminal; preserved on shutdown/unclean death; recovery appends a continuation instruction and counts attempts; durable claims are not proof the process is live | `specs/v2/session.md` (dev), "Execution Is Process-Local"/"Recovery Boundaries" | **12 §2.5/§4.8** (HZ already cites opencode `execution.ts#L73-L83` at `file:///data/home/forge/hzcode/docs/12-sessions-state.md#L798`): add sessions.active()-style non-claim and the continuation-instruction rule; **06** flow 6.8 aligns |
| A5 | **Retry accounting** — retries keep the logical step number and do not consume another step allowance before durable output; incomplete-stream continuation adds a synthetic continuation instruction with a new assistant message ID under the same budget; one immediate full-context rebuild on continuation rejection | `specs/v2/session.md` (dev), "Retry Is Narrow And Observable" | **08 §2.6/§2.7**: add step-allowance accounting; **06** flow 6.23 |
| A6 | **Compaction terminality** — one overflow-triggered compaction may rebuild the same logical Step before durable output; second overflow or any overflow after durable output is terminal; provider-native continuation does not cross the boundary; full transcript stays durable | `specs/v2/session.md` (dev), "Compaction Rebuilds Active History" | **10** (compaction) + **12** (R112 area): add the exactly-once-per-step rebuild rule and the boundary reset |
| A7 | **Scoped registration overlays** — latest active registration wins; closing reveals next-latest; caller mutation after registration has no effect; per-request capture of the advertised set | `specs/v2/tools.md#L49-L83` | **09 §2.3** + **15**: add overlay-stack semantics and the per-request pinning rule |
| A8 | **Name normalization and reservation** — unsupported characters → `_`; `execute` reserved for Code Mode | `specs/v2/tools.md#L49-L83` | **09 §2.3** (naming) + **11**: add the reservation list and the normalization function as a specified rule |
| A9 | **Machine/model output split** — machine `output` (Code-Mode-visible, ephemeral) vs model `content` (durable canonical) vs `metadata` (UI, bounded, opt-in); invalid input never executes; invalid output never succeeds | `specs/v2/tools.md#L127-L177` | **09 §2.5/§3.6** (`ToolResultV1`): verify the split exists; if single-valued, add the dual fields and the two failure rules |
| A10 | **Fail-closed retention** — if complete retention of oversized output fails, the call fails operationally; never publish lossy success; producer caps are not registry bounding | `specs/v2/tools.md#L148-L166` | **09 §2.6/§2.7**: add the no-lossy-success law and the two-limit distinction |
| A11 | **Cache-preserving final step** — keep tool definitions with `toolChoice: "none"` instead of stripping them, so the cached prefix survives | `specs/v2/tools.md#L127-L147` | **09** pipeline + **10** cache guard: add the final-step rule |
| A12 | **Encode-once event fan-out** — one semantic subscription → one encoded immutable frame → nonblocking offer to independent per-connection queues; a slow connection's failure must not stall publication or other subscribers; control/heartbeat frames must not consume subscriber lag budget | `specs/v2/event-stream-architecture.md#L1-L80` | **07** (framing §, C11 area) + **14**: add the single-encoding rule and the isolation invariant; **keep HZ's resumable `page_end` policy** — do not copy v2's terminate-the-connection choice |
| A13 | **Replay→live handoff marker** — subscribe before replay; emit one synchronization marker at the captured watermark; streaming deltas are intentionally not replayable | `specs/v2/session.md` (dev), "Durable Events Are Session-Scoped" | **07** (SSE framing rules at `file:///data/home/forge/hzcode/docs/07-apis-and-contracts.md#L896`) + **06 §3.5**: add the handoff marker and the live-only class |
| A14 | **Spec-corpus governance** — authority-by-concern table; per-file status (contract / accepted / draft / historical); rejected options kept with tradeoffs; "no checklists, no backlog"; semantic not type-precise | `specs/v2/README.md` (dev) | **00-index / _conventions**: add document classes + status field + an authority table; **24/25** adopt the "GitHub issues own active work" boundary |
| A15 | **Placement as an explicit concept** — sessions are ID-bound values, placement resolved per operation and at drain start; services acquired lazily; movement must not pin events to the old place; execution process-owned until explicit fencing | `specs/v2/session.md` (dev); `specs/project.md#L3` | **12** + **03 §3.1/§3.4**: define placement/fencing as a named concept with its boundaries |


## §5 — What v2 does that HorizonCode docs do NOT yet cover

These are the deltas I confirmed by grepping the HZ docs for the specific terms; each is a candidate for the target doc named. Where a check is cheap, the check is stated so it can be re-run.

1. **Step-allowance accounting.** HZ 08 has steer/queue (R-runtime-27..31) but no notion of a per-turn step allowance that new input *promotes* and a steer batch resets once. Absorb into 08 §2.5 and 06 flow 6.7. (Verified: no `allowance` in doc 08.)
2. **Control-item delivery boundaries.** HZ's queue flow (06 §6.7) does not say that compaction/move items are inbox items that later steers must not cross. Absorb the rule and its ordering guarantee.
3. **Instruction delta mechanism.** HZ 10 has the AGENTS.md/ZH.md hierarchy, size caps, and session-start compile (R121–R125), but nothing like content-addressed instruction blobs, a `{delta, text?}` durable event, the `"removed"` sentinel, or an epoch whose start is a sequence. HZ's model is *recompile at epoch*; v2's is *sync deltas, project frozen prose, move the baseline*. Pick deliberately; today HZ has no covering design for mid-session edits beyond detect+notice+reload.
4. **Registration overlay semantics.** HZ 15 has plugin activation and HZ 09 has namespacing, but nowhere states "latest active registration wins; closing reveals next-latest; per-request capture". Absorb into 09 §2.3 + 15.
5. **Tool name reservation.** No statement in HZ 09/11 that the name `execute` is reserved (for Code Mode) or that unsupported name characters normalize to `_`. Add to the naming section.
6. **Model/machine output split.** Verified gap *pending a schema look*: if `ToolResultV1` (`file:///data/home/forge/hzcode/docs/09-tools.md#L295-L310`) is single-valued, add the machine `output` vs model `content` vs UI `metadata` split plus "invalid output never produces a successful execution".
7. **No-lossy-success law.** HZ has retention language ("preserved") but I found no rule that *failure to fully retain* must fail the call rather than publish a lossy success. Add beside 09 §2.6 output-rendering contract.
8. **Encode-once fan-out.** HZ 07 C11 specifies the backpressure *policy* (bounded queue, `page_end`, `resnapshot_required`, 4,096/2 MiB) but not the *architecture* that makes encoding once and sharing one immutable frame safe, nor the isolation invariant that one slow subscriber cannot stall the feed. Add to 07's framing section and reference from 14.
9. **Placement/fencing as first-class.** HZ 03 mentions workspace binding and path trust (03 §8.1 area) and 12 has session state, but there is no *Location* concept: ID-bound values that outlive a particular execution site, lazy acquisition, movement without pinning, and "process-owned until explicit fencing". This is the single most structural v2 idea not yet mirrored in HZ. Add to 12 (state) with a pointer from 03.
10. **Doc-status discipline.** HZ docs have Status sections but no enforced per-section class (contract vs decision record vs historical) and no authority-by-concern table for *which document owns which kind of truth*. Absorb the `specs/v2/README.md` pattern into `_conventions.md` and the 00 index.

**Unverified leads** (from the prior partial report at this path; do not adopt without re-reading the source): provider-policy mechanics (last-match-wins, reversed document ordering for safety, `tool.use` never grants, enforcement protection against plugin removal, decider-named denial messages), the event-stream encoding-failure law and its benchmark, session-retry event names. These are plausible and consistent with the headings I verified, but this pass did not read those bodies.


## §6 — Risk and uncertainty note (exploration branch)

### 6.1 Provenance and status risks

- **The subject checkout is an exploration, not a shipped design.** One commit, April 2026; the probe files literally throw `Not implemented`; the sync README calls itself an initial implementation and states its debts ("should fail in the future" type error; `convertEvent` "should be avoided"). Do not port its **structure** (monolith + `v2/` + `sync/`) — port its **laws and rejected-option records**, and cite dev for anything claimed as implemented.
- **Internal inconsistency on the branch itself:** `specs/project.md` still lists `session.init` while `specs/v2/session.md` removes it. Read both as dated notes.
- **Seven-month gap.** Dev HEAD is the place where 2.0 landed and where the corpus beneath it carries statuses (Accepted/Draft/Historical). Any row in §4 should be re-verified against dev before it becomes an HZ commitment, because names changed (`sync` → `event*`, `control-plane` → `location*`, message/part projection instead of a single entry union).
- **Even the dev corpus is semantic, not type-precise** by its own rule ("explain cross-module contracts without copying exact types"), so type-level HZ decisions must be checked against `packages/{protocol,schema,core}` sources rather than against the prose.

### 6.2 What I did and did not read

Read in full: both `specs/` files on the branch; dev `specs/v2/README.md`; dev `specs/v2/session.md`; dev `tools.md` (all heading-bearing ranges plus the body from §Registrations through §Laws); `event-stream-architecture.md` through the Delivery Law; branch `session-entry.ts`, `v2/session.ts`, `sync/event.sql.ts`, `sync/README.md`, `session/projectors.ts` head, `session/schema.ts`, plus file inventories for `plugin/`, `control-plane/`, `session/`, dev `packages/core/src`, dev `packages/schema/src`, and HZ doc headings for 03/05/06/08/09/10/12/15/24/25 + `_conventions.md`. Not read: provider-policy body, catalog body, claude-provider body, event-stream body past the delivery law, dev implementations, branch plugin sources. No code was executed.

### 6.3 Prior partial at this path (process note)

When I wrote the skeleton, the target file already contained a **partial report from a different, interrupted run** (self-described as "after the diving agent died"). I superseded it because (a) it was not my skeleton for this task, (b) it mixed in a different task's framing — references to editing "doc 26 (ledger), doc 05/09" that do not exist in the HZ docs listing I enumerated (00–25 + `_conventions.md`), and "Fixed by this pass" claims for a read-only study, and (c) parts of it (provider-policy mechanics, event-feed capacity/benchmark) could not be verified against what I read. Its verifiable material that overlaps my own reading (tool laws, delivery law, authority table) agrees with mine; its unverifiable specifics are carried forward only as the **unverified leads** list in §5. If a future pass wants those details, re-read `provider-policy.md` and `event-stream-architecture.md` first.

### 6.4 Absorb-with-judgment: where HZ is already ahead of v2

Do not regress these while absorbing: HZ's projector contract already requires **digests and shadow-rebuild verification** (06 E-38..E-46), stronger than v2branch's projector list; HZ's event **versioning and reader gating** (06 E-31..E-37) is stronger than v2's `version: 1` field; HZ 07 already picks a **resumable** overflow policy where v2 terminates the connection — the improved behaviour is HZ's, and only v2's *encode-once + subscriber isolation* rationale should be imported; HZ 12 already cites the opencode claim implementation it wants to inherit (12 §4.8's note). In at least these four places the direction of borrowing is reversed.

