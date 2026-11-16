/**
 * owner-worker-control-pipe.ts — C-12 reduced framed owner/worker control pipe
 * (docs/30 C-12 / NF-071 remainder after ruling 22).
 *
 * Pure protocol only: closed versioned bootstrap, worker hello / identity
 * handshake, and NDJSON turn frames. Owner verifies identity BEFORE any work
 * reservation. No spawnOwned wiring, no loop.ts dispatch, no real OS pipe —
 * callers drive encode/decode over bytes they already own.
 *
 * ADAPT (idea only) from hermes-agent managed_worker bootstrap/hello framing
 * (audit/pass3/audit-hermes-report.md U2/U3 items 13–14; repo not cloned).
 * Birth identity uses ruling-22 `{pid, startTicks}` vocabulary.
 *
 * Residuals (named): product owner↔worker spawn + stdio pipe; ancestor-chain
 * proving; full D-6 RuntimeEvent publish path; FIFO reserve wiring.
 */

import type { ProcessIdentity } from "./worker-identity";
import { verifyIdentity } from "./worker-identity";

/** Wire protocol version for bootstrap + every subsequent frame. */
export const OWNER_WORKER_CONTROL_PIPE_V = 1 as const;

/** Hermes-style hard cap: refuse a single frame above 4 MiB. */
export const OWNER_WORKER_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Closed bootstrap field set (no extras). */
export const BOOTSTRAP_KEYS = [
  "v",
  "kind",
  "profileId",
  "sessionId",
  "executionId",
  "generation",
  "pid",
  "startTicks",
  "secret",
  "epoch",
] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

export interface OwnerWorkerBootstrap {
  v: typeof OWNER_WORKER_CONTROL_PIPE_V;
  kind: "bootstrap";
  profileId: string;
  sessionId: string;
  executionId: string;
  generation: number;
  /** Expected worker pid at reservation time (owner-side record). */
  pid: number;
  /** Expected /proc startTicks birth (ruling 22). */
  startTicks: number;
  /** Shared one-shot secret; mismatch refuses the handshake. */
  secret: string;
  /** Owner epoch; worker hello must echo the same epoch. */
  epoch: number;
}

/** Closed hello field set (worker → owner). */
export const HELLO_KEYS = [
  "v",
  "kind",
  "executionId",
  "pid",
  "startTicks",
  "secret",
  "epoch",
] as const;

export interface OwnerWorkerHello {
  v: typeof OWNER_WORKER_CONTROL_PIPE_V;
  kind: "hello";
  executionId: string;
  pid: number;
  startTicks: number;
  secret: string;
  epoch: number;
}

/** Closed turn-frame kinds (D-6 / hermes U3 reduced set). */
export const TURN_FRAME_KINDS = [
  "delta",
  "tool.start",
  "tool.complete",
  "approval",
  "clarify",
  "result",
  "finished",
] as const;

export type TurnFrameKind = (typeof TURN_FRAME_KINDS)[number];

export interface OwnerWorkerTurnFrame {
  v: typeof OWNER_WORKER_CONTROL_PIPE_V;
  kind: TurnFrameKind;
  executionId: string;
  /** Opaque payload; shape left to the product publisher. */
  payload?: unknown;
}

export type OwnerWorkerFrame = OwnerWorkerBootstrap | OwnerWorkerHello | OwnerWorkerTurnFrame;

export type DecodeOk<T> = { ok: true; value: T };
export type DecodeErr = { ok: false; reason: string };
export type DecodeResult<T> = DecodeOk<T> | DecodeErr;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function refuseUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
): DecodeErr | undefined {
  const allow = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allow.has(key)) {
      return { ok: false, reason: `unknown field: ${key}` };
    }
  }
  return undefined;
}

function requireNonEmptyString(raw: Record<string, unknown>, key: string): string | DecodeErr {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: `missing or empty ${key}` };
  }
  return value;
}

