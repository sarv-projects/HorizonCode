# 02 — Decisions & Architecture Decision Records

> Every load-bearing choice, with the alternatives we rejected and why. Decisions here are binding for the spec set; later docs must not contradict them.

---

## Decision summary

| ID | Decision | Status |
|---|---|---|
| ADR-001 | **Terminal-first; the TUI is the product, the protocol is the API** | Accepted |
| ADR-002 | **Hybrid runtime: TypeScript/Bun for the agent, Rust for authority and native capability** | Accepted |
| ADR-003 | **The kernel is a separate process, not a library** | Accepted |
| ADR-004 | **Event-sourced session storage (log is the state of record)** | Accepted |
| ADR-005 | **One Controller, many front-ends, enforced by a parity ratchet** | Accepted |
| ADR-006 | **MCP is a client *and* a server** | Accepted |
| ADR-007 | **Policy is code: wildcard rules + Starlark prefix engine** | Accepted |
| ADR-008 | **Workspace config may only narrow user config** | Accepted |
| ADR-009 | **Cache prefix stability is a CI contract** | Accepted |
| ADR-010 | **Self-improvement never widens authority** | Accepted |
| ADR-011 | **No hidden in-memory tool loop: one provider stream per step** | Accepted |
| ADR-012 | **Every mutation produces a receipt; `UNKNOWN` is a first-class state** | Accepted |
| ADR-013 | **Local-first, BYO keys, offline-capable** | Accepted |
| ADR-014 | **Derivative work is permitted, tracked and attributed** | Accepted |
| ADR-015 | **Tools are declared, not string-matched** | Accepted |
| ADR-016 | **Subagent construction funnels through one primitive** | Accepted |

---

## ADR-001 — Terminal-first; the TUI is the product, the protocol is the API

**The question the user asked:** terminal model, or web UI mode? Which is easier, and which makes a better coding agent?

**Decision.** **Terminal-first.** The primary, fully-featured product is a fullscreen terminal UI. Web, desktop, IDE and mobile surfaces are **thin clients of the same protocol**, built later and never allowed to lag (parity ratchet).

**Why terminal is the better primary surface for a coding agent:**

1. **Zero distance to the work.** A coding agent lives where the code lives: a shell, a repo, an editor, a terminal multiplexer. A browser tab adds a context switch, an auth surface and a rendering layer for no capability gain.
2. **Latency and throughput.** Terminal rendering is cheap. Fullscreen diff review, long scrollback and thousands of streamed lines are native to it and painful in browsers.
3. **Universality.** SSH, containers, CI, remote boxes, locked-down corporate machines: a terminal works everywhere, with no install UI, no port, no certificate, no browser version matrix.
4. **Scriptability and composability.** `hzcode -p ... | jq`, piping diffs to `git apply`, running in a Makefile — the terminal is a program; a web app is a destination.
5. **Every strong reference agent is terminal-first** (Grok, Codex, Claude Code, ForgeCode, oh-my-pi, Reasonix, opencode). The one with the best TUI (Grok) is also the one with the most polished product feel.
6. **Effort allocation.** Terminal-first spends the effort budget on agent quality — context, tools, authority, verification — instead of on CSS, layout, hydration and cross-browser testing. **Better agent is a function of those things, not of the UI.**

**Why web/desktop still exist:**

- Reviewing a 50-file diff, reading a long plan, or approving a risky batch is genuinely better with more pixels and a real pointer.
- Teams need shared, observable sessions and dashboards.
- Non-terminal users (product, design, data) should be able to hand a task to the agent.
- Mobile/remote supervision (approve a shell command from a phone) is a genuine affordance.

**Why the protocol comes first anyway.** The Controller is transport-agnostic from day one: an internal `Controller` service speaks a versioned command/event protocol. The TUI is the first client of that protocol; the HTTP/SSE server, web app, desktop app, IDE bridge and SDKs are later clients of the *same* protocol. This means:

