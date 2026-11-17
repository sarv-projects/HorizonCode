/**
 * responses-steer-wire.ts — the real OpenAI Responses WebSocket `response.steer`
 * wire for C-9.
 *
 * Protocol (developers.openai.com/api/docs/guides/steering, verified 2026-11-17):
 *  - connect to `wss://api.openai.com/v1/responses` with Bearer auth;
 *  - `response.create` starts a response; the server sends `response.created`
 *    with the response id;
 *  - a client `response.steer` may then queue `input` for that response, keyed by
 *    `previous_response_id` (ONLY these three fields are legal);
 *  - `response.steer.accepted` means queued (not yet applied); `pending` means
 *    queued but the server needs tool results/approval; `failed` means it will
 *    not be applied. Accepted input is connection-local: a disconnect loses it.
 *
 * This module owns ONLY the wire + acknowledgement semantics. Callers keep the
 * existing `LiveSteeringChannel` claim/accept/reject ordering; `pumpResponsesSteering`
 * is the bridge that turns a claimed steer into a wire send (and rejects on a
 * failure so the step-boundary drain still delivers the user's text).
 *
 * No dependency: the WebSocket constructor is injected (Bun's global WebSocket
 * is the default), so the hermetic tests use a fake socket and never touch the
 * network. A live opt-in test uses OPENAI_API_KEY + GPT-6 (steering is only
 * supported by the GPT-6 family).
 */

import type { LiveSteering, LiveSteerClaim } from "../../contracts";

export const RESPONSES_WS_URL = "wss://api.openai.com/v1/responses";
/** Steering is only available on GPT-6-class models over the WebSocket API. */
export const RESPONSES_STEER_MODELS = ["gpt-6-astra"];

export interface SteerSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

export type SteerSocketFactory = (url: string, headers: Record<string, string>) => SteerSocket;

export interface SteerResult {
  accepted: boolean;
  /** Server-assigned id, present on accepted/pending. */
  steerId?: string;
  /** `pending` means queued but awaiting required tool results / approval. */
  pending?: boolean;
  requiredInput?: readonly unknown[];
  error?: string;
  errorCode?: string;
}

export interface ResponsesSteerWireOptions {
  apiKey: string;
  url?: string;
  responseId?: string;
  onEvent?: (event: Record<string, unknown>) => void;
  /** Injectable for hermetic tests; defaults to the global WebSocket. */
  socketFactory?: SteerSocketFactory;
  ackTimeoutMs?: number;
}

function defaultSocketFactory(url: string, headers: Record<string, string>): SteerSocket {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string, opts?: unknown) => SteerSocket })
    .WebSocket;
  if (Ctor === undefined) throw new Error("WebSocket is unavailable in this runtime");
  // Bun accepts `{ headers }` in the WebSocket options bag; this is the only
  // supported way to send the required Bearer token on the opening handshake.
  return new Ctor(url, { headers });
}

