# Deep-dive: Code Mode across two implementations (decision pass for HorizonCode)

Scope: (A) `opencode`'s `@opencode/codemode`; (B) `codex-rs`'s code-mode family (`code-mode`, `code-mode-host`, `code-mode-protocol`, `code-mode-runtime`, `v8-poc`). Deliverable: a decision for HorizonCode docs 09 / 24 plus a deepened, testable design.

---

## 1. Maps

### (A) opencode — `@opencode/codemode` (v2.2.5, pure TypeScript, Effect-native)

Root: `/data/home/forge/repo-tour/opencode/packages/codemode`

```
README.md                       # contract: supported subset, limits, results, discovery
interpreter-support.md          # checkable support matrix (language + stdlib); test262 parity tracking
AGENTS.md                       # invariants: program values are `Value`; host values enter only via fromHost/fromJson
package.json                    # deps: acorn 8.15 + effect; tests: `bun test`
script/{build,pack,sync-test262,test262-report}.ts

src/codemode.ts                 # CodeMode.make / CodeMode.execute, ExecutionLimits, Diagnostic + Result schemas
src/namespace.ts                # Namespace.make({description, tools}) — descriptions join search matching
src/tools.ts                    # Tools<R> record type (tool | namespace | nested record)
src/tool.ts                     # Tool.make({description, input, output, execute}) — Effect-native, schema-decoded
src/tool-runtime.ts             # tool trie, catalog, `search` signature, hooks (tool.before/after), call admission
src/tool-schema.ts              # TypeScript-signature rendering for the model-visible catalog
src/tool-error.ts               # ToolRuntimeError with DiagnosticKind
src/scan.ts                     # static `tools.<path>` extraction from a snippet (no dynamic access)
src/data.ts / src/extension.ts  # host<->program boundary data copy; host extension globals
src/stdlib/*.ts                 # array, string, object, number, regexp, date, json, math, collections, bytes,
                                #   headers, url, iterator, value, web (base64/crypto/structuredClone), console
src/interpreter/                # execute.ts (program lifecycle), runner.ts (explicit-stack VM), interpreter.ts,
                                #   globals.ts, limits.ts, promises.ts, generators.ts, modules.ts, scope.ts,
                                #   objects.ts, intrinsics.ts, native.ts, errors.ts, extensions.ts, references.ts
src/openapi/*                   # spec -> tool projection helper (`resolve-library-id`-style names get bracketed)
test/*.test.ts                  # codemode, limits, tool-paths, parity, callbacks, promise, errors, stdlib,
                                #   openapi, many `*-test262.test.ts` suites; test/test262/{manifest,run.ts,skipped.txt}
```

### (B) codex-rs — code-mode family (Rust, embedded V8, out-of-process host)

Root: `/data/home/forge/repo-tour/codex/codex-rs`

