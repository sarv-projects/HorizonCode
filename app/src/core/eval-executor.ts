/**
 * eval-executor.ts — the live-loop executor for the eval runner (docs/30 §4
 * item 8; the piece `core/evals.ts` names as "not in this slice").
 *
 * `core/evals.ts` grades; it never runs anything. This module runs ONE eval
 * case through the real harness — the real loop, the real guard, the real
 * kernel, the real tools — in a disposable scratch workspace, and reports
 * exactly the three things the grader is allowed to see:
 * `{terminal, finalAnswer, toolCalls}`. No transcript, no tool results, no
 * receipts: that boundary is what keeps the grader's inputs honest.
 *
 * Two ways to run a case, one result shape:
 *
 *  - `makeRuntimeExecutor` — the product path. It builds the runtime the TUI
 *    and headless mode build (`core/index.ts` `createRuntime`), so an eval case
 *    exercises the same composition root as a real chat: config, provider
 *    selection, kernel start, session open, crash repair. `mock: true` (the
 *    default) forces the offline provider, so the run is hermetic and
 *    deterministic; `mock: false` runs against the configured real provider
 *    (the live-provider half — needs a key).
 *
 *  - `makeScriptedExecutor` — the test-model path. The model is a caller-
 *    supplied `Provider` (see `providers/scripted.ts`), so an eval case can
 *    pin the exact turn shape it means to test. The deps are assembled here the
 *    way the suites assemble them (kernel + store + `runTurn`), because the
 *    runtime composition root does not accept an injected provider.
 *
 * One scratch workspace per case, always: `opts.rootDir` (default the OS temp
 * dir) gets a fresh `hz-eval-ws-*` directory, `opts.files` seeds it, the run
 * happens there, and the directory is removed afterwards unless
 * `keepWorkspaces` is set. Nothing in the caller's workspace is touched — an
 * eval must be able to run from anywhere, including CI, without rearranging the
 * repository it started from.
 *
 * Approvals: DEFAULT DENY. A scratch workspace's in-workspace reads and writes
 * are already allowed by the guard's defaults, so the offline paths never hit
 * the handler; anything that asks (a write outside the scratch dir, a shell
 * command) is refused unless the caller sets `autoApprove: true`. That flag is
 * for disposable, hermetic runs — a live-provider executor should leave it off.
 *
 * `finalAnswer` is pinned to what the runtime reports as the run's assistant
 * text (`Runtime.send` → `text`): the grader's `no_answer_leak` run-half scans
 * exactly this string. `terminal` is the run's `exit.terminal` when the run
 * produced one, else `cancelled` for an aborted run and `succeeded` for an
 * un-aborted one — the same fallback `exitCodeFor` uses (an absent exit is
 * success, and a run that was stopped is not a success).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, RunBudget, RuntimeEvent, TerminalState, Usage } from "../contracts";
import type { PostmortemEvalCase } from "./evals";
import type { EvalExecutor, EvalExecutorResult } from "./evals";
import { metricContract } from "./metrics";
import { createRuntime } from "./index";
import { KernelClient } from "./kernel";
import type { LoopDeps } from "./loop";
import { runTurn } from "./loop";
import { SessionStore } from "./session";

export interface LoopEvalExecutorOptions {
  /** Parent directory for scratch workspaces. Default: the OS temp dir. */
  rootDir?: string;
  /** Model name the run records. Default: the runtime's configured default. */
  model?: string;
  /** The product path: `true` (default) forces the offline provider. */
  mock?: boolean;
  /**
   * The scripted path: when set, the deps are assembled directly with this
   * provider instead of the runtime composition root. `mock` is ignored.
   */
  provider?: Provider;
  /** Run budget for one case. Default: 12 steps, no token or wall cap beyond the loop's own. */
  budget?: RunBudget;
  /** Keep each case's scratch workspace (for inspection). Default: false. */
  keepWorkspaces?: boolean;
  /** Files to seed into every scratch workspace, relative to its root. */
  files?: Readonly<Record<string, string>>;
  /**
   * Let the guard's asks succeed ("approve everything"). Default: false —
   * asks are refused. Only for disposable, hermetic runs.
   */
  autoApprove?: boolean;
}