- Adding a surface never forks behaviour (ADR-005).
- Headless/CI mode is not a special case — it is just another client.
- A capability added for the web UI (e.g. rich diff review) is automatically available to the TUI in a terminal-appropriate form.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Web-first (Electron/browser only) | Slower start, heavier install, worse for SSH/CI, and it spends the effort budget on UI instead of agent quality. |
| TUI-only | Loses team sharing, long-diff review, dashboards and mobile supervision; also forks behaviour later when a surface is bolted on. |
| IDE-extension-first (VS Code only) | Subordinates the agent to one editor and one vendor; ACP + a bridge covers many editors without that lock-in. |

**Consequences.**

- The TUI must be excellent, not adequate: fullscreen alt-screen with mouse, inline fallback, diff viewer, palette, theming (see `13-tui.md`).
- The protocol is a public, versioned contract with generated clients (see `07-apis-and-contracts.md`).
- Surface work is budgeted *after* agent-quality work in every milestone.

---

## ADR-002 — Hybrid runtime: TypeScript/Bun for the agent, Rust for authority and native capability

**Decision.** The interaction, orchestration and cognition planes are **TypeScript on Bun**. The authority plane (kernel) and the native capability stack (shell, VFS, edit, diff, AST, walker, VCS, sandbox, PTY) are **Rust**.

**Why not pure TypeScript.** Authority cannot be enforced by the process it constrains. A policy check written in the same runtime as the plugin it is checking is advisory. Additionally, the native capability stack (in-process bash with an injectable VFS, streaming edit engine, AST rewrites, gitoxide-class VCS access, OS sandboxing) is either impossible or an order of magnitude slower in JS.

**Why not pure Rust.** Terminal UI iteration speed and ecosystem (React-style component model, streaming markdown, schema validation, provider SDK knowledge) strongly favour TypeScript; ~300 provider/model entries served by a smaller set of wire codecs (cf. `01-vision-and-superset.md` §2.2) are config-and-codec work that benefits from a high-level language and a huge package ecosystem. Every high-velocity reference agent that is Rust-first (codex, grok-build) pays for it in slower UI iteration and heavier crate scaffolding.

**Consequences.**

- One IPC boundary between the planes, versioned and schema-generated (ADR-003).
- Native capability is exposed to TS through **one** N-API addon plus the kernel socket — not a sprawl of bindings (lesson from oh-my-pi).
- A cross-plane contract test runs on every build: the TS side must fail closed if the native side is absent or older than the pinned ABI.

---

## ADR-003 — The kernel is a separate process, not a library

**Decision.** `hzk` runs as a supervised separate process (one host kernel per workspace, plus one supervisor per active session where isolation demands it). Communication is a versioned, schema-generated protocol over a Unix domain socket (Windows: named pipe).

**Why.**

- A library inside the agent process can be monkey-patched, replaced or bypassed by a plugin, an MCP server or a compromised dependency. A separate process with a pinned binary digest cannot.
- Crash isolation: a runaway effect, a wedged PTY or an out-of-memory build must not take down the agent that is supervising it.
- Capability accounting requires a process boundary for cgroups, rlimits, namespaces and OS sandboxing.
- It makes the authority boundary *auditable*: the kernel's asset is SHA-256-pinned and its manifest is checked at startup.

**Rejected alternative.** In-process kernel (simpler, faster, no IPC) — rejected because it fails the threat model in `11-authority-safety.md`.

**Consequences.**

- Startup must handle kernel absence, kernel version mismatch and kernel crash: all three are **fail-closed** (read-only mode) with a clear diagnostic, never silent fallback to unguarded execution.
- The kernel protocol is versioned; every request carries a protocol revision and is rejected if the kernel does not declare support.

---

## ADR-004 — Event-sourced session storage (the log is the state of record)

**Decision.** Sessions are an append-only event log (SQLite WAL, one transaction per fact) plus projectors that fold events into read models (messages, inbox, claims, todo state, usage). There is no mutable table that is the "real" state.

**Why.**

- **Crash truth.** After a kill -9 there is exactly one question: which facts are durable? An append-only log answers it.
- **Replay and time travel.** Rollout replay, `session fork`, checkpoints and audit all fall out of the log for free.
- **Deterministic tests.** Projectors are pure functions over events; the recorder/replayer makes provider tests hermetic.
- **Two writers, one truth.** TUI and server are both clients; a log with monotonic sequence numbers makes concurrent observation safe.

**Rejected alternative.** Mutable session rows with best-effort event notification — rejected because recovery becomes guesswork and replay is impossible.