interface PendingSteer {
  resolve: (result: SteerResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ResponsesSteerWire {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #socketFactory: SteerSocketFactory;
  readonly #ackTimeoutMs: number;
  readonly #onEvent?: (event: Record<string, unknown>) => void;
  #socket: SteerSocket | undefined;
  #responseId: string | undefined;
  #pending: PendingSteer[] = [];
  #openPromise: Promise<void> | undefined;
  #closed = false;

  constructor(opts: ResponsesSteerWireOptions) {
    if (opts.apiKey.trim() === "") throw new Error("ResponsesSteerWire needs an API key");
    this.#url = opts.url ?? RESPONSES_WS_URL;
    this.#headers = { Authorization: `Bearer ${opts.apiKey}` };
    this.#socketFactory = opts.socketFactory ?? defaultSocketFactory;
    this.#ackTimeoutMs = opts.ackTimeoutMs ?? 10_000;
    this.#onEvent = opts.onEvent;
    this.#responseId = opts.responseId;
  }

  get responseId(): string | undefined {
    return this.#responseId;
  }

  /** Open (idempotently) and resolve once the socket is ready. */
  open(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("ResponsesSteerWire is closed"));
    if (this.#openPromise !== undefined) return this.#openPromise;
    this.#openPromise = new Promise<void>((resolve, reject) => {
      let socket: SteerSocket;
      try {
        socket = this.#socketFactory(this.#url, this.#headers);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.#socket = socket;
      const failed = (err: unknown): void => {
        const message = err instanceof Error ? err.message : String(err);
        this.#rejectPending(`websocket error: ${message}`);
        reject(new Error(message));
      };
      socket.onopen = () => resolve();
      socket.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return; // protocol says every message is JSON; ignore malformed frames.
        }
        if (parsed === null || typeof parsed !== "object") return;
        const msg = parsed as Record<string, unknown>;
        this.#onEvent?.(msg);
        if (msg.type === "response.created") {
          const id = (msg.response as Record<string, unknown> | undefined)?.id;
          if (typeof id === "string" && id !== "") this.#responseId = id;
        }
        this.#dispatchAck(msg);
      };
      socket.onerror = failed;
      socket.onclose = (event) => {
        const reason = event.reason || `closed (${event.code ?? "?"})`;
        this.#rejectPending(`websocket ${reason}`);
      };
    });
    return this.#openPromise;
  }

  #dispatchAck(msg: Record<string, unknown>): void {
    const next = this.#pending.shift();
    if (next === undefined) return;
    clearTimeout(next.timer);
    const type = msg.type;
    if (type === "response.steer.accepted" || type === "response.steer.pending") {
      const steer = (msg.steer ?? {}) as Record<string, unknown>;
      next.resolve({
        accepted: true,
        steerId: typeof steer.id === "string" ? steer.id : undefined,
        pending: type === "response.steer.pending",
        requiredInput: Array.isArray(msg.required_input) ? msg.required_input : undefined,
      });
      return;
    }
    if (type === "response.steer.failed") {
      const steer = (msg.steer ?? {}) as Record<string, unknown>;
      const error = (msg.error ?? {}) as Record<string, unknown>;
      next.resolve({
        accepted: false,
        steerId: typeof steer.id === "string" ? steer.id : undefined,
        error: typeof error.message === "string" ? error.message : "steer failed",
        errorCode: typeof error.code === "string" ? error.code : undefined,
      });
      return;
    }
    // Any other frame is not an acknowledgement: keep the pending steer.
    this.#pending.unshift(next);
  }

  #rejectPending(reason: string): void {
    const pending = this.#pending.splice(0, this.#pending.length);
    for (const item of pending) {
      clearTimeout(item.timer);
      item.resolve({ accepted: false, error: reason });
    }
  }

  /**
   * Send exactly `{type, previous_response_id, input}` (the only legal fields).
   * Resolves on accepted/pending; a failure or timeout returns `accepted: false`
   * so the caller rejects the claim and the step-boundary drain still runs.
   */
  steer(input: string | string[]): Promise<SteerResult> {
    const responseId = this.#responseId;
    if (responseId === undefined || responseId === "") {
      return Promise.resolve({ accepted: false, error: "no response.created id for response.steer" });
    }
    if (typeof input === "string" ? input.trim() === "" : input.length === 0) {
      return Promise.resolve({ accepted: false, error: "empty steer input" });
    }
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== 1 || this.#closed) {
      return Promise.resolve({ accepted: false, error: "responses websocket is not open" });
    }
    const frame = { type: "response.steer", previous_response_id: responseId, input };
    return new Promise<SteerResult>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#pending.findIndex((p) => p.resolve === resolve);
        if (index >= 0) this.#pending.splice(index, 1);
        resolve({ accepted: false, error: `response.steer acknowledgement timed out after ${this.#ackTimeoutMs}ms` });
      }, this.#ackTimeoutMs);
      if ((timer as { unref?: () => void }).unref) (timer as { unref?: () => void }).unref?.();
      this.#pending.push({ resolve, timer });
      try {
        socket.send(JSON.stringify(frame));
      } catch (err) {
        const index = this.#pending.findIndex((p) => p.resolve === resolve);
        if (index >= 0) this.#pending.splice(index, 1);
        clearTimeout(timer);
        resolve({ accepted: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  close(): void {
    this.#closed = true;
    this.#rejectPending("websocket closed by client");
    try {
      this.#socket?.close(1000, "client done");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Bridge the agent-side claim/accept/reject ordering to the real wire. On an
 * accepted steer the claim is accepted (the model will see it); on any failure
 * the claim is rejected so `LiveSteeringChannel.deferred` preserves FIFO order
 * for the ordinary step-boundary drain.
 */
export async function pumpResponsesSteering(
  steering: LiveSteering,
  wire: ResponsesSteerWire,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await steering.wait(signal);
    if (signal.aborted) return;
    const claim: LiveSteerClaim | undefined = await steering.claim(signal);
    if (claim === undefined) continue;
    const result = await wire.steer(claim.messages.join("\n"));
    if (result.accepted) claim.accept();
    else claim.reject();
  }
}
