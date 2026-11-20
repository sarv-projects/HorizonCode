/**
 * server.ts — the single-attach server (`hzcode serve`), reduced v1.
 *
 * A long-lived leader for one workspace that speaks the NDJSON JSON-RPC server
 * protocol defined ADDITIVELY in contracts.ts (HZ_PROTO / ServerRequest /
 * ServerResponse / ServerNotification / SERVER_METHODS). One request per input
 * line, one response line per request, plus `session.event` notifications that
 * carry a RuntimeEvent tagged with the owning sessionId. The transport is
 * INJECTED — `{ input, output }` — so tests drive it over in-memory pipes with
 * no real stdio; `hzcode serve` wires it to process.stdin/stdout in main.ts.
 *
 * ROLLOUT RECONSTRUCTION / DAEMON RECOVERY. Every session is opened through
 * `createRuntime`, and nowhere else. createRuntime runs BOTH crash recoveries
 * on open/resume BEFORE the first turn — `SessionStore.repairDanglingToolCalls`
 * (the TRANSCRIPT: an unanswered assistant tool_call is paired with a synthetic
 * UNKNOWN tool result — the dsh `ToolCallRecovery` pairing invariant) and
 * `AdmissionQueue.recoverInterrupted` (the ADMISSION FIFO: a `running` row left
 * by a killed turn is settled to `unknown`/`interrupted` so it halts followers
 * instead of silently replaying). So when a client attaches or resumes a
 * session that a previous process left interrupted mid-turn, the server
 * reconstructs it from the SessionStore + the append-only kernel event-log
 * before the next prompt. This maps to codex app-server's `daemon_recovery` +
 * `rollout_reconstruction` and dsh's `ToolCallRecovery`, in reduced form: the
 * server is the leader that re-derives live state from durable state on attach.
 * The kernel event log is APPEND-ONLY — the server never edits past records; a
 * resume continues forward (new events, never a mutation of old ones). Resume
 * is BY ID: `runtimeFor(id)` opens `createRuntime({ sessionId: id })`, so ANY
 * session `session.list` advertises (`hz://session/<id>`) — not just the
 * most-recently-touched one — can be prompted or subscribed; an unknown id
 * fails closed as INVALID_PARAMS.
 *
 * ALL MUTATION GOES THROUGH THE RUNTIME (S4/S49): the server owns no DB writes
 * of its own. prompt -> runtime.send, rewind -> runtime.rewindTo, fork -> runtime.forkSession, create/resume
 * -> createRuntime. The server only routes frames and fans RuntimeEvents out as
 * notifications.
 *
 * REDUCED v1 — DESIGNED extension points NOT implemented here (documented so the
 * surface is honest, see the contracts.ts block and docs/14):
 *   - transports beyond stdio (UDS/pipe, TCP loopback, HTTP/SSE/WS) — S32;
 *   - auth (S38) and the discovery/registration file (S34);
 *   - multi-client coordination: roles (S41), per-client cursors/lanes,
 *     driver-lease claim/release (S42–S44). SINGLE-ATTACH stand-in: one
 *     subscriber per session, LAST subscriber wins (a new `session.subscribe`
 *     for a session replaces the previous connection's stream for it);
 *   - remaining §3.2 method families beyond single-attach.
 *   ACP v2 agent attach lives in `acp-agent.ts` / `hzcode acp` (ruling **642**),
 *   not inside this NDJSON server protocol.
 */

import * as readline from "node:readline";
import type { Readable } from "node:stream";
import type {
  KernelMode,
  RuntimeEvent,
  ServerNotification,
  ServerResponse,
} from "../contracts";
import { HZ_PROTO, SESSION_EVENT_METHOD, SERVER_METHODS } from "../contracts";
import { createRuntime, type HzRuntime } from "./index";
import { resolveKernelBinary } from "./kernel";
import { SessionStore } from "./session";

const SERVER_VERSION = "0.1.0";

/** A line sink: the server writes one JSON frame per call (no trailing data). */
export interface LineSink {
  write(line: string): void;
}

