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
import { homedir } from "node:os";
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
  RunExit,
  RuntimeOptions,
  SessionForkPayload,
  ToolContext,
  ToolResult,
} from "../contracts";
import { EventTypes, newId, nowIso } from "../contracts";
import { AdmissionQueue } from "./admission";
import { acceptInterjection, InterjectionBuffer } from "./interjection";
import { resolveThinkingEffort } from "./thinking-effort";
import { augmentConfigWithTrustedWorkspace, defaultConfigPath, loadConfig, readConfigFile, type HzConfig, type McpConfig } from "./config";
import { applySandboxChildNetFromConfig } from "./sandbox-child-net";
import {
  applyEffectHostKernelFromUserConfig,
  applyEffectHostKernelSandboxDefault,
} from "./effect-host-runtime";
import { kernelEnforcesProcessSandbox } from "./sandbox-spawn";
import { catalogWindow, loadCatalog } from "./catalog/catalog";
import { startModelsCatalogPoll, type ModelsPollStop } from "./catalog/catalog-poll";
import {
  startAnthropicCacheKeepalive,
  type AnthropicCacheKeepaliveStop,
} from "./providers/anthropic-cache-keepalive";
import {
  formatCacheablePrefixMeasure,
  measureCacheablePrefix,
} from "./providers/anthropic-cache-measure";
import type { EffectRecord } from "./effect-host";
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
// Hooks v1 lifecycle (docs/15 §2.4 H1): the runtime seam emits session.start/
// session.end as OBSERVATION points (H4) alongside the existing event appends.
import { loadHooks, runLifecycleHooks } from "./hooks";
import { ensureWorkspaceHookTrust, hooksLoadOptions } from "./trust";
import { SessionStore, type SessionInfo } from "./session";
import { reindexSessionSearch, searchSessions as ftsSearchSessions } from "./session-search";
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
import { clearDiscoveredTools, getTool } from "../tools";
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
import type { PermissionMode } from "./permission-mode";
import { isPermissionMode, meetPermissionMode, permissionModeError } from "./permission-mode";
import { consumeChange, reloadFromDisk } from "../tools/change-journal";
import { receiptHead, type ChainStatus } from "./convo";
import { isRefused, writeAtomic } from "../tools/atomic-write";
import { setThemeMode } from "../tui/style";
import { EffectHost } from "./effect-host";
import { loadEffectLedger, WorkspaceEffectLedger } from "./effect-ledger";
import { collectUnknownEffectRows, type UnknownEffectRow } from "./effect-unknown-list";
import { mirrorEffectReconcileToKernel } from "./effect-kernel-reconcile";
import { reconcileEffectsOnAttach } from "./effect-reconcile-attach";
import { effectHostKernelRequireRefusal } from "./effect-host-posture";
import {
  effectReconcileBlockLatchView,
  effectReconcileBlockObservePendingRefusal,
  effectReconcileBlockRefusal,
  tryReleaseEffectReconcileBlock,
  type EffectReconcileBlockLatchView,
} from "./effect-reconcile-block";

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
  /**
   * Full-text search over session titles + user prompts (docs/12 F8).
   * Empty query returns the recent list (same as `sessions()`).
   * Hits may carry a `snippet` of the matched user-prompt body.
   */
  searchSessions(query: string, limit?: number): Array<
    SessionInfo & { snippet?: string; messageCount?: number; totalCostUsd?: number }
  >;
  /** The most recent dispatch's context estimate, or undefined before one ran. */
  contextUsage(): ContextUsage | undefined;
  /**
   * Plan mode (the user's toggle): while on, `write`/`edit` calls stage for
   * review and effectful tools (shell, undo, preview, agent, code_mode) are
   * refused; read-only tools are unaffected.
   */
  setPlanMode(on: boolean): void;
  planMode(): boolean;
  /**
   * The named permission mode (permission-mode.ts): `plan` while plan mode is
   * on, else the non-plan mode. Session-only; never written to disk.
   */
  permissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
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
  /**
   * Session fork (docs/12 S-45): copy this session's transcript (all of it, or
   * the first `at` messages, boundary-safe) into a NEW session with forkedFrom
   * lineage. The parent is untouched and this runtime stays on it; the child's
   * kernel stream starts with a `session.fork` event naming the parent stream
   * and its head seq. Resume the child with `switchSession` or `createRuntime`.
   */
  forkSession?(at?: number): Promise<SessionInfo>;
  /** Move this runtime onto an existing session of this workspace (resume). */
  switchSession?(sessionId: string): HzRuntime;
  /** T-12: retitle the current session; returns the stored title. */
  renameSession?(title: string): string;
  /** T-12: drop the last reply and return the last user text to send again. */
  retryLast?(): string | undefined;
  /** T-12: the session title (for exports). */
  sessionTitle?(): string;
  /** T-16: run one shell command through the guard, approval and a receipt (hzcode commit). */
  runGuardedShell?(command: string): Promise<{ ok: boolean; output: string }>;
  /** T-16: the newest receipt hash, when the chain has one. */
  receiptHead?(): string | undefined;
  /** T-12: the receipt chain status for exports (verify + head hash). */
  receiptChain?(): Promise<ChainStatus>;
  /** Mid-turn steer into the active turn (C-9); no-op when idle. */
  interject(text: string, opts?: { images?: readonly unknown[] }): {
    accepted: boolean;
    reason?: "idle" | "empty" | "closed";
    imagesRefused?: true;
  };
  turnInFlight(): boolean;
  /** Unreconciled EffectHost rows for the workspace session (docs/28 ruling 264). */
  unknownEffects(): UnknownEffectRow[];
  /** EffectHost row for UNKNOWN inspect (ruling 282). */
  getEffectRecord(effectId: string): EffectRecord | undefined;
  /** In-run EffectHost ids (durable + open). */
  listEffectIds(): string[];
  /** Observe-only reconcile from session logs + receipts (R169 reduced; ruling 282). */
  reconcileUnknownEffectsNow(): Promise<number>;
  /** Drops `HZ_EFFECT_RECONCILE_BLOCK` latch when ledger/probe/unpaired/UNKNOWN are clean (ruling **293**). */
  tryReleaseReconcileBlockIfClean(): boolean;
  /** Active reconcile-block latch for TUI status (ruling **304**). */
  reconcileBlockLatch(): EffectReconcileBlockLatchView;
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
  /** Per-turn mid-turn steer buffer; set for the duration of `runSend`. */
  private turnInterjection?: InterjectionBuffer;
  private readonly queued: string[] = [];
  private sendQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** The newest `context.usage` this runtime saw (the `/context` report). */
  private lastContext: ContextUsage | undefined;
  /** NF-073: the resolved budget every turn tree draws from (0 = unlimited). */
  private readonly budget: RunBudget;
  /** Plan mode's per-session toggle (the TUI's /plan); off by default. */
  private planOn = false;
  /** The non-plan permission mode (default | accept-edits | read-only). */
  private mode: Exclude<PermissionMode, "plan"> = "default";
  /** The MCP manager this runtime owns, started by createRuntime, stopped by close(). */
  private mcp: McpManager | undefined;
  /** Optional models.dev background poll (`HZ_MODELS_POLL_MS`). */
  private modelsCatalogPollStop?: ModelsPollStop;
  /** Optional Anthropic cache keep-alive stub (`HZ_ANTHROPIC_CACHE_KEEPALIVE_MS`). */
  private anthropicCacheKeepaliveStop?: AnthropicCacheKeepaliveStop;
  /** Durable EffectHost ledger (ruling 224); shared across turns for this runtime. */
  private readonly effectHost: EffectHost;

  beginModelsCatalogPoll(stop: ModelsPollStop): void {
    this.modelsCatalogPollStop = stop;
  }

  beginAnthropicCacheKeepalive(stop: AnthropicCacheKeepaliveStop): void {
    this.anthropicCacheKeepaliveStop = stop;
  }

  constructor(args: {
    workspace: string;
    config: HzConfig;
    model: string;
    provider: Provider;
    store: SessionStore;
    session: SessionInfo;
    kernel: KernelClient;
    budget: RunBudget;
    permissionMode?: PermissionMode;
    effectHost: EffectHost;
  }) {
    if (args.permissionMode === "plan") this.planOn = true;
    else if (args.permissionMode !== undefined) this.mode = args.permissionMode;
    this.workspace = args.workspace;
    this.config = args.config;
    this.currentModel = args.model;
    this.provider = args.provider;
    this.store = args.store;
    this.session = args.session;
    this.kernel = args.kernel;
    this.budget = args.budget;
    this.effectHost = args.effectHost;
  }

  private async emitEffectReconciled(
    rows: ReturnType<typeof reconcileEffectsOnAttach>,
    sessionId: string,
  ): Promise<void> {
    for (const row of rows) {
      if (!row.reconciled) continue;
      await this.append(streamFor(sessionId), EventTypes.effectReconciled, {
        effectId: row.effectId,
        tool: row.tool,
        callId: row.callId,
        priorVerdict: row.priorVerdict,
        verdict: row.verdict,
        observeOnly: true,
      });
      // A session switch during an awaited kernel RPC must not notify the new
      // session about the old session's attachment reconciliation.
      if (this.session.id === sessionId && this.active) {
        emit(this.active, { type: "effect.reconciled", effectId: row.effectId });
      }
    }
  }

  async attachEffectLedger(): Promise<void> {
    const sessionId = this.session.id;
    const rows = reconcileEffectsOnAttach(this.workspace, sessionId, this.effectHost);
    for (const row of rows) {
      if (row.priorVerdict === row.verdict && !row.reconciled) continue;
      await mirrorEffectReconcileToKernel(this.kernel, this.effectHost.getRecord(row.effectId));
    }
    await this.emitEffectReconciled(rows, sessionId);
    const settled = rows.filter((r) => r.reconciled);
    if (settled.length > 0) {
      this.note(
        `reconciled ${settled.length} effect(s) from the durable ledger after restart ` +
          `(${settled.map((r) => r.effectId).join(", ")})`,
      );
    }
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
   * UI/CLI mutations that bypass runTurn still obey the EffectHost gates.
   * They have not been wired to kernel effect.execute; strict mode therefore
   * refuses rather than silently running an ambient Bun mutation.
   */
  private directMutationRefusal(tool: string, args: Record<string, unknown>): string | undefined {
    return (
      effectReconcileBlockRefusal(this.workspace, this.session.id, tool, args, this.effectHost) ??
      effectReconcileBlockObservePendingRefusal(this.workspace, tool, args, this.effectHost) ??
      effectHostKernelRequireRefusal(tool, args, false)
    );
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
    this.session = this.store.createSession(title, { permissionMode: this.permissionMode() });
    this.leases.length = 0;
    void this.logSessionEnd(previous.id);
    void this.logSessionStart();
    void this.attachEffectLedger();
    return this;
  }

  /** send() calls accepted and not yet finished (fork refuses while any). */
  private pendingSends = 0;

  async forkSession(at?: number): Promise<SessionInfo> {
    // A fork taken mid-turn would copy a partial transcript (an assistant
    // message with its tool results still arriving): refuse until the turn ends.
    if (this.active || this.pendingSends > 0) throw new Error("cannot fork while a turn is running; wait for it to finish or cancel it");
    const parentStream = streamFor(this.session.id);
    let parentSeq = 0;
    try {
      const events = await this.kernel.readEvents(parentStream, 1);
      parentSeq = events.reduce((max, ev) => Math.max(max, ev.seq), 0);
    } catch {
      /* an unreadable parent log records seq 0; the fork itself still works */
    }
    const childMode = meetPermissionMode(this.session.permissionMode, this.permissionMode());
    const child = this.store.forkSession(this.session.id, { at, parentSeq, permissionMode: childMode });
    const payload: SessionForkPayload = {
      parentSessionId: this.session.id,
      parentStream,
      parentSeq,
      messageIndex: child.forkedFrom?.messageIndex ?? 0,
    };
    // A fork is a NEW stream whose first event references the parent; the
    // parent's log is never written to (append-only, no rewrite).
    // The store row already carries the lineage, so a failed append leaves a
    // valid fork (resume never reads this event); say so rather than fail.
    try {
      await this.append(streamFor(child.id), EventTypes.sessionFork, payload);
    } catch (err) {
      this.note(`fork recorded in the session store, but the session.fork event was not written: ${errorMessage(err)}`);
    }
    return child;
  }

  switchSession(sessionId: string): HzRuntime {
    const next = this.store.getSession(sessionId);
    if (!next) throw new Error(`no session ${sessionId} in this workspace`);
    const previous = this.session;
    // Resume runs the same transcript repair createRuntime runs on open.
    this.store.repairDanglingToolCalls(next.id);
    this.session = next;
    if (next.permissionMode !== undefined) this.setPermissionMode(next.permissionMode);
    this.leases.length = 0;
    void this.logSessionEnd(previous.id);
    void this.logSessionStart();
    void this.attachEffectLedger();
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

  renameSession(title: string): string {
    const next = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (next === "") throw new Error("a title is required");
    this.store.touchSession(this.session.id, next);
    this.session = { ...this.session, title: next };
    return next;
  }

  sessionTitle(): string {
    return this.session.title;
  }

  retryLast(): string | undefined {
    if (this.active || this.pendingSends > 0) throw new Error("cannot retry while a turn is running");
    const rows = this.store.history(this.session.id);
    let at = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].role === "user" && (rows[i].content ?? "").trim() !== "") {
        at = i;
        break;
      }
    }
    if (at < 0) return undefined;
    const text = rows[at].content;
    this.store.truncateMessages(this.session.id, at);
    return text;
  }

  receiptHead(): string | undefined {
    return receiptHead(this.kernel.stateDir);
  }

  async runGuardedShell(command: string): Promise<{ ok: boolean; output: string }> {
    const refusal = this.directMutationRefusal("shell", { command });
    if (refusal) return { ok: false, output: refusal };
    const shell = getTool("shell");
    if (!shell) return { ok: false, output: "the shell tool is not available" };
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
    const args = { command };
    const result = await shell.execute(args, ctx);
    const output = result.ok ? result.output : `${result.error ?? "failed"}\n${result.output ?? ""}`.trim();
    try {
      await this.kernel.issueReceipt({
        action: "tool.execute",
        tool: "shell",
        argsDigest: sha256Hex(canonicalJson(args)),
        resultDigest: sha256Hex(
          typeof result.output === "string"
            ? result.output
            : canonicalJson({
                ok: result.ok,
                output: result.output ?? null,
                error: result.error ?? null,
              }),
        ),
      });
    } catch {
      /* the commit already happened or was refused; a lost receipt is reported by verify */
    }
    return { ok: result.ok, output };
  }

  async receiptChain(): Promise<ChainStatus> {
    const verdict = await this.kernel.verifyReceipts();
    return { ...verdict, head: receiptHead(this.kernel.stateDir) };
  }

  contextUsage(): ContextUsage | undefined {
    return this.lastContext;
  }

  unknownEffects(): UnknownEffectRow[] {
    const { verdicts } = loadEffectLedger(this.workspace);
    return collectUnknownEffectRows(this.effectHost, verdicts);
  }

  getEffectRecord(effectId: string) {
    return this.effectHost.getRecord(effectId);
  }

  listEffectIds(): string[] {
    return this.effectHost.listEffectIds();
  }

  async reconcileUnknownEffectsNow(): Promise<number> {
    const rows = reconcileEffectsOnAttach(this.workspace, this.session.id, this.effectHost);
    for (const row of rows) {
      if (row.priorVerdict === row.verdict && !row.reconciled) continue;
      await mirrorEffectReconcileToKernel(this.kernel, this.effectHost.getRecord(row.effectId));
    }
    await this.emitEffectReconciled(rows, this.session.id);
    const settled = rows.filter((r) => r.reconciled);
    if (settled.length > 0) {
      this.note(
        `/unknown reconcile: settled ${settled.length} effect(s) from logs ` +
          `(${settled.map((r) => r.effectId).join(", ")})`,
      );
    }
    if (tryReleaseEffectReconcileBlock(this.workspace, this.session.id, this.effectHost)) {
      this.note("effect reconcile block cleared (/unknown reconcile)");
    }
    return settled.length;
  }

  tryReleaseReconcileBlockIfClean(): boolean {
    return tryReleaseEffectReconcileBlock(this.workspace, this.session.id, this.effectHost);
  }

  reconcileBlockLatch(): EffectReconcileBlockLatchView {
    return effectReconcileBlockLatchView(this.workspace, this.session.id, this.effectHost);
  }

  setPlanMode(on: boolean): void {
    this.planOn = on === true;
  }

  planMode(): boolean {
    return this.planOn;
  }

  permissionMode(): PermissionMode {
    return this.planOn ? "plan" : this.mode;
  }

  setPermissionMode(mode: PermissionMode): void {
    if (!isPermissionMode(mode)) throw new Error(permissionModeError(mode));
    if (mode === "plan") {
      this.planOn = true;
      return;
    }
    this.planOn = false;
    this.mode = mode;
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
    // Rewind restores with writeAtomic outside runTurn. Refuse the entire
    // file+conversation rewind BEFORE any mutation when its path is blocked;
    // otherwise the transcript could rewind while the workspace did not.
    for (const item of restorable) {
      const refusal = this.directMutationRefusal("write", { path: item.rel });
      if (refusal) return `rewind refused (workspace and transcript unchanged): ${item.rel}: ${refusal}`;
    }
    const skippedNote =
      plan.skipped.length > 0
        ? `${plan.skipped.length} change(s) cannot be put back (content not kept, or the change created the file) and were left as they are`
        : "";
    if (restorable.length === 0) {
      // No file to put back, but the conversational rewind still applies: a
      // rewind to a checkpoint with no later file changes must still cut the
      // transcript back to the checkpoint's boundary (FEAT-002). Boundary-safe,
      // same invariant as above.
      const truncation = this.store.truncateMessages(this.session.id, checkpoint.messageIndex);
      const transcriptNote =
        truncation.removed > 0
          ? `removed ${truncation.removed} transcript message(s)` +
            (truncation.adjustedTo !== checkpoint.messageIndex
              ? ` (boundary moved earlier to ${truncation.adjustedTo} to keep a tool-call group whole)`
              : "")
          : "removed no transcript messages";
      const fileNote =
        `no restorable change was recorded after checkpoint ${n}` +
        (skippedNote === "" ? "" : ` \u2014 ${skippedNote}`);
      const summary =
        truncation.removed > 0
          ? `rewound to checkpoint ${n}: ${transcriptNote} \u2014 ${fileNote}`
          : `nothing to rewind to checkpoint ${n}: ${fileNote} \u2014 ${transcriptNote}`;
      await this.append(streamFor(this.session.id), "rewind.plan", {
        checkpoint: checkpoint.id,
        restored: [],
        refused: [],
        skipped: plan.skipped.map((s) => s.rel),
      });
      await this.append(streamFor(this.session.id), "rewind.conversation", {
        checkpoint: checkpoint.id,
        messageIndex: checkpoint.messageIndex,
        removed: truncation.removed,
        adjustedTo: truncation.adjustedTo,
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
    // FEAT-002 conversational rewind, ADDITIVE to the file-side restore above
    // (wave-14c shipped the file side only). The checkpoint recorded the
    // session's message count at the boundary; truncate the transcript back to
    // it. `truncateMessages` is boundary-safe: it never leaves a dangling
    // assistant tool_call in the kept prefix (it moves the cut earlier if the
    // naive boundary would split a tool-call group), so the kept history stays
    // provider-replayable. The kernel event log stays append-only — the rewind
    // is recorded below as a NEW forward event, never a log edit.
    const truncation = this.store.truncateMessages(this.session.id, checkpoint.messageIndex);

    const parts: string[] = [
      restored.length > 0
        ? `restored ${restored.length} change(s) from before checkpoint ${n}: ${restored.join(", ")}`
        : "restored nothing",
    ];
    if (refused.length > 0) parts.push(`refused ${refused.length}: ${refused.join("; ")}`);
    if (skippedNote !== "") parts.push(skippedNote);
    if (truncation.removed > 0) {
      const adjusted =
        truncation.adjustedTo !== checkpoint.messageIndex
          ? ` (boundary moved earlier to ${truncation.adjustedTo} to keep a tool-call group whole)`
          : "";
      parts.push(`removed ${truncation.removed} transcript message(s)${adjusted}`);
    } else {
      parts.push("removed no transcript messages");
    }
    const summary = parts.join(" \u2014 ");
    await this.append(streamFor(this.session.id), "rewind.apply", {
      checkpoint: checkpoint.id,
      restored,
      refused,
      skipped: plan.skipped.map((s) => s.rel),
    });
    // Append-only forward audit event for the conversational truncation. The
    // past log records are untouched; this records that the rewind happened and
    // what it removed, so `verify` still passes and the history is auditable.
    await this.append(streamFor(this.session.id), "rewind.conversation", {
      checkpoint: checkpoint.id,
      messageIndex: checkpoint.messageIndex,
      removed: truncation.removed,
      adjustedTo: truncation.adjustedTo,
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
      const refusal = this.directMutationRefusal("write", { path: change.rel, content: change.after });
      if (refusal) {
        kept.push(`${change.rel}: ${refusal}`);
        continue;
      }
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
            resultDigest: sha256Hex(
              typeof result.output === "string"
                ? result.output
                : canonicalJson({
                    ok: result.ok,
                    output: result.output ?? null,
                    error: result.error ?? null,
                  }),
            ),
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
      trustedWorkspaceHooks: this.config.trustedWorkspaceHooks,
      home: homedir(),
      guard: (action: GuardAction) =>
        this.kernel.checkGuard(action, scopeFor(action, this.workspace), this.leases, this.session.id),
      approve: (req: ApprovalRequest) => (this.instanceApproval ?? getApprovalHandler())(req),
      onNotice: (message: string) => this.note(message),
    });
  }

  sessions(): SessionInfo[] {
    return this.store.listSessions();
  }

  searchSessions(query: string, limit = 20): Array<
    SessionInfo & { snippet?: string; messageCount?: number; totalCostUsd?: number }
  > {
    const enrich = (
      row: SessionInfo & { snippet?: string },
    ): SessionInfo & { snippet?: string; messageCount?: number } => ({
      ...row,
      messageCount: this.store.messageCount(row.id),
    });
    const q = query.trim();
    if (q === "") {
      return this.store.listSessions(limit).map((info) => {
        const preview = this.store.lastUserPromptPreview(info.id);
        const base = preview === "" ? info : { ...info, snippet: preview };
        return enrich(base);
      });
    }
    const mapHits = (): Array<SessionInfo & { snippet?: string; messageCount?: number }> => {
      const hits = ftsSearchSessions(this.workspace, q, limit);
      const out: Array<SessionInfo & { snippet?: string; messageCount?: number }> = [];
      for (const hit of hits) {
        const info = this.store.getSession(hit.sessionId);
        if (info) out.push(enrich({ ...info, snippet: hit.snippet || undefined }));
      }
      return out;
    };
    let out = mapHits();
    if (out.length === 0) {
      // Heal a missing/stale sidecar once (Grok bootstrap idea, sync and cheap).
      reindexSessionSearch(this.workspace, this.store.listSessions(500), (id) => this.store.userPromptText(id));
      out = mapHits();
    }
    return out;
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
    // H1 session.start: an OBSERVATION lifecycle hook (H4 — it may observe and
    // may return an H9 note, but can never block the session opening). Loaded
    // at the runtime seam; absent config costs nothing.
    await this.runSessionHook("sessionStart", { provider: this.provider.name, model: this.currentModel });
  }
  private async logSessionEnd(sessionId: string): Promise<void> {
    clearDiscoveredTools(sessionId);
    await this.append(streamFor(sessionId), EventTypes.sessionEnd, { sessionId });
    // H1 session.end: the OBSERVATION counterpart to session.start (H4).
    await this.runSessionHook("sessionEnd", {}, sessionId);
  }

  /**
   * Run the session.start/session.end hooks (H1), swallowing any H9 context
   * fragments — there is no active provider request here to carry a note into,
   * and the fragments are already recorded as attributed `hook.decision`
   * events by the runner. Observation-only; never blocks (H4).
   */
  private async runSessionHook(
    point: "sessionStart" | "sessionEnd",
    detail: Record<string, unknown>,
    sessionId: string = this.session.id,
  ): Promise<void> {
    try {
      await runLifecycleHooks(
        loadHooks(
          this.workspace,
          hooksLoadOptions(this.workspace, { trustedWorkspaceHooks: this.config.trustedWorkspaceHooks }, (message) => this.note(message)),
        ),
        {
          point,
          sessionId,
          workspace: this.workspace,
          detail,
          onNotice: (message) => this.note(message),
        },
      );
    } catch {
      /* a lifecycle hook can never take the session down (H4) */
    }
  }

  /**
   * Record one checkpoint for the turn that just completed: the ids of every
   * live journal entry THIS session wrote inside the turn's window (wave-14c).
   * Every completed turn is a checkpoint — a time boundary the human can rewind
   * to — zero-change turns included. Best-effort: a failed checkpoint must
   * never fail the turn, and a corrupt journal read is a notice, never an
   * empty `changes` (which would claim the turn changed nothing).
   */
  private async ensureHookTrust(): Promise<void> {
    const home = homedir();
    await ensureWorkspaceHookTrust(
      this.workspace,
      this.config.trustedWorkspaceHooks,
      home,
      (req) => (this.instanceApproval ?? getApprovalHandler())(req),
      async (payload) => {
        await this.kernel.issueReceipt({
          action: "hook.trust",
          tool: "hooks",
          argsDigest: sha256Hex(canonicalJson(payload)),
          resultDigest: sha256Hex(payload.decision),
        });
      },
      (message) => this.note(message),
    );
  }

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
        label: firstLine.slice(0, 60),
        onAppendFailure: (message) => this.note(message),
      });
    } catch (err) {
      this.note(`could not record a checkpoint for this turn: ${errorMessage(err)}`);
    }
  }

  turnInFlight(): boolean {
    return this.controller !== undefined && !this.closed;
  }

  interject(text: string, opts?: { images?: readonly unknown[] }): {
    accepted: boolean;
    reason?: "idle" | "empty" | "closed";
    imagesRefused?: true;
  } {
    if (this.closed) return { accepted: false, reason: "closed" };
    if (!this.turnInFlight() || this.turnInterjection === undefined) return { accepted: false, reason: "idle" };
    const outcome = acceptInterjection(this.turnInterjection, text, opts);
    if (!outcome.accepted) return outcome;
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (this.active) {
      emit(this.active, { type: "interjection.queued", text: trimmed });
      if (outcome.imagesRefused === true) {
        emit(this.active, {
          type: "notice",
          message: "mid-turn steer: image attachments are not supported yet — your text was queued; images were dropped",
        });
      }
    }
    return outcome;
  }

  send(text: string, cb: RuntimeCallbacks): Promise<{ text: string; aborted: boolean; exit: RunExit }> {
    // Turns are serialized: a second send waits for the first to finish.
    this.pendingSends += 1;
    const run = this.sendQueue
      .then(
        () => this.runSend(text, cb),
        () => this.runSend(text, cb),
      )
      .finally(() => {
        this.pendingSends -= 1;
      });
    this.sendQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSend(text: string, cb: RuntimeCallbacks): Promise<{ text: string; aborted: boolean; exit: RunExit }> {
    if (this.closed) {
      emit(cb, { type: "error", message: "this runtime is closed" });
      return { text: "", aborted: false, exit: { terminal: "failed", detail: "internal_error" } };
    }
    const controller = new AbortController();
    this.controller = controller;
    this.active = cb;
    const interjection = new InterjectionBuffer();
    this.turnInterjection = interjection;
    while (this.queued.length > 0) emit(cb, { type: "notice", message: this.queued.shift() ?? "" });
    this.pruneLeases();
    const queue = new AdmissionQueue(this.store);
    const admissionId = queue.admit(this.session.id, text);
    if (!queue.begin(admissionId)) {
      const next = queue.nextRunnable(this.session.id);
      const reason =
        next.runnable === false && next.halted === true
          ? `admission halted (blocked by ${next.blockedBy})`
          : "admission could not begin (queue busy or already settled)";
      emit(cb, { type: "error", message: reason });
      queue.settle(admissionId, "failed", reason);
      if (this.controller === controller) this.controller = undefined;
      if (this.active === cb) this.active = undefined;
      if (this.turnInterjection === interjection) this.turnInterjection = undefined;
      return { text: "", aborted: false, exit: { terminal: "failed", detail: "internal_error" } };
    }
    try {
      const home = homedir();
      await this.ensureHookTrust();
      // Skills: list what is available, and when the human opens a message with
      // `/<skill>`, activate it by injecting the body for this turn only.
      const skillSections: string[] = [];
      const skillTrust = {
        trustedWorkspaceHooks: this.config.trustedWorkspaceHooks,
        home,
        onNotice: (message: string) => this.note(message),
      };
      const directory = skillsPromptSection(this.workspace, skillTrust);
      if (directory !== "") skillSections.push(directory);
      let userContent = text;
      const activated = resolveSkillForMessage(this.workspace, text, skillTrust);
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
      const catalog = loadCatalog();
      const contextWindowTokens = catalogWindow(this.provider.name, this.currentModel, catalog);
      const thinking = resolveThinkingEffort({
        userText: userContent,
        envValue: process.env.HZ_THINKING_EFFORT,
        autoDifficulty: process.env.HZ_THINKING_AUTO === "1",
      });
      if (thinking.effort !== undefined && thinking.source !== undefined) {
        emit(callbacks, {
          type: "notice",
          message: `thinking effort: ${thinking.effort} (${thinking.source})`,
        });
      }
      const outcome = await runTurn(
        {
          workspace: this.workspace,
          sessionId: this.session.id,
          model: this.currentModel,
          provider: this.provider,
          providerBaseUrl: this.config.resolved?.baseUrl ?? this.config.baseUrl ?? "",
          contextWindowTokens,
          kernel: this.kernel,
          store: this.store,
          signal: controller.signal,
          callbacks,
          interjection,
          sessionLeases: this.leases,
          thinkingEffort: thinking.effort,
          // Plan mode rides this run's deps: staging/refusals happen inside
          // executeTool, and the model is told via the plan rail line.
          planMode: this.planOn,
          permissionMode: this.mode,
          approve: this.instanceApproval ?? getApprovalHandler(),
          systemExtra: skillSections.length > 0 ? skillSections.join("\n\n") : undefined,
          ledger,
          effectHost: this.effectHost,
          trustedWorkspaceHooks: this.config.trustedWorkspaceHooks,
          delegate: (task, maxSteps, profile) =>
            runNested({
              workspace: this.workspace,
              task,
              maxSteps,
              profile,
              model: this.currentModel,
              provider: this.provider,
              kernel: this.kernel,
              store: this.store,
              signal: controller.signal,
              sessionLeases: this.leases,
              approve: this.instanceApproval ?? getApprovalHandler(),
              permissionMode: this.mode,
              ledger,
              effectHost: this.effectHost,
              trustedWorkspaceHooks: this.config.trustedWorkspaceHooks,
              onEvent: (ev) => emit(cb, ev),
            }),
        },
        userContent,
      );
      // Wave-14c: record the turn's checkpoint AFTER the run completed. The
      // label is the user's first line; the change ids come from the durable
      // journal's window, so a resumed process still rewinds by file state.
      this.recordTurnCheckpoint(text, turnStartedAt);
      const settlement =
        outcome.exit.terminal === "succeeded"
          ? "done"
          : outcome.exit.terminal === "interrupted" || outcome.exit.terminal === "unknown" || outcome.aborted
            ? "unknown"
            : "failed";
      queue.settle(admissionId, settlement, outcome.exit.detail ?? outcome.exit.terminal);
      return outcome;
    } catch (err) {
      queue.settle(admissionId, "unknown", errorMessage(err));
      emit(cb, { type: "error", message: `runtime error: ${errorMessage(err)}` });
      emit(cb, { type: "turn.done" });
      // Every outcome carries an exit (plan-mode turns included), so a caller
      // never has to guess whether a missing exit meant success.
      return {
        text: "",
        aborted: controller.signal.aborted,
        exit: controller.signal.aborted
          ? { terminal: "interrupted", detail: "aborted" }
          : { terminal: "failed", detail: "internal_error" },
      };
    } finally {
      const stranded = interjection.drainAll();
      for (const entry of stranded) {
        if (this.queued.length < 32) this.queued.push(entry.text);
        else this.note("mid-turn steer: a buffered message was dropped (queue full)");
      }
      if (this.controller === controller) this.controller = undefined;
      if (this.active === cb) this.active = undefined;
      if (this.turnInterjection === interjection) this.turnInterjection = undefined;
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
    this.modelsCatalogPollStop?.();
    this.modelsCatalogPollStop = undefined;
    this.anthropicCacheKeepaliveStop?.();
    this.anthropicCacheKeepaliveStop = undefined;
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
 * Bring up the runtime for one workspace. `sessionId` resumes that SPECIFIC
 * session by id (server-mode resume-by-id — fails closed if the id is unknown);
 * `continueSession` resumes the most recently touched session; otherwise a
 * fresh one starts (zero-config default: provider `mock`, no key, kernel
 * fallback when the Rust binary is absent). `sessionId` wins over
 * `continueSession` when both are set.
 */
export async function createRuntime(opts: RuntimeOptions): Promise<HzRuntime> {
  const workspace = path.resolve(opts?.workspace && opts.workspace.trim() !== "" ? opts.workspace : process.cwd());
  const startupNotices: string[] = [];
  const userConfigFile = readConfigFile(defaultConfigPath(homedir()));
  applySandboxChildNetFromConfig(userConfigFile, process.env);
  const effectHostFromConfig = applyEffectHostKernelFromUserConfig(userConfigFile, process.env);
  if (effectHostFromConfig.notice) startupNotices.push(effectHostFromConfig.notice);
  const config = augmentConfigWithTrustedWorkspace(loadConfig(process.env, undefined, workspace), workspace, process.env, homedir(), (message) =>
    startupNotices.push(message),
  );
  if (config.theme !== undefined) setThemeMode(config.theme);
  const model = opts?.model && opts.model.trim() !== "" ? opts.model.trim() : config.model;
  const provider = makeProvider(config, { mockFlag: opts?.mock === true });
  const store = new SessionStore(workspace);

  let session: SessionInfo | null = null;
  const wantId = typeof opts?.sessionId === "string" && opts.sessionId !== "" ? opts.sessionId : undefined;
  if (wantId !== undefined) {
    // Resume-by-id: open exactly the requested session. Fail closed if it is
    // not in this workspace rather than silently retargeting to another one, so
    // `session.list`'s per-id addressing is honest and a wrong id is a clean
    // error, never a surprise write to a different session's transcript.
    session = store.getSession(wantId);
    if (!session) {
      store.close();
      throw new Error(`no session ${wantId} in this workspace`);
    }
  }
  if (!session && opts?.continueSession) session = store.latestSession();
  const initialMode = opts?.permissionMode ?? config.permissionMode;
  if (!session) session = store.createSession("New chat", { permissionMode: initialMode });

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

  const effectHostSandboxDefault = applyEffectHostKernelSandboxDefault(
    process.env,
    await kernelEnforcesProcessSandbox(kernel),
  );
  if (effectHostSandboxDefault.notice) startupNotices.push(effectHostSandboxDefault.notice);

  const effectLedger = new WorkspaceEffectLedger(workspace);
  const effectHost = new EffectHost(effectLedger);
  effectHost.hydrate(loadEffectLedger(workspace).records);

  const rawBudget: RunBudget = { ...(config.budget ?? {}), ...(opts?.budget ?? {}) };

  impl = new HzRuntimeImpl({
    workspace,
    config,
    model,
    provider,
    store,
    session,
    kernel,
    permissionMode: opts?.permissionMode ?? config.permissionMode,
    // NF-073: steps stay capped at MAX_PROVIDER_CALLS unless the environment or
    // the caller set a budget; 0 (explicit) = unlimited, per dimension.
    budget: {
      maxSteps: rawBudget.maxSteps !== undefined ? rawBudget.maxSteps : MAX_PROVIDER_CALLS,
      maxTokens: rawBudget.maxTokens ?? 0,
      maxWallMs: rawBudget.maxWallMs ?? 0,
    },
    effectHost,
  });
  await impl.logSessionStart();
  await impl.attachEffectLedger();
  for (const message of startupNotices) impl.note(message);
  if (config.permissionModeRejected !== undefined) {
    impl.note(`config permissionMode ignored: ${config.permissionModeRejected}`);
  }
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
  impl.beginModelsCatalogPoll(
    startModelsCatalogPoll({
      home: homedir(),
      onNotice: (message) => impl.note(message),
    }),
  );
  impl.beginAnthropicCacheKeepalive(
    startAnthropicCacheKeepalive({
      onNotice: (message) => impl!.note(message),
      onMeasure: () => {
        if (impl!.providerName !== "anthropic") return undefined;
        const msgs = impl!.history();
        if (msgs.length === 0) return undefined;
        return formatCacheablePrefixMeasure(measureCacheablePrefix(msgs));
      },
    }),
  );
  return impl;
}

/** Register the process-wide approval handler (used by every runtime). */
export function setApprovalHandler(fn: ApprovalHandler): void {
  setProcessApprovalHandler(fn);
}

export { getApprovalHandler } from "./loop";
export { loadConfig, describeConfig, missingKey, DEFAULT_MODELS, builtinDefaultModel } from "./config";
export type { HzConfig, ProviderName } from "./config";
export {
  loadCatalog,
  curatedCatalog,
  decodeCatalog,
  decodeModel,
  validateCatalog,
  loadSnapshotFile,
  fetchLiveCatalog,
  catalogDefaultModel,
  catalogModel,
  catalogWindow,
  catalogCachePath,
  readCatalogCache,
  writeCatalogCache,
  MINIMUM_PROVIDERS,
  CATALOG_PATH,
  DEFAULT_CATALOG_SOURCE,
} from "./catalog/catalog";
export type { Catalog, LoadedCatalog, CatalogModel, CatalogProvider, CatalogSource, ModelCapabilities, ModelCost } from "./catalog/catalog";
export { KernelClient, LocalKernel, resolveKernelBinary } from "./kernel";
export { SessionStore, type SessionInfo } from "./session";
export { makeProvider, createMockProvider, createAnthropicProvider, createOpenAiProvider, createGoogleProvider, createOllamaProvider } from "./providers";
export { systemPrompt, MAX_PROVIDER_CALLS, HISTORY_LIMIT, MAX_CONSECUTIVE_FORMAT_ERRORS } from "./loop";
export { BudgetLedger, budgetCountdownLine, exitCodeFor } from "./loop";
export type { BudgetStop, BudgetCountdown } from "./loop";
export { listSkills, getSkill, skillsPromptSection, resolveSkillForMessage, activeSkillSection } from "./skills";
export { runNested, SUBAGENT_SYSTEM_PROMPT, clampSteps } from "./subagent";
export type { Skill } from "./skills";