**Consequences.**

- Schema migration must be log-compatible; events are versioned and never rewritten.
- Projections are disposable and rebuildable (`hzcode session reindex`).

---

## ADR-005 — One Controller, many front-ends, enforced by a parity ratchet

**Decision.** All behaviour lives in the transport-agnostic `Controller`. Front-ends are clients. A bespoke linter (*parity ratchet*) fails CI when a capability is reachable from one surface but not another.

**Why.** The single most common failure in multi-surface agents is drift: the web UI grows a feature the TUI lacks (or vice versa), and the codebase forks into two agents with one name. Reasonix demonstrated the ratchet; Codex demonstrated the protocol-first alternative; we take both.

**Consequences.**

- Front-end code may not contain domain logic; it may only render and collect input.
- New capabilities declare their surface projection in the same PR (TUI renderer, output format, server events, SDK method).

---

## ADR-006 — MCP is a client *and* a server

**Decision.** HorizonCode consumes MCP servers (tools, resources, prompts, OAuth) and exposes its own tools/sessions over MCP, so other agents can drive it.

**Why.** Being a server is what turns the agent into infrastructure: CI systems, IDEs and other agents can call it without bespoke glue. It also makes the tool surface portable across the ecosystem.

**Consequences.** Server mode is a separate entrypoint with its own permission profile (`mcp-server` posture defaults to read-only plus explicitly granted tools).

---

## ADR-007 — Policy is code: wildcard rules + Starlark prefix engine

**Decision.** Permissions are expressed in two composable layers. **Layer 1 (ergonomic):** wildcard rules with the Claude-Code-style shape — `Shell(git *)`, `Edit(src/**)`, `Read(*)`, `Web(domain:github.com)`, `Provider(model:claude-*)`. **Layer 2 (semantic):** a Starlark prefix engine that evaluates command decisions structurally (`execpolicy`), never by string matching on prose.

**Why.** Wildcards alone are unsafe (`Shell(rm -rf*)` cannot see `xargs rm`), and a semantic engine alone is unusable for everyday expression. The two together give expressiveness *and* safety. Precedence and its single enforcement point are owned by `11-authority-safety.md` R1.

**Consequences.** Every rule compiles to a canonical form with a digest; the effective policy set is hashed into the session posture so a run can be shown to have run under a specific policy revision.

---

## ADR-008 — Workspace config may only narrow user config

**Decision.** A repository's `.hz/config` may restrict permissions, but may never grant more than the user-level configuration allows. Programs named by a workspace config (hooks, LSP servers, MCP servers) stay **off until explicitly trusted for that folder** (trust-on-first-use with a per-directory decision).

**Why.** Otherwise `git clone && hzcode` is a remote-code-execution vector: a hostile repo ships a hook that runs on open. Every mature agent in the reference set has had to solve this; several solved it only after the fact.

**Consequences.** Merging is a lattice meet, not an overwrite. Trust decisions are recorded with path + digest and shown in `hzcode doctor`.

---

## ADR-009 — Cache prefix stability is a CI contract

**Decision.** The context compiler emits a **byte-stable prefix** (system prompt, tool schemas, declared configuration) and a **projected tail** (memory, skills index, goal/plan, retrievals). A CI cache-guard test fails the build when the prefix drifts for a given (provider, model, config) tuple.

**Why.** Cache misses are the largest silent cost and latency tax in agent loops, and the usual cause is accidental prefix churn (reordered tools, timestamps, unstable JSON key order). Reasonix proved a cache-guard is practical; oh-my-pi proved credential-affinity pinning matters.

**Consequences.** Compiler output is deterministic; tool schemas are sorted and versioned; anything volatile lives in the tail only.

---

## ADR-010 — Self-improvement never widens authority

**Decision.** The learning loop may change memory, skills, prompts, retrieval weights and *non-authority* routing heuristics. It may never add, widen or pre-approve a capability, edit policy, or alter the kernel. Any such change must be proposed as a reviewable artifact for a human to accept.

**Why.** An agent that can widen its own permissions is not an agent with permissions; it is an unbounded process. This is the line that makes unattended long-horizon operation acceptable.

**Consequences.** The learning loop emits *proposals* (diffs, skill bundles, memory facts with provenance). Proposals are receipted, reviewable, revertible and off by default in untrusted workspaces.