/**
 * The injectable transport. `input` is either a Node Readable (process.stdin in
 * production) or an async iterable of chunks/lines (an in-memory test pipe);
 * `output` receives one serialized JSON object per call, newline added here.
 */
export interface ServerOptions {
  workspace: string;
  input: Readable | AsyncIterable<string | Uint8Array | Buffer>;
  output: LineSink | ((line: string) => void);
  mock?: boolean;
  model?: string;
}

export interface ServerHandle {
  /** Begin reading request lines; resolves when the input stream ends. */
  start(): Promise<void>;
  /** Close every live runtime and stop reading. Idempotent. */
  stop(): Promise<void>;
  /** The session ids this process has brought live (for tests/supervision). */
  sessionIds(): string[];
}

type JsonRpcError = { code?: number; message: string };

/** docs/14 §3.2 spirit: unknown method is a typed error, never ignored (S89). */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Parse method name for dispatch policy (interject may bypass prompt queue blocking). */
function requestMethod(line: string): string {
  const trimmed = line.trim();
  if (trimmed === "") return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.method === "string" ? parsed.method : "";
  } catch {
    return "";
  }
}

function interjectBypassesQueue(method: string): boolean {
  return method === "session.interject";
}

class ServerError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * D-6 / ruling 492 — canonical hermes-style turn frames (ADDITIVE).
 *
 * The existing `session.event` notification carries the RuntimeEvent verbatim
 * and is UNCHANGED: existing single-attach clients keep working byte-for-byte.
 * In addition, every RuntimeEvent is mapped to zero or more canonical frames
 * published on a SEPARATE `session.frame` notification method. A client that
 * does not know that method ignores it; a client that opts in sees the hermes
 * U3 frame vocabulary (delta / tool.start / approval / clarify / result /
 * finished) instead of having to infer turn structure from raw RuntimeEvents.
 *
 * Mapping table (pure, deterministic, one pass per event):
 *
 *   RuntimeEvent                     frame kind(s)
 *   -------------------------------- | ----------------------------------
 *   assistant.delta                  delta       — streamed assistant text
 *   assistant.thinking               delta       — display-only reasoning stream
 *   tool.card {status:running}       tool.start  — a tool invocation began
 *   tool.card {status:ok|error}      result      — that tool's outcome
 *   approval                         approval    — typed approval question (D-6)
 *   clarify                          clarify     — typed clarification question (D-6)
 *   notice "approval: …"            approval    — legacy prefix projection (compat)
 *   notice "clarify: …"             clarify     — legacy prefix projection (compat)
 *   assistant.done                   result      — final assistant text of the turn
 *   error                            result      — status "error"
 *   turn.done                        finished    — the turn boundary
 *   every other event                (no frame)
 *
 * D-6 adds dedicated `approval` / `clarify` RuntimeEvent variants (contracts.ts)
 * emitted from the real loop paths; those map directly below. The legacy
 * `notice` prefix projection (constants below) is KEPT for additive
 * compatibility with older producers: an ordinary notice still emits no frame.
 * Nothing here mutates providers or the RuntimeEvent stream — the frame set is
 * a derived, additive projection.
 */
export const SESSION_FRAME_METHOD = "session.frame" as const;
export const SERVER_FRAME_KINDS = [
  "delta",
  "tool.start",
  "approval",
  "clarify",
  "result",
  "finished",
] as const;
export type ServerFrameKind = (typeof SERVER_FRAME_KINDS)[number];

/** `notice` message prefixes that project to the user-input frame kinds. */
export const APPROVAL_NOTICE_PREFIX = "approval:";
export const CLARIFY_NOTICE_PREFIX = "clarify:";

export interface ServerTurnFrame {
  kind: ServerFrameKind;
  sessionId: string;
  /** Originating RuntimeEvent type (provenance for additive consumers). */
  source: RuntimeEvent["type"];
  /** delta / result: streamed or final text. */
  text?: string;
  /** tool.start / result: tool identity. */
  callId?: string;
  name?: string;
  args?: Record<string, unknown>;
  /** approval / clarify: the user-facing prompt. */
  message?: string;
  /** result: outcome status ("ok" | "error"). */
  status?: string;
}