/** What one executed case left behind, for the runner's report. */
export interface EvalObservation {
  caseId: string;
  /** The scratch workspace the case ran in (kept on disk only when `keepWorkspaces`). */
  workspace: string;
  terminal: TerminalState;
  /** Distinct tool names the run exercised, in first-seen order. */
  toolCalls: string[];
  /** Length of the run's final assistant text, in characters. */
  textChars: number;
  /** Final assistant text (preds.json `model_patch` reduced form). */
  submission: string;
  model: string;
  sessionId: string;
  /** Wall time for the case, milliseconds. */
  durationMs: number;
  /** True when the workspace was left on disk. */
  kept: boolean;
  /**
   * F-4: provider-reported token usage captured from the runtime's `usage`
   * facade events (summed across the case's model turns). Absent when the
   * provider reported no usage — the runner then counts $0 with source `none`.
   */
  usage?: Usage;
  /** Provider name that reported the usage (first turn wins). */
  provider?: string;
}

export interface LoopEvalExecutor {
  /** The `EvalExecutor` to hand to `runEvalCase`/`runEvalSet`. */
  executor: EvalExecutor;
  /** Per-case observations, in execution order. */
  observations(): readonly EvalObservation[];
  /** Scratch workspaces left on disk (empty unless `keepWorkspaces`). */
  keptWorkspaces(): readonly string[];
}

/**
 * H-7: contracted machine-readable facts about one executor's observations.
 * The observation fields are raw (callers branch on them); this is the
 * publication surface where each number carries its four contract slots.
 */
export function evalExecutorPublication(observations: readonly EvalObservation[]): string[] {
  const cases = observations.length;
  const toolCalls = observations.reduce((s, o) => s + o.toolCalls.length, 0);
  const durationMs = observations.reduce((s, o) => s + o.durationMs, 0);
  const withUsage = observations.filter((o) => o.usage !== undefined).length;
  const anchor = "none — first executor observation set (no prior run to compare against)";
  const population = `${cases} eval case(s) executed through this loop evaluator`;
  const excludes = "none — every executed case contributes an observation; an aborted run is still counted";
  return [
    metricContract({ metric: "eval executor cases executed", anchor, population, excludes, value: cases }),
    metricContract({ metric: "eval executor distinct tool names observed", anchor, population, excludes, value: toolCalls }),
    metricContract({ metric: "eval executor wall-clock (milliseconds)", anchor, population, excludes, value: `${Math.round(durationMs)}ms` }),
    metricContract({ metric: "eval executor cases reporting usage", anchor, population, excludes, value: `${withUsage}/${cases}` }),
  ];
}

const DEFAULT_EVAL_BUDGET: RunBudget = { maxSteps: 12, maxTokens: 0, maxWallMs: 0 };

