# 14 — Surfaces (headless, server, web, desktop, IDE/ACP, MCP server, SDKs)

> **Implementation reality (read first).** Four surfaces have code: the scrollback TUI ([`13-tui.md`](13-tui.md)), print mode (`hzcode -p`, VERIFIED, ruling 57), the line-per-message headless pipe mode, and `hzcode serve` (single-attach NDJSON JSON-RPC v1 over stdio, seven methods, TESTED, rulings 53 and 54). **Everything else in this document is DESIGN ONLY: NOT IMPLEMENTED**: UDS, TCP, HTTP, SSE and WebSocket transports; the discovery file; server authentication and pairing; multi-client coordination; the web app; the desktop app; the IDE bridge and ACP; MCP server mode; generated SDKs; mobile supervision; sharing and presence; the parity ratchet; the `exec` subcommand and `ExecResultV1`; CI recipes. The Provenance section at the end of this document lists, per surface, what exists, where the design came from (exact upstream URLs at pinned commits), and a detailed deferral note (G1 to G13) for each missing piece.

> **Permission modes (`docs/28` ruling 58).** `hzcode --permission-mode <m>` works with chat, pipes and `-p` (a non-default mode prints one stderr line; stdout stays clean). `hzcode serve` does not take a mode yet.
>
> **Headless print mode (`docs/28` ruling 57).** `hzcode -p [text] --output-format text|json|stream-json` runs one non-interactive turn (prompt from stdin when `-p` has no text). `json` prints one result object `{type:"result", result, sessionId, exit:{terminal,detail?,code}, usage, toolCalls, changedFiles}`; `stream-json` prints one RuntimeEvent per line then that object. The exit code is `exitCodeFor` (0/1/3/4/5/130/143; a missing prompt or bad format is 2). The line-per-message mode is unchanged.
>
> **Agent presets (stage 3, `docs/28` ruling 56).** `subagent.event` frames, relayed as `session.event` in server mode, carry an optional `profile` string (additive) when the child ran under a preset.
>
> **Implementation note (2026-11-09, integration branch `integration/superset`).** Shipped and TESTED: a single-attach server mode speaking NDJSON JSON-RPC v1 over stdio (`docs/28` §1 server row; resume by id, read-only `session.list`), reusing `createRuntime` recovery. Headless remains line-in / text-out (a `turn.diff` is summarised on stderr as `· changed N file(s)`, never printed to stdout; `subagent.event` frames are relayed to server clients as ordinary `session.event` notifications, `docs/28` ruling 54). Stage 1 (2026-11-09): the server answers each line while stdin is open (a Worker reads fd 0 because Bun batches pipe stdin until EOF) and `server.hello` reports the real `kernelMode` before any session (`docs/28` ruling 53). Headless `-p` with JSON/JSONL output has since shipped (ruling 57, see the print-mode note above). STILL NOT STARTED: UDS/TCP/HTTP+SSE transports, SDKs, web, desktop and IDE surfaces, the fullscreen TUI renderer.

> ADR-001 makes the TUI the product and the protocol the API; ADR-005 makes every surface a client of one Controller. This document fixes each non-TUI surface: its architecture, protocol usage, auth, capabilities and limits — plus the parity ratchet that stops them drifting apart.

---

## 1. Purpose

This document decides:

1. What the eight surfaces are, what protocol each one speaks, and what each one may and may not do.
2. The headless/print/exec contract used by CI, including exit codes and JSON schemas.
3. The local server: transports, discovery, auth, multi-client coordination and remote-exposure safety.
4. The web app, desktop app, IDE/ACP bridge, MCP server mode, SDKs, mobile supervision and collaboration, each with capabilities and limits.
5. The parity ratchet: how it is computed, what fails the build, and how exceptions are granted and expired.