/** Project one RuntimeEvent into zero or more canonical hermes-style frames. */
export function mapRuntimeEventToFrames(ev: RuntimeEvent, sessionId: string): ServerTurnFrame[] {
  switch (ev.type) {
    case "assistant.delta":
    case "assistant.thinking":
      return [{ kind: "delta", sessionId, source: ev.type, text: ev.text }];
    case "tool.card":
      return ev.status === "running"
        ? [
            {
              kind: "tool.start",
              sessionId,
              source: ev.type,
              callId: ev.callId,
              name: ev.name,
              args: ev.args,
            },
          ]
        : [
            {
              kind: "result",
              sessionId,
              source: ev.type,
              callId: ev.callId,
              name: ev.name,
              status: ev.status,
              ...(ev.summary !== undefined ? { text: ev.summary } : {}),
            },
          ];
    case "approval":
      return [
        {
          kind: "approval",
          sessionId,
          source: ev.type,
          message: ev.message,
          ...(ev.callId !== undefined ? { callId: ev.callId } : {}),
          ...(ev.tool !== undefined ? { name: ev.tool } : {}),
        },
      ];
    case "clarify":
      return [
        { kind: "clarify", sessionId, source: ev.type, message: ev.message },
      ];
    case "notice":
      if (ev.message.startsWith(APPROVAL_NOTICE_PREFIX)) {
        return [
          {
            kind: "approval",
            sessionId,
            source: ev.type,
            message: ev.message.slice(APPROVAL_NOTICE_PREFIX.length).trim(),
          },
        ];
      }
      if (ev.message.startsWith(CLARIFY_NOTICE_PREFIX)) {
        return [
          {
            kind: "clarify",
            sessionId,
            source: ev.type,
            message: ev.message.slice(CLARIFY_NOTICE_PREFIX.length).trim(),
          },
        ];
      }
      return [];
    case "assistant.done":
      return [{ kind: "result", sessionId, source: ev.type, text: ev.text }];
    case "error":
      return [{ kind: "result", sessionId, source: ev.type, text: ev.message, status: "error" }];
    case "turn.done":
      return [{ kind: "finished", sessionId, source: ev.type }];
    default:
      return [];
  }
}

