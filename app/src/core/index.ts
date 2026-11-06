/**
 * index.ts — the runtime facade.
 *
 * createRuntime() wires the whole core together: configuration, the session
 * store, the kernel client (Rust when available, the local fallback otherwise)
 * and the provider. The interface layer only sees this object:
 *
 *   const runtime = await createRuntime({ workspace });
 *   await runtime.send("what does this repo do?", { onEvent: renderer.handle });
 *   await runtime.close();
 *
 * Everything the UI needs to draw arrives as RuntimeEvent; core never prints.
 */

import * as path from "node:path";
import type {
  ApprovalHandler,
  ChatMsg,
  GuardKind,
  KernelMode,
  Lease,
  Provider,
  Runtime,
  RuntimeCallbacks,
  RuntimeEvent,
  RuntimeOptions,
} from "../contracts";
import { EventTypes, newId, nowIso } from "../contracts";
import { loadConfig, type HzConfig } from "./config";
import { KernelClient } from "./kernel";
import {
  errorMessage,
  getApprovalHandler,
  runTurn,
  SESSION_LEASE_TTL_MS,
  setApprovalHandler as setProcessApprovalHandler,
  streamFor,
} from "./loop";
import { makeProvider } from "./providers";
import { SessionStore, type SessionInfo } from "./session";

/** The runtime the TUI drives: the base contract plus the hooks it offers. */
export interface HzRuntime extends Runtime {
  readonly workspace: string;
  readonly config: HzConfig;
  /** Register (or clear, with a non-function) this instance's approval handler. */
  setApprovalHandler(fn: ApprovalHandler): void;
  /** Remember an approval for the rest of the session (the "always" answer). */
  grantLease(kind: GuardKind, pattern: string, ttlMs?: number): Promise<Lease>;
  /** Start a fresh session in this workspace and switch to it. */
  newSession(title?: string): HzRuntime;
  setModel(model: string): string;
  history(): ChatMsg[];
  sessions(): SessionInfo[];
}

function emit(cb: RuntimeCallbacks, event: RuntimeEvent): void {
  try {
    cb?.onEvent?.(event);
  } catch {
    /* a rendering failure must never break a turn */
  }
}

class HzRuntimeImpl implements HzRuntime {
  readonly workspace: string;
  readonly config: HzConfig;
  private readonly store: SessionStore;
  private readonly kernel: KernelClient;
  private readonly provider: Provider;
  private readonly leases: Lease[] = [];
  private session: SessionInfo;
  private currentModel: string;
  private instanceApproval?: ApprovalHandler;
  private controller?: AbortController;
  private active?: RuntimeCallbacks;
  private readonly queued: string[] = [];
  private sendQueue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(args: {
    workspace: string;
    config: HzConfig;
    model: string;
    provider: Provider;
    store: SessionStore;
    session: SessionInfo;
    kernel: KernelClient;
  }) {
    this.workspace = args.workspace;
    this.config = args.config;
    this.currentModel = args.model;
    this.provider = args.provider;
    this.store = args.store;
    this.session = args.session;
    this.kernel = args.kernel;
  }

  get sessionId(): string {
    return this.session.id;
  }

  get model(): string {
    return this.currentModel;
  }

  get providerName(): string {
    return this.provider.name;
  }

  get kernelMode(): KernelMode {
    return this.kernel.mode;
  }

  /** A note from the kernel: shown now when a turn is running, else on the next one. */
  note(message: string): void {
    if (this.active) emit(this.active, { type: "notice", message });
    else if (this.queued.length < 8) this.queued.push(message);
  }

  setApprovalHandler(fn: ApprovalHandler): void {
    this.instanceApproval = typeof fn === "function" ? fn : undefined;
  }

  async grantLease(kind: GuardKind, pattern: string, ttlMs: number = SESSION_LEASE_TTL_MS): Promise<Lease> {
    const lease = await this.kernel.makeLease(kind, typeof pattern === "string" && pattern !== "" ? pattern : "*", ttlMs);
    this.leases.push(lease);
    return lease;
  }

  newSession(title = "New chat"): HzRuntime {
    const previous = this.session;
    this.session = this.store.createSession(title);
    this.leases.length = 0;
    void this.logSessionEnd(previous.id);
    void this.logSessionStart();
    return this;
  }

  setModel(model: string): string {
    const next = typeof model === "string" ? model.trim() : "";
    if (next === "") throw new Error("a model name is required");
    this.currentModel = next;
    return next;
  }

  history(): ChatMsg[] {
    return this.store.history(this.session.id);
  }

  sessions(): SessionInfo[] {
    return this.store.listSessions();
  }