function requirePositiveInt(raw: Record<string, unknown>, key: string): number | DecodeErr {
  const value = raw[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return { ok: false, reason: `missing or invalid ${key}` };
  }
  return value as number;
}

function requireNonNegInt(raw: Record<string, unknown>, key: string): number | DecodeErr {
  const value = raw[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    return { ok: false, reason: `missing or invalid ${key}` };
  }
  return value as number;
}

function checkVersion(raw: Record<string, unknown>): DecodeErr | undefined {
  if (raw.v !== OWNER_WORKER_CONTROL_PIPE_V) {
    return { ok: false, reason: `unsupported protocol version: ${String(raw.v)}` };
  }
  return undefined;
}

/** Build a closed bootstrap frame (owner → worker, first frame on the pipe). */
export function makeBootstrap(input: {
  profileId: string;
  sessionId: string;
  executionId: string;
  generation: number;
  identity: ProcessIdentity;
  secret: string;
  epoch: number;
}): OwnerWorkerBootstrap {
  return {
    v: OWNER_WORKER_CONTROL_PIPE_V,
    kind: "bootstrap",
    profileId: input.profileId,
    sessionId: input.sessionId,
    executionId: input.executionId,
    generation: input.generation,
    pid: input.identity.pid,
    startTicks: input.identity.startTicks,
    secret: input.secret,
    epoch: input.epoch,
  };
}

/** Build a closed hello frame (worker → owner) echoing bootstrap scope. */
export function makeHello(input: {
  executionId: string;
  identity: ProcessIdentity;
  secret: string;
  epoch: number;
}): OwnerWorkerHello {
  return {
    v: OWNER_WORKER_CONTROL_PIPE_V,
    kind: "hello",
    executionId: input.executionId,
    pid: input.identity.pid,
    startTicks: input.identity.startTicks,
    secret: input.secret,
    epoch: input.epoch,
  };
}

export function makeTurnFrame(input: {
  kind: TurnFrameKind;
  executionId: string;
  payload?: unknown;
}): OwnerWorkerTurnFrame {
  return {
    v: OWNER_WORKER_CONTROL_PIPE_V,
    kind: input.kind,
    executionId: input.executionId,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };
}

/** Encode one frame as a single NDJSON line (no trailing newline in return). */
export function encodeFrame(frame: OwnerWorkerFrame): DecodeResult<string> {
  const line = JSON.stringify(frame);
  if (utf8ByteLength(line) > OWNER_WORKER_MAX_FRAME_BYTES) {
    return { ok: false, reason: `frame exceeds ${OWNER_WORKER_MAX_FRAME_BYTES} bytes` };
  }
  return { ok: true, value: line };
}

export function decodeBootstrap(raw: unknown): DecodeResult<OwnerWorkerBootstrap> {
  if (!isPlainObject(raw)) return { ok: false, reason: "bootstrap must be an object" };
  const unknown = refuseUnknownKeys(raw, BOOTSTRAP_KEYS);
  if (unknown) return unknown;
  const version = checkVersion(raw);
  if (version) return version;
  if (raw.kind !== "bootstrap") return { ok: false, reason: `expected kind bootstrap, got ${String(raw.kind)}` };

  const profileId = requireNonEmptyString(raw, "profileId");
  if (typeof profileId !== "string") return profileId;
  const sessionId = requireNonEmptyString(raw, "sessionId");
  if (typeof sessionId !== "string") return sessionId;
  const executionId = requireNonEmptyString(raw, "executionId");
  if (typeof executionId !== "string") return executionId;
  const secret = requireNonEmptyString(raw, "secret");
  if (typeof secret !== "string") return secret;
  const generation = requireNonNegInt(raw, "generation");
  if (typeof generation !== "number") return generation;
  const pid = requirePositiveInt(raw, "pid");
  if (typeof pid !== "number") return pid;
  const startTicks = requirePositiveInt(raw, "startTicks");
  if (typeof startTicks !== "number") return startTicks;
  const epoch = requireNonNegInt(raw, "epoch");
  if (typeof epoch !== "number") return epoch;

  return {
    ok: true,
    value: {
      v: OWNER_WORKER_CONTROL_PIPE_V,
      kind: "bootstrap",
      profileId,
      sessionId,
      executionId,
      generation,
      pid,
      startTicks,
      secret,
      epoch,
    },
  };
}