function seedWorkspace(workspace: string, files: Readonly<Record<string, string>> | undefined): void {
  if (files === undefined) return;
  for (const [rel, content] of Object.entries(files)) {
    const target = path.resolve(workspace, rel);
    // Never let a seed escape the scratch workspace.
    if (target !== workspace && !target.startsWith(workspace + path.sep)) {
      throw new Error(`eval seed escapes the scratch workspace: ${rel}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/** The fallback terminal when a run produced no `RunExit`: mirror `exitCodeFor`. */
function terminalOf(exit: { terminal: TerminalState } | undefined, aborted: boolean): TerminalState {
  if (exit !== undefined) return exit.terminal;
  return aborted ? "cancelled" : "succeeded";
}

/** Distinct tool names in first-seen order from the session's own history. */
function toolCallsFromHistory(rows: ReadonlyArray<{ role: string; toolName?: string }>): string[] {
  const names: string[] = [];
  for (const row of rows) {
    if (row.role !== "tool") continue;
    const name = typeof row.toolName === "string" ? row.toolName : "";
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * F-4: capture provider-reported usage from the runtime's additive `usage`
 * facade events. One event is emitted per model turn; token fields are summed
 * so a multi-step case is attributed to the whole run. The first provider/model
 * seen wins (a case uses one provider). Nothing is invented: with no events the
 * snapshot is empty, and `evals.ts` honestly records $0 with source `none`.
 */
interface UsageCapture {
  onEvent(ev: RuntimeEvent): void;
  snapshot(): { usage?: Usage; provider?: string; model?: string };
}

function captureProviderUsage(): UsageCapture {
  let usage: Usage | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  const add = (key: keyof Usage, value: number | undefined): void => {
    if (value === undefined) return;
    if (usage === undefined) usage = {};
    usage[key] = (usage[key] ?? 0) + value;
  };
  return {
    onEvent(ev) {
      if (ev.type !== "usage") return;
      if (provider === undefined) provider = ev.provider;
      if (model === undefined) model = ev.model;
      add("inputTokens", ev.usage.inputTokens);
      add("outputTokens", ev.usage.outputTokens);
      add("cacheCreationInputTokens", ev.usage.cacheCreationInputTokens);
      add("cacheReadInputTokens", ev.usage.cacheReadInputTokens);
    },
    snapshot() {
      return {
        ...(usage !== undefined ? { usage } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
      };
    },
  };
}

/**
 * The product path: `createRuntime` with `mock` (default true), one scratch
 * workspace per case. Hermetic when mocked; the live-provider half when not.
 */
export function makeRuntimeExecutor(opts: LoopEvalExecutorOptions = {}): LoopEvalExecutor {
  const observations: EvalObservation[] = [];
  const kept: string[] = [];

  const executor: EvalExecutor = async (caseObj: PostmortemEvalCase): Promise<EvalExecutorResult> => {
    const workspace = mkdtempSync(path.join(opts.rootDir ?? tmpdir(), "hz-eval-ws-"));
    seedWorkspace(workspace, opts.files);
    const started = Date.now();
    let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
    try {
      const captured = captureProviderUsage();
      runtime = await createRuntime({
        workspace,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        mock: opts.mock ?? true,
        budget: opts.budget ?? DEFAULT_EVAL_BUDGET,
      });
      const result = await runtime.send(caseObj.task, { onEvent: (ev) => captured.onEvent(ev) });
      const toolCalls = toolCallsFromHistory(runtime.history());
      const terminal = terminalOf(result.exit, result.aborted);
      const keep = opts.keepWorkspaces === true;
      const usage = captured.snapshot();
      observations.push({
        caseId: caseObj.id,
        workspace,
        terminal,
        toolCalls,
        textChars: result.text.length,
        submission: result.text,
        model: runtime.model,
        sessionId: runtime.sessionId,
        durationMs: Date.now() - started,
        kept: keep,
        ...(usage.usage !== undefined ? { usage: usage.usage } : {}),
        ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
      });
      if (keep) kept.push(workspace);
      return {
        terminal,
        finalAnswer: result.text,
        toolCalls,
        ...(usage.usage !== undefined ? { usage: usage.usage } : {}),
        ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
        ...(usage.model !== undefined ? { model: usage.model } : {}),
      };
    } finally {
      if (runtime !== undefined) await runtime.close().catch(() => undefined);
      if (opts.keepWorkspaces !== true) rmSync(workspace, { recursive: true, force: true });
    }
  };

  return { executor, observations: () => observations, keptWorkspaces: () => kept };
}

/**
 * The scripted path: deps assembled the way the suites assemble them, with a
 * caller-supplied provider. Everything else (scratch workspace, one case per
 * call, the three-field result) is identical to the product path.
 */
export function makeScriptedExecutor(
  provider: Provider,
  opts: LoopEvalExecutorOptions = {},
): LoopEvalExecutor {
  const observations: EvalObservation[] = [];
  const kept: string[] = [];

  const executor: EvalExecutor = async (caseObj: PostmortemEvalCase): Promise<EvalExecutorResult> => {
    const workspace = mkdtempSync(path.join(opts.rootDir ?? tmpdir(), "hz-eval-ws-"));
    seedWorkspace(workspace, opts.files);
    const started = Date.now();
    const kernel = new KernelClient({ workspace });
    const store = new SessionStore(workspace);
    try {
      await kernel.start();
      const session = store.createSession("eval");
      const captured = captureProviderUsage();
      const deps: LoopDeps = {
        workspace,
        sessionId: session.id,
        model: opts.model ?? "scripted-1",
        provider,
        kernel,
        store,
        signal: new AbortController().signal,
        callbacks: { onEvent: (ev) => captured.onEvent(ev) },
        sessionLeases: [],
        approve: async () => opts.autoApprove === true,
        budget: opts.budget ?? DEFAULT_EVAL_BUDGET,
      };
      const result = await runTurn(deps, caseObj.task);
      const toolCalls = toolCallsFromHistory(store.history(session.id));
      const terminal = terminalOf(result.exit, result.aborted);
      const keep = opts.keepWorkspaces === true;
      const usage = captured.snapshot();
      observations.push({
        caseId: caseObj.id,
        workspace,
        terminal,
        toolCalls,
        textChars: result.text.length,
        submission: result.text,
        model: deps.model,
        sessionId: deps.sessionId,
        durationMs: Date.now() - started,
        kept: keep,
        ...(usage.usage !== undefined ? { usage: usage.usage } : {}),
        ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
      });
      if (keep) kept.push(workspace);
      return {
        terminal,
        finalAnswer: result.text,
        toolCalls,
        ...(usage.usage !== undefined ? { usage: usage.usage } : {}),
        ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
        ...(usage.model !== undefined ? { model: usage.model } : {}),
      };
    } finally {
      await kernel.close().catch(() => undefined);
      store.close();
      if (opts.keepWorkspaces !== true) rmSync(workspace, { recursive: true, force: true });
    }
  };

  return { executor, observations: () => observations, keptWorkspaces: () => kept };
}