```
code-mode/                      # client side: session providers + transport clients
  src/lib.rs                    # re-exports protocol; GrpcCodeModeSessionProvider, ProcessOwned…Provider, Disabled…
  src/grpc_session/{mod,transport,operations,reconnect,callbacks,completion,deadline,state,generation,
                    process_metrics,conversion}.rs
  src/remote_session/{connection.rs,connection/driver*.rs,delegate.rs}

code-mode-protocol/             # wire contract shared by all three
  src/runtime.rs                # ExecuteRequest{enabled_tools,source,yield_time_ms,max_output_tokens},
                                #   WaitRequest, TerminateRequest, RuntimeResponse::{Yielded,Terminated,Pending,Result},
                                #   ExecuteToPendingOutcome; DEFAULT_EXEC_YIELD_TIME_MS=10s, MAX_OUTPUT_TOKENS=10k
  src/session.rs                # CodeModeSession, StartedCell, CodeModeSessionDelegate{invoke_tool,notify,cell_closed},
                                #   CellId, CodeModeSessionCellExecutionLimits{max_yield_time_ms,max_heap_size_bytes},
                                #   CodeModeOutputTruncation{Client|Server}, CodeModeSessionOptions
  src/description.rs            # tool description overrides; json_schema_types.rs for schema conversion
  src/host/{mod,message,codec,payload,types,error}.rs   # host framing (stdio + grpc codecs)
  src/grpc/, src/response.rs, src/process_metrics.rs

code-mode-host/                 # the process that owns cells and routes nested calls outward
  src/main.rs                   # bin `code-mode-host`: --listen stdio|stdio://|grpc+stdio://|grpc://IP:PORT, OTLP
  src/peer.rs, src/transport.rs, src/grpc_transport.rs, src/grpc_stdio.rs
  src/grpc/{mod,session,delegate,routing,events,waits,validation,capacity,conversions}.rs
  src/process_metrics.rs, src/transport_tests.rs
  tests/{grpc,grpc_notifications,grpc_tcp,stdio,ui_sandbox,settled,capacity,ui_plugin_wire}.rs
  tests/grpc/{admission_tests,network_policy_tests,image_cancellation_tests,session_recovery_tests,
              process_metrics_tests}.rs

code-mode-runtime/              # the sandbox itself: V8 isolates, one supervised OS thread per cell
  src/lib.rs                    # InProcessCodeModeSession, initialize_v8, V8JitMode, run_ui_sandbox
  src/v8_init.rs                # process-wide OnceLock init; ICU; flags: --no-maglev --no-turbolev
                                #   --no-turbo-inline-array-builtins; V8JitMode::Disabled => --jitless
  src/service.rs                # session facade: execute/wait/terminate, yield grace period, options
  src/session_runtime/{mod,types}.rs   # stored_values + cells + TaskTracker + shutdown token
  src/cell_actor/{mod,types,callbacks,conversions}.rs  # per-cell state machine: tool tasks, notifications,
                                #   cancellation tokens, completion commit
  src/runtime/{mod,globals,callbacks,timers,value,event_channel,module_loader,audio,settled.js}.rs
                                #   RuntimeCommand/RuntimeEvent, globals install, tool callback, timers, JSON bridge
  src/output/{mod,output_collection,output_render}.rs   # bounded output collection + truncation notices
  src/ui/{mod,engine,failures}.rs  # ui sandbox helper isolate: heap_limits(0, 64 MiB)
  tests/{jit,settled,array_sort}.rs

v8-poc/                         # Bazel-wired PoC crate, NOT wired into code mode
  src/lib.rs                    # bazel_target(), embedded_v8_version(), linked_v8_has_sandbox()
  Cargo.toml                    # feature `sandbox` => v8/v8_enable_sandbox
```

---

## 2. Execution model per implementation

### (A) opencode — a purpose-built interpreter, not an isolate