export function decodeHello(raw: unknown): DecodeResult<OwnerWorkerHello> {
  if (!isPlainObject(raw)) return { ok: false, reason: "hello must be an object" };
  const unknown = refuseUnknownKeys(raw, HELLO_KEYS);
  if (unknown) return unknown;
  const version = checkVersion(raw);
  if (version) return version;
  if (raw.kind !== "hello") return { ok: false, reason: `expected kind hello, got ${String(raw.kind)}` };

  const executionId = requireNonEmptyString(raw, "executionId");
  if (typeof executionId !== "string") return executionId;
  const secret = requireNonEmptyString(raw, "secret");
  if (typeof secret !== "string") return secret;
  const pid = requirePositiveInt(raw, "pid");
  if (typeof pid !== "number") return pid;
  const startTicks = requirePositiveInt(raw, "startTicks");
  if (typeof startTicks !== "number") return startTicks;
  const epoch = requireNonNegInt(raw, "epoch");
  if (typeof epoch !== "number") return epoch;

  return {
    ok: true,
    value: {
      v: OWNER_WORKER_CONTROL_PIPE_V,
      kind: "hello",
      executionId,
      pid,
      startTicks,
      secret,
      epoch,
    },
  };
}

const TURN_KIND_SET = new Set<string>(TURN_FRAME_KINDS);
const TURN_KEYS = ["v", "kind", "executionId", "payload"] as const;

export function decodeTurnFrame(raw: unknown): DecodeResult<OwnerWorkerTurnFrame> {
  if (!isPlainObject(raw)) return { ok: false, reason: "turn frame must be an object" };
  const unknown = refuseUnknownKeys(raw, TURN_KEYS);
  if (unknown) return unknown;
  const version = checkVersion(raw);
  if (version) return version;
  if (typeof raw.kind !== "string" || !TURN_KIND_SET.has(raw.kind)) {
    return { ok: false, reason: `unknown turn kind: ${String(raw.kind)}` };
  }
  const executionId = requireNonEmptyString(raw, "executionId");
  if (typeof executionId !== "string") return executionId;
  return {
    ok: true,
    value: {
      v: OWNER_WORKER_CONTROL_PIPE_V,
      kind: raw.kind as TurnFrameKind,
      executionId,
      ...(Object.prototype.hasOwnProperty.call(raw, "payload") ? { payload: raw.payload } : {}),
    },
  };
}

/** Decode one NDJSON line into the matching closed frame type. */
export function decodeFrameLine(line: string): DecodeResult<OwnerWorkerFrame> {
  if (utf8ByteLength(line) > OWNER_WORKER_MAX_FRAME_BYTES) {
    return { ok: false, reason: `frame exceeds ${OWNER_WORKER_MAX_FRAME_BYTES} bytes` };
  }
  const trimmed = line.trim();
  if (trimmed === "") return { ok: false, reason: "empty frame" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "frame is not JSON" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "frame must be an object" };
  if (parsed.kind === "bootstrap") return decodeBootstrap(parsed);
  if (parsed.kind === "hello") return decodeHello(parsed);
  return decodeTurnFrame(parsed);
}

export type HandshakeState = "awaiting_hello" | "verified" | "refused";

export interface HandshakeVerdict {
  ok: boolean;
  state: HandshakeState;
  reason?: string;
  identity?: ProcessIdentity;
}

/**
 * Owner-side handshake: after bootstrap is issued, accept ONE hello and verify
 * identity + secret + epoch BEFORE any work may be reserved.
 *
 * `liveProcCheck` defaults to `/proc` verifyIdentity (ruling 22). Tests may
 * inject a stub when /proc is unavailable or identity is synthetic.
 */