Sources: `source: ../README.md` (§3.6 interface surfaces); `source: 02-decisions.md` (ADR-001, ADR-003, ADR-005, ADR-006, ADR-008, ADR-013); synthesis from `source: audit/pass2/grok-build-report.md`, `source: audit/pass2/codex-report.md`, `source: audit/pass2/opencode-report.part1.md`, `source: audit/pass2/oh-my-pi-report.md`, `source: audit/pass2/DeepSeek-Reasonix-report.md`; reference implementations at source: [`grok-build/crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs) (leader + ACP replay), source: [`opencode/packages/cli/src/services/service-registration.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/services/service-registration.ts) (registration file), source: [`opencode/packages/server/src/pairing.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/pairing.ts) and `auth.ts` (pairing codes, session tokens), source: [`codex/codex-rs/app-server/`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server) (code-generated JSON-RPC app-server), source: `DeepSeek-Reasonix/desktop` (repo not cloned, path not verified) (desktop as a nested module), source: [`oh-my-pi/packages/coding-agent/src/modes/acp/`](https://github.com/can1357/oh-my-pi/tree/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/modes/acp) (ACP agent mode).

### 1.1 The eight surfaces

| Surface | Entry point | Protocol / transport | Process model | Primary use |
|---|---|---|---|---|
| **TUI** | `hzcode` (no args) | in-process Controller client | same process | interactive work; specified in `docs/13-tui.md` |
| **Print / headless** | `hzcode run`, `hzcode -p`, `hzcode exec` | in-process Controller client; text/JSON/JSONL out | one process per run | CI, scripts, pipes |
| **Server** | `hzcode serve` | JSON-RPC 2.0 over stdio / UDS / TCP + HTTP/SSE/WS | long-lived leader per workspace | all remote clients, IDE bridges, SDKs |
| **Web app** | served by `hzcode serve --web` | SDK over HTTP/SSE/WS to the local server | browser | long diffs, dashboards, supervision, sharing |
| **Desktop** | `hzcode-desktop` (Electron) | SDK to a local server it supervises | Electron main + sandboxed renderer | native notifier/menus/tray/file dialogs |
| **IDE bridge / ACP** | `hzcode acp`, `hzcode ide` | ACP v1 NDJSON JSON-RPC over stdio; bridge RPC to the leader | bridge process | editor-native review and permission proxying |
| **MCP server mode** | `hzcode mcp serve` | MCP over stdio or HTTP | one process per client | HorizonCode as infrastructure for other agents |
| **SDKs** | `@horizoncode/sdk`, `horizoncode` (py), `horizoncode` (go), `horizoncode` (rs) | generated clients over the server protocol | host application | embedding in services and tools |

Rule numbering is stable and testable. `MUST` fails a gate; `SHOULD` is reported; `MAY` is free. All capabilities in this document start at **DESIGNED** (`_conventions.md` §8).

## 2. Rules

### 2.1 Universal surface rules

| # | Rule |
|---|---|
| S1 | Every surface MUST drive the same `Controller` (`@horizoncode/core`). A surface MUST NOT own a run loop, a session store, a prompt builder, a tool executor, a policy evaluator or a cost ledger. The Controller's command vocabulary is fixed by `docs/03-hld.md` I-01 (`submit`, `cancel`, `approve`, `answer`, `setPosture`, `compact`, `fork`, `rewind`, `attach`, `detach`); every method this document defines (§3.2) MUST be a thin wrapper over one of those commands, never a parallel path. |
| S2 | A surface MUST contain no domain logic: it may encode, transport, render and collect input. A diff computed in a front-end, a rule evaluated in a front-end, or a tool invoked directly by a front-end is a defect. |
| S3 | Every surface MUST speak a versioned protocol (`HZ_PROTO=1`) and MUST reject a peer whose declared revision it does not support, with a typed error naming both revisions. |
| S4 | Every mutating request from any surface MUST reach the kernel through the ordinary tool/effect path and MUST settle into a receipt. There MUST be no surface-only mutation path (no "admin write", no local unlink, no direct DB edit). |
| S5 | All surfaces MUST use the same capability IDs, the same effect classes and the same `reason_code` vocabulary (`_conventions.md` §5, §6). A surface MUST NOT invent synonyms. |
| S6 | Fail closed everywhere: absent kernel, unsupported protocol, missing auth, unrenderable approval, or unknown effect class ⇒ refuse the operation with a typed error and a visible reason. Surfaces MUST NOT fall back to unguarded behaviour. |
| S7 | Auth, posture and grants MUST be enforced server-side (or in the Controller), never in the client. A client that hides a button MUST NOT be the reason an action is impossible. |
| S8 | Every surface MUST expose session identity as `hz://session/<id>`, receipt identity as `hz://receipt/<id>` and artifact identity as `hz://artifact/<sha256>`; display names are labels only. |
| S9 | Every surface MUST surface unreconciled `UNKNOWN` effects; a surface that can report success must also be able to report `UNKNOWN`, and CI-facing surfaces MUST fail the build on an unreconciled unknown unless explicitly opted out. |
| S10 | Every surface MUST be able to show the policy revision and posture in effect for the session it observes; a surface that cannot must mark those values `UNKNOWN` rather than omitting them. |
| S11 | Surfaces MUST NOT widen authority: a suggestion, an editor click, a share link or an MCP call may only *request*; the user's approval and the kernel's decision are the only sources of permission. |
| S12 | Every surface MUST fail the parity ratchet when it lacks a declared projection for a capability it exposes or claims (§2.11). |

### 2.2 (a) Headless, print and exec modes + CI

| # | Rule |
|---|---|
| S13 | The headless entry points are: `hzcode run <prompt>` (one turn or a bounded run), `hzcode print`/`-p <prompt>` (alias; minimal output), and `hzcode exec <command>` (run one shell command under current policy and report the receipt). All three MUST be non-interactive: no TTY required, no prompt for input, no approval dialog. |
| S14 | Output format is selected by `--output plain|json|jsonl` (default `plain` for `run`/`-p`, `json` for `exec`). `--json` is an alias for `--output json`. Schemas are `HeadlessResultV1` (docs/13-tui.md §3.5) and `ExecResultV1` (§3.3). |
| S15 | stdout carries only the selected output; diagnostics, progress, logs and warnings go to stderr. With `--output json|jsonl`, stdout MUST contain nothing but the schema'd payload. |
| S16 | Exit codes are canonical across all surfaces and are owned by **one table, §3.2**; this rule points at it and MUST NOT restate it (RC-5). Any rule here or in another document that needs an exit code cites §3.2. |
| S17 | A run that ends with an unreconciled `UNKNOWN` MUST set `unknowns` in the result and MUST exit `3` unless `--allow-unknown` is passed, in which case exit is `0` and `unknowns` is still populated. CI MUST be able to gate on `unknowns` without parsing prose. `--allow-unknown` MUST NOT downgrade a denial or a kernel-absence refusal. |
| S18 | A run that was denied by policy MUST exit `4` and MUST include `denials[]` with `capabilityId`, `reasonCode` and, when one exists, `receiptId`. |
| S19 | Non-interactive approval is policy-only: `--posture allow|ask|deny`, `--allow <rule>` (repeatable), `--deny <rule>` (repeatable), or workspace/user config. When the effective decision is `ask`, it MUST resolve to `deny` with reason code `noninteractive_ask` — never a hang, never an implicit allow. |
| S20 | CI runs MUST be able to constrain work without touching the repository's own config: `--max-turns`, `--budget tokens=…,usd=…,wall=…`, `--tools <allowlist>`, `--disallowed-tools <list>`, `--no-network`, `--offline`, `--sandbox <profile>`, `--no-auto-update`. A flag that cannot be honored MUST fail with `2`, not be ignored silently. |
| S21 | `--offline` MUST disable every outbound path that is not the configured model endpoint: web search/fetch, notifications, webhooks, telemetry export, update checks, share/live features, marketplace. It MUST print the disabled destinations to stderr once. |
| S22 | Credentials in CI come from the environment or the OS keychain, never from an interactive flow: `HZ_MODEL_API_KEY` / provider-specific env names, cloud workload identity (OIDC) for Bedrock/Vertex, or `hzcode auth import --stdin`. Device-code flows MUST NOT be attempted when stdin is not a TTY. |
| S23 | Secrets MUST NOT appear in stdout, stderr, logs, receipts, artifacts or the transcript. Redaction runs at the boundary (log writer, exporter, notification) and MUST be tested with a planted secret in every output mode. |
| S24 | The headless run MUST be reproducible enough for CI: given the same prompt, config, policy revision, model, and recorded provider fixtures, the transcript structure (event kinds and order) MUST be identical. The `testing` harness records and replays provider traffic for this purpose. |
| S25 | `--print-session` MUST emit the session id and `hz://session/<id>` on stderr (or as fields in JSON) so a pipeline can inspect receipts afterwards with `hzcode receipt show` / `hzcode session verify`. |
| S26 | `hzcode session verify <id>` MUST be the CI gate for correctness claims: it replays the receipt chain plus the independent-evidence gate and exits `0` only when the claims are supported, and exits `3` when the verdict is `UNKNOWN` (a residual unknown effect). It MUST NOT trust the model's summary. |
| S27 | `hzcode exec` MUST NOT be a raw shell: the command goes through the same admission, policy evaluation, sandbox and receipt path as the agent's shell tool, and the result MUST include the receipt id, exit code, duration, and truncated-output marker. |
| S28 | Long-running CI jobs MUST be able to stream progress without breaking machine parsing: `--output jsonl` emits one object per line; `--progress=stderr` (default) writes human progress to stderr. `--progress=none` MUST silence it. |
| S29 | Artifacts produced by a run (patches, reports, screenshots, generated files) MUST be addressable as `hz://artifact/<sha256>` and MUST be listed in the result as `artifacts[]` with `sha256`, `bytes`, `mediaType` and `producedBy` (receipt id). |
| S30 | CI usage MUST be documented as runnable recipes in the repo (a `ci/` directory) proving: policy-gated run, budget-bounded run, `session verify` gate, JSON consumption with `jq`, and an `unknowns`-gated failure. |

### 2.3 (b) The local server

| # | Rule |
|---|---|
| S31 | `hzcode serve` MUST start (or attach to) **one leader per workspace**. The leader owns the Controller, the session store, the kernel connection, leases and the tool runner; it is the only process that mutates durable state. |
| S32 | The server MUST expose the same versioned RPC surface over four transports: JSON-RPC 2.0 over **stdio**, over a **Unix domain socket** (Windows: named pipe), over **TCP loopback**, and **HTTP** for request/response with **SSE** and **WebSocket** for streams. Transport selection MUST NOT change semantics: one method table, one error vocabulary. |
| S33 | The default bind is loopback only: `127.0.0.1` (and `::1`) on an ephemeral port, UDS at `$XDG_RUNTIME_DIR/hzcode/<workspace-hash>.sock` (fallback `~/.local/run/hzcode/…`; Windows `\\.\\pipe\\hzcode-<workspace-hash>`). Binding to any non-loopback address requires an explicit `--bind <addr>` **and** `--allow-remote`; without both, the server MUST refuse to start. |
| S34 | Discovery MUST be a registration file written by the leader at `~/.local/state/horizon/serve/<workspace-hash>.json`, containing: `id`, `version`, `proto`, `abi`, `workspace`, `pid`, `leaderPid`, `startedAt`, `urls[]` (ws/http/uds), `port`, `token`, `authMode`, `tlsFingerprint?`, `capabilities`. It MUST be `0600`, written to `<file>.<id>.tmp` and atomically renamed with bounded retries, and MUST be removed on graceful shutdown only if the leader still owns it. |
| S35 | The registration file MUST be treated as a *hint*, not as truth: a client MUST verify by connecting and calling `server.hello` and MUST compare `id`, `proto`, `pid` and workspace. A stale file MUST cause a client to start (or find) a new leader, not to trust the file. |
| S36 | Liveness: the leader MUST re-read its registration every 5 s and compare ownership (`id`, version, url, pid, token). If it has been displaced, it MUST treat itself as superseded, stop accepting new sessions, and shut down cleanly, logging the observation. |
| S37 | Concurrency of leaders MUST be arbitrated by an advisory lock file (`<workspace-hash>.lock`, `flock`/`LockFileEx`) held for the leader's lifetime; the loser MUST either attach to the winner or exit `0` with an "already served" message. A killed leader MUST leave a lock that a new leader can reclaim after a bounded stale check (pid liveness + age). |
| S38 | Auth is mandatory and has exactly three modes: **(1) local token** (default) — a per-launch 256-bit token generated at start, stored in the registration file (0600) and never logged, presented as `Authorization: Bearer <token>` for HTTP/WS or in the JSON-RPC handshake for stdio/UDS; **(2) pairing code** — a single-use, base64url, 128-bit code with a 5-minute TTL, exchangeable for a session token; **(3) OAuth/OIDC** for remote deployments (enterprise). There MUST NOT be an unauthenticated mode. |
| S39 | UDS/pipe clients that are the same user and hold the socket permission MAY be authenticated by peer credentials, but the session MUST still be bound to a client identity and MUST still be listed in `/clients`. |
| S40 | Session tokens MUST be HMAC-derived from the server secret with an expiry (default 30 days) so that rotating the secret revokes every token; tokens MUST be scope-limited (see S41). HTTP cookie names MUST include the port so two local servers on the same host cannot collide. |
| S41 | Every client MUST be given a role at connect: `observer` (subscribe only), `interactive` (prompt, answer asks, drive), `supervisor` (spawn/stop sessions, read receipts, no prompting), `automation` (scoped to declared methods only). Roles are server-enforced; methods that exceed the role MUST return `role_forbidden` with the required role in the error payload. |
| S42 | Multi-client coordination: clients subscribe with `(sessionId, cursor, lanes)` and receive a **snapshot** then incremental events. The server MUST order events by a monotonic sequence, MUST support `durable` and `ephemeral` lanes (ephemeral may be dropped, durable may not), and MUST resnapshot a client whose cursor has fallen outside the retained window instead of silently skipping events. |
| S43 | Exactly one client at a time MAY hold the **driver** lease for a session (the client whose answers and prompts are authoritative). Attempting to prompt without the lease MUST return `driver_lease_held` naming the holder; the lease MUST be claimable, releasable, and revocable by a `supervisor`, and it MUST be released on disconnect with a documented grace period. |
| S44 | An approval ask MUST be broadcast to all clients watching the session with `interactive` or `supervisor` role; the **first** answer wins, and every other client MUST receive `ask_answered` with the answering client's id. An `observer` MUST NOT be able to answer. |
| S45 | Remote-exposure safety: when `--allow-remote` is set the server MUST (1) require a token or OAuth on every connection, (2) validate the `Host` header against the configured host allowlist (DNS-rebinding defence), (3) apply a strict CORS allowlist (no `*` with credentials), (4) require a CSRF token for cookie-authenticated state-changing requests, (5) log every remote connection attempt with peer address and outcome, and (6) print a startup warning naming the exposure and how to undo it. |
| S46 | Tunnels/relays (`hzcode serve --tunnel <provider>`) MUST be opt-in, expiring (default 8 h max), scoped to one workspace, revocable with one command, listed in `hzcode config show egress`, and MUST require a token even when the tunnel provider offers "public" URLs. |
| S47 | Rate limits MUST be enforced per client and per method class (prompt/effect/read) with a token bucket, and MUST return `rate_limited` with `retryAfterMs`. Limits MUST be configurable and reported by `server.hello`. |
| S48 | Server-side request handling MUST be cancelable (`$/cancelRequest`-style) and MUST propagate cancellation to the Controller, which MUST mark the effect terminal or `UNKNOWN` — never leave a half-applied effect unreported. |
| S49 | The server MUST be the only writer of the session store for attached clients; a second `hzcode` process starting in the same workspace MUST attach rather than open the store writer. Direct database access by any client is forbidden. |
| S50 | `hzcode serve status --json` MUST report: leader pid, uptime, proto/abi, registered urls, connected clients with roles, sessions with driver holders, pending asks, unreconciled unknowns, kernel health, and the policy revision in effect. |
| S51 | Shutdown MUST be graceful and observable: on `SIGTERM`/`server.shutdown` the leader stops accepting work, waits for in-flight effects to reach a terminal state (with a bounded deadline), persists claim state so a restart is resumable rather than ambiguous, and removes its registration only if it still owns it. |
| S52 | Protocol evolution MUST be additive within `HZ_PROTO=1`: new methods and new optional fields only; removing or re-typing a field requires a revision bump and a deprecation window of at least two minor releases with a runtime warning on use. |

### 2.4 (c) The web app

| # | Rule |
|---|---|
| S53 | `@horizoncode/web` MUST be a **thin client**: it composes `@horizoncode/sdk` (generated from `packages/protocol`) and `@horizoncode/ui` primitives, and MUST NOT depend on `@horizoncode/core`, `@horizoncode/tools`, `@horizoncode/context` or the kernel client. Such a dependency MUST fail the build. |
| S54 | The web app MUST contain no domain logic (S2): no prompt assembly, no tool invocation, no policy evaluation, no diff computation, no cost calculation, no memory ranking. Every value it shows comes from a server projection; every action it offers is a server method. |
| S55 | Capability — **session list**: list, filter and sort sessions by workspace, age, cost and status (live/idle/unknown), with live sessions marked and their driver holder shown. |
| S56 | Capability — **transcript**: windowed render of the same block model as the TUI (text, thinking, tool calls, diffs, media), with folds, server-side search, copy, and provenance on every receipt-bearing element. |
| S57 | Capability — **diff review with per-hunk accept**: identical hunk model and identical semantics as `docs/13-tui.md` §2.7. Accepting a hunk MUST call the server, which submits `files.patch` through the kernel; the web app MUST NOT apply a patch, compute the result, or claim success before a receipt settles. |
| S58 | Capability — **approvals**: the same approval contract as the TUI (exact effect, effect class, origin, sandbox, policy revision, reason code, four decisions and what each persists). A decision the web app cannot render exactly MUST be disabled, exactly as in the TUI (fail closed). |
| S59 | Capability — **terminal panes (PTY bridge)**: interactive shells MUST be provided by a server-side PTY bridge over `terminal.pty`, streamed to the browser over WebSocket with explicit backpressure (bounded window, pause/resume), server-side scrollback, resize events, and the pty recorded as a child of the owning session. The PTY pair itself is kernel-owned (interface I-25 in `docs/03-hld.md`); the bridge only frames and forwards bytes and never owns the process. |
| S60 | The PTY bridge MUST NOT be a bypass: every pty is created through the kernel with `terminal.pty` (or `terminal.run` for one-shot commands) under interface I-25, is receipted, is bound to the session's workspace, and inherits the session's sandbox profile and posture. |
| S61 | Capability — **artifacts**: browse, preview (images, diffs, JSON, Markdown, logs), download with integrity (sha256) and trace back to the producing receipt and tool call. Previews of untrusted media MUST render in a sandboxed iframe with a strict CSP and a `sandbox` attribute, never inline in the app's origin. |
| S62 | Capability — **memory browser**: view the four tiers (working, episodic, semantic, team) with provenance (source session/turn/receipt), search, and actions `forget` (soft, receipted), `promote` (episodic → semantic, requires review) and `share to team` (opt-in, §2.10). The browser MUST NOT allow editing a fact without recording provenance for the edit. |
| S63 | Capability — **cost dashboard**: cost and tokens rolled up by session tree, model, day, tool and workspace, using the ledger as authority; incomplete ledgers MUST be marked and MUST NOT be zero-filled; tick-accurate integer accounting MUST be available for reconciliation. |
| S64 | The cost dashboard MUST NOT recompute prices in the browser: it renders server-provided, price-table-versioned amounts and shows the revision they came from. |
| S65 | Capability — **sharing and collaboration**: a viewer can be given a scoped, expiring, redactable link (§2.10); live sessions can be watched with presence; the app MUST show who is watching, who holds the driver lease, and whether the session is being driven elsewhere. |
| S66 | Real-time updates MUST use SSE (or WS) with the same `(cursor, lanes)` subscription model as every other client (S42); the web app MUST NOT poll the session store and MUST NOT hold a second source of truth in browser storage beyond UI preferences. |
| S67 | Client-local state (panel layout, theme, last-open tab) MAY be stored in the browser; anything that changes what a session *is* MUST be server-side. Local state that diverges MUST be discarded in favour of the server on conflict. |
| S68 | Auth: the web app authenticates with a pairing code exchanged for a session token (§3.2), stored in an `HttpOnly`, `SameSite=Strict` cookie scoped to the server port; the token MUST NOT be placed in a URL, localStorage or a service-worker cache. |
| S69 | The web app MUST enforce a strict CSP (`default-src 'self'`, no `unsafe-inline`, no `unsafe-eval`), MUST NOT load third-party scripts by default, and MUST declare each allowed origin explicitly. |
| S70 | Multi-tab behaviour MUST be coherent: two tabs are two clients; the server-visible driver lease and ask-routing rules (S43–S44) decide which tab is authoritative, and the UI MUST show when it is not the driver. |
| S71 | The web app MUST degrade offline: it MAY serve a cached shell, but every action MUST queue nothing and MUST show `disconnected` rather than pretend to work. No optimistic mutation of durable state. |
| S72 | Equality of capability: any session-management, diff-review, approval or cost capability reachable in the web app MUST also be reachable in the TUI and in print mode (`--output jsonl`), and vice versa; the difference may only be presentation (§2.11). |

### 2.5 (d) The desktop app

| # | Rule |
|---|---|
| S73 | The desktop app is Electron with a strict three-process split: **main** (OS integration only), **preload** (a narrow typed bridge) and **renderer** (the web app bundle). There MUST NOT be a fourth kind of process owning domain behaviour. |
| S74 | The renderer MUST run sandboxed with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, no `remote` module and no `enableRemoteModule` escape hatch. A preload that exposes `require`, `process` or raw IPC objects MUST fail the build. |
| S75 | The preload MUST expose a hand-written, versioned, minimal API surface (window controls, tray badge, native dialogs, deep links, updater status) with typed methods and no generic `invoke(channel, payload)` passthrough. Each method MUST validate its arguments in main. |
| S76 | Renderer content MUST be served from a custom scheme (`app://`) with a strict CSP; navigation MUST be allowlisted; `window.open` MUST be denied by default; `will-navigate` MUST block any origin outside the app. |
| S77 | The desktop app MUST talk to the agent through the local server protocol (S31–S32) exactly like the web app, either attaching to a running leader or supervising one it starts. It MUST NOT embed the Controller, call the kernel, or read the session store directly. |
| S78 | Capability — **native menus**: an application menu with the standard roles (about, quit, edit, view, window) plus agent entries (new session, resume, open workspace, approve/deny for the focused ask, show receipts, cost dashboard). Menu accelerators MUST map to the same named actions as the TUI keymap registry where an equivalent action exists, but the desktop MUST NOT invent a permission path. |
| S79 | Capability — **tray**: an icon reflecting session state (idle, working, waiting-for-approval, `UNKNOWN`, error), with a menu to open the window, jump to the pending ask, and quit; the tray MUST reflect the same state the server reports (no local inference). |
| S80 | Capability — **notifications**: native OS notifications for the events in `docs/13-tui.md` R178, with the same rate limiting, content minimisation and per-event opt-in; `include_content` MUST be off by default. Clicking a notification MUST focus the relevant session and ask. |
| S81 | Capability — **file dialogs**: open/save dialogs for workspace selection, attachments, hunk-bundle export and artifact download. A chosen path MUST be sent to the server as a declared attachment/effect request; the desktop MUST NOT write a file into a workspace on its own. |
| S82 | Capability — **auto-update**: signed manifests, digest-pinned artifacts, channel selection (`stable|beta|enterprise`), staged rollout, downgrade protection, and a user-visible update state. The app MUST NOT restart while a turn is active; it MUST defer to the next idle boundary or ask. |
| S83 | Auto-update MUST verify the signature **before** writing the artifact and MUST keep the previous version until the new one starts successfully once (rollback on first-run crash). |
| S84 | **Nested-module build rule**: the desktop lives in a nested module (`desktop/`) with its own lockfile and build, so its native/Node dependencies (Electron, node-gyp addons, notifier/clipboard/tray libraries, updater) cannot enter the CLI binary's dependency graph. A CI check MUST assert that the CLI's production dependency closure contains no desktop-module package, and that building the CLI does not install the desktop's dependencies. |
| S85 | The nested module MUST NOT be a source of duplicated logic: it may depend on `@horizoncode/sdk`, `@horizoncode/protocol` types and `@horizoncode/ui`, and MUST NOT depend on `@horizoncode/core`. |
| S86 | The desktop MUST be usable when the CLI is updated underneath it: `server.hello` reports the CLI/server version and the app MUST warn on protocol incompatibility instead of guessing. |
| S87 | Deep links (`hzcode://session/<id>`, `hzcode://receipt/<id>`) MUST be validated (scheme, shape, known ids) and MUST NOT carry authority: a link opens a view, it never approves anything. |
| S88 | Desktop-only behaviours (menus, tray, notifier, file dialogs, updater) MUST be declared as desktop projections of capabilities so the ratchet sees them; a desktop-only capability that changes agent behaviour is a design error, not an exception. |

### 2.6 (e) IDE bridge and ACP

| # | Rule |
|---|---|
| S89 | `hzcode acp` MUST implement ACP v1 over stdio with NDJSON JSON-RPC 2.0 framing: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/update` notifications, `session/request_permission`, `session/cancel`, and file/selection context messages. Unknown methods MUST return a JSON-RPC `method_not_found` error, never be ignored. |
| S90 | `hzcode ide` MUST provide the richer bridge surface (session replay, workspace secrets, attachments, follow-along, diff open) over the local server protocol with a JWT-authenticated handshake, so an editor can use either ACP alone or ACP + bridge. |
| S91 | Connecting: the editor either launches `hzcode acp` as a child process or connects a bridge client to an existing leader. In both cases the session MUST be addressable as `hz://session/<id>` and MUST be the same session the TUI and web app can attach to. |
| S92 | Capability negotiation MUST happen at `initialize`: the editor declares its capabilities (diffs, terminals, diagnostics, selection context, file read/write, notifications, elicitation forms); the agent declares its own. Every feature MUST be used only when both sides declare it, and an unsupported feature MUST produce an explicit user-visible fallback (for example "open the diff in the TUI") rather than a silent no-op. |
| S93 | Editor feature mapping (VS Code and JetBrains) MUST be declared as data in one table, not as per-editor branches in the agent. Minimum mapping: |
| | · **Diff display** — VS Code: virtual documents + `vscode.diff` + a `CodeLens`/`CommentThread` per hunk; JetBrains: `DiffManager.showDiff` + a `HighlightInfo`/intention action per hunk. Both MUST map to the same hunk ids the server exposes. |
| | · **Per-hunk accept/reject** — the editor sends a `diff.hunk.decision {sessionId, hunkId, decision}`; the server submits the `files.patch` effect; the editor renders `applied|apply_failed|unknown` from the receipt, never from optimism. |
| | · **Selection/context** — the editor may attach the current selection or file as prompt context (origin `UserAction`); it MUST NOT inject system-level instructions. |
| | · **Diagnostics** — the agent's language tooling results MAY be surfaced as diagnostics; the editor MUST NOT let an agent diagnostic be a hard block on the user's editing. |
| | · **Terminal** — the editor's terminal may host the agent's pty output read-only; interactive pty in-editor requires the editor's terminal capability to be declared. |
| | · **Follow-along** — the editor MAY scroll to or open files the agent is reading/writing, gated by a user setting and never silently. |
| S94 | Permission proxying: an ask MUST be rendered in the editor with the same content contract as the TUI approval card (exact effect, effect class, origin, sandbox, policy revision, reason code, and the same four decisions with the same persistence semantics). The editor is a *renderer* of the ask, not a policy authority. |
| S95 | An editor MUST NOT be able to answer an ask without an explicit user interaction; an auto-answer, a remember-my-last-answer default, or a "silent allow" from the editor MUST be refused by the server (error `client_policy_forbidden`). |
| S96 | If the editor cannot render the exact effect (S94), the ask MUST be answered `deny` with reason code `unrenderable_ask` and the user MUST be offered the terminal fallback that can render it. Fail closed. |
| S97 | Session replay after a leader crash: the bridge MUST maintain a replayable client state — the `initialize` parameters, every `session/new`/`session/load`/`session/resume` it performed, the last `cursor` per session, and the client's declared capabilities. On reconnect it MUST perform a fresh handshake and re-issue the cached session operations, **swallowing only the responses to replayed requests** while forwarding all notifications, re-subscribe each session from its last cursor (I-02), then emit the ACP extension notification `hz/reconnected` with the recovered session ids. |
| S98 | Replay MUST NOT re-run any prompt, re-admit any input, or duplicate any effect: the cached set covers session *attachment* only. A session whose state cannot be recovered MUST be marked `partial` in the reconnect notification with the reason, and the editor MUST surface it. |
| S99 | Replay state MUST be bounded (a configurable maximum number of cached sessions and bytes) and MUST be dropped on explicit session close. It MUST NOT contain credentials, file contents, or transcript text beyond ids and cursors. |
| S100 | The bridge MUST NOT hold durable state that the leader lacks: if a crash loses replay state, the editor MUST still be able to list and re-attach to sessions from the store. |
| S101 | What the editor is **not** allowed to do, enforced server-side and tested: |
| | (1) execute a tool or an effect directly — it may only request a prompt or a hunk decision; |
| | (2) evaluate or alter policy, posture, grants or sandbox profile; |
| | (3) write, delete or move a file in the workspace except through the agent's tools; |
| | (4) approve an ask on the user's behalf without an explicit interaction (S95); |
| | (5) add, remove or redefine tools, agents, skills or providers; |
| | (6) read receipts, artifacts or memory beyond the scopes granted to its client role; |
| | (7) present its own messages as system/authority-origin — editor context is `UserAction` origin at most; |
| | (8) suppress a barrier: asks, budget exhaustion and unreconciled `UNKNOWN` MUST be shown even if the editor hides the panel. |
| S102 | Detect-and-report: if an editor violates S101, the server MUST refuse with a typed error, log the attempt to the session's operations log, and increment a visible counter in `hzcode doctor --json`. |
| S103 | The IDE surface MUST NOT be a privileged path to session lifecycle: creating, forking, rewinding or deleting sessions from an editor MUST use the same methods, the same `session.manage` capability and the same receipts as every other surface. |
| S104 | ACP terminals and elicitation MUST be capability-gated: `ask_user` questions may be rendered as editor forms only when the editor declares elicitation support; otherwise the ask MUST fall back to the terminal/TUI path and the editor MUST show where it went. |
| S105 | The bridge MUST support workspace secrets by reference only: the editor may name a secret for a request, but the value MUST stay in the vault and MUST never transit the editor. Secret names used MUST appear in the receipt's redacted metadata. |
| S106 | Attachments from the editor (file, selection, image) MUST be validated (size, type, path within workspace unless explicitly allowed) and hashed into `hz://artifact/<sha256>` before entering a prompt, so the prompt's content is reproducible. |
| S107 | The IDE surface MUST be tested against at least two real hosts (VS Code and one JetBrains IDE) with a shared conformance suite exercising: connect, negotiate, prompt, ask render, hunk accept, crash-and-replay, and role restrictions. |
| S108 | Disconnecting MUST be safe: closing the editor MUST release the driver lease, leave the session resumable, and MUST NOT cancel an in-flight effect silently — a cancel must be explicit or the effect settles normally. |

### 2.7 (f) MCP server mode

| # | Rule |
|---|---|
| S109 | `hzcode mcp serve` MUST expose HorizonCode over MCP so other agents and systems can drive it: tools, resources and prompts, over stdio (default) or streamable HTTP (interface I-27 in `docs/03-hld.md`). |
| S110 | Exposed **tools** MUST be an explicit allow-list (default: read-only tools only). Each exposed tool keeps its real capability ID, effect class and declarations; the MCP name is a stable alias, and an alias MUST NOT change the effect class. |
| S111 | Mutating tools MUST be off by default. Enabling one MUST require an explicit configuration entry naming the tool, the workspace scope, and the posture it may run under; the MCP caller's authority is always a **subset** of the user's (ADR-008 lattice meet). |
| S112 | Posture defaults for `mcp-server`: sandboxed workspace-write is OFF, network is OFF, credential access is OFF, host writes outside the workspace are OFF, subagent spawning is OFF, and time/token budgets are capped (defaults: 30 minutes wall, 200 k tokens per MCP session) with the cap reported in the MCP server's capability metadata. |
| S113 | Exposed **resources** MUST be `hz://` URIs: at minimum `hz://session/<id>` (transcript projection), `hz://receipt/<id>`, `hz://artifact/<sha256>`, `hz://session/<id>/diff`, and `hz://memory/<tier>`. Resources MUST be read-only and access-scoped to the calling client. |
| S114 | Resource subscriptions MUST be supported for session events; a subscriber gets the same durable/ephemeral lane semantics as every other client (S42) and MUST be told when its cursor is too old (resnapshot), never silently skipped. |
| S115 | Exposed **prompts** MUST come from the same registry as the TUI slash commands (skills, custom commands, built-ins) with a declared safe subset: a prompt that would require an interactive approval MUST NOT be exposed, and exposing it MUST be refused at config load. |
| S116 | Every MCP tool call MUST be admitted as a session-scoped batch with a non-human origin (`ManagedRun`, or a dedicated session bound to the calling client). An MCP caller MUST NEVER be represented as `UserAction` — a model-originated batch must not be able to present itself as human authority. |
| S117 | Every MCP tool call MUST be receipted with the client id, the MCP session id, the capability ID and the effect class. The MCP response MUST include the receipt id so the caller's own audit trail can link to it. |
| S118 | Auth: stdio inherits the process boundary and still binds a client identity; HTTP transport MUST require a token or OAuth; each client MUST have a scoped token (client id + tool allow-list + workspace + expiry) and MUST appear in `/clients` with its scope. |
| S119 | An MCP caller MUST NOT be able to read another client's session, another workspace's artifacts, or any receipt outside its granted scope; cross-scope reads MUST return `not_found` (not `forbidden`) to avoid leaking existence. |
| S120 | Rate limits and budgets MUST be per MCP client, and MUST be reported to the caller as MCP errors with the budget name that was exhausted. |
| S121 | The MCP server MUST fail closed on any capability it cannot attribute: an unknown tool requested by name, an unparseable call, an attempt to use a resource URI with a scheme it does not own ⇒ typed error, no side effect. |
| S122 | Being an MCP server is what makes HorizonCode usable as **infrastructure**: a CI job, a review bot, another agent, or an IDE can call the same capability surface, and every call lands in the same receipt chain, so the caller's claim can be verified with `hzcode session verify` rather than believed. |
| S123 | The MCP server MUST publish its capability metadata (exposed tools with effect classes, resources, prompts, budgets, auth mode, protocol revision) at handshake, and MUST NOT advertise a tool it would refuse to run. |
| S124 | MCP client mode must remain independent: configuring an outbound MCP server MUST NOT change the posture, tool allow-list or budgets of the inbound MCP server. Two directions, two configurations, two audit trails. |

### 2.8 (g) SDKs

| # | Rule |
|---|---|
| S125 | SDKs MUST be **generated** from the single protocol source (I-30 in `docs/03-hld.md`): `packages/protocol` plus the `hz_abi` bound (JSON-Schema/type definitions) → `hz_codegen` → TS (`@horizoncode/sdk`), Python, Go and Rust clients, plus the JSON-RPC method table, the error catalog and the event union. |
| S126 | Generation MUST be deterministic: the same input produces byte-identical output, and a CI drift check MUST fail when a committed generated file differs from a fresh generation. Generated files MUST carry a `generated — do not edit` header with the source revision. |
| S127 | SDKs MUST be thin: connect/attach, request/response, streaming subscription, cancellation, typed errors, and `hz://` URI helpers. They MUST NOT contain prompt construction, policy decisions, retries that change semantics, or client-side defaults that differ from the server's. |
| S128 | Compatibility guarantee: within `HZ_PROTO=1` (major), changes are additive only; SDKs MUST silently accept unknown fields and unknown event kinds (forward compatibility), and MUST surface them to the caller through an `unknown` escape hatch rather than crashing. |
| S129 | A method or event removed in a new major MUST be deprecated for at least two minor releases in the old major, with a runtime deprecation notice emitted by the client on use and a documented migration note. |
| S130 | A conformance suite MUST run the same scripted session against a fixture server through every SDK: connect, hello, create session, prompt, stream events, answer an ask, accept a hunk, read a receipt, handle an `UNKNOWN`, cancel, and disconnect. All four SDKs MUST pass it. |
| S131 | SDK auth MUST use the same modes as the server (token, pairing code, OAuth); an SDK MUST NOT implement an unauthenticated convenience path. |
| S132 | SDKs MUST expose the same exit-relevant facts the CLI does: `unknowns[]`, `denials[]`, `costIsPartial`, `usage_is_incomplete`. A caller MUST NOT have to parse prose to detect a non-success outcome. |
| S133 | SDK retries MUST be opt-in, MUST be limited to idempotent reads and to requests explicitly declared idempotent, and MUST NOT retry an effect that could have been applied. `UNKNOWN` MUST be surfaced to the caller (S9). |
| S134 | Embedding example (TS, in-process): start a Controller with a workspace, subscribe to events, call `session.prompt`, render tool calls, and assert on receipts — with no HTTP server involved (`@horizoncode/sdk` may compose the local server in-process, mirroring the SDK composition rule of the reference repos). |
| S135 | Embedding example (CI, Python): run a bounded prompt with a token budget, then call `session.verify` and fail the job when the verdict is unsupported or when `unknowns` is non-empty. |
| S136 | Embedding example (Go service): attach to a running leader via the registration file, subscribe to a session, and expose an approval endpoint that proxies a `permission.answer` with the same decision vocabulary. |
| S137 | Embedding example (Rust runner): drive `hzcode exec` over stdio JSON-RPC, including cancellation, and map `reason_code`s to the host application's error taxonomy. |
| S138 | SDK docs MUST be generated from the same source as the code (signatures, schemas, examples compiled in CI), so documentation drift is a build failure. |
| S139 | Each SDK MUST be independently installable and versioned in lockstep with the protocol revision it targets (`sdk 1.x` ⇒ `HZ_PROTO=1`); the version mapping MUST be published in the SDK README and asserted by the conformance suite. |
| S140 | The SDKs MUST NOT be a second implementation of the agent: no SDK may embed a prompt orchestrator, a context compiler or a tool executor, even to be "convenient". |

### 2.9 (h) Mobile and remote supervision

| # | Rule |
|---|---|
| S141 | Remote supervision MUST be a **web-app capability, not a new client**: the web app MUST be a responsive PWA reachable from a phone against the user's own server (directly on the LAN, through an SSH port-forward, or through an opt-in tunnel with auth). |
| S142 | The mobile view MUST support: approve/deny with the full approval contract (exact effect, decisions and persistence), view live progress (step, tool, elapsed, cost, tokens), read the transcript, see and act on `UNKNOWN`, and receive notifications. |
| S143 | The mobile view MUST NOT be a reduced-authority path: what it can approve it approves with the same records and the same limits as the desktop (S58, S94). |
| S144 | Mobile approval MUST be deliberate: the approve control MUST require an explicit tap on the named decision (never a swipe-to-approve, never a default-focused allow), and a long-press or copy action MUST show the exact effect for verification. |
| S145 | Mobile MUST NOT enable, by default: shell/PTY panes, bulk hunk accept, policy editing, or secret management. Each may be enabled explicitly, and each MUST be listed in `/doctor` as a device capability. |
| S146 | Notifications to a phone MUST use the notification service the user configured (web push through the user's own server, an OS notification relay, or a webhook), MUST carry no transcript content by default, and MUST be disableable per event kind (parity with `docs/13-tui.md` R177–R182). |
| S147 | Remote supervision MUST respect `--offline` and MUST be reported by `hzcode config show egress`; no cloud component is required for any of it (ADR-013). |
| S148 | A supervising device MUST appear in presence and in the session's operations log with its client id and role, so "who approved this" is answerable. |

### 2.10 (i) Collaboration and sharing

| # | Rule |
|---|---|
| S149 | Sharing MUST be explicit and scoped: a share grant is a signed token with (session scope, artifact scope, receipt scope, expiry, redaction profile, viewer identity) and MUST be revocable immediately (revocation checked on every request, not cached beyond one request). |
| S150 | Share links MUST be redactable: the default profile strips secrets and environment values, credentials, absolute home paths, file contents outside declared allow-paths, and any content marked sensitive by the session. The profile used MUST be recorded on the grant and shown to the sharer. |
| S151 | A share link MUST NEVER grant execution: viewers may read, comment and (if granted) watch live, but approving, prompting, hunk-accepting and shell access MUST be refused for share tokens. |
| S152 | Shared content MUST be served with integrity: artifacts by sha256, receipts by id and digest, and the response MUST state the redaction profile that was applied. |
| S153 | Live sessions: watching a session MUST use the same subscription model (S42), and a viewer MUST be marked as an `observer` client in `/clients` with its presence visible to other participants. |
| S154 | Presence MUST be real: heartbeat-based, expiring (default 30 s), and MUST show role (driver, observer, supervisor) per session. Presence MUST NOT be inferred from read receipts. |
| S155 | Follow mode (a viewer's viewport following the driver) MUST be explicit, per-viewer, and cancelable by the viewer at any moment; it MUST NOT move a viewer's scroll position silently while they are reading a diff. |
| S156 | Comments MUST be anchored to durable ids (session/part/receipt/hunk id), MUST NOT be editable by viewers into agent instructions, and MUST NOT enter the model's context unless a human explicitly promotes them into a prompt (origin `UserAction`). |
| S157 | Team memory sync MUST be opt-in per workspace, MUST preserve provenance on every shared fact (source session, turn, receipt, and the profile that redacted it), and MUST record the sync as a receipted operation on the exporting side. |
| S158 | Team sync conflicts MUST be resolved by review, never by an automatic destructive merge: conflicting facts from two machines MUST both be retained with their provenance and flagged for a human decision. |
| S159 | Secrets MUST NOT enter team memory: any fact classified `credential` or matching the secret scanner MUST be rejected at the sync boundary with a diagnostic, not silently redacted into a half-fact. |
| S160 | Publishing an artifact out of the team (an external share) MUST be a distinct, receipted action that names the destination, and MUST be refused for artifacts produced from `credential`-class effects. |
| S161 | Collaboration surfaces MUST be subject to the same parity rules (§2.11): a collaboration state that only the web app can render MUST fail the ratchet unless the TUI declares an equivalent (for example, a presence line in the status bar). |
| S162 | Every shared read and every revoked link MUST be logged locally (who, what scope, when, and the grant id) and MUST be visible in `hzcode doctor --json` under `sharing`. |

### 2.11 (j) The parity ratchet

| # | Rule |
|---|---|
| S163 | Capabilities MUST be declared in one registry with explicit **surface projections**: for each capability, which of the eight surfaces exposes it and how (`render`, `output-kind`, `rpc-method`, `sdk-method`, `declared-absent-with-reason`). For tools, the per-tool `renderers` field of `ToolDeclarationV1` (`docs/05-domain-and-schemas.md`) is the projection source the ratchet reads. |
| S164 | The ratchet MUST compute reachability statically per surface: the CLI's command/method dispatch tables, the server's method registry, the web/desktop view routes, the IDE bridge's negotiated feature table, the MCP exposure list, and the generated SDK surface. A capability reachable only through dynamic string building MUST be rejected by the linter (it cannot be counted). |
| S165 | The ratchet MUST fail the build when: (a) a capability has a projection on surface A but neither a projection nor a declared-absent reason on surface B, where both declare support for that capability family; (b) a capability is reachable in a surface without a registry row; (c) a surface exposes a capability marked `no-surface-projection`; (d) a declared-absent reason is missing, empty, or lacks an owner and expiry. |
| S166 | The ratchet MUST treat the TUI as the **reference set** and MUST report a diff (not a failure) when another surface strictly exceeds it, with a warning that the TUI projection is missing. |
| S167 | Exceptions: `parity-exceptions.toml` entries MUST carry `capability`, `surface`, `reason`, `owner`, `issue` and `expires` (ISO date, ≤ 90 days). An expired exception MUST fail the build; an exception without an owner MUST fail the build. |
| S168 | Debt MUST only decrease: the ratchet keeps a `baseline.json` of current gaps, and a PR that adds a gap MUST fail even if the total is under the previous count. Removing gaps MUST update the baseline in the same PR. |
| S169 | True input-modality differences (mouse capture, terminal size, tray, native menus, editor-native diff rendering) MUST be declared as `modal-equivalent` mappings naming the equivalent affordance on surfaces that lack the modality — never as a blanket exemption. |
| S170 | Adding a capability MUST land its projections in the same PR: TUI renderer (or a declared NA), output kind, server method, SDK method, and the capability matrix row (§3.1). The build MUST fail on a missing projection. |
| S171 | The ratchet MUST also check the *converse* direction of drift: a server method or SDK method with no registry row, an event kind with no `docs/13-tui.md` §3.2 row or `jsonl` kind, and an MCP-exposed tool not present in the registry. |
| S172 | The ratchet MUST run in CI on every PR and MUST be runnable locally (`hzcode parity check --json`), producing a machine-readable report listing gap, surface, owner, and the fix hint. |

### 2.12 (k) Compaction UX, bulk review and preview (NF-062, NF-055)

> Adopted 2026-11-07 from [29-final-audit.md](./29-final-audit.md) Part D (RC-15).

1. **Compaction UX metrics:** before/after/saved tokens, manual compaction CTA, busy-guard disabling — with the baseline captured **before** the request (the condense POST can only return after the server emitted its event).
2. **Bulk review (NF-062):** Keep All / Undo All over per-hunk review, both receipted (`files.patch` under the review lease).
3. **Preview surface (NF-055):** the bound preview URL is displayed per session; opening/refreshing is a surface action, never authority.

### 2.13 (l) Observability affordances (RC-15)

> Adopted 2026-11-07 from the adoption wave (`30-steal-list.md` §2 I; sources A.9.4 aider, A.9.5 mini-swe-agent).

1. **Prompt inspection:** a surface MUST be able to dump the exact rendered message list and exit **without a provider call** (`--show-prompts`-class); prompt behaviour is never debugged by guesswork.
2. **Per-chunk context cost table:** a `/tokens`-class view lists each context chunk with its token count, a `$` figure, and a remediation hint per row (which command frees it).
3. **State externalisation:** `--show-repo-map`- and `/settings`-class flags print the exact state the harness sent; a local-only analytics log records events without any network call.
4. **Batch progress answers "broken or slow?":** per-status histogram, ETA and running cost while a batch runs; in a **batch** run Ctrl-C **drains** in-flight work instead of discarding results already paid for (`docs/13-tui.md` R45 governs the interactive case, where Ctrl-C is graded: once interrupts the turn, three times exits 130 — not an injected message).
5. **No prompt without a TTY:** unattended runs degrade to a saved `LimitsExceeded` trajectory rather than an interactive prompt or a crash.

---

## 3. Interfaces

### 3.1 Surface capability matrix

> **DESIGN TARGET, not a description of the product.** Only the TUI, print and server columns correspond to any code, and each is partial (see the table in the Provenance section). Commands named in cells (`session diff --json`, `receipt show`, `session verify`, `policy list`, `parity check --json`, `session tree --json`, `share create`, `usage`) are not implemented. In particular the print column's `partial (--resume, --continue)` is only `--continue`/`--resume` for chat, and `-p` does not take a session id.

Legend: **full** = native affordance; **partial** = available in a constrained form (see the reason); **deleg.** = reachable by delegating to another surface (e.g. MCP exposes a resource instead of a UI); **none** = deliberately absent, with the reason given; **n/a** = not meaningful for that surface. All rows are `DESIGNED`; the ratchet (§2.11) is what keeps them honest.

| Capability | TUI | print | server | web | desktop | IDE | MCP | SDK |
|---|---|---|---|---|---|---|---|---|
| Prompt + streaming output | full | full | full | full | full | full | partial (as a `hz_prompt` tool) | full |
| Approval / permission answering | full | partial (policy flags only, `ask`⇒deny) | full | full | full | full (proxied, explicit click only) | none (a caller is not a human) | full |
| Diff review with per-hunk accept | full | none (no affordance; export via `session diff --json`) | full | full | full | full (editor-native diff, same hunk ids) | none | full |
| Session list / resume | full | partial (`--resume`, `--continue`) | full | full | full | partial (list + attach) | partial (`hz_session_*` tools) | full |
| Fork / rewind / archive / delete | full | partial (flags) | full | full | full | partial (fork only; rewind requires confirmation in TUI/web) | none | full |
| Receipt inspection and `session verify` | full | full (`receipt show`, `session verify`) | full | full | full | partial (ask provenance only) | partial (`hz://receipt/<id>`) | full |
| Cost and token dashboards | full | partial (`usage` in JSON) | full | full | full | partial (per-turn cost line) | partial (`hz://session/<id>/usage`) | full |
| Memory browser (four tiers, provenance) | full | partial (CLI list/recall) | full | full | full | none (no editor affordance; opens the web app) | partial (`hz://memory/<tier>`) | full |
| Terminal panes / PTY | full | partial (one-shot `exec`) | full | full | full | partial (read-only output pane) | none (never an unattended pty) | partial (attach streams) |
| Artifacts (list, preview, download) | full | full (paths + sha256 in result) | full | full | full | partial (open in editor) | partial (resources) | full |
| Collaboration / presence / comments | partial (presence line, comments modal) | none | full | full | full | none | none | full |
| Share links (create, revoke, redaction) | partial (create/revoke via `/share`) | partial (`share create`) | full | full | full | none | none | full |
| Mobile / remote supervision | none (a terminal is not a phone) | none | full (serves it) | full | full | none | none | partial |
| Session tree (parent/child, cost roll-up) | full | partial (`session tree --json`) | full | full | full | partial | partial | full |
| Policy and posture inspection | full | full (`policy list`, posture in JSON) | full | full | full | partial (read-only chip) | none (callers cannot see or change policy) | full |
| Grant create / revoke | full (approval card) | partial (CLI) | full | full | full | partial (ask only) | none | full |
| Budgets (set, observe, exhaust) | full | full | full | full | full | partial (observe) | partial (per-call caps, reported) | full |
| `UNKNOWN` visibility and reconciliation | full | full (`unknowns[]`, exit code) | full | full | full | partial (banner + link) | partial (error field) | full |
| Notifications (bell, desktop, web push, webhook) | full | partial (stderr only) | full (webhooks) | full (web push) | full (native) | partial (editor notification) | none | full |
| Workflow / scheduler management | full | partial | full | full | full | none | partial | full |
| Skills, plugins, marketplace | full | partial | full | full | full | none | none (exposure is config, not runtime) | full |
| Model / provider selection | full | full | full | full | full | partial | partial | full |
| Voice input (STT/TTS) | full | none | partial (host-dependent) | partial (browser mic) | full | none | none | partial |
| Attachments and media | full | partial (paths in prompt JSON) | full | full | full | partial (editor attachments) | partial | full |
| Compaction control (trigger, strategy) | full | partial | full | full | full | none | none | full |
| Self-improvement proposals review | full | partial | full | full | full | none | none | full |
| Remote execution (SSH, containers, WSL) | full | partial | full | full | full | none | partial | full |
| Doctor / diagnostics bundle | full | full (`doctor --json`) | full | partial (renders the report) | full | partial | partial | full |
| MCP client configuration | full | partial | full | full | full | none | n/a | full |
| Parity ratchet report | partial (modal) | full (`parity check --json`) | full | partial | partial | none | none | partial |

### 3.2 Protocol, auth and exit codes

| Transport | Used by | Framing | Auth | Notes |
|---|---|---|---|---|
| in-process | TUI, print, SDK (in-process mode) | direct call | n/a (same process) | still goes through the Controller's command surface |
| stdio | `hzcode acp`, supervisors, `hzcode exec` clients, MCP stdio | NDJSON JSON-RPC 2.0 | process boundary + handshake client id | no discovery needed; one client per pipe |
| Unix domain socket / named pipe | local tools, IDE bridge, SDKs | length-prefixed JSON-RPC 2.0 | per-launch token or peer credentials (S39) | path is a discovery hint, verified by `server.hello` |
| TCP loopback | web app, desktop, SDKs, tests | JSON-RPC 2.0 over WS, or HTTP per request | per-launch token, pairing code, session token | default `127.0.0.1:0`; non-loopback requires `--allow-remote` |
| HTTP + SSE | web app, dashboards, CI observers | one request per call; SSE for streams | bearer/session cookie + CSRF for cookies | read-mostly; mutating calls go through the same methods |
| WebSocket | web app (PTY bridge, live streams) | JSON-RPC frames + binary pty frames | bearer/session token at connect | bounded send window; server pauses the pty on pressure |
| tunnel/relay | remote supervision | transport-dependent | always token/OAuth | opt-in, expiring, listed in egress |

Method families (complete list lives in `packages/protocol`; this table fixes the shape and the capability each family carries):

| Family | Methods (abridged) | Capability ID | Mutating |
|---|---|---|---|
| auth | `auth.pair`, `auth.session.revoke` | `session.manage` (pairing needs only the code itself) | yes (revoke) |
| server | `server.hello`, `server.capabilities`, `server.shutdown`, `server.subscribe` | `session.manage` (shutdown: `session.manage` + explicit supervisor role) | no (shutdown: yes) |
| session | `session.list`, `session.create`, `session.prompt`, `session.cancel`, `session.fork`, `session.rewind`, `session.delete`, `session.subscribe`, `session.verify` | `session.manage` | mixed |
| transcript | `transcript.window`, `transcript.search`, `transcript.export` | `files.read` (session projection) | no |
| diff | `diff.list`, `diff.plan`, `diff.hunk.decision`, `diff.exportBundle` | `files.patch` (decision), `artifact.write` (export) | yes (decision) |
| approval | `permission.answer`, `permission.pending`, `permission.history` | answering an ask: **`UNKNOWN`** — no registered capability ID exists (a decision is `UserAction` origin, not a capability the asker holds); the reads carry `session.manage` + client role `interactive` | yes |
| receipts | `receipt.list`, `receipt.get`, `receipt.verify` | `files.read` (ledger read) | no |
| artifacts | `artifact.list`, `artifact.get`, `artifact.put` | `artifact.write` | put only |
| memory | `memory.list`, `memory.search`, `memory.forget`, `memory.promote`, `memory.share` | `memory.read` / `memory.write` | yes (write ops) |
| terminal | `terminal.create`, `terminal.attach`, `terminal.input`, `terminal.resize`, `terminal.close` | `terminal.pty` | yes |
| policy | `policy.list`, `policy.grants`, `policy.revoke` | `policy.list`: `session.manage`; `policy.grants`/`policy.revoke`: **`UNKNOWN`** — no registered mutation ID for policy or grants | yes (revoke) |
| usage | `usage.session`, `usage.tree`, `usage.dashboard` | `files.read` | no |
| clients | `clients.list`, `clients.role`, `clients.driver.claim`, `clients.driver.release` | `session.manage` | yes |
| sharing | `share.create`, `share.revoke`, `share.list` | `collab.manage` `[planned]` (reserved in `_conventions.md` §5; promoted when sharing lands) | yes |
| diagnostics | `doctor.report`, `parity.report`, `bench.report` | `files.read` | no |

Capability IDs in this table come from `_conventions.md` §5 and nothing else — no wildcard (`share.*`) and no borrowed ID. Where no registered ID fits, the cell says **`UNKNOWN`** rather than substituting a read-only ID: answering an ask and mutating policy/grants fall into that class today, and the registry entry (plus the effect class it implies) MUST be added to `_conventions.md` §5 before either is implemented (R-ops-74; RC-11 reserved-then-promote), with this table updated in the same change.

Alignment with the system interfaces (`docs/03-hld.md`): every **command** method above is a thin wrapper over an I-01 surface command (`submit`, `cancel`, `approve`, `answer`, `setPosture`, `compact`, `fork`, `rewind`, `attach`, `detach`); every **stream** method is a subscription over I-02 (`log({ after })`, addressed by `hz://session/<id>` with a monotonic cursor, replayable by cursor); no method may bypass I-03 to reach the kernel, and no surface may write the log (E-17 in `docs/06-events-and-flows.md`).

Auth matrix:

| Mode | Where allowed | Secret handling | Failure |
|---|---|---|---|
| per-launch token | stdio/UDS/TCP/HTTP/WS on this machine | 256-bit, stored only in the `0600` registration file, never logged; rotated per launch | `401 unauthorized`; connection closed after the failed handshake |
| pairing code | browser/desktop/mobile first connect | 128-bit base64url, single use, 5-minute TTL, exchanged for a session token | `401 pairing_expired` / `pairing_consumed` |
| session token | browser/desktop/mobile subsequent | HMAC over expiry with the server secret; rotating the secret revokes all | `401 session_revoked` / `session_expired` |
| OAuth/OIDC | remote/enterprise deployments | provider tokens; mapped to a client id + role | `401` / `403 role_forbidden` |
| peer credentials | UDS/pipe, same user, socket `0600` | no secret in transit | `403 peer_mismatch` |

Exit codes (canonical for every surface, referenced by `docs/13-tui.md` §2.17):

| Code | Meaning | Emitted by |
|---|---|---|
| 0 | success | all |
| 1 | error (provider, tool, storage, internal) | all |
| 2 | usage, configuration or environment error: bad flags, invalid keybindings/theme, unusable config, terminal too small, unusable workspace or session store, unsupported protocol revision | all |
| 3 | **fail-closed** — the outcome cannot be proven or guaranteed: kernel absent or ABI-mismatched while a mutation was required, an `ask` with no answerer (`noninteractive_ask` / `no_interactive_client`), an unreconciled `UNKNOWN` (also the `hzcode session verify` verdict `UNKNOWN`), a requested guarantee the sandbox cannot make | all |
| 4 | **policy denial** — `Guard` returned `DENY` for a requested effect and the run stopped (`denials[]` populated) | all |
| 5 | budget exhaustion (tokens, steps, wall clock, cost, triage, web search) | all |
| 130 | interrupted by SIGINT | TUI, print, server |
| 143 | terminated by SIGTERM | all |

Codes `3` and `4` are deliberately distinct: `3` means *the tool cannot prove what happened or cannot guarantee the requested effect*, `4` means *policy said no*. Both are non-success, neither is ever reported as `0`, and `--allow-unknown` downgrades only the `UNKNOWN` case of `3` — never a denial and never a kernel-absence refusal. This matches `docs/06-events-and-flows.md` (kernel absent/older/mismatched digest ⇒ read-only + exit code 3 in headless; a residual unknown ⇒ `session verify` = `UNKNOWN` ⇒ exit code 3).

### 3.3 `ExecResultV1`

> **DESIGN ONLY: NOT IMPLEMENTED.** `hzcode -p --output-format json` prints a different, smaller object, `PrintResult` in `app/src/tui/print.ts`: `{type:"result", result, sessionId, exit:{terminal, detail?, code}, usage, toolCalls, changedFiles}`. `ExecResultV1` below describes ONE shell execution; the two must not be confused. Deferral note G13.

| Field | Type | Notes |
|---|---|---|
| `command` | string (normalized argv) | The normalized form the kernel evaluated, not the raw string |
| `exitCode` | integer \| null | null when the process was killed by a signal |
| `signal` | string, optional | e.g. `SIGKILL` (cgroup OOM), `SIGSEGV` |
| `stdoutRef` / `stderrRef` | string | `hz://artifact/<sha256>`; inline only under a byte threshold |
| `truncated` | object | the `truncated` object of `docs/09-tools.md` R-tools-43 — `{ reason, omittedBytes, omittedLines, nextOffset, artifactUri? }` — owned there and referenced here, never re-shaped |
| `receiptId` | string | `hz://receipt/<id>` |
| `terminalState` | enum | the RC-7 terminal vocabulary, lowercase and verbatim: `succeeded` \| `failed` \| `denied` \| `cancelled` \| `unknown` \| `budget_exhausted` \| `timeout` \| `interrupted` |
| `reasonCode` | string, optional | Present for `denied` and `unknown` |
| `sandbox` | object | `{ mode, residuals[] }` — typed residuals, never silent degradation |
| `durationMs` | number | Wall clock |
| `resources` | object, optional | peak RSS, CPU time when cgroup accounting is available |

### 3.4 Discovery file

```json
{
  "id": "01J9Z6W8H9T3Q4V5R7S8P2M4K6",
  "version": "0.1.0",
  "proto": 1,
  "abi": 1,
  "workspace": "`repo` (repo not cloned, path not verified)",
  "pid": 41231,
  "leaderPid": 41231,
  "startedAt": "2026-11-06T10:41:07Z",
  "port": 51873,
  "urls": ["http://127.0.0.1:51873", "ws://127.0.0.1:51873/rpc", "unix:/run/user/1000/hzcode/9f3c1a2b.sock"],
  "authMode": "token",
  "token": "<256-bit base64url, file mode 0600>",
  "tlsFingerprint": null,
  "capabilities": ["session", "diff", "permission", "terminal", "usage", "sharing"],
  "limits": { "maxClients": 32, "rateLimitPerMin": 600 }
}
```

Rules: file mode MUST be `0600`; the directory MUST be `0700`; the file MUST be replaced atomically; clients MUST verify with `server.hello` before using it (S35); `token` MUST be treated as a secret by every reader and MUST NOT be copied into logs, crash reports or bug reports (`hzcode doctor` redacts it).

### 3.5 MCP exposure

| MCP surface | Exposed items | Default | Notes |
|---|---|---|---|
| tools | `hz_read`, `hz_grep`, `hz_glob`, `hz_repo_map`, `hz_code_index`, `hz_verify`, `hz_receipt_get`, `hz_session_list`, `hz_session_get`, `hz_prompt` (gated) | read-only set enabled; mutating tools disabled | each maps to a real tool with the same capability ID and effect class |
| tools (gated) | `hz_write`, `hz_edit`, `hz_patch`, `hz_shell`, `hz_test`, `hz_container` | disabled | enabling requires an explicit config entry with workspace scope |
| resources | `hz://session/<id>`, `hz://session/<id>/diff`, `hz://session/<id>/usage`, `hz://receipt/<id>`, `hz://artifact/<sha256>`, `hz://memory/<tier>`, `hz://skill/<name>`, `hz://tool/<name>` | enabled for the caller's scope | read-only; subscriptions for session events; URI resolution per I-29 |
| prompts | skills and custom commands from the slash registry, marked `safe-for-mcp` | enabled for the safe subset | interactive-approval prompts excluded (S115) |

Handshake metadata MUST include: protocol revision, exposed tools with `effectClass` and `capabilityId`, resources, prompts, budgets, auth mode, and the posture the server will enforce. The MCP server MUST NOT advertise anything it would refuse to run (S123).

### 3.6 SDK surface mapping

| Concept | TS | Python | Go | Rust |
|---|---|---|---|---|
| client | `HorizonClient` | `HorizonClient` | `hzclient.Client` | `horizoncode::Client` |
| types | generated interfaces | generated dataclasses | generated structs | generated structs |
| streaming | `AsyncIterable<Event>` | `Iterator[Event]` | channel | `Stream<Item = Event>` |
| errors | `HorizonError` with `code`/`reasonCode` | `HorizonError` | `*hz.Error` | `Error` enum |
| cancellation | `AbortSignal` | `cancel()` | `context.Context` | `CancellationToken` |
| URI helper | `hz.session(id)` | `hz_session(id)` | `hz.Session(id)` | `hz::session(id)` |

## 4. Data

| Store | Location | Written by | Contents |
|---|---|---|---|
| registration | `~/.local/state/horizon/serve/<workspace-hash>.json` | leader only | S34 fields |
| lock | `~/.local/state/horizon/serve/<workspace-hash>.lock` | leader only | advisory leader exclusion (S37) |
| client registry | server memory + `…/clients.json` snapshot | leader only | client id, role, transport, first/last seen, scopes, presence expiry |
| share grants | `~/.local/state/horizon/sharing/grants.json` + signing keys in the vault | leader only | grant id, scope, expiry, redaction profile, revocation state |
| desktop prefs | `~/Library/Application Support/horizon-desktop/` (OS-conventional) | desktop main | window geometry, tray prefs, update channel, notification prefs |
| web prefs | browser localStorage | web app | layout, theme, last tab (S67) |
| IDE replay cache | editor-managed tmp dir, mode `0600` | bridge | S97 fields (ids and cursors only) |
| MCP client scopes | `~/.config/horizon/mcp-server.toml` | user | client id, tool allow-list, workspace, expiry |
| SDK none | — | — | SDKs MUST NOT persist session content; caches are opt-in and scoped to generated schema artifacts |

## 5. Errors and failure modes

| Failure | Behaviour | Fail-closed evidence |
|---|---|---|
| Kernel absent | read-only posture for every surface; mutating calls return `kernel_unavailable` with the required capability | typed error + visible banner, exit 3 when a mutation was required |
| Kernel protocol mismatch | refuse mutating calls; report both ABI versions | `abi_mismatch` payload; no silent fallback |
| Registration file stale/foreign | client starts or finds a leader; never trusts the file | `server.hello` verification (S35) |
| Leader crash with clients attached | clients see `leader_lost`, retry with backoff, re-handshake; IDE bridge replays session attachment (S97); in-flight effects settle `UNKNOWN` when observation was lost | `hz.effect.unknown` + client-visible reconnect status |
| Two leaders racing | the loser attaches or exits 0; no second writer | lock file + store-writer assertion (S37, S49) |
| Unauthorized / wrong role | `401`/`403` with the required role named; attempt logged | server-side check, never a client-only guard (S7) |
| Cursor too old | resnapshot, never a silent skip | `subscription.resnapshot` event |
| Approval needed with no interactive client | resolve to `deny` (`noninteractive_ask` / `no_interactive_client`); the run does not hang | recorded denial with reason code; exit 3 in print/CI |
| Web/desktop renderer crash | UI restarts and re-attaches; no durable state lost (server owns it) | session still resumable |
| PTY stream backpressure exceeded | server pauses the pty (SIGSTOP-equivalent by not reading) and shows the client `pty_paused` | no unbounded buffering |
| Update fails signature check | refuse to install; keep the running version | `update_signature_invalid` surfaced in the UI |
| Share token scope exceeded | `403 share_scope` and a local log entry | grants are enforced server-side per request |
| MCP call to an unexposed tool | `tool_not_exposed`; no side effect | allow-list checked before admission |
| SDK/server protocol mismatch | client refuses to start and names revisions | `proto_mismatch` |
| `UNKNOWN` anywhere | surfaced on every surface; CI exit takes it into account (S17) | never converted to success by any surface |

Three vocabularies meet in the table above and MUST stay distinct. **Guard decision reason codes** are the closed set of `docs/11-authority-safety.md` §5.1. **RPC/transport errors** (`role_forbidden`, `driver_lease_held`, `tool_not_exposed`, `client_policy_forbidden`, `pairing_expired`, `pairing_consumed`, `session_revoked`, `session_expired`, `peer_mismatch`, `abi_mismatch`, `proto_mismatch`, `leader_lost`, `rate_limited`, `share_scope`, `grant_revoked`, `pty_paused`) are this document's own error namespace and MUST NOT be added to §5.1. **Surface decision codes** — `noninteractive_ask`, `no_interactive_client`, `unrenderable_ask` — resolve an ask with no answerer and therefore do belong in the closed decision set; they are registered in `docs/11-authority-safety.md` §5.1 as of the RC-15 reconciliation, so a receipt may carry them under G2 (`exhaustive_reason_codes`).

## 6. Flows

### 6.1 CI run and verification

1. Job sets provider credentials in the environment, runs `hzcode run "<task>" --output json --posture deny --allow "Shell(git *)" --budget usd=2.00 --max-turns 40 --offline`.
2. The run admits the prompt durably, executes steps, and prints exactly one JSON object (stdout) with `sessionId`, `usage`, `denials[]`, `unknowns[]`, `artifacts[]`.
3. The job asserts on the object with `jq` (for example `unknowns` empty and `stopReason == "end_turn"`), then runs `hzcode session verify "$sessionId" --json` and gates on the verdict.
4. A policy denial exits `4` with a machine-readable reason; a fail-closed refusal (kernel absent, unattended `ask`) or an unreconciled `UNKNOWN` exits `3`; the job reports each as the failure it is, never as a flake.
5. Artifacts are uploaded from `hz://artifact/<sha256>` paths; the patch is applied to the candidate branch by the job's own VCS step (using the exported hunk bundle digest), never by the agent's front-end.

### 6.2 Starting the server, discovering it, and coordinating clients

1. `hzcode serve` tries the workspace lock; if held, it checks pid liveness and either attaches to the leader or exits 0 with `already served`.
2. The leader generates a per-launch token, binds loopback, writes the registration file atomically (`0600`), and begins a 5-second ownership re-check.
3. The TUI (in another terminal) attaches by reading the registration file, calling `server.hello`, comparing ids, and claiming none of the roles the leader already granted (`observer` by default for a second client).
4. The web app is opened from the printed pairing URL; the app calls `auth.pair {code}` and receives a session token, stores it in an `HttpOnly` cookie, and subscribes with a cursor.
5. The first interactive client claims the **driver** lease; a second interactive client is told who holds it. An ask is broadcast; the first answer wins and every other client receives `ask_answered` with the answering client id (S44).
6. On `SIGTERM` the leader stops accepting work, waits for in-flight effects to settle or become `UNKNOWN`, releases the driver lease with a notice, removes the registration if it still owns it, and exits.

### 6.3 IDE attach, ask, hunk accept, crash replay

1. The editor starts `hzcode acp`; the bridge performs the ACP handshake, negotiates capabilities with the editor, and attaches to (or starts) the workspace leader.
2. The user prompts from the editor; the session is created in the store and is immediately visible to the TUI and the web app.
3. A tool requests `terminal.run`; the ask is rendered in the editor with the exact argv, effect class, origin, sandbox mode and policy revision. The user approves `allow once`; the server records the decision as `hz.permission.answered` and the **kernel** consumes the challenge and issues the one-use lease — no surface or server mints a lease (`docs/11-authority-safety.md` L1–L4, A11).
4. The agent edits two files; the editor shows the diff with per-hunk affordances. Accepting hunk 1 sends `diff.hunk.decision`; the server submits `files.patch`, the receipt settles, and the editor renders `applied` from the receipt. Hunk 2 returns `stale_preimage` and the editor offers re-diff.
5. The leader crashes (OOM). The bridge loses the connection; the client stays alive. On reconnect the bridge replays `initialize` and the cached session attachments, swallowing the responses to replayed requests while forwarding notifications, and emits `hz/reconnected` (the one name, declared in S97) with the recovered session ids. Sessions that could not be recovered are marked `partial` with the reason.
6. No prompt is re-run, no effect is duplicated, and the user sees a single reconnect notice with the recovered sessions listed.

### 6.4 Desktop supervised start and update

1. The desktop app starts, looks for a registration file for the last workspace, verifies it via `server.hello`, and attaches; if none is found it spawns `hzcode serve --web` as a child and records the child pid for supervision.
2. Menus and tray reflect server state (S79). Native notifications follow `docs/13-tui.md` R178 defaults.
3. The updater checks its channel, downloads a signed manifest, verifies signature and digest, stages the artifact, and defers installation until the session is idle (S82–S83).
4. If the first start after the update crashes, the previous version is restored and the failure is reported with the crash bundle attached (opt-in).

### 6.5 Share link lifecycle

1. From the TUI (`/share`), the web app or the CLI, the user selects a session and a redaction profile (default `strict`), a scope (session read, artifacts read, receipts read) and an expiry.
2. The server creates a signed grant, records the profile on it, and returns the link; the grant and profile are shown to the sharer, who must confirm.
3. A viewer opens the link, is identified (or anonymous-with-grant), and reads only what the scope allows; each read is logged with the grant id (S162).
4. The sharer revokes the grant; the next request fails with `403 grant_revoked`. Live viewers are dropped with a notice and presence is updated.

## 7. Security and authority

| Surface | Capability IDs it may request | Extra narrowing |
|---|---|---|
| TUI | `ui.present`, `session.manage`, `terminal.pty`, `files.read`, `artifact.write`, `net.fetch` | interactive user answer required for anything above read-only |
| print/exec | `session.manage`, `files.read`, `terminal.run`, `net.fetch`, `artifact.write` | policy-only approvals; `ask`⇒deny |
| server | none of its own; it transports requests | role scoping, per-client rate limits |
| web | `session.manage`, `terminal.pty`, `files.patch` (via decision), `memory.write`, `collab.manage` `[planned]` | client role; share tokens never execute (S151) |
| desktop | as web, plus OS integration (no agent capability) | renderer sandbox; preload allow-list |
| IDE | `session.manage`, `files.patch` (via decision) | S101 list enforced server-side |
| MCP server | the exposed tool allow-list only | S110–S112 defaults; member-of-user-authority only |
| SDK | whatever the host's client role allows | no convenience path around auth |

| Rule | Statement |
|---|---|
| Fail-closed | No surface may proceed without a kernel decision for a mutating effect; a missing kernel yields read-only, never unguarded writes. |
| Least privilege | Every client is created with a role; roles are additive only by explicit server configuration and are always ≤ the user's own posture. |
| Secret hygiene | Tokens live in `0600` files or OS keychain; credentials never transit a front-end; redaction at every exporter (S23). |
| Egress | Every outbound destination (model endpoint, tunnel, webhook, notification, share, telemetry, update) is listed by `hzcode config show egress` and disabled by `--offline` (S21, S147). |
| Attribution | Every mutating call records the origin kind, the client id and the surface; an MCP or editor caller can never be attributed as `UserAction` (S116). |
| Auditability | Receipts, decisions, grants, share reads and reconnect events are durable and inspectable from any surface. |

## 8. Performance budgets

| Surface | Metric | Budget |
|---|---|---|
| server | `server.hello` round trip (UDS, warm) | ≤ 5 ms p95 |
| server | read method (`transcript.window`, 200 blocks) | ≤ 25 ms p95 |
| server | mutating call admission to lease (excluding the effect) | ≤ 30 ms p95 |
| server | SSE/WS event propagation from log append to client write | ≤ 50 ms p99, no unbounded queue |
| server | concurrent clients per leader | ≥ 32 without degradation of the above |
| server | registration file write (atomic, retrying) | ≤ 50 ms p99; never blocks request handling |
| print | process start to first token printed | ≤ 250 ms p50 (warm), excluding provider time |
| print | JSON object emission overhead | ≤ 10 ms after the last provider event |
| web | first meaningful paint (local server, warm) | ≤ 800 ms p50 |
| web | transcript scroll (5 000 blocks) | ≤ 16 ms per frame |
| web | diff first paint (10 000 lines) | ≤ 400 ms |
| web | live event → DOM update | ≤ 100 ms p99 |
| desktop | cold start to interactive window | ≤ 1.5 s p50 |
| desktop | notification delivery after event | ≤ 500 ms p95 |
| desktop | attach to an existing leader | ≤ 300 ms p95 |
| IDE | ACP `initialize` handshake | ≤ 200 ms p95 |
| IDE | ask render after `permission.asked` | ≤ 150 ms p95 |
| IDE | hunk decision → receipt state shown | ≤ 300 ms p95 (excluding the patch itself) |
| IDE | reconnect + session replay (10 sessions) | ≤ 2 s p95 |
| MCP | tool call overhead above the underlying tool | ≤ 15 ms p95 |
| MCP | resource read (`hz://session/<id>`, 200 blocks) | ≤ 40 ms p95 |
| SDK | generated client call overhead (no transport) | ≤ 1 ms p95 |
| SDK | conformance suite (all four SDKs) | ≤ 3 min in CI |
| parity | ratchet analysis over the repo | ≤ 60 s in CI |

## 9. Tests

> **No `surfaces/*` gate below exists.** The tests that do exist for the shipped surfaces are `app/tests/core/server.test.ts`, `s1-serve-files-exit.test.ts`, `session-fork.test.ts`, `rewind-conversation.test.ts`, `app/tests/tui/print.test.ts`, `headless.test.ts` and the e2e steps of `ops/gates.sh` (`e2e-headless-smoke`, `e2e-budget-rail`, `e2e-usage-error`). The table is the plan for the designed surfaces.

| Gate | Proves | Kind |
|---|---|---|
| `surfaces/parity.ratchet` | S163–S172: every capability has projections or an owned, expiring reason; debt only decreases; no orphan methods | linter + registry |
| `surfaces/headless.schema` | `HeadlessResultV1`/`ExecResultV1` conformance, stdout cleanliness, exit codes, `unknowns`/`denials` gating | schema tests + CLI e2e |
| `surfaces/ci.recipes` | The documented CI recipes run green, including the policy-denial and budget-exhaustion paths | CI job |
| `surfaces/headless.redaction` | A planted secret never appears in any output mode, log or artifact | e2e |
| `surfaces/server.transports` | The same method behaves identically over stdio, UDS, TCP, HTTP+SSE and WS | conformance |
| `surfaces/server.discovery` | Atomic registration, stale-file handling, displacement shutdown, lock arbitration | integration |
| `surfaces/server.auth` | Token, pairing-code TTL/single-use, session-token expiry and rotation-revocation, role enforcement | security tests |
| `surfaces/server.remote` | Non-loopback requires `--allow-remote` + auth; Host-header validation; CORS/CSRF; remote attempts logged | security tests |
| `surfaces/server.multiclient` | Cursors, resnapshot, driver lease, ask-first-wins, observer-cannot-answer | integration |
| `surfaces/server.shutdown` | Graceful drain, claim durability, resumability after restart | integration |
| `surfaces/web.thin` | No dependency on domain packages; no domain logic in the bundle | dependency + lint gate |
| `surfaces/web.parity` | Diff accept and approval decisions call the server and reflect receipts only | browser e2e against a fixture server |
| `surfaces/web.pty` | PTY bridge backpressure, pause/resume, resize, teardown, receipts | e2e |
| `surfaces/desktop.sandbox` | `sandbox: true`, `contextIsolation`, no `nodeIntegration`, no generic IPC passthrough, navigation allowlist | static + runtime assertions |
| `surfaces/desktop.nested` | CLI dependency closure excludes the desktop module; CLI build does not install desktop deps | build assertion |
| `surfaces/desktop.update` | Signature verify before write, rollback on first-run crash, no restart mid-turn | integration with a fixture updater |
| `surfaces/ide.acp` | Handshake, negotiation fallback, ask render parity, hunk decision, role restrictions | conformance vs VS Code + JetBrains harnesses |
| `surfaces/ide.replay` | Leader-crash replay recovers attachments without re-running prompts or duplicating effects; `partial` marking | chaos test (kill -9 the leader) |
| `surfaces/ide.forbidden` | Each S101 prohibition is refused with a typed error and logged | security tests |
| `surfaces/mcp.exposure` | Advertised set equals the runnable set; allow-list enforcement; origin typing; per-client scoping; budgets | conformance |
| `surfaces/mcp.resources` | `hz://` resource reads and subscriptions respect lanes and scopes; cross-scope reads are `not_found` | integration |
| `surfaces/sdk.conformance` | All four SDKs pass the scripted session; generation is deterministic; drift check fails on edit | generated-artifact + e2e |
| `surfaces/sdk.compat` | Unknown fields/events tolerated; deprecation notices emitted; version mapping asserted | unit |
| `surfaces/mobile.parity` | Mobile approve uses the full contract; no reduced-authority path; deltas disabled by default | device-profile e2e |
| `surfaces/sharing.redaction` | Strict profile strips secrets, env values and out-of-scope content; revocation is immediate; share tokens cannot execute | security tests |
| `surfaces/sharing.presence` | Presence expiry, role display, follow mode does not move a reading viewer | integration |
| `surfaces/perf.gate` | All budgets in §8 within 20 % | CI benchmark |

## 10. Status

Every capability below starts at **DESIGNED**, except the rows `28-implementation-status.md` records above it — that file owns implementation levels (RC-13) and is the only place a level above `DESIGNED` may be claimed. Evidence required to advance is named per row; no row may claim `WIRED` or above without the named test green and a real run recorded.

| Capability | Surface(s) | Level | Evidence required to advance |
|---|---|---|---|
| Print/exec CLI path (schemas, exit codes, approvals fail closed) | print | VERIFIED (`28-implementation-status.md` §1: `bin/hzcode`, `--output` modes, headless approvals fail closed, exit-code e2e) | `surfaces/headless.schema`, `surfaces/headless.redaction` |
| CI recipes and gate wiring (documented recipes run green in CI) | print | DESIGNED for the recipes; the repository's own gate runner `ops/gates.sh` (8 gates) and `.github/workflows/ci.yml` exist, see [`16-operations.md`](16-operations.md) | `surfaces/ci.recipes` |
| Local server transports (stdio/UDS/TCP/HTTP/SSE/WS) | server | DESIGNED for UDS/TCP/HTTP/SSE/WS; the stdio single-attach subset is TESTED per `28-implementation-status.md` (server row) | `surfaces/server.transports` |
| Discovery + leader arbitration | server | DESIGNED | `surfaces/server.discovery` |
| Auth (token, pairing, session token, roles) | server | DESIGNED | `surfaces/server.auth` |
| Multi-client coordination (cursors, driver lease, ask routing) | server | DESIGNED | `surfaces/server.multiclient` |
| Remote exposure safety | server | DESIGNED | `surfaces/server.remote` |
| Graceful shutdown and resumability | server | DESIGNED for the drain protocol; resume by id and crash recovery on attach ship in the stdio subset (`createRuntime` runs both recoveries) | `surfaces/server.shutdown` |
| Web app as thin client | web | DESIGNED | `surfaces/web.thin`, `surfaces/web.parity` |
| Web diff review and approvals | web | DESIGNED | `surfaces/web.parity` |
| Web PTY bridge | web | DESIGNED | `surfaces/web.pty` |
| Web artifacts, memory browser, cost dashboard | web | DESIGNED | web e2e + provenance assertions |
| Desktop shell, menus, tray, notifications, file dialogs | desktop | DESIGNED | `surfaces/desktop.sandbox`, notification tests |
| Desktop auto-update | desktop | DESIGNED | `surfaces/desktop.update` |
| Desktop nested-module build rule | desktop | DESIGNED | `surfaces/desktop.nested` |
| IDE bridge + ACP (negotiation, diffs, permission proxying) | IDE | DESIGNED | `surfaces/ide.acp` |
| IDE session replay after leader crash | IDE | DESIGNED | `surfaces/ide.replay` |
| IDE prohibitions enforced | IDE | DESIGNED | `surfaces/ide.forbidden` |
| MCP server mode (tools, resources, prompts, posture defaults) | MCP | DESIGNED | `surfaces/mcp.exposure`, `surfaces/mcp.resources` |
| Generated SDKs + conformance | SDK | DESIGNED | `surfaces/sdk.conformance`, `surfaces/sdk.compat` |
| Mobile/remote supervision as a web capability | web | DESIGNED | `surfaces/mobile.parity` |
| Sharing, redaction, live sessions, presence, team memory sync | server, web | DESIGNED | `surfaces/sharing.redaction`, `surfaces/sharing.presence` |
| Parity ratchet | all | DESIGNED | `surfaces/parity.ratchet` wired into CI with `baseline.json` |
| Performance budgets | all | DESIGNED | `surfaces/perf.gate` on the reference machine |

Known limitations this document MUST NOT paper over:

1. The ancestor's subagent dispatch lane is reported closed by a flag and its completion gate accepts an arbitrary string (source: `HANDOFF.md` of the ancestor project (not cloned, path not verified)); therefore no surface may claim that a child session's completion was verified until the evidence gate is wired (S9, S26).
2. The ancestor refuses two edits to the same file in one message (`stale_preimage`), so the web/IDE hunk flows MUST apply sequentially with recomputed preimages rather than bulk-applying (S57, S93).
3. Cross-platform sandbox residuals are typed, not absent: a surface MUST render the residual vector rather than imply confinement it does not have (`docs/02-decisions.md`, ADR-002 and P6).

> **Session fork (`docs/28` ruling 59).** `session.fork {sessionId, at?}` returns `{sessionId, uri, forkedFrom{uri,sessionId,messageIndex,parentSeq}, model, providerName, kernelMode}`; the child is live and promptable. `session.list` rows carry `forkedFrom` only for forks. Bad `at` or an unknown session is INVALID_PARAMS.

> **Guardian surfacing (`docs/28` ruling 60).** `ApprovalRequest` gains an optional `guardian` string (additive); `HORIZON_GUARDIAN=enforce` is the only env switch.

---

## Provenance (surfaces: what ships, what is design only, where it came from)

This section records, for the non-TUI surfaces, which designs and which bytes came from other repositories, with exact GitHub URLs at the commit that was read, which parts of this document are design only, and a detailed deferral note for every missing piece. It is a handoff aid and changes no status level; `docs/28-implementation-status.md` is the only place that may claim a level above DESIGNED.

Reading the tables:

- URLs point at a file at the full 40 character SHA from [`research/upstream-pins.md`](research/upstream-pins.md). Each path was checked with `git ls-files` in the read-only clone before it was written. Anything not checkable is written `path not verified`.
- **Relation**: **copied verbatim**, **ported**, **adapted**, or **idea only**, as defined in the Provenance section of [`08-runtime.md`](08-runtime.md). In this document nothing is copied verbatim and nothing is ported. The shipped surfaces are original TypeScript written against the designs; upstream repositories supplied flag names, output shapes and architecture ideas.
- Judged from the header comments of the HorizonCode files, the docs/28 rulings and reading both sides.
- Licences: cline and codex Apache-2.0; oh-my-pi and opencode MIT; grok-build and claude-code carry their own `LICENSE` files that were not analysed. The worktree has no `LICENSE` or `NOTICE`; any future verbatim or ported row would owe attribution (OPEN item for the human owner). Nothing here is copied, so nothing is owed today.
- The ancestor project referred to in older text (`horizoncode` / `repo-tour`) is an earlier private codebase that is not available in this sandbox; its paths cannot be verified. aider, mini-swe-agent, hermes-agent, OpenHands, SWE-agent, wshobson-agents, DeepSeek-Reasonix and opencode-v2 are not cloned; see the 'Not cloned' table in [`research/upstream-pins.md`](research/upstream-pins.md).
- Research: [`research/compare-codex-grok.md`](research/compare-codex-grok.md), [`research/steal-ohmypi-codex.md`](research/steal-ohmypi-codex.md), [`research/steal-opencode-cline.md`](research/steal-opencode-cline.md), [`30-steal-list.md`](30-steal-list.md).

### Implemented surfaces versus the capability matrix (read this first)

The capability matrix in section 3.1 is a **design target for eight surfaces**. Four surfaces have any code at all, and each is narrower than its column:

| Surface | Shipped | Not shipped (see the deferral note) |
|---|---|---|
| TUI | the scrollback chat of [`13-tui.md`](13-tui.md) | fullscreen mode, palette, keymap (docs/13 D1 to D18) |
| print | `-p` with `text`, `json`, `stream-json`; exit codes; fail-closed approvals | `exec` subcommand, `ExecResultV1`, `--on-client-gone` (G12, G13) |
| headless pipe | one turn per stdin line, plain text out | machine-readable output on this path (use `-p`), parity spec (G12) |
| server | `hzcode serve`: stdio, single-attach, 7 methods, resume by id, fork, rewind, crash recovery on attach | other transports, discovery, auth, multi-client, approvals, permission mode (G1 to G4, G11) |
| web, desktop, IDE/ACP, MCP server, SDKs, mobile, sharing | nothing | G5 to G9 |

Every cell of the section 3.1 matrix outside the four rows above is a **claim about a future surface**, including the printed commands such as `session diff --json`, `receipt show`, `session verify`, `policy list`, `parity check --json`, `session tree --json` and `share create`. None of those subcommands exists in `app/src/main.ts`; the subcommands that exist are `serve`, `doctor`, `config check` and `commit`, and `run <name>` for custom commands.

### What shipped, and where it came from

| # | HorizonCode file(s) | Upstream exact URL(s) at the pinned SHA | Relation | Notes |
|---|---|---|---|---|
| 1 | `app/src/tui/print.ts`, `app/src/main.ts` (`-p`, `--output-format`) | [`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)<br>[`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/exec/src/cli.rs)<br>Claude Code `-p --output-format json\|stream-json`: product behaviour, the pinned claude-code clone has no CLI source (path not verified) | idea only (flag names and output shapes) | Ruling 57, VERIFIED. `text`, `json` (one result object) and `stream-json` (one `RuntimeEvent` per line, then the result object). Exit code from `exitCodeFor` in `app/src/core/loop.ts`. **The printed object is `PrintResult`, NOT the `ExecResultV1` of section 3.3**: `ExecResultV1` describes one shell execution (stdout refs, signal, sandbox residuals) and is DESIGN ONLY; `PrintResult` describes a whole turn (`result`, `sessionId`, `exit{terminal,detail,code}`, `usage`, `toolCalls`, `changedFiles`). Do not conflate them. |
| 2 | `app/src/tui/headless.ts`, `app/src/main.ts` (stdin is a pipe) | [`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/exec/src/cli.rs)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md) | idea only | Line-per-message pipe mode: each stdin line is one turn, plain text out, a `turn.diff` is summarised on stderr as `. changed N file(s)`, headless approvals fail closed (nothing prompts). Not the S11 `--on-client-gone` behaviour: an EPIPE is not handled specially. |
| 3 | `app/src/core/server.ts`, `app/src/contracts.ts` (`HZ_PROTO`, `ServerRequest`, `ServerResponse`, `ServerNotification`, `SERVER_METHODS`), `app/src/core/stdin-worker.ts`, `app/src/core/stdin-live.ts`, `app/src/main.ts` (`serve`) | [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)<br>[`crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs)<br>[`packages/server/src/api.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/api.ts) | idea only (single-attach NDJSON JSON-RPC over stdio), original implementation | `hzcode serve`, TESTED (`app/tests/core/server.test.ts`, `s1-serve-files-exit.test.ts`, `session-fork.test.ts`). Seven methods: `server.hello`, `session.create`, `session.list`, `session.subscribe`, `session.prompt`, `session.rewind`, `session.fork`. Every session opens through `createRuntime`, so both crash recoveries (`repairDanglingToolCalls`, `recoverInterrupted`) run before the next turn. `server.hello` reports `capabilities {methods, transports:["stdio"], singleAttach:true}` and the real `kernelMode`. The transport is injected (`{input, output}`), which is how tests run it over in-memory pipes. `stdin-worker.ts` exists because Bun 1.2.x delivers pipe stdin only at EOF; a Worker doing blocking `readSync` on fd 0 makes the server answer each line while stdin stays open (ruling 53). The code header names codex `app-server` `daemon_recovery` and `rollout_reconstruction` as the pattern; codex is Rust, HorizonCode's server is a 464-line TypeScript file written from scratch. |
| 4 | `app/src/core/server.ts` (`session.event` notification relay of `subagent.event`), `app/src/contracts.ts` (`RuntimeEvent`) | [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol) | idea only (notification shape) | Streamed turn events are `session.event` notifications that carry a `RuntimeEvent` tagged with the owning `sessionId`; `subagent.event` frames are relayed as ordinary `session.event`s (ruling 54). Last subscriber wins per session; this is the single-attach stand-in for S41 to S44. |
| 5 | `app/src/core/permission-mode.ts`, `app/src/main.ts` (`--permission-mode`) | [`crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)<br>[`crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md) | idea only (mode names), original policy layer | Ruling 58. Works with chat, pipes and `-p`. `hzcode serve` does NOT take a mode yet (named gap G11). |
| 6 | `ops/gates.sh`, `ops/ci/github-actions.yml`, `.github/workflows/ci.yml` | [`.github/workflows/ci.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/.github/workflows/ci.yml) | idea only | The only CI recipe that exists is the repository's own gate runner (see Provenance in [`16-operations.md`](16-operations.md)). The documented `surfaces/ci.recipes` (section 2.2, flow 6.1) are NOT written. |


### Where each design family came from (all DESIGN ONLY unless marked)

| Family | Upstream exact URL(s) at the pinned SHA | Status | Notes |
|---|---|---|---|
| S-universal (section 2.1): one Controller, every surface a client, parity ratchet inputs | [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)<br>[`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol)<br>[`crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs) | PARTIAL: TUI, print, headless and serve all go through `createRuntime`; no Controller object, no capability matrix | The shipped surfaces share the runtime facade (`Runtime.send`, `RuntimeEvent`). There is no `CapabilityRecordV1`, no machine-readable matrix and no ratchet (`gate:parity-ratchet` and `gate:frontend-parity` are declared gaps in `ops/gate-catalogue.md`). |
| Section 2.2 headless, print, exec and CI (S9 to S16) | [`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)<br>[`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/exec/src/cli.rs) | PARTIAL: print and headless ship; `ExecResultV1`, `exec` subcommand, `--on-client-gone`, the redaction schema, CI recipes do not | Exit codes (0/1/2/3/4/5/130/143) are implemented by `exitCodeFor`; a missing prompt or bad format is 2. See G12 and G13. |
| Section 2.3 local server: transports, discovery, auth, multi-client, remote exposure (S30 to S50) | [`packages/server/src/api.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/api.ts)<br>[`packages/server/src/auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/auth.ts)<br>[`packages/server/src/pairing.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/pairing.ts)<br>[`packages/cli/src/services/service-registration.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/services/service-registration.ts)<br>[`crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs)<br>[`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md) | PARTIAL: stdio, single-attach, 7 methods; everything else NOT IMPLEMENTED | See G1 to G4. |
| Section 2.4 web app (S51 to S62) | [`packages/app`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/app)<br>[`packages/server/src/event-feed.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/event-feed.ts)<br>DeepSeek-Reasonix web frontend: repo not cloned, path not verified | NOT IMPLEMENTED (design only) | No browser surface exists. See G8. |
| Section 2.5 desktop app (S63 to S72) | [`packages/desktop`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/desktop)<br>DeepSeek-Reasonix `desktop`: repo not cloned, path not verified | NOT IMPLEMENTED (design only) | See G8. |
| Section 2.6 IDE bridge and ACP (S86 to S96) | [`crates/codegen/xai-acp-lib/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/lib.rs)<br>[`crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs)<br>[`packages/cli/src/acp`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/acp)<br>[`packages/coding-agent/src/modes/acp`](https://github.com/can1357/oh-my-pi/tree/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/modes/acp)<br>DeepSeek-Reasonix `internal/frontend/acp`: repo not cloned, path not verified | NOT IMPLEMENTED (design only); `server.ts` rejects unknown methods with a typed METHOD_NOT_FOUND | No ACP agent. See G5. |
| Section 2.7 MCP server mode (S97 to S103) | [`codex-rs/codex-mcp`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/codex-mcp)<br>[`codex-rs/rmcp-client`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/rmcp-client)<br>codex `codex-rs/mcp-server`: path not present in the pinned clone, not verified | NOT IMPLEMENTED (design only); the MCP CLIENT ships (see [`15-extensibility.md`](15-extensibility.md)) | Do not confuse the two: HorizonCode can consume MCP servers (stdio, user config) but does not expose itself as one. See G6. |
| Section 2.8 SDKs (S104 to S110) | [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol)<br>[`packages/sdk`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/sdk)<br>[`docs/sdk.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/sdk.md)<br>[`docs/rpc.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/rpc.md) | NOT IMPLEMENTED (design only); nothing generated | `contracts.ts` is hand-written TypeScript, not generated from a schema. See G7. |
| Sections 2.9 and 2.10 mobile supervision, collaboration and sharing (S111 to S125) | [`docs/collab.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/collab.md)<br>[`infra/share.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/infra/share.ts)<br>[`packages/cli/src/services/remote-tunnel.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/services/remote-tunnel.ts) | NOT IMPLEMENTED (design only) | See G9. |
| Section 2.11 parity ratchet (S126 to S130) | idea only: no upstream reference for a capability-matrix ratchet was found in the pinned clones | NOT IMPLEMENTED (design only); `gate:parity-ratchet` is a declared gap | See G10. |


### Sources that could not be linked

`HANDOFF.md` of the ancestor project (the closed subagent lane and the `stale_preimage` limitation cited in section 10) and the other 'ancestor' paths belong to an earlier private codebase that is not cloned here; they stay as text and are marked 'path not verified'. The DeepSeek-Reasonix web, desktop and ACP frontends cited in section 1 are in a repository that is not cloned. The pinned claude-code repository contains plugins, examples and a changelog but no CLI or SDK source, so Claude Code behaviours (`-p`, `--output-format`, the SDK) are product behaviour with no file link.


### Deferred or not started: detailed notes for the next agent

Each note gives: what is deferred, why, the upstream reference, whether to adopt as is or adapt, a suggested design, and the files to touch. 'Adapt' is the default because the references are Rust or framework-specific TypeScript. No note changes a status level. Paths are from the repository root.

#### G1. Transports beyond stdio: UDS or named pipe, TCP loopback, HTTP with SSE, WebSocket (S30 to S33)

- **What is deferred.** Everything in section 3.2 other than the stdio NDJSON framing. `server.hello` reports `transports: ["stdio"]` and nothing else.
- **Why.** One client per process over stdio proves the method set and the crash-recovery seam without opening a network surface. A listening socket needs auth (G3) first, otherwise it is an unauthenticated local authority.
- **Upstream reference.** [`packages/server/src/api.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/api.ts)<br>[`packages/server/src/fetch.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/fetch.ts)<br>[`packages/server/src/event-feed.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/event-feed.ts)<br>[`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)
- **Adopt as is or adapt.** ADAPT. Take opencode's split (a transport-neutral `handlers` layer plus a thin fetch/SSE adapter) and the idea from codex of one protocol over several transports. Do not copy: both are built on their own frameworks.
- **Suggested design.** Keep `createServer` transport-injected (it already is). Add `transports/uds.ts` first (Unix domain socket under `<state root>/server.sock`, mode 0600, `SO_PEERCRED` check not available in Bun so rely on directory mode 0700), then loopback TCP bound to `127.0.0.1` only. Only after G3 (auth) add HTTP+SSE. Each transport must reuse `dispatch` unchanged and be tested by running the existing `server.test.ts` cases through it.
- **Files to touch.** `app/src/core/server.ts` (no change to dispatch), new `app/src/core/server-transports/*.ts`, `app/src/main.ts` (`--listen` flag), `app/tests/core/server-uds.test.ts`, `app/src/contracts.ts` (additive: `transports` values only).

#### G2. Discovery file and leader arbitration (S34 to S37)

- **What is deferred.** A registration file that tells a second client where the running leader is, and a rule for what happens when two `hzcode serve` start for one workspace. Not built; a second `serve` simply runs a second server on its own stdio.
- **Why.** Meaningless without a non-stdio transport (G1).
- **Upstream reference.** [`packages/cli/src/services/service-registration.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/services/service-registration.ts)<br>[`packages/cli/src/services/port-owner.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/services/port-owner.ts)<br>[`packages/cli/src/services/server-connection.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/services/server-connection.ts)<br>[`crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs)
- **Adopt as is or adapt.** ADAPT. opencode's registration file and port-owner check are the closest shape; Grok's leader plus replay of the ACP handshake is the reference for takeover.
- **Suggested design.** Write `<state root>/server.json` `{pid, startedAt, transport, address, protoVersion}` atomically (temp file plus rename, 0600). A starting server reads it, probes the pid and the address, and either refuses with exit 2 and the existing address or replaces a stale file. Add a test that kills the leader with SIGKILL and asserts the next start replaces the file and runs both crash recoveries.
- **Files to touch.** new `app/src/core/server-registration.ts`, `app/src/core/server.ts`, `app/src/main.ts`, `app/tests/core/server-registration.test.ts`.

#### G3. Server authentication: token, pairing codes, session tokens, roles (S38 to S40)

- **What is deferred.** Any form of authentication on the server. Today the only protection is that the transport is the parent process's stdio.
- **Why.** Required before any network transport (G1). The design says pairing codes and short-lived session tokens, never a long-lived secret in a URL.
- **Upstream reference.** [`packages/server/src/pairing.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/pairing.ts)<br>[`packages/server/src/auth.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/auth.ts)<br>[`packages/server/src/cors.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/cors.ts)
- **Adopt as is or adapt.** ADAPT. Read `pairing.ts` and `auth.ts` for the code-to-token exchange and expiry rules; reimplement with `node:crypto` (zero runtime dependencies).
- **Suggested design.** A 0600 `server-token` file created at first start; `server.hello` accepts `{token}`; for remote pairing add a six-digit code valid for 120 seconds, single use, exchanged for a session token bound to a client id and role (`viewer|driver`). Compare in constant time. Reject any request before `server.hello` with a typed error. Tests: wrong token, expired code, reused code, role escalation attempt.
- **Files to touch.** `app/src/core/server.ts`, new `app/src/core/server-auth.ts`, `app/src/contracts.ts` (additive `server.auth` method), `app/tests/core/server-auth.test.ts`.

#### G4. Multi-client coordination: roles, per-client cursors, driver lease, ask routing (S41 to S50)

- **What is deferred.** Several clients on one session with one driver at a time. Today a new `session.subscribe` replaces the previous subscriber for that session (last wins).
- **Why.** Needs auth (G3) for roles and the event-log cursor model of docs/06 (`hz.subscribe` with a resume cursor), which the TS runtime does not implement.
- **Upstream reference.** [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)<br>[`packages/server/src/event-feed.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/event-feed.ts)<br>[`crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs)
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** Add a per-session subscriber set with a client id and role, a driver lease (one holder, renewed by activity, expires after N seconds idle) and routing of `ApprovalRequest` to the driver only. Replay from a cursor by reading the kernel `log.read` for the session stream (`fromSeq`), which already exists in `KernelRequestMap`.
- **Files to touch.** `app/src/core/server.ts`, `app/src/core/index.ts` (approval handler injection), `app/src/contracts.ts` (additive), `app/tests/core/server-multiclient.test.ts`.

#### G5. ACP agent and IDE bridge (S86 to S96)

- **What is deferred.** An Agent Client Protocol endpoint (`hzcode acp`) so editors can attach, with permission proxying and replay after a leader crash. The `session/request_permission` flow must resolve a normal guard challenge. Nothing exists; `server.ts` header marks it S89.
- **Why.** A large surface that depends on the server being stable first (G1 to G4) and on the approval card contract.
- **Upstream reference.** [`crates/codegen/xai-acp-lib/src/lib.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/lib.rs)<br>[`crates/codegen/xai-acp-lib/src/gateway.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-acp-lib/src/gateway.rs)<br>[`crates/codegen/xai-grok-pager-bin/src/main.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager-bin/src/main.rs)<br>[`packages/cli/src/acp/agent.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/acp/agent.ts)<br>[`packages/cli/src/acp/capabilities.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/acp/capabilities.ts)<br>[`packages/coding-agent/src/modes/acp`](https://github.com/can1357/oh-my-pi/tree/21f1188cf88b2f534c092181968cd5a4d1a9c296/packages/coding-agent/src/modes/acp)<br>DeepSeek-Reasonix `internal/frontend/acp` (handshake, clientio, session, dispatch): repo not cloned, path not verified
- **Adopt as is or adapt.** ADAPT. opencode's `packages/cli/src/acp` is TypeScript and the nearest shape; Grok's stdio replay (cached initialize and session attach re-sent to a new leader, responses swallowed) is the reference for crash replay. Pin one ACP revision first (open item 7 of docs/07).
- **Suggested design.** `hzcode acp` runs `createServer`-like dispatch over stdio speaking ACP: map `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel` to `createRuntime`/`Runtime.send`/`abort`; map `RuntimeEvent` to `session/update`; map an `ApprovalRequest` to `session/request_permission` and treat a digest mismatch or malformed answer as deny (test X16 in docs/15). Extension methods under `_hzcode/*` only.
- **Files to touch.** new `app/src/core/acp/*.ts`, `app/src/main.ts`, `app/tests/core/acp-*.test.ts`, docs/07 section 4.5 revision pin.

#### G6. MCP server mode: expose HorizonCode as an MCP server (S97 to S103)

- **What is deferred.** Tools, resources and prompts exposed to another agent, with posture defaults (read-only by default). Not built. The MCP CLIENT does ship.
- **Why.** An inbound authority path; it must be designed with the same guard and receipt pipeline and a conservative default.
- **Upstream reference.** [`codex-rs/codex-mcp`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/codex-mcp)<br>[`codex-rs/rmcp-client`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/rmcp-client)<br>[`docs/mcp-protocol-transports.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/mcp-protocol-transports.md)<br>[`docs/mcp-server-tool-authoring.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/mcp-server-tool-authoring.md)<br>codex `codex-rs/mcp-server`: not present in the pinned clone, path not verified
- **Adopt as is or adapt.** ADAPT the protocol handling; the authority rules are HorizonCode's own (section 3.5).
- **Suggested design.** `hzcode mcp serve` over stdio: `initialize`, `tools/list` (read-only tools only by default: `read`, `grep`, `glob`, `repo_map`), `tools/call` routed through the same `executeToolCall` path so every call is guarded and receipted. Reuse the framing code in `app/src/core/mcp/client.ts` for newline-delimited JSON-RPC.
- **Files to touch.** new `app/src/core/mcp/server.ts`, `app/src/main.ts`, `app/tests/core/mcp-server.test.ts`.

#### G7. Generated SDKs and a schema-exported protocol (S104 to S110)

- **What is deferred.** A JSON schema for the server protocol and SDKs generated from it (TS, Python, Go, Rust). Today `contracts.ts` is the hand-written source and `kernel/src/protocol.rs` is aligned to it by the interop suites.
- **Why.** `gate:wire-parity` is a declared gap precisely because no generator exists. Generating is only worth it once there is more than one consumer.
- **Upstream reference.** [`codex-rs/app-server-protocol`](https://github.com/openai/codex/tree/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server-protocol)<br>[`packages/sdk`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/sdk)<br>[`docs/sdk.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/sdk.md)
- **Adopt as is or adapt.** ADAPT the idea (one schema, generated TypeScript types and JSON schema, a checked-in snapshot test). Do not adopt codex's Rust `ts-rs` pipeline.
- **Suggested design.** Write `app/scripts/gen-protocol-schema.ts` that derives a JSON schema from the exported contract types (a small hand-written table is acceptable for 7 methods), commit the output under `app/schema/`, and add a test that fails when `contracts.ts` changes without regenerating. Keep `contracts.ts` additive-only.
- **Files to touch.** `app/src/contracts.ts` (comments only), new `app/scripts/gen-protocol-schema.ts`, `app/schema/*.json`, `app/tests/contracts/schema-snapshot.test.ts`.

#### G8. Web app and desktop app (S51 to S72)

- **What is deferred.** A browser client and an Electron or Tauri shell. Not started; design lives in sections 2.4 and 2.5.
- **Why.** Both are thin clients over the server (G1 to G4) and add a large dependency surface, which conflicts with the zero-runtime-dependency rule for `app/`. They would live in separate packages.
- **Upstream reference.** [`packages/app`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/app)<br>[`packages/desktop`](https://github.com/sst/opencode/tree/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/desktop)<br>[`packages/server/src/event-feed.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/server/src/event-feed.ts)<br>DeepSeek-Reasonix `desktop` (nested module): repo not cloned, path not verified
- **Adopt as is or adapt.** ADAPT the architecture (web client of the server protocol, desktop as a supervisor of the same binary). Do not copy code: it is SolidJS and Electron specific.
- **Suggested design.** Do not start before G1 to G4. Then a `web/` package with its own `package.json`, outside `app/`, consuming the generated schema (G7) and nothing from `app/src/core`.
- **Files to touch.** new top-level `web/` and `desktop/` packages; `ops/gate-catalogue.md` row for `gate:layering` once packages exist.

#### G9. Mobile supervision, collaboration, sharing links, presence, team memory sync (S111 to S125)

- **What is deferred.** All of sections 2.9 and 2.10.
- **Why.** Needs the web surface (G8) and a redaction pipeline for shared transcripts; sharing a transcript without redaction would leak secrets.
- **Upstream reference.** [`docs/collab.md`](https://github.com/can1357/oh-my-pi/blob/21f1188cf88b2f534c092181968cd5a4d1a9c296/docs/collab.md)<br>[`infra/share.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/infra/share.ts)<br>[`packages/cli/src/services/remote-tunnel.ts`](https://github.com/sst/opencode/blob/12a661ea40cd5863b271a89bb06b8a3ddb7ab5a0/packages/cli/src/services/remote-tunnel.ts)
- **Adopt as is or adapt.** idea only. Study, then design against HorizonCode's redaction rules.
- **Suggested design.** First the local-only part: `/export html` already writes a static page with the receipt chain verdict (ruling 80). A share link is that page uploaded by an explicit user action after a redaction pass; keep it opt-in and off by default.
- **Files to touch.** `app/src/core/convo.ts` (export), a new redaction module, docs/14 section 2.10.

#### G10. Parity ratchet and capability matrix (S126 to S130)

- **What is deferred.** A machine-readable capability matrix, a computed parity score and `baseline.json` that fails the build when a surface regresses.
- **Why.** Only four small surfaces exist and they share one runtime; a ratchet over them would be ceremony. `gate:parity-ratchet` and `gate:frontend-parity` stay declared gaps.
- **Upstream reference.** idea only: no upstream reference was found in the pinned clones.
- **Adopt as is or adapt.** Original design.
- **Suggested design.** When a second non-TUI surface (G1 or G5) lands, add `app/src/surfaces/matrix.ts` listing each capability by surface, and a test that compares it with a committed baseline.
- **Files to touch.** new `app/src/surfaces/matrix.ts`, `app/tests/surfaces/parity.test.ts`, `ops/gate-catalogue.md`.

#### G11. Permission mode on `hzcode serve` (named gap)

- **What is deferred.** `hzcode serve` ignores `--permission-mode`. A server session always runs in the `default` mode, and approvals for `ask` decisions have no client route (single-attach has no approval method).
- **Why.** Approval routing needs the multi-client design (G4); a mode flag alone would give a client no way to answer an ask.
- **Upstream reference.** [`crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/22-permissions-and-safety.md)<br>[`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/app-server/README.md)
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** Add `session.create {permissionMode}` (additive), default `read-only` for server sessions until an approval method exists, and an `approval.request` notification plus `approval.answer` request. Fail closed: no answer within the deadline is a deny.
- **Files to touch.** `app/src/core/server.ts`, `app/src/core/permission-mode.ts`, `app/src/contracts.ts`, `app/tests/core/server.test.ts`.

#### G12. CI recipes and `hzcode exec` (section 2.2, flow 6.1)

- **What is deferred.** Documented recipes for GitHub Actions and others, an `exec` subcommand with an explicit non-interactive contract and `--on-client-gone`, and a headless parity spec.
- **Why.** `-p` covers the practical need; recipes are documentation and a conformance test of them is not written (`surfaces/ci.recipes`).
- **Upstream reference.** [`crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)<br>[`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/exec/src/cli.rs)<br>[`.github/workflows/ci.yml`](https://github.com/tailcallhq/forgecode/blob/a22b49288856d5b3f3ca57e8532683d54a662c8c/.github/workflows/ci.yml)
- **Adopt as is or adapt.** ADAPT.
- **Suggested design.** Write `docs/recipes/ci.md` with a tested example that runs `hzcode -p ... --output-format json` against the mock provider (`--mock`) and asserts the exit code and the `PrintResult` fields. Add a headless parity fixture that runs the same script through `-p` and the pipe mode.
- **Files to touch.** new docs recipe, `app/tests/tui/print-recipe.test.ts`, `app/src/tui/print.ts` (no change expected).

#### G13. `ExecResultV1` (section 3.3) is not what print mode emits

- **What is deferred.** The designed per-execution result (`command`, `exitCode`, `signal`, `stdoutRef`, `truncated`, `receiptId`, `terminalState`, `sandbox`) is not produced anywhere. Print mode emits `PrintResult` per turn.
- **Why.** The shell tool returns a bounded text result and a receipt id; artifact refs (`hz://artifact/<sha256>`) do not exist yet.
- **Upstream reference.** idea only: codex `exec` JSONL item events are the nearest upstream shape, see [`codex-rs/exec/src/cli.rs`](https://github.com/openai/codex/blob/8703d32bd0ea5cf26768859a3dd476df906ba053/codex-rs/exec/src/cli.rs).
- **Adopt as is or adapt.** Original shape; keep it separate from `PrintResult` and say so in the contract.
- **Suggested design.** If wanted, add an additive `tool.card.detail` extension (the `ToolCardDetail` already carries `durationMs`, `output`, `exitCode`) rather than a new top-level type, and add `receiptId` to it.
- **Files to touch.** `app/src/contracts.ts` (additive), `app/src/core/loop.ts`, `app/tests/core/*`.