- **Sandbox technology.** No V8/WASM. A tree-walking interpreter (`src/interpreter/`) over acorn's AST, limited to an allowlist of language features; values are interpreter-owned `Value`/`Obj` objects. Even `Function.prototype.constructor` is a deliberate rejection: *"The Function constructor is not supported; write the function inline."* There is no ambient filesystem, network, process, or host API surface — the only escape hatch is the host-provided `tools` tree plus explicitly declared **extensions** (`Extension.make`) that the host chooses to expose as globals.
- **What the program may call.** `tools.<namespace>.<tool>(input)` (schema-decoded in, JSON-copied out), the `search(...)` built-in, and extension globals. Module-style imports (`import x from "m"`, `require("m")`, `await import("m")`) resolve **only** to declared globals (`node:fs`, `fs`, `fs/promises`, `url`, `util`, `buffer` map onto whatever the host provided); anything else throws/rejects. `export` is a parse error.
- **Execution shape.** Programs run inside an implicit async-function scope: top-level `await` and `return` work; without a `return` the final top-level expression is the result (REPL semantics); `undefined` becomes `null`. When the program returns, **still-running host work is interrupted, not awaited**; unhandled rejections from un-awaited promises come back as warnings.
- **Boundary data contract.** Crossing the boundary is `JSON.stringify` + a short conversion table: promises awaited, `Set` → array, `URLSearchParams` → query string, `Error` → `{name, message, …}`, `Uint8Array` rejected with an encode-as-text hint, own `__proto__` keys dropped. Depth cap 32. Unsupported syntax yields `UnsupportedSyntax` with `{line, column}`.
- **Limits.** `timeoutMs` (cooperative; fires *between* interpreter steps; no default = unlimited), `maxToolCalls`, `maxOutputBytes` (result + logs; warnings get a separate equal budget). Built-in-level bounds keep one step from materializing the unbounded: strings 2^24 chars, arrays 10,000,000 elements, 10,000 pending promises, host-side depth 32 — each exceeding case throws `RangeError`. Explicitly out of scope: **a single pathological regex match can run long**, because the host regex engine has no interrupt hook (documented gap in `interpreter-support.md`).
- **Cancellation.** Effect-based. `Effect.ensuring` interrupts the runner; a timeout that fires while a call is in flight interrupts the call; `tool.after`/`extension.after` hooks observe `{status: "interrupted"}` and cannot change the outcome. Host interruption **propagates as Effect interruption**, not as a diagnostic; everything else becomes a `Result`.
- **Failure modes / output contract.** `Result` is always plain data, never an Effect failure: `Success{ok:true,value,warnings?,logs?,truncated?,toolCalls}` or `Failure{ok:false,error:Diagnostic,logs?,truncated?,toolCalls}`. Diagnostic kinds: `ParseError`, `UnsupportedSyntax`, `UnknownTool` (with did-you-mean suggestions), `InvalidToolInput`, `InvalidToolOutput`, `InvalidDataValue`, `ToolCallLimitExceeded`, `TimeoutExceeded`, `ToolFailure`, `ExecutionFailure`, `Truncated`. `toolCalls` retains **every admitted call in order, including after failure** — the host always learns what was attempted. Notable nuance: if the program returned but background work was still alive at the timeout, the result is a success with a leading `TimeoutExceeded` warning, not a failure.
- **Hooks (authority seam).** `hooks: {"tool.before", "tool.after", "extension.before", "extension.after"}` run around every host call, with decoded input; a failing `before` **denies** the call before it reaches the host and the program sees a normal thrown/rejected error.

### (B) codex — embedded V8 isolate per cell, host-mediated nested calls

