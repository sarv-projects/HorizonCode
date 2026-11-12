/**
 * dap/client.ts — DAP client over stdio (docs/33 §5.1; adapted from oh-my-pi client patterns).
 *
 * Content-Length framing matches LSP (`encodeMessage` / `LspFramer`). Handles requests,
 * responses, and **events** (required for real adapters).
 *
 * Upstream reference: oh-my-pi @ 21f1188 — `packages/coding-agent/src/dap/client.ts`.
 * Session launch/attach sequencing lives in `session.ts` (from OMP `session.ts`).
 */

import type { GuardAction } from "../../contracts";
import { canonicalJson, sha256Hex } from "../canon";
import { LspFramer, encodeMessage } from "../lsp/framing";

/** Spawn admission for starting a debug adapter process. */
export function dapSpawnAction(command: string, args: string[]): GuardAction {
  const programDigest = sha256Hex(canonicalJson({ command, args })).slice(0, 16);
  return { kind: "spawn", target: `debug ${programDigest}` };
}

/**
 * Dual admission for `debug` launch (docs/33 §5.1): debuggee as `shell.exec`
 * plus adapter as `spawn`. Both must clear the guard before the tool runs.
 */
export function debugLaunchActions(
  program: string,
  adapterCommand: string | undefined,
  adapterArgs: string[],
): GuardAction[] {
  const actions: GuardAction[] = [{ kind: "shell.exec", target: program }];
  if (adapterCommand !== undefined && adapterCommand !== "") {
    actions.push(dapSpawnAction(adapterCommand, adapterArgs));
  }
  return actions;
}

export interface DapStackFrame {
  id: number;
  name: string;
  line: number;
}

export interface DapVariable {
  name: string;
  value: string;
}

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  [key: string]: unknown;
}

export interface DapClientOptions {
  write: (frame: Uint8Array) => void;
  requestTimeoutMs?: number;
}

type DapMessage = Record<string, unknown>;
type DapEventHandler = (body: unknown, event: string) => void;

function isResponse(
  m: DapMessage,
): m is DapMessage & { type: "response"; request_seq: number; success?: boolean; body?: unknown; message?: string } {
  return m.type === "response" && typeof m.request_seq === "number";
}

function isEvent(m: DapMessage): m is DapMessage & { type: "event"; event: string; body?: unknown } {
  return m.type === "event" && typeof m.event === "string";
}

/**
 * Minimal DAP session over a byte stream (stdio of a debug adapter).
 */
export class DapClient {
  private framer = new LspFramer();
  private nextSeq = 1;
  private pending = new Map<number, { resolve: (body: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Set<DapEventHandler>>();
  private capabilities: DapCapabilities = {};

  constructor(private opts: DapClientOptions) {}

  getCapabilities(): DapCapabilities {
    return this.capabilities;
  }

  /** Subscribe to a DAP event name (e.g. `initialized`, `stopped`). */
  onEvent(event: string, handler: DapEventHandler): () => void {
    const set = this.eventHandlers.get(event) ?? new Set();
    set.add(handler);
    this.eventHandlers.set(event, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.eventHandlers.delete(event);
    };
  }

  /** Wait until an event fires (pattern from oh-my-pi `DapClient.waitForEvent`). */
  waitForEvent<T = unknown>(
    event: string,
    predicate?: (body: T) => boolean,
    timeoutMs?: number,
  ): Promise<T> {
    const ms = timeoutMs ?? this.opts.requestTimeoutMs ?? 10_000;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        fn();
      };
      const unsubscribe = this.onEvent(event, (body) => {
        if (predicate && !predicate(body as T)) return;
        finish(() => resolve(body as T));
      });
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`DAP event ${event} timed out after ${ms}ms`)));
      }, ms);
    });
  }

  private dispatchEvent(event: string, body: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const h of handlers) h(body, event);
    }
  }

  push(chunk: Uint8Array): void {
    this.framer.push(chunk);
    for (const msg of this.framer.drain()) {
      const m = msg as DapMessage;
      if (isEvent(m)) {
        this.dispatchEvent(m.event, m.body ?? {});
        continue;
      }
      if (!isResponse(m)) continue;
      const pending = this.pending.get(m.request_seq);
      if (!pending) continue;
      this.pending.delete(m.request_seq);
      if (m.success === false) {
        const detail = typeof m.message === "string" && m.message !== "" ? m.message : "dap request failed";
        pending.reject(new Error(detail));
      } else {
        pending.resolve(m.body);
      }
    }
  }

  /** Public request path (oh-my-pi `sendRequest`). */
  sendRequest(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const seq = this.nextSeq++;
    const frame = encodeMessage({ type: "request", seq, command, arguments: args ?? {} });
    this.opts.write(frame);
    const timeoutMs = this.opts.requestTimeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`dap ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (body) => {
          clearTimeout(t);
          resolve(body);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  /**
   * Send `initialize` and wait for the `initialized` event.
   * Does **not** send `configurationDone` — callers (or `ready()`) do that, matching OMP
   * so `launch` can be in flight before configurationDone.
   */
  async initialize(adapterID = "hzcode"): Promise<DapCapabilities> {
    const initDone = this.waitForEvent("initialized", undefined, this.opts.requestTimeoutMs);
    const body = (await this.sendRequest("initialize", {
      clientID: "hzcode",
      adapterID,
      linesStartAt1: true,
      pathFormat: "path",
      supportsConfigurationDoneRequest: true,
    })) as DapCapabilities | undefined;
    await initDone;
    this.capabilities = body ?? {};
    return this.capabilities;
  }

  async configurationDone(): Promise<void> {
    await this.sendRequest("configurationDone");
  }

  /** Initialize + configurationDone for read-only queries. */
  async ready(adapterID = "hzcode"): Promise<void> {
    await this.initialize(adapterID);
    await this.configurationDone();
  }

  async stack(_frameId = 1): Promise<DapStackFrame[]> {
    const threads = (await this.sendRequest("threads")) as { threads?: Array<{ id: number }> };
    const tid = threads.threads?.[0]?.id ?? 1;
    const body = (await this.sendRequest("stackTrace", { threadId: tid, startFrame: 0, levels: 20 })) as {
      stackFrames?: Array<{ id: number; name: string; line: number }>;
    };
    return (body.stackFrames ?? []).map((f) => ({ id: f.id, name: f.name, line: f.line }));
  }

  async setBreakpoints(sourcePath: string, lines: number[]): Promise<void> {
    await this.sendRequest("setBreakpoints", {
      source: { path: sourcePath },
      breakpoints: lines.map((line) => ({ line })),
    });
  }

  async locals(frameId: number): Promise<DapVariable[]> {
    const scopes = (await this.sendRequest("scopes", { frameId })) as { scopes?: Array<{ variablesReference: number }> };
    const ref = scopes.scopes?.[0]?.variablesReference;
    if (ref === undefined) return [];
    const vars = (await this.sendRequest("variables", { variablesReference: ref })) as {
      variables?: Array<{ name: string; value: string }>;
    };
    return (vars.variables ?? []).map((v) => ({ name: v.name, value: v.value }));
  }
}
