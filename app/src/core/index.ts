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
import { readFileSync } from "node:fs";
import type {
  ApprovalHandler,
  ApprovalRequest,
  ChatMsg,
  ContextUsage,
  GuardAction,
  GuardKind,
  KernelMode,
  Lease,
  Provider,
  RunBudget,
  Runtime,
  RuntimeCallbacks,
  RuntimeEvent,
  RuntimeOptions,
  ToolContext,
  ToolResult,
} from "../contracts";
import { EventTypes, newId, nowIso } from "../contracts";
import { AdmissionQueue } from "./admission";
import { loadConfig, type HzConfig, type McpConfig } from "./config";
import { KernelClient } from "./kernel";
import {
  BudgetLedger,
  errorMessage,
  getApprovalHandler,
  MAX_PROVIDER_CALLS,
  runTurn,
  scopeFor,
  SESSION_LEASE_TTL_MS,
  setApprovalHandler as setProcessApprovalHandler,
  streamFor,
} from "./loop";
import { makeProvider } from "./providers";
import { SessionStore, type SessionInfo } from "./session";
import { activeSkillSection, resolveSkillForMessage, skillsPromptSection } from "./skills";
import { runNested } from "./subagent";
import { stopAllPreviews } from "../tools/preview";
// Plan mode's staging store and the apply path: /apply runs each staged write
// through the ordinary `write` tool, so an applied plan takes exactly the guard,
// approval and read-before-write route a live write takes (no second writer).
import { discardStaged, stagedChanges as planStagedChanges, type StagedChange } from "./plan";
// The MCP manager (docs/09 §4.7): connect-time spawn admissions happen through
// the session's kernel; its children are reaped by close().
import { startMcpManager, type McpManager } from "./mcp";
import { getTool } from "../tools";
import { noteRead } from "../tools/read-ledger";
import { canonicalJson, sha256Hex } from "./canon";
// Wave-14c rewind: the durable checkpoint store (the TUI's /rewind) sits on the
// change journal; a restore runs through the same `write` tool route /apply
// uses, so a rewind takes exactly the guard, approval, ledger and journal path
// a live write takes (no second writer).
import {
  checkpointByNumber,
  checkpointViews,
  changesSince,
  listCheckpoints,
  recordCheckpoint,
  rewindPlan,
  type CheckpointView,
} from "./checkpoints";
import { consumeChange, reloadFromDisk } from "../tools/change-journal";
import { isRefused, writeAtomic } from "../tools/atomic-write";

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
  /**
   * Plan mode (the user's toggle): while on, `write`/`edit` calls stage for
   * review and effectful tools (shell, undo, preview, agent, code_mode) are
   * refused; read-only tools are unaffected.
   */
  setPlanMode(on: boolean): void;
  planMode(): boolean;
  /** The session's staged changes, oldest first (plan mode's review surface). */
  stagedChanges(): readonly StagedChange[];
  /** Apply every staged change through the ordinary guard path; summary line. */
  applyPlan(): Promise<string>;
  /** Discard one staged change, or all; returns how many were dropped. */
  discardPlan(rel?: string): number;
  /**
   * Wave-14c rewind: the workspace's checkpoints, newest first and 1-numbered
   * (`/rewind <n>` takes `n`). Optional so a stripped runtime can omit it; the
   * TUI degrades with a typed "not supported" line.
   */
  checkpoints?(): CheckpointView[];
  /**
   * Put back the files the workspace changed after checkpoint `n` (never the
   * checkpoint's own changes; a file that moved on since is refused, not
   * overwritten). Returns the summary line the TUI prints.
   */
  rewindTo?(n: number): Promise<string>;
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
  /** Plan mode's per-session toggle (the TUI's /plan); off by default. */
  private planOn = false;
  /** The MCP manager this runtime owns, started by createRuntime, stopped by close(). */
  private mcp: McpManager | undefined;

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

  /**
   * The "always" answer (ruling 32 / docs/11 L7 reduced form): a session
   * GRANT, not a lease. It allows nothing by itself; the kernel mints a fresh
   * one-use lease for each effect the grant covers (see KernelClient.makeGrant).
   * The name is kept for the TUI contract; the object is still Lease-shaped.
   */
  async grantLease(kind: GuardKind, pattern: string, ttlMs: number = SESSION_LEASE_TTL_MS): Promise<Lease> {
    const grant = await this.kernel.makeGrant(kind, typeof pattern === "string" && pattern !== "" ? pattern : "*", ttlMs);
    this.leases.push(grant);
    return grant;
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

  setPlanMode(on: boolean): void {
    this.planOn = on === true;
  }

  planMode(): boolean {
    return this.planOn;
  }

  stagedChanges(): readonly StagedChange[] {
    return planStagedChanges(this.session.id);
  }

  discardPlan(rel?: string): number {
    return discardStaged(this.session.id, rel);
  }

  /** The workspace's checkpoints, newest first, numbered for `/rewind <n>`. */
  checkpoints(): CheckpointView[] {
    return checkpointViews(listCheckpoints(this.workspace).checkpoints);
  }

  /**
   * Rewind the workspace to checkpoint `n` (the TUI's /rewind <n>). Only the
   * live journal entries recorded AFTER that checkpoint that the checkpoint
   * itself does not cover are put back, newest first; each restore takes the
   * exact route `undo` takes — guard, approval on ask, the journal's
   * stale-check, an atomic write, a consume tombstone — so a file that moved on
   * since the recorded change wrote it is refused and named, never overwritten.
   * The consumed entry is tombstoned on success, so a reload cannot resurrect
   * it and a second rewind of the same checkpoint has nothing left to put back
   * (a rewind is idempotent; it is deliberately not itself journaled, exactly
   * like undo's restore). The plan itself never writes (checkpoints.rewindPlan
   * is pure), so a refusal leaves the workspace exactly as it was.
   */
  async rewindTo(n: number): Promise<string> {
    const load = listCheckpoints(this.workspace);
    const checkpoint = checkpointByNumber(load, n);
    if (checkpoint === undefined) {
      const note = load.corrupt === true ? ` (the checkpoint store is corrupt: ${load.reason ?? "unreadable"})` : "";
      throw new Error(`no checkpoint ${n} in this workspace${note}`);
    }
    const plan = rewindPlan(this.workspace, checkpoint.id);
    if (plan.refusal !== undefined) throw new Error(plan.refusal);
    const restorable = plan.restores.filter((item) => item.restorable);
    const skippedNote =
      plan.skipped.length > 0
        ? `${plan.skipped.length} change(s) cannot be put back (content not kept, or the change created the file) and were left as they are`
        : "";
    if (restorable.length === 0) {
      const summary =
        `nothing to rewind to checkpoint ${n}: no restorable change was recorded after it` +
        (skippedNote === "" ? "" : ` \u2014 ${skippedNote}`);
      await this.append(streamFor(this.session.id), "rewind.plan", {
        checkpoint: checkpoint.id,
        restored: [],
        refused: [],
        skipped: plan.skipped.map((s) => s.rel),
      });
      return summary;
    }
    const ctx: ToolContext = {
      cwd: this.workspace,
      workspace: this.workspace,
      sessionId: this.session.id,
      signal: new AbortController().signal,
      guard: (action: GuardAction) =>
        this.kernel.checkGuard(action, scopeFor(action, this.workspace), this.leases, this.session.id),
      approve: (req: ApprovalRequest) => (this.instanceApproval ?? getApprovalHandler())(req),
      receipt: (rec) => this.kernel.issueReceipt(rec),
    };
    const restored: string[] = [];
    const refused: string[] = [];
    for (const item of restorable) {
      // Re-read the entry fresh: an earlier restore in this loop just tombstoned
      // the journal view the plan was computed from (the plan carries ids, not
      // payloads).
      const entry = reloadFromDisk(this.workspace).entries.find((e) => e.id === item.entryId);
      if (entry === undefined || entry.before === null) {
        refused.push(`${item.rel}: the recorded content is no longer available`);
        continue;
      }
      let current: string | null = null;
      try {
        current = readFileSync(entry.path).toString("utf8");
      } catch {
        current = null;
      }
      if (current === null || sha256Hex(current) !== entry.afterSha256) {
        refused.push(`${item.rel}: changed since the recorded change wrote it \u2014 refusing to overwrite a concurrent edit`);
        continue;
      }
      // Same consent path as the write this reverses (tools/undo.ts).
      const action: GuardAction = { kind: "fs.write", target: entry.path };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        refused.push(`${item.rel}: denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
        continue;
      }
      if (decision.decision === "ask") {
        const approved = await ctx.approve(
          { title: `Rewind: restore ${item.rel}`, detail: `reverts the ${entry.tool} recorded after checkpoint ${n}`, kind: "fs.write" },
          action,
        );
        if (!approved) {
          refused.push(`${item.rel}: declined by user`);
          continue;
        }
      }
      const outcome = await writeAtomic(entry.path, entry.before, ctx);
      if (isRefused(outcome)) {
        refused.push(`${item.rel}: ${outcome.refusal.split("\n")[0]}`);
        continue;
      }
      // The entry is spent: tombstone it so a reload cannot resurrect it and a
      // second rewind of the same checkpoint finds nothing to put back.
      consumeChange(this.session.id, entry);
      // The workspace now holds the restored bytes -- later edits are legitimate.
      noteRead(ctx, entry.path);
      restored.push(item.rel);
      try {
        await this.kernel.issueReceipt({
          action: "tool.execute",
          tool: "rewind",
          argsDigest: sha256Hex(canonicalJson({ checkpoint: checkpoint.id, entryId: entry.id, rel: item.rel })),
          resultDigest: sha256Hex(entry.before),
        });
      } catch (err) {
        this.note(`could not issue a receipt for the rewound write ${item.rel}: ${errorMessage(err)}`);
      }
    }
    const parts: string[] = [
      restored.length > 0
        ? `restored ${restored.length} change(s) from before checkpoint ${n}: ${restored.join(", ")}`
        : "restored nothing",
    ];
    if (refused.length > 0) parts.push(`refused ${refused.length}: ${refused.join("; ")}`);
    if (skippedNote !== "") parts.push(skippedNote);
    const summary = parts.join(" \u2014 ");
    await this.append(streamFor(this.session.id), "rewind.apply", {
      checkpoint: checkpoint.id,
      restored,
      refused,
      skipped: plan.skipped.map((s) => s.rel),
    });
    return summary;
  }

  /**
   * Apply the session's staged changes (the TUI's /apply). Each change runs
   * through the ordinary `write` tool — the same guard check, approval prompt
   * (an fs.write outside the workspace still asks), read-before-write ledger,
   * atomic replacement and change journal a live write takes, so an applied
   * plan is indistinguishable from the same edit made directly. A change that
   * cannot be applied is KEPT and named with its reason; the rest continue —
   * one refusal must not drop the remainder of the plan.
   */
  async applyPlan(): Promise<string> {
    const pending = planStagedChanges(this.session.id);
    if (pending.length === 0) {
      return this.planOn
        ? "nothing staged yet — plan mode stages write/edit calls for /changes to inspect"
        : "nothing staged (plan mode is off; writes apply directly)";
    }
    const write = getTool("write");
    if (write === undefined) return "the write tool is unavailable in this build; nothing applied";
    const ctx: ToolContext = {
      cwd: this.workspace,
      workspace: this.workspace,
      sessionId: this.session.id,
      signal: new AbortController().signal,
      guard: (action: GuardAction) =>
        this.kernel.checkGuard(action, scopeFor(action, this.workspace), this.leases, this.session.id),
      approve: (req: ApprovalRequest) => (this.instanceApproval ?? getApprovalHandler())(req),
      receipt: (rec) => this.kernel.issueReceipt(rec),
    };
    const written: string[] = [];
    const kept: string[] = [];
    for (const change of pending) {
      // A staged change is a snapshot, not a lock: if the file moved on since it
      // was staged, applying would silently overwrite the newer content. The
      // change is KEPT and the reason stated — the user re-stages against the
      // new state (same rule the change journal's stale-check encodes).
      let current: string | null = null;
      try {
        current = readFileSync(change.resolved).toString("utf8");
      } catch {
        current = null;
      }
      const movedOn = change.before === null ? current !== null : current !== change.before;
      if (movedOn) {
        kept.push(
          `${change.rel}: changed on disk since it was staged${change.before === null ? " (the file now exists)" : ""} — re-stage to review the new state`,
        );
        continue;
      }
      // /changes showed this content before /apply ran: the read the ledger
      // wants IS the review (write otherwise refuses an existing unread file).
      if (change.before !== null) noteRead(ctx, change.resolved);
      let result: ToolResult;
      try {
        result = await write.execute({ path: change.rel, content: change.after }, ctx);
      } catch (err) {
        result = { ok: false, output: "", error: errorMessage(err) };
      }
      if (result.ok) {
        written.push(change.rel);
        discardStaged(this.session.id, change.rel);
        // The receipt chain stays unbroken for applied writes: the loop issues
        // one receipt per tool call, and /apply is a real write the loop never
        // saw. Best-effort; a failure is noticed, never fatal to the apply.
        try {
          await this.kernel.issueReceipt({
            action: "tool.execute",
            tool: "write",
            argsDigest: sha256Hex(canonicalJson({ path: change.rel, content: change.after })),
            resultDigest: sha256Hex(typeof result.output === "string" ? result.output : ""),
          });
        } catch (err) {
          this.note(`could not issue a receipt for the applied write ${change.rel}: ${errorMessage(err)}`);
        }
      } else {
        const reason = (result.error && result.error !== "" ? result.error : result.output) || "failed";
        kept.push(`${change.rel}: ${reason.split("\n")[0]}`);
      }
    }
    const parts: string[] = [
      written.length > 0 ? `applied ${written.length} staged change(s): ${written.join(", ")}` : "applied nothing",
    ];
    if (kept.length > 0) parts.push(`kept ${kept.length}: ${kept.join("; ")}`);
    const summary = parts.join(" \u2014 ");
    await this.append(streamFor(this.session.id), "plan.apply", {
      applied: written,
      kept,
      remaining: planStagedChanges(this.session.id).length,
    });
    return summary;
  }

  /**
   * Connect the configured MCP servers (docs/09 §4.7). Called once by
   * createRuntime; a server that fails to start is a notice, not a startup
   * failure, and every connect is admitted as a `spawn` through the session's
   * kernel before the program runs.
   */
  async startMcp(config: McpConfig | undefined): Promise<void> {
    if (this.mcp !== undefined) return;
    this.mcp = await startMcpManager(config, {
      workspace: this.workspace,
      sessionId: this.session.id,
      guard: (action: GuardAction) =>
        this.kernel.checkGuard(action, scopeFor(action, this.workspace), this.leases, this.session.id),
      approve: (req: ApprovalRequest) => (this.instanceApproval ?? getApprovalHandler())(req),
      onNotice: (message: string) => this.note(message),
    });
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
      // Ruling 33: the mode THIS run came up in is part of the session's
      // provenance. Read after kernel.start(), so the log records what actually
      // ran rather than what was hoped for — and a later fallback (or a resume
      // under a different transport) can never rewrite an earlier run's record.
      kernelMode: this.kernel.mode,
    });
  }
  private async logSessionEnd(sessionId: string): Promise<void> {
    await this.append(streamFor(sessionId), EventTypes.sessionEnd, { sessionId });
  }

  /**
   * Record one checkpoint for the turn that just completed: the ids of every
   * live journal entry THIS session wrote inside the turn's window (wave-14c).
   * Every completed turn is a checkpoint — a time boundary the human can rewind
   * to — zero-change turns included. Best-effort: a failed checkpoint must
   * never fail the turn, and a corrupt journal read is a notice, never an
   * empty `changes` (which would claim the turn changed nothing).
   */
  private recordTurnCheckpoint(userText: string, turnStartedAt: number): void {
    try {
      const since = changesSince(this.workspace, turnStartedAt, this.session.id);
      if (since.corrupt === true) {
        this.note(
          "no checkpoint was recorded for this turn: the change journal is unreadable, so what the turn changed cannot be verified",
        );
        return;
      }
      const firstLine = userText.trim().split(/\r?\n/, 1)[0] ?? "";
      recordCheckpoint(this.workspace, this.session.id, this.store.messageCount(this.session.id), since.entries.map((entry) => entry.id), {
        label: firstLine.slice(0, 80),
      });
    } catch (err) {
      this.note(`could not record a checkpoint for this turn: ${errorMessage(err)}`);
    }
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
      const turnStartedAt = Date.now();
      const outcome = await runTurn(
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
          // Plan mode rides this run's deps: staging/refusals happen inside
          // executeTool, and the model is told via the plan rail line.
          planMode: this.planOn,
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
      // Wave-14c: record the turn's checkpoint AFTER the run completed. The
      // label is the user's first line; the change ids come from the durable
      // journal's window, so a resumed process still rewinds by file state.
      this.recordTurnCheckpoint(text, turnStartedAt);
      return outcome;
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
    // MCP children are this runtime's spawns: reap them before the kernel goes
    // down, so no server process outlives the session that started it.
    await this.mcp?.stop();
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

  // Crash-recovery on open is TWO complementary repairs, not one — see external
  // audit finding 2 and the dsh ToolCallRecovery reference. A run killed between
  // "append the assistant message with its tool calls" and "append the tool
  // result" leaves two distinct kinds of damage, and each mechanism heals one:
  //
  //   - repairDanglingToolCalls repairs the TRANSCRIPT: an assistant tool call
  //     with no following tool result is answered with a synthetic UNKNOWN
  //     result (the dsh ToolCallRecovery pairing invariant). Without it every
  //     real provider refuses to replay the history and the session is bricked.
  //
  //   - recoverInterrupted settles the ADMISSION FIFO: a 'running' row left by
  //     the killed turn becomes 'unknown' (evidence 'interrupted'), which HALTS
  //     its followers instead of silently replaying a turn whose effect may or
  //     may not have happened.
  //
  // They are complementary, never duplicative: one keeps the provider-replayable
  // history valid, the other keeps the work-queue honest. recoverInterrupted was
  // defined but called from nowhere on the live path (external audit finding 2);
  // wiring it here, beside repairDanglingToolCalls and BEFORE the first turn can
  // run, closes that finding — a resumed server session (FEAT-003) reuses this
  // same entry point. Both run for a resumed session and a fresh one alike (a
  // fresh session has no rows, so each is a no-op). Both are idempotent.
  const repaired = store.repairDanglingToolCalls(session.id);
  const interrupted = new AdmissionQueue(store).recoverInterrupted(session.id);

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
  if (impl.kernelMode === "untrusted") {
    // Ruling 33: the mode is first-class. Coming up without the Rust kernel
    // gets exactly ONE notice, delivered on the first turn (note() queues it
    // when nothing is running — the same path kernel mode-change notes use).
    // The wording is honest about what parity does and does not cover: guard
    // decisions are pinned to the kernel's by tests/core/interop.test.ts; the
    // OS-level guarantees are what the in-process fallback cannot give.
    impl.note(
      "kernel: running without the Rust kernel binary (untrusted/fallback) — guard decisions are contract-identical " +
        "(interop-pinned); OS-level process supervision, file locking and the supervised-kill ladder are weaker in this mode",
    );
  }
  if (repaired.repaired > 0) {
    impl.note(
      `repaired ${repaired.repaired} interrupted tool call(s) left by a run that was killed mid-execution ` +
        `(${repaired.calls.join(", ")}) — each was answered with UNKNOWN; verify the real state before trusting it`,
    );
  }
  if (interrupted.length > 0) {
    // The admission side of the same crash: a turn that was 'running' when the
    // process died is now 'unknown' and will never be silently replayed. It
    // halts its followers until a human resolves it (requeue/drop/cancel).
    impl.note(
      `settled ${interrupted.length} interrupted admission row(s) left 'running' by a killed run ` +
        `(${interrupted.join(", ")}) — each is now 'unknown' (evidence 'interrupted') and will never be replayed; ` +
        `resolve it before the queue can advance`,
    );
  }
  // MCP servers: user-config only, spawned via the spawn-kind admission, and
  // reaped by close(). Starting them never fails the session.
  await impl.startMcp(config.mcp);
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
export { makeProvider, createMockProvider, createAnthropicProvider, createOpenAiProvider, createGoogleProvider, createOllamaProvider } from "./providers";
export { systemPrompt, MAX_PROVIDER_CALLS, HISTORY_LIMIT, MAX_CONSECUTIVE_FORMAT_ERRORS } from "./loop";
export { BudgetLedger, budgetCountdownLine, exitCodeFor } from "./loop";
export type { BudgetStop, BudgetCountdown } from "./loop";
export { listSkills, getSkill, skillsPromptSection, resolveSkillForMessage, activeSkillSection } from "./skills";
export { runNested, SUBAGENT_SYSTEM_PROMPT, clampSteps } from "./subagent";
export type { Skill } from "./skills";