- **Sandbox technology.** `rusty_v8` isolate created per execution cell, driven on a **dedicated supervised OS thread** (`spawn_supervised_runtime_thread`, `catch_unwind`, `ThreadPanicked` event). Process-wide `initialize_v8` (`OnceLock`) with ICU data and flags `--no-maglev --no-turbolev --no-turbo-inline-array-builtins`; `V8JitMode::Disabled` adds `--jitless` (irreversible per process; a conflicting second request is an error). `v8-poc` proves the sandbox build flag and ABI separately (`linked_v8_has_sandbox()`), and is reserved for future experiments — it is not in the code-mode path.
- **Globals exposed.** A `tools` object with **one JS function per enabled tool** (callback data = stable per-cell index into `enabled_tools`), `ALL_TOOLS` (array of `{name, description}` for self-discovery), media helpers `text`, `image`, `audio`, `generatedImage`, document helpers `notify`, `yield_control`, `exit`, state helpers `store`, `load`, timers `setTimeout`/`clearTimeout`. The runtime **deletes** `console`, `Atomics`, `SharedArrayBuffer`, `WebAssembly`. `settled.js` is compiled into the isolate for promise combinators.
- **How a call inside the script reaches a real tool.** `tools.foo(input)` → V8 callback `runtime/callbacks.rs::tool_callback` → input serialized to JSON (a `toJSON`/getter may even call `exit()`, which is checked) → a `PromiseResolver` is stored in `RuntimeState.pending_tool_calls` under `tool-<n>` → `blocking_send(RuntimeEvent::ToolCall{id, name, kind, input})` up the event channel → `cell_actor` `spawn_tool` → `CellHost::invoke_tool` (cancellation token child) → protocol `CodeModeSessionDelegate::invoke_tool(CellId, invocation, token)` → the embedding process (grpc delegate → client/app-server) executes the **ordinary** tool path and returns JSON → `RuntimeCommand::ToolResponse|ToolError` → the stored resolver settles the JS promise. The isolate holds only a name, an index, JSON in, JSON out — never a lease, capability handle, or host object.
- **Limits & lifecycle.** `ExecuteRequest{yield_time_ms (default 10 s), max_output_tokens (default 10 000)}`; cells are **long-lived state machines** (`RuntimeCommand::{ToolResponse, ToolError, TimeoutFired, ObservePendingFrontier, Terminate}`, `RuntimeControlCommand::{Continue, Resume, Terminate}`, `PendingRuntimeMode::PauseUntilResumed`); `yield_control` + `WaitRequest`/`WaitToPendingRequest` let the host poll a cell; `Terminate` uses `v8::IsolateHandle::terminate_execution()` from the supervisor side; `YIELD_GRACE_PERIOD = 1 s`. `CodeModeSessionCellExecutionLimits{max_yield_time_ms, max_heap_size_bytes}` is the declared resource contract — **note the gap: `InProcessCodeModeSession::with_options` resets `max_heap_size_bytes` to `None`**, so the main cell path does not currently enforce a heap cap (only the UI helper isolate does: `heap_limits(0, 64 MiB)`).
- **Output contract.** `RuntimeResponse::{Yielded, Terminated, Pending, Result}` carrying `FunctionCallOutputContentItem`s plus `cell_id`, with `CodeModeOutputTruncation::{Client, Server}` deciding who owns the budget; the `Server` mode collects with a prefix + rolling tail, separate byte budgets for text/image/audio, an item limit, and loss notices that survive a zero-token budget. Timing (`code_mode_host_duration`, `result_buffered_for`) is attached by the host on the wire.
- **Failure modes.** Thread panic → `ThreadPanicked` + task-failure handler; tool error text → promise rejection; unpredictable paths (invalid callback data, out-of-range tool index, non-string store key, non-serializable store value) → JS `TypeError` thrown into the script; HEAP exhaustion is listed as fatal to the wielded isolate, with the parent surviving to restart it (comment in `ui/engine.rs`).

---

## 3. Tool projection and namespacing

### (A) opencode — a *derived* namespace tree plus in-language discovery

- **Projection.** Tools are declared as a record tree; **dots in names are namespace separators** and `Namespace.make({description, tools})` adds a model-visible description that participates in search for every descendant. The trie is built once (`toolTrie`) and flattened to catalog entries `{path, description, signature}`; a path can hold a tool and children at once (`tools.issues()` and `tools.issues.list()`). The last tool registered for a canonical path wins.
- **Naming.** The rendered call is always canonical, e.g. paths with non-identifier segments render as bracket access: `tools.context7["resolve-library-id"](…)` (`toolExpression`). `tools.api.issues.list`, `tools.api["issues.list"]`, and `tools["api.issues"].list` are the same canonical path — enforced by tests in `test/tool-paths.test.ts`.
- **Progressive discovery.** `search({query?, namespace?, limit?, offset?})` is a **language built-in that counts as an admitted tool call** (and is shadowable by program declarations). It matches paths, descriptions, and enclosing namespace descriptions, ranks paths/descriptions ahead of full schema rendering (signatures are lazy getters), and returns `{items:[{path,description,signature}], remaining, next:{offset}|null}` — i.e. a paginated discovery protocol, not a dump.
- **Static subset check.** `scanTools(code)` walks the AST and returns every `tools.<path>` a snippet references, in first-seen order; it **fails** on syntax errors, dynamic bracket access (`tools[name]`), or aliasing/passing `tools` instead of calling directly. This is exactly the primitive needed to enforce a "tools the snippet may call" subset at compile time, and to deny `ToolNotInSubset` before anything runs.