export function createServer(opts: ServerOptions): ServerHandle {
  const writeLine: (line: string) => void =
    typeof opts.output === "function" ? opts.output : (line: string) => opts.output && (opts.output as LineSink).write(line);

  // One runtime per session, brought up lazily via createRuntime (the recovery
  // seam). `order` preserves first-seen order for sessionIds().
  const runtimes = new Map<string, HzRuntime>();
  const order: string[] = [];
  // Single-attach: the sessions this connection has explicitly subscribed to
  // (last subscriber wins — there is one connection). A turn's events stream to
  // this connection whether or not the session is here; the set records intent
  // for ongoing notification and is the seam a multi-client server would key
  // per-connection fan-out on (S42–S44, not in v1).
  const subscribed = new Set<string>();
  let stopped = false;
  let kernelMode: KernelMode | undefined;

  function send(obj: ServerResponse | ServerNotification): void {
    try {
      writeLine(JSON.stringify(obj) + "\n");
    } catch {
      /* a serialization/transport failure must not crash the loop */
    }
  }

  function notify(sessionId: string, ev: RuntimeEvent): void {
    // The streamed event is the RuntimeEvent verbatim, tagged with its session
    // (contracts.ts: `session.event` notification carrying a RuntimeEvent). On
    // this single-attach connection a turn's events always stream: `subscribe`
    // additionally marks a session for ongoing notification, but a `prompt`
    // alone streams its own turn to whoever is attached to this connection.
    // NOTE (v1): `subscribed` is NOT consulted here — on one connection every
    // turn's events stream unconditionally. The set records subscribe intent
    // and is the seam a multi-client server (S42–S44) would key per-connection
    // fan-out on; it deliberately does not gate notification in single-attach.
    const params = { sessionId, event: ev };
    send({ method: SESSION_EVENT_METHOD, params } satisfies ServerNotification);
    // ADDITIVE (D-6 / ruling 492): publish the canonical frame projection on a
    // separate method. The `session.event` line above is byte-identical to the
    // pre-existing stream, so single-attach clients that only read it are
    // unaffected; `session.frame` is opt-in by simply reading that method.
    for (const frame of mapRuntimeEventToFrames(ev, sessionId)) {
      send({ method: SESSION_FRAME_METHOD, params: frame } satisfies ServerNotification);
    }
  }

  /** Open a FRESH session (session.create). Resume-by-id lives in runtimeFor. */
  async function openFresh(): Promise<HzRuntime> {
    // createRuntime with neither sessionId nor continueSession starts a new
    // session; it still runs both crash recoveries (a no-op on fresh rows).
    const runtime = await createRuntime({
      workspace: opts.workspace,
      model: opts.model,
      mock: opts.mock === true,
    });
    kernelMode = runtime.kernelMode;
    const id = runtime.sessionId;
    if (!runtimes.has(id)) order.push(id);
    runtimes.set(id, runtime);
    return runtime;
  }

  /** Resolve the live/opened runtime a method targets by sessionId. */
  async function runtimeFor(sessionId: string): Promise<HzRuntime> {
    const live = runtimes.get(sessionId);
    if (live !== undefined) return live;
    // Not live in this process yet: resume THAT SPECIFIC session from disk
    // (createRuntime's recovery runs here — the rollout reconstruction seam).
    // createRuntime({ sessionId }) opens the requested id by id, so ANY session
    // `session.list` advertised — not just the most-recently-touched one — can
    // be prompted/subscribed. A sessionId unknown to this workspace fails closed
    // inside createRuntime; surface it as INVALID_PARAMS, not an INTERNAL_ERROR.
    let runtime: HzRuntime;
    try {
      runtime = await createRuntime({
        workspace: opts.workspace,
        model: opts.model,
        mock: opts.mock === true,
        sessionId,
      });
    } catch (err) {
      throw new ServerError(
        INVALID_PARAMS,
        `cannot resume session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    kernelMode = runtime.kernelMode;
    const id = runtime.sessionId;
    if (!runtimes.has(id)) order.push(id);
    runtimes.set(id, runtime);
    return runtime;
  }

  /**
   * Before any session exists the real mode is not known yet, but it is not
   * "unknown" either: createRuntime starts the Rust kernel exactly when
   * resolveKernelBinary finds one (side-effect free, no state dir touched), and
   * otherwise runs the local fallback. A session opened later reports the
   * measured mode and takes over.
   */
  function predictKernelMode(): KernelMode {
    return resolveKernelBinary() !== undefined ? "trusted" : "untrusted";
  }

  async function handleHello(): Promise<unknown> {
    // Reduced S35 handshake shape: the proto/version a client verifies against,
    // the workspace, the kernel mode and the implemented capabilities.
    return {
      proto: HZ_PROTO,
      version: SERVER_VERSION,
      workspace: opts.workspace,
      kernelMode: kernelMode ?? predictKernelMode(),
      capabilities: { methods: [...SERVER_METHODS], transports: ["stdio"], singleAttach: true },
    };
  }

  async function handleCreate(): Promise<unknown> {
    const runtime = await openFresh();
    return {
      sessionId: runtime.sessionId,
      model: runtime.model,
      providerName: runtime.providerName,
      kernelMode: runtime.kernelMode,
    };
  }

  async function handleList(): Promise<unknown> {
    // READ-ONLY: `session.list` must never create or touch a session. A live
    // runtime can list from its own store; otherwise open a SessionStore
    // directly for a read and close it — NOT createRuntime, which would fall
    // through continueSession -> latestSession() -> createSession() and
    // materialize an empty session on a workspace that has none.
    const live = runtimes.size > 0 ? [...runtimes.values()][0] : undefined;
    let infos;
    if (live !== undefined) {
      infos = live.sessions();
    } else {
      const store = new SessionStore(opts.workspace);
      try {
        infos = store.listSessions();
      } finally {
        store.close();
      }
    }
    // docs/14 S8: a session's identity is `hz://session/<id>`.
    const sessions = infos.map((s) => ({
      uri: `hz://session/${s.id}`,
      id: s.id,
      title: s.title,
      created: s.created,
      updated: s.updated,
      // Fork lineage (additive): present only on a fork.
      ...(s.forkedFrom !== undefined
        ? {
            forkedFrom: {
              uri: `hz://session/${s.forkedFrom.sessionId}`,
              sessionId: s.forkedFrom.sessionId,
              messageIndex: s.forkedFrom.messageIndex,
              parentSeq: s.forkedFrom.parentSeq,
            },
          }
        : {}),
    }));
    return { sessions };
  }

  function requireSessionId(params: unknown): string {
    if (!isRecord(params) || typeof params.sessionId !== "string" || params.sessionId === "") {
      throw new ServerError(INVALID_PARAMS, "sessionId (string) is required");
    }
    return params.sessionId;
  }

  async function handleSubscribe(params: unknown): Promise<unknown> {
    const sessionId = requireSessionId(params);
    // Bring the session live (resume + recover) so a subscriber attaching to an
    // interrupted session triggers reconstruction immediately, before any
    // prompt — single-attach: this connection replaces any prior subscriber.
    const runtime = await runtimeFor(sessionId);
    subscribed.add(runtime.sessionId);
    return { sessionId: runtime.sessionId, subscribed: true };
  }

  async function handlePrompt(params: unknown): Promise<unknown> {
    const sessionId = requireSessionId(params);
    if (!isRecord(params) || typeof params.text !== "string") {
      throw new ServerError(INVALID_PARAMS, "text (string) is required");
    }
    const text = params.text;
    const runtime = await runtimeFor(sessionId);
    const id = runtime.sessionId;
    // Every RuntimeEvent is fanned out as a `session.event` notification tagged
    // with the session. A subscriber is not required — a prompt alone streams
    // its own events to whoever is attached to this session.
    const result = await runtime.send(text, { onEvent: (ev) => notify(id, ev) });
    return { sessionId: id, text: result.text, aborted: result.aborted, exit: result.exit };
  }

  async function handleRewind(params: unknown): Promise<unknown> {
    const sessionId = requireSessionId(params);
    if (!isRecord(params) || typeof params.n !== "number" || !Number.isFinite(params.n)) {
      throw new ServerError(INVALID_PARAMS, "n (number) is required");
    }
    const n = params.n;
    const runtime = await runtimeFor(sessionId);
    if (typeof runtime.rewindTo !== "function") {
      throw new ServerError(INTERNAL_ERROR, "this build does not support rewind");
    }
    const summary = await runtime.rewindTo(n);
    return { sessionId: runtime.sessionId, summary };
  }

  async function handleInterject(params: unknown): Promise<unknown> {
    const sessionId = requireSessionId(params);
    if (!isRecord(params) || typeof params.text !== "string") {
      throw new ServerError(INVALID_PARAMS, "text (string) is required");
    }
    const runtime = await runtimeFor(sessionId);
    if (typeof runtime.interject !== "function") {
      throw new ServerError(INTERNAL_ERROR, "this build does not support interject");
    }
    const images = Array.isArray(params.images) ? params.images : undefined;
    const outcome = runtime.interject(params.text, images !== undefined ? { images } : undefined);
    return { sessionId: runtime.sessionId, ...outcome };
  }

  async function handleFork(params: unknown): Promise<unknown> {
    const sessionId = requireSessionId(params);
    let at: number | undefined;
    if (isRecord(params) && params.at !== undefined) {
      if (typeof params.at !== "number" || !Number.isInteger(params.at) || params.at < 0) {
        throw new ServerError(INVALID_PARAMS, "at must be a non-negative integer message index");
      }
      at = params.at;
    }
    const parent = await runtimeFor(sessionId);
    if (typeof parent.forkSession !== "function") {
      throw new ServerError(INTERNAL_ERROR, "this build does not support fork");
    }
    const child = await parent.forkSession(at);
    // Resume the child through the ordinary by-id path (recovery runs).
    const runtime = await runtimeFor(child.id);
    return {
      sessionId: runtime.sessionId,
      uri: `hz://session/${runtime.sessionId}`,
      forkedFrom: {
        uri: `hz://session/${sessionId}`,
        sessionId,
        messageIndex: child.forkedFrom?.messageIndex ?? 0,
        parentSeq: child.forkedFrom?.parentSeq ?? 0,
      },
      model: runtime.model,
      providerName: runtime.providerName,
      kernelMode: runtime.kernelMode,
    };
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "server.hello":
        return handleHello();
      case "session.create":
        return handleCreate();
      case "session.list":
        return handleList();
      case "session.subscribe":
        return handleSubscribe(params);
      case "session.prompt":
        return handlePrompt(params);
      case "session.rewind":
        return handleRewind(params);
      case "session.fork":
        return handleFork(params);
      case "session.interject":
        return handleInterject(params);
      default:
        // S89 spirit: an unknown method is a typed error, never ignored.
        throw new ServerError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let id: number | string | null = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A malformed frame cannot be correlated to an id; answer with JSON null
      // (the JSON-RPC unmatchable id), NOT 0 — `0` is a legal correlation id
      // and would collide with a real request. contracts.ts ServerResponse.id
      // permits null for exactly this uncorrelated case.
      send({ id: null, error: { code: INVALID_PARAMS, message: "invalid JSON request line" } });
      return;
    }
    if (!isRecord(parsed) || (typeof parsed.id !== "number" && typeof parsed.id !== "string")) {
      // Same: a frame with no scalar id cannot be correlated — answer with null.
      send({ id: null, error: { code: INVALID_PARAMS, message: "request needs a numeric or string id" } });
      return;
    }
    id = parsed.id;
    const method = typeof parsed.method === "string" ? parsed.method : "";
    if (method === "") {
      send({ id, error: { code: INVALID_PARAMS, message: "request needs a method" } });
      return;
    }
    try {
      const result = await dispatch(method, parsed.params);
      send({ id, result });
    } catch (err) {
      const e: JsonRpcError =
        err instanceof ServerError
          ? { code: err.code, message: err.message }
          : { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) };
      send({ id, error: e });
    }
  }

  async function start(): Promise<void> {
    const input = opts.input;
    // A Node Readable gets a line reader; an async iterable of lines/bytes is
    // consumed directly (tests push lines; stdio pushes a byte stream).
    if (typeof (input as Readable).on === "function" && typeof (input as Readable).pipe === "function") {
      const rl = readline.createInterface({ input: input as Readable, crlfDelay: Infinity, terminal: false });
      // Serialize line handling so responses keep request order per connection.
      let chain: Promise<void> = Promise.resolve();
      await new Promise<void>((resolve) => {
        rl.on("line", (line: string) => {
          if (interjectBypassesQueue(requestMethod(line))) {
            void handleLine(line).catch(() => undefined);
            return;
          }
          chain = chain.then(() => handleLine(line)).catch(() => undefined);
        });
        rl.on("close", () => {
          void chain.then(() => resolve());
        });
        rl.on("error", () => {
          void chain.then(() => resolve());
        });
      });
      return;
    }
    // Async-iterable transport: chunks may be whole lines or arbitrary byte
    // slices, so buffer and split on newlines.
    let buf = "";
    let chain = Promise.resolve();
    for await (const chunk of input as AsyncIterable<string | Uint8Array | Buffer>) {
      if (stopped) break;
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (interjectBypassesQueue(requestMethod(line))) {
          void handleLine(line).catch(() => undefined);
        } else {
          chain = chain.then(() => handleLine(line));
        }
        nl = buf.indexOf("\n");
      }
    }
    if (buf.trim() !== "") {
      if (interjectBypassesQueue(requestMethod(buf))) {
        void handleLine(buf).catch(() => undefined);
      } else {
        chain = chain.then(() => handleLine(buf));
      }
    }
    await chain;
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    subscribed.clear();
    const live = [...runtimes.values()];
    runtimes.clear();
    order.length = 0;
    await Promise.all(
      live.map((runtime) =>
        Promise.resolve()
          .then(() => runtime.close())
          .catch(() => undefined),
      ),
    );
  }

  return {
    start,
    stop,
    sessionIds: () => [...order],
  };
}