export class OwnerWorkerHandshake {
  readonly bootstrap: OwnerWorkerBootstrap;
  #state: HandshakeState = "awaiting_hello";
  #reason?: string;
  #verified?: ProcessIdentity;
  readonly #liveProcCheck: (identity: ProcessIdentity) => { ok: boolean; reason?: string };

  constructor(
    bootstrap: OwnerWorkerBootstrap,
    opts?: {
      liveProcCheck?: (identity: ProcessIdentity) => { ok: boolean; reason?: string };
    },
  ) {
    this.bootstrap = bootstrap;
    this.#liveProcCheck = opts?.liveProcCheck ?? ((id) => verifyIdentity(id));
  }

  get state(): HandshakeState {
    return this.#state;
  }

  get refuseReason(): string | undefined {
    return this.#reason;
  }

  /** True only after a verified hello — the C-12 "before work is reserved" gate. */
  get mayReserveWork(): boolean {
    return this.#state === "verified";
  }

  acceptHello(raw: unknown): HandshakeVerdict {
    if (this.#state === "verified") {
      return { ok: false, state: this.#state, reason: "hello already accepted" };
    }
    if (this.#state === "refused") {
      return { ok: false, state: this.#state, reason: this.#reason ?? "handshake refused" };
    }

    const decoded = decodeHello(raw);
    if (decoded.ok === false) {
      return this.#refuse(decoded.reason);
    }
    const hello = decoded.value;
    if (hello.executionId !== this.bootstrap.executionId) {
      return this.#refuse("executionId mismatch");
    }
    if (hello.secret !== this.bootstrap.secret) {
      return this.#refuse("secret mismatch");
    }
    if (hello.epoch !== this.bootstrap.epoch) {
      return this.#refuse("stale or mismatched epoch");
    }
    if (hello.pid !== this.bootstrap.pid || hello.startTicks !== this.bootstrap.startTicks) {
      return this.#refuse("identity mismatch against bootstrap");
    }

    const identity: ProcessIdentity = { pid: hello.pid, startTicks: hello.startTicks };
    const live = this.#liveProcCheck(identity);
    if (!live.ok) {
      return this.#refuse(live.reason ?? "live identity check failed");
    }

    this.#state = "verified";
    this.#verified = identity;
    return { ok: true, state: "verified", identity };
  }

  /** Explicit reserve gate used by tests / future owner wiring. */
  reserveWork(): DecodeResult<{ executionId: string; identity: ProcessIdentity }> {
    if (!this.mayReserveWork || this.#verified === undefined) {
      return {
        ok: false,
        reason: this.#reason ?? "identity handshake incomplete; work not reserved",
      };
    }
    return {
      ok: true,
      value: { executionId: this.bootstrap.executionId, identity: this.#verified },
    };
  }

  #refuse(reason: string): HandshakeVerdict {
    this.#state = "refused";
    this.#reason = reason;
    return { ok: false, state: "refused", reason };
  }
}

/**
 * Incremental NDJSON line splitter for a control pipe byte stream.
 * Incomplete trailing lines stay buffered; complete lines are drained decoded.
 */
export class ControlPipeFramer {
  #buffer = "";

  push(chunk: string | Uint8Array): DecodeResult<OwnerWorkerFrame>[] {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    this.#buffer += text;
    const out: DecodeResult<OwnerWorkerFrame>[] = [];
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      out.push(decodeFrameLine(line));
    }
    return out;
  }

  /** Decode a final incomplete line if the peer closed mid-frame. */
  flush(): DecodeResult<OwnerWorkerFrame> | undefined {
    if (this.#buffer.trim() === "") {
      this.#buffer = "";
      return undefined;
    }
    const line = this.#buffer;
    this.#buffer = "";
    return decodeFrameLine(line);
  }
}