### (B) codex — a flat callable table plus an enumerable description array

- **Projection.** Each enabled tool gets one global function name via `normalize_code_mode_identifier(name)`; nested/dotted tool names are flattened into that identifier space (there is no `tools.a.b` object nesting in the runtime globals I read). The callback carries a **catalog index**, so names are only labels: authority and routing come from the index → `EnabledToolMetadata{global_name, tool_name, description, kind}`.
- **Discovery.** `ALL_TOOLS` is a plain array of `{name, description}` — descriptions are enumerable by the script, but contain no callable reference; the callable surface is exactly `tools`, keyed by the same names. There is no search/describe *function*; the model-side progressive discovery lives in the host/client's tool catalog, not inside the isolate.
- **Kind.** `CodeModeToolKind` distinguishes nested code-mode-visible tools from other kinds, so the host can decide scheduling/admission per call.

---

## 4. State persistence

- **opencode: none by design.** `CodeMode.execute` allocates fresh interpreter state inside `Effect.suspend` so reused Effects never share state; per-call `bindings` inject read-only JSON into the outer global scope. Any cross-run memory must be a host tool (or the host re-injecting bindings).
- **codex: yes, two levels.** (1) *In-cell*: `RuntimeState.stored_values` is mutated by `store(key, value)` (JSON-serializable only; a non-serializable value throws) and read by `load(key)`; the cell thread keeps both the pre-existing map and `stored_value_writes` for the cells' own later reads. (2) *Cross-cell / session*: `SessionRuntime::Inner.stored_values: Mutex<HashMap<String, Arc<JsonValue>>>` — cells **snapshot the keys while sharing immutable payloads**, so commits from a later cell cannot change what an earlier cell saw, and a new cell is seeded from the session map. `Result` events carry `stored_value_writes` back up so the session can commit them. State is plain JSON: no objects, no functions, no capabilities.

---

## 5. Decision for HorizonCode — docs 09 (`code_mode`), 24 (NF-015 / NF-001), and a new NF

Baseline I am deciding against: doc 09 §`code_mode` — confined JS/TS ("QuickJS-class isolate") calling tools over a typed namespaced bridge; input `{code ≤128 KiB, tools[] subset of visible, timeoutMs default 30000, outputMode}`; output `{result, toolCalls[{toolId,ms,ok}], stdout, durationMs, limitHits[]}`; capability `codemode.execute`, effect `external-effect`, perm `ask`, lease kernel + one lease per inner call; fails `ToolNotInSubset`, `IterationLimit`, `MemoryLimit`.

### 5.1 Verdict

**ADOPT (unchanged):** the capability/tool shape — `codemode.execute` + `builtin.code_mode`, `external-effect` as the *declared maximum*, `ask` per call with the subset shown, kernel lease + one lease per inner call (R-tools-32), `ToolNotInSubset` at compile time, and the "partial `toolCalls` audit table on mid-way failure" rule. Both implementations validate every part of this; nothing here needs to change.

**DEEPEN (add detail the docs lack, both implementations demonstrate as necessary):**