  private pruneLeases(): void {
    const now = Date.now();
    for (let i = this.leases.length - 1; i >= 0; i -= 1) {
      const expiry = Date.parse(this.leases[i]?.expiry ?? "");
      if (!Number.isFinite(expiry) || expiry <= now) this.leases.splice(i, 1);
    }
  }

  private async append(stream: string, type: string, payload: unknown): Promise<void> {
    try {
      await this.kernel.appendEvent(stream, {
        id: newId(),
        ts: nowIso(),
        stream,
        type,
        actor: { kind: "system", id: "hzcode" },
        payload,
      });
    } catch {
      /* the log is an audit trail; failing to append must not stop the chat */
    }
  }

  /** Public so createRuntime can open the session in the log at startup. */
  async logSessionStart(): Promise<void> {
    await this.append(streamFor(this.session.id), EventTypes.sessionStart, {
      sessionId: this.session.id,
      workspace: this.workspace,
      provider: this.provider.name,
      model: this.currentModel,
    });
  }
  private async logSessionEnd(sessionId: string): Promise<void> {
    await this.append(streamFor(sessionId), EventTypes.sessionEnd, { sessionId });
  }

  send(text: string, cb: RuntimeCallbacks): Promise<{ text: string; aborted: boolean }> {
    // Turns are serialized: a second send waits for the first to finish.
    const run = this.sendQueue.then(
      () => this.runSend(text, cb),
      () => this.runSend(text, cb),
    );
    this.sendQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSend(text: string, cb: RuntimeCallbacks): Promise<{ text: string; aborted: boolean }> {
    if (this.closed) {
      emit(cb, { type: "error", message: "this runtime is closed" });
      return { text: "", aborted: false };
    }
    const controller = new AbortController();
    this.controller = controller;
    this.active = cb;
    while (this.queued.length > 0) emit(cb, { type: "notice", message: this.queued.shift() ?? "" });
    this.pruneLeases();
    try {
      return await runTurn(
        {
          workspace: this.workspace,
          sessionId: this.session.id,
          model: this.currentModel,
          provider: this.provider,
          kernel: this.kernel,
          store: this.store,
          signal: controller.signal,
          callbacks: cb,
          sessionLeases: this.leases,
          approve: this.instanceApproval ?? getApprovalHandler(),
        },
        text,
      );
    } catch (err) {
      emit(cb, { type: "error", message: `runtime error: ${errorMessage(err)}` });
      emit(cb, { type: "turn.done" });
      return { text: "", aborted: controller.signal.aborted };
    } finally {
      if (this.controller === controller) this.controller = undefined;
      if (this.active === cb) this.active = undefined;
    }
  }

  abort(): void {
    try {
      this.controller?.abort();
    } catch {
      /* nothing in flight */
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    await this.sendQueue.catch(() => undefined);
    await this.logSessionEnd(this.session.id);
    await this.kernel.close();
    this.store.close();
  }
}

/**
 * Bring up the runtime for one workspace. `continueSession` resumes the most
 * recently touched session; otherwise a fresh one starts (zero-config default:
 * provider `mock`, no key, kernel fallback when the Rust binary is absent).
 */
export async function createRuntime(opts: RuntimeOptions): Promise<HzRuntime> {
  const workspace = path.resolve(opts?.workspace && opts.workspace.trim() !== "" ? opts.workspace : process.cwd());
  const config = loadConfig();
  const model = opts?.model && opts.model.trim() !== "" ? opts.model.trim() : config.model;
  const provider = makeProvider(config, { mockFlag: opts?.mock === true });
  const store = new SessionStore(workspace);

  let session: SessionInfo | null = null;
  if (opts?.continueSession) session = store.latestSession();
  if (!session) session = store.createSession();

  let impl: HzRuntimeImpl | null = null;
  const kernel = new KernelClient({
    workspace,
    onModeChange: (_mode, reason) => impl?.note(`kernel: ${reason}`),
  });
  await kernel.start();

  impl = new HzRuntimeImpl({ workspace, config, model, provider, store, session, kernel });
  await impl.logSessionStart();
  return impl;
}

/** Register the process-wide approval handler (used by every runtime). */
export function setApprovalHandler(fn: ApprovalHandler): void {
  setProcessApprovalHandler(fn);
}

export { getApprovalHandler } from "./loop";
export { loadConfig, describeConfig, missingKey, DEFAULT_MODELS } from "./config";
export type { HzConfig, ProviderName } from "./config";
export { KernelClient, LocalKernel, resolveKernelBinary } from "./kernel";
export { SessionStore, type SessionInfo } from "./session";
export { makeProvider, createMockProvider, createAnthropicProvider, createOpenAiProvider } from "./providers";
export { systemPrompt, MAX_PROVIDER_CALLS, HISTORY_LIMIT } from "./loop";