---

## ADR-011 — No hidden in-memory tool loop: one provider stream per step

**Decision.** A step = load history → compile context → **one** `llm.stream` call → apply tool results as durable events → end step. There is no inner `while (toolCalls)` loop inside a single step.

**Why.** Hidden loops destroy replay fidelity, blow up prompt caching, make interruption racy and make cost accounting a lie. OpenCode's one-stream-per-step discipline is the correct model and we adopt it wholesale.

**Consequences.** Parallel tool calls within a step are still allowed; they are a *batch* applied to the log before the next step begins.

---

## ADR-012 — Every mutation produces a receipt; `UNKNOWN` is a first-class state

**Decision.** Any effect that changes the world (file write, process execution, network effect, credential use, plugin effect, external API call) settles into a receipt with: capability ID, origin kind, intent digest, policy revision, lease ID, observation, and a terminal state of `SUCCEEDED`, `FAILED`, `DENIED` or **`UNKNOWN`** — the receipt subset of the RC-7 outcome enum, mapped by `05-domain-and-schemas.md` §4.11. `UNKNOWN` is never retried automatically.

**Why.** "Probably fine" is the worst possible outcome for an autonomous agent. An explicit unknown forces reconciliation, and the honesty of the state machine is what makes unattended operation legitimate.

**Consequences.** Every tool implementation must declare how it is observed; a tool that cannot be observed cannot be given mutation authority.

---

## ADR-013 — Local-first, BYO keys, offline-capable

**Decision.** The agent runs entirely on the user's machine. Keys live in the OS keychain (or an encrypted store) and are never proxied through our servers. A model that runs locally is a first-class citizen. Optional cloud features are opt-in and individually disableable.

**Why.** Code is the most sensitive asset a company has; "your source is sent to our server which forwards it" is a non-starter in most enterprises and a needless risk everywhere else.

**Consequences.** Sync, sharing, telemetry and collaboration features must all work degraded-but-useful when offline. No feature may make an outbound call that the user cannot see and disable.

---

## ADR-014 — Derivative work is permitted, tracked and attributed

**Decision.** HorizonCode inherits ideas and, where licensed, code from upstream projects. Derivative code carries its upstream attribution (including Apache §4(b) notices where applicable) and a `NOTICE` register. Overlay status against any pinned upstream is auditable.

**Why.** Two of the references are themselves derivatives (HorizonCode←OpenCode, oh-my-pi←Pi; grok-build ships codex/opencode tool ports with notices). Pretending otherwise creates a legal and maintenance liability, and a blind fork prevents upstream fixes from being adopted.

**Consequences.** Upstream pins are recorded with revision digests; bootstrap re-hydration is scripted; a provenance register maps each inherited file to its origin.

---

## ADR-015 — Tools are declared, not string-matched

**Decision.** A tool is a declared object: name, namespaced ID, JSON-Schema input/output, read-only class, concurrency class, effect class, **capability ID**, permission requirements, idempotency semantics, prompt fragment, UI renderers and telemetry fields. The runtime validates against those declarations; it never pattern-matches model output to guess intent.

**Why.** Undeclared tools cannot be reasoned about: they cannot be permissioned precisely, cannot be receipted honestly, and cannot be rendered well. ForgeCode's compile-time tool descriptions and Claude Code's self-contained tool contract both point here; we take the stronger form (generated declarations from a single source of truth).

**Consequences.** Tool descriptions are generated, not hand-written per surface; a tool missing a declaration fails the build.

---

## ADR-016 — Subagent construction funnels through one primitive

**Decision.** Every subagent — task, fleet member, team member, read-only explorer, background job — is created by exactly one internal primitive that applies: capability narrowing, budget inheritance, depth/concurrency limits, context capsule construction and receipt linkage. A **boundary test fails CI when a new caller appears**.

**Why.** The easiest way for an agent system to become unsafe is for child construction to be duplicated: one path forgets to narrow permissions, another forgets the budget, a third forgets receipts. Reasonix's boundary-test discipline is the cheapest possible defence.

**Consequences.** Child sessions are always traceable to a parent receipt, and `hzcode session tree` can always reconstruct authority and cost.