1. **Projection & namespacing** — copy opencode's model directly: `tools.<path>` where dots are namespace separators; namespaces carry descriptions that participate in discovery; every path has exactly one canonical spelling and non-identifier segments render as bracket access; the catalog is `{path, description, signature}` with a lazily rendered signature.
2. **Progressive discovery inside the snippet** — `search({query?, namespace?, limit?, offset?})` lowered to the *ordinary* `tool_search` pipeline (doc 09 §3.3): pipeline-admitted, counted against the snippet's call budget, paginated (`remaining`/`next.offset`), and subject to `admitTools`/session visibility — never a private registry read.
3. **Subset enforcement via static scan** — the `tools: string[]` input must be checked *both* ways: every `tools.<path>` the static scanner finds must be in the declared subset (`ToolNotInSubset`, compile time, before any effect), and the declared subset must be a subset of `visibleTools(session)` (never admit what the model was not told about). Reject dynamic access (`tools[name]`), aliasing, and passing `tools` around — that is what makes the check sound.
4. **Per-call hooks as the authority seam** — code mode must expose the equivalent of `tool.before/after` (deny-on-before-failure; after observes `success|failure|interrupted` with decoded input) so policy, telemetry, and receipts attach at the same place every other call does.
5. **State persistence as an explicit, bounded capability** — adopt the codex model: `store(key, json)`/`load(key)`, JSON-only, **session-scoped**, snapshot-per-exec so a later cell cannot retroactively change an earlier cell's view. Persisted snippet state is data, never authority, and must be receipted when it holds values produced by a mutating call.

**CHANGE (three things that are wrong or under-specified as written):**

- **C-1 — "QuickJS-class isolate" is not a confinement claim.** Replace it with a **guarantee vector** (the NF-016 shape: filesystem read/write, network egress, process tree, resource limits, credentials, workspace fence — each `enforced | best_effort | unsupported` with typed residuals). Two acceptable backends, and the doc must name which one is mandatory on which surface: (i) a **pure interpreter with an allowlisted subset** (opencode's design: no ambient I/O by construction, `UnsupportedSyntax` for anything outside the subset, boundary data as JSON), or (ii) **V8 (or another engine) with JIT/codegen disabled and ambient globals deleted** (codex's design: no `WebAssembly`, no `SharedArrayBuffer`/`Atomics`, no `console`, heap cap set). "QuickJS-class" must never be the thing that decides whether we are confined — the vector does, and NF-016 already says a caller states the minimum level per dimension and fails closed.
- **C-2 — the output contract must carry host identity, not just `{toolId, ms, ok}`.** Each inner call needs its **lease id and `EffectReceiptV1` id** (or `receiptId: null` for read-only calls), plus the ratified terminal state from RC-7 (`succeeded | failed | denied | cancelled | unknown | budget_exhausted | timeout | interrupted`). Without this, doc 09's own rule ("partial effects are visible and reconcilable") is unenforceable: ms/ok cannot be reconciled against the ledger. Add `cellId` when persistence is on.
- **C-3 — persistence and long-running cells must be first-class in the tool contract, not implicit.** Doc 09's `code_mode` is one-shot (`timeoutMs` default 30 s). Codex shows the real ergonomics: cells are actors that can pause/resume/yield and be waited on. Add `cellId?` + `action: 'exec' | 'wait' | 'terminate'` (or an equivalent explicit cell model), a `yield`/`wait` pair, and a default yield rather than a kill — with the rule that **termination never counts as settlement**: in-flight inner calls settle or become `UNKNOWN` and go to reconciliation (NF-001 + `gate:no-unknown-retry`).

**New NF: yes, one is needed.** NF-015 is the native capability stack (N-API addon, crates) and NF-001 is the execution constitution; neither is the right owner for code-mode-specific invariants (subset soundness, nested-call authority, isolate confinement vector, snippet state scope). Add a new entry — **NF-NNN, next free id** (the catalog currently references NF-001…NF-049): *"Code mode: confined programming over the tool tree, with per-nested-call authority"*. It depends on NF-001, NF-016, and (for the native engine path) NF-015; capability IDs `codemode.execute` (+ existing per-call IDs); authority impact `kernel`.

### 5.2 Concrete, testable rules to paste into the docs

