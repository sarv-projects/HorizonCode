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
  ContextUsage,
  GuardKind,
  KernelMode,
  Lease,
  Provider,
  RunBudget,
  Runtime,
  RuntimeCallbacks,
  RuntimeEvent,
  RuntimeOptions,
} from "../contracts";
import { EventTypes, newId, nowIso } from "../contracts";
import { loadConfig, type HzConfig } from "./config";
import { KernelClient } from "./kernel";
import {
  BudgetLedger,
  errorMessage,
  getApprovalHandler,
  MAX_PROVIDER_CALLS,
  runTurn,
  SESSION_LEASE_TTL_MS,
  setApprovalHandler as setProcessApprovalHandler,
  streamFor,
} from "./loop";
import { makeProvider } from "./providers";
import { SessionStore, type SessionInfo } from "./session";
import { activeSkillSection, resolveSkillForMessage, skillsPromptSection } from "./skills";
import { runNested } from "./subagent";
import { stopAllPreviews } from "../tools/preview";

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
  /** The most recent dispatch's context estimate, or undefined before one ran. */
  contextUsage(): ContextUsage | undefined;
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
  /** The newest `context.usage` this runtime saw (the `/context` report). */
  private lastContext: ContextUsage | undefined;
  /** NF-073: the resolved budget every turn tree draws from (0 = unlimited). */
  private readonly budget: RunBudget;

  constructor(args: {
    workspace: string;
    config: HzConfig;
    model: string;
    provider: Provider;
    store: SessionStore;
    session: SessionInfo;
    kernel: KernelClient;
    budget: RunBudget;
  }) {
    this.workspace = args.workspace;
    this.config = args.config;
    this.currentModel = args.model;
    this.provider = args.provider;
    this.store = args.store;
    this.session = args.session;
    this.kernel = args.kernel;
    this.budget = args.budget;
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

  contextUsage(): ContextUsage | undefined {
    return this.lastContext;
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
      // Skills: list what is available, and when the human opens a message with
      // `/<skill>`, activate it by injecting the body for this turn only.
      const skillSections: string[] = [];
      const directory = skillsPromptSection(this.workspace);
      if (directory !== "") skillSections.push(directory);
      let userContent = text;
      const activated = resolveSkillForMessage(this.workspace, text);
      if (activated) {
        skillSections.push(activeSkillSection(activated.skill));
        userContent = activated.action !== "" ? activated.action : `Apply the ${activated.skill.name} skill.`;
        emit(cb, { type: "notice", message: `skill active: ${activated.skill.name}` });
      }
      // NF-073: one ledger per turn tree — the main turn and every subagent it
      // spawns share this ceiling; a fresh one starts with each send().
      const ledger = new BudgetLedger(this.budget);
      // The context snapshot rides every dispatch: capture the newest one for
      // `/context` while passing every event through untouched.
      const callbacks: RuntimeCallbacks = {
        onEvent: (event) => {
          if (event.type === "context.usage") this.lastContext = event;
          emit(cb, event);
        },
      };
      return await runTurn(
        {
          workspace: this.workspace,
          sessionId: this.session.id,
          model: this.currentModel,
          provider: this.provider,
          kernel: this.kernel,
          store: this.store,
          signal: controller.signal,
          callbacks,
          sessionLeases: this.leases,
          approve: this.instanceApproval ?? getApprovalHandler(),
          systemExtra: skillSections.length > 0 ? skillSections.join("\n\n") : undefined,
          ledger,
          delegate: (task, maxSteps) =>
            runNested({
              workspace: this.workspace,
              task,
              maxSteps,
              model: this.currentModel,
              provider: this.provider,
              kernel: this.kernel,
              store: this.store,
              signal: controller.signal,
              sessionLeases: this.leases,
              approve: this.instanceApproval ?? getApprovalHandler(),
              ledger,
            }),
        },
        userContent,
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
    // Previews are process-global (tools/preview.ts): stop every live one, from
    // any session, so no dev server outlives the runtime that started it.
    await stopAllPreviews();
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

  // A run killed between "append the assistant message with its tool calls" and
  // "append the tool result" leaves an unanswered call, and every real provider
  // refuses to replay that history — which made a crash permanently brick the
  // session. Repair it on open, for a resumed session and for a fresh one alike
  // (a fresh session has no rows, so this is a no-op). Idempotent.
  const repaired = store.repairDanglingToolCalls(session.id);

  let impl: HzRuntimeImpl | null = null;
  const kernel = new KernelClient({
    workspace,
    onModeChange: (_mode, reason) => impl?.note(`kernel: ${reason}`),
  });
  await kernel.start();

  const rawBudget: RunBudget = { ...(config.budget ?? {}), ...(opts?.budget ?? {}) };

  impl = new HzRuntimeImpl({
    workspace,
    config,
    model,
    provider,
    store,
    session,
    kernel,
    // NF-073: steps stay capped at MAX_PROVIDER_CALLS unless the environment or
    // the caller set a budget; 0 (explicit) = unlimited, per dimension.
    budget: {
      maxSteps: rawBudget.maxSteps !== undefined ? rawBudget.maxSteps : MAX_PROVIDER_CALLS,
      maxTokens: rawBudget.maxTokens ?? 0,
      maxWallMs: rawBudget.maxWallMs ?? 0,
    },
  });
  await impl.logSessionStart();
  if (repaired.repaired > 0) {
    impl.note(
      `repaired ${repaired.repaired} interrupted tool call(s) left by a run that was killed mid-execution ` +
        `(${repaired.calls.join(", ")}) — each was answered with UNKNOWN; verify the real state before trusting it`,
    );
  }
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
export { systemPrompt, MAX_PROVIDER_CALLS, HISTORY_LIMIT, MAX_CONSECUTIVE_FORMAT_ERRORS } from "./loop";
export { BudgetLedger, budgetCountdownLine, exitCodeFor } from "./loop";
export type { BudgetStop, BudgetCountdown } from "./loop";
export { listSkills, getSkill, skillsPromptSection, resolveSkillForMessage, activeSkillSection } from "./skills";
export { runNested, SUBAGENT_SYSTEM_PROMPT, clampSteps } from "./subagent";
export type { Skill } from "./skills";