| # | Rule | Test |
|---|---|---|
| CM-1 | The callable surface inside the snippet is exactly the declared subset ∩ `visibleTools(session)` ∩ the step's registry snapshot; nothing else resolves. | Attempt `tools.<path>` outside the subset → `ToolNotInSubset` before any effect; attempt a tool that is visible-but-not-declared → same. Assert zero host calls were dispatched (count host invocations). |
| CM-2 | Subset enforcement is **static and total**: dynamic access (`tools[name]`), aliasing `tools`, and computed property calls are rejected by the scanner. | Fixture snippets → `UnsupportedSyntax`/`ToolNotInSubset`; a snippet that hides a call behind `eval`/`Function` fails parse. |
| CM-3 | Every nested call re-enters the ordinary pipeline: resolve → Guard → durable prepare → **its own** one-use lease → execute → settle → receipt. The snippet never sees a lease, receipt id, or host object. | Integration test: one mutating inner call produces one `EffectReceiptV1` with `origin=SessionBatch`, its own lease id, distinct from the outer `codemode.execute` lease. |
| CM-4 | The outer `ask` shows the declared subset only, and covers exactly "run a confined program with this subset" — never the capability *classes* the subset excludes. Loops cannot widen it. | Decision-log test: a snippet looping a `files.write` tool N times yields N inner receipts, one outer decision; no extra capability appears in any decision. |
| CM-5 | Amplification is bounded before the first inner call: `maxToolCalls` (default finite), per-inner-call budget, per-step lease ceiling, and the outer tool's own timeout. | Snippet with an unbounded loop → `IterationLimit`/`ToolCallLimitExceeded` with the audit table, and lease count ≤ ceiling. |
| CM-6 | Timing out or terminating the cell **never** reports a dispatched mutation as failed-safe: every inner call ends in a terminal state, `UNKNOWN` when the transport died after dispatch, and the step reconciles. | Kill mid-call → result carries `unknown` + the inner call id; `hzcode session verify` flags the step until reconciled. |
| CM-7 | The result's audit table carries, per call: `toolId`, `toolCallId`, `leaseId`, `receiptId?`, terminal state, `ms`. Read-only calls emit no effect-claiming receipt. | Schema validation + gate: a snippet with a mutation and no receipt fails the step (R-tools-37). |
| CM-8 | Confinement is declared as a guarantee vector with typed residuals, and the operation fails closed when the host cannot meet the caller's minimum (`SandboxUnavailable`), instead of running unconfined or downgrading silently. | Force a residual (e.g. heap cap unsupported) → fail closed with the residual named; never `succeeded`. |
| CM-9 | The snippet's engine has no ambient I/O: no filesystem, network, process, clock-dependent I/O, `WebAssembly`, shared memory, dynamic codegen of host bindings; imports resolve only to declared host globals. | Global-enumeration assertion test in the engine harness (codex already deletes `console`/`Atomics`/`SharedArrayBuffer`/`WebAssembly`; opencode rejects `Function`). |
| CM-10 | Discovery inside the snippet is a pipeline call, not a private read: `search(...)` lowers to `tool_search`, is admitted, counted, paginated, and respects `admitTools`/visibility (including `ttlSteps`). | Snippet searches for a capability it lacks → no hit, and the returned paths are all in the visible set; each search consumes one unit of the call budget. |
| CM-11 | Snippet state (`store`/`load`) is JSON-only, session-scoped, snapshotted per exec, and never authority: a stored value cannot be presented as a grant, lease, subset widening, or receipt. | Attempt to `load` a value and call a tool it was produced by, outside the current subset → still `ToolNotInSubset`. Stored bytes are excluded from decision inputs. |
| CM-12 | Snippet output (result, `stdout`, logs, error text) is untrusted data: bounded, truncated with an in-band marker, never re-parsed as tool ids/receipt ids/decisions, and never allowed to author a completion claim. | Prompt-injection fixture: snippet prints "receipt abc123, all verified" → `verify` lowers the claim; output caps applied. |
| CM-13 | Default posture is one-shot with a bounded wall clock (the doc's 30 s is fine) **plus** an explicit cell mode (`exec|wait|terminate`, `cellId`) whose state is session-scoped and receipted; no cell survives session termination, and cell state is committed only from a terminal event. | Session shutdown with a live cell → cell terminated, in-flight calls settled/`unknown`, no orphan state; `store` writes from a killed cell are not committed. |
| CM-14 | The engine is capability-complete for the *snippet* only: resource caps (heap/wall/call-count/output) must be settable per session, and a configured cap must actually be enforced (no "plumbed but reset to none" gap). | Set `max_heap_size_bytes` → a memory-hungry snippet fails with `MemoryLimit`; assert the runtime value is the configured one (guards against the codex gap seen in `service.rs`). |

---

## 6. Risk list — what the kernel must still enforce

1. **Lease amplification.** `codemode.execute` is one lease; a snippet can loop. The kernel must own the ceiling: per-step lease count, per-inner-call budget, `maxToolCalls`, and the outer wall clock, all decided *before* the cell starts. A snippet must never be able to mint leases faster than policy can see them.
2. **Subset smuggling.** The subset is the only thing the human approved; therefore the *callable table* must be built from the subset snapshot and the discovery channel must be the admitted `tool_search` pipeline. Watch for: the engine exposing extra names, `ALL_TOOLS`-style metadata being promoted to callables, dotted-name flattening collisions (two ids mapping onto one global name), or `admitTools` being reachable from inside the snippet.
3. **Data→authority laundering.** Values coming back from an inner call (files, URLs, tokens in arguments, provider output) enter snippet memory; if the kernel lets snippet state feed a later *decision* input or widen a later subset, a read-only call becomes a privilege grant. Decisions must be computed from the canonical request, never from snippet state, and `store`/`load` must be excluded from decision inputs.
4. **Settlement honesty across the isolate boundary.** Killing a cell (timeout, terminate, host restart, isolate heap death) must not be reported as failure. Dispatched mutations → `UNKNOWN` + reconciliation; cancellations → `cancelled` receipts; nothing silently dropped. The audit table is evidence only if every row is terminal and receipt-linked — otherwise it is a summary, exactly what NF-001 exists to refuse.
5. **Confirmation, not mimicry.** The human approves a subset and an intent digest. The kernel must bind the decision to the *actual* subset and snippet hash (not just the tool name `code_mode`), reject a second execution that reuses that decision, and refuse `SessionBatch` origins presenting as `UserAction` (R-tools-31/38).
6. **Confinement claims.** Doc 09's "QuickJS-class isolate" must become an enforced guarantee vector with typed residuals (NF-016); fail closed when unsupported. No JIT-enabled engine with ambient host bindings, no shared memory, no dynamic codegen path around the subset scanner.
7. **Resource exhaustion as a liveness attack.** Unbounded loops, string/array materialization, pending promises, regex backtracking, heap growth. The engine's own limits must exist *and* be configured per session (the codex `max_heap_size_bytes: None` reset is exactly the failure mode to test for), because a hung cell blocks a step budget even if it never touches a resource.
8. **Output as an injection vector.** Snippet output flows to the model; it must be bounded, truncated with an explicit marker, treated as data, and never allowed to author receipt ids, tool ids, verification claims, or permission prompts.
9. **Concurrency & ordering.** Unrestricted tool-call concurrency (opencode) plus long-lived cells (codex) means a step can have many in-flight receipts at once; the kernel must sequence leases per resource, keep `at-most-once` calls honest across cell pauses, and reconcile a cell that dies between `execute` and `settle`.
10. **Session-scoped persistence.** Code-mode state must be scoped to the session, cleared/terminated with it, excluded from decision inputs, and surfaced as data in receipts when it carries mutation-derived values; a forked or resumed run must not inherit another session's cell state.
