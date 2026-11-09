/**
 * subagent.ts — nested delegation runs.
 *
 * The `agent` tool asks the runtime for a DelegateRunner; the runtime builds one
 * here. A nested run is a small agent loop of its own, not a fork of the
 * conversation: a fresh child session, a focused system prompt, the seven base
 * tools (never `agent` itself — no recursion), the parent's abort signal, guard
 * flow and approvals. Children receive NO parent session leases (docs/09
 * R-tools-32: grants, never parent leases): every child effect that needs
 * approval re-enters the approval path on its own.
 *
 * The child writes its own messages to its own session and its own event
 * stream; every tool it runs leaves a receipt exactly like the parent's do. The
 * caller gets back one thing: the subagent's final report, capped.
 */

import type { ApprovalHandler, Lease, Provider, RuntimeEvent, ToolResult } from "../contracts";
// Hooks v1 lifecycle (docs/15 §2.4 H1): subagent.start/subagent.stop mark the
// child session boundary (session.start/end for the child), OBSERVATION-only
// (H4 — a subagent boundary hook can never block the delegated run).
import { loadHooks, runLifecycleHooks } from "./hooks";
import type { KernelClient } from "./kernel";
import { getApprovalHandler, runTurn, taskHead, type BudgetLedger, type LoopDeps } from "./loop";
import type { SessionStore } from "./session";
import { BASE_TOOL_NAMES } from "../tools";

/** The child prompt is fixed: a subagent reports, it does not converse. */
export const SUBAGENT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete the task, then report concisely. Do not ask questions.";

export const DEFAULT_SUBAGENT_STEPS = 12;
export const MAX_SUBAGENT_STEPS = 20;
export const SUBAGENT_OUTPUT_CAP = 8000;

/** Model turns a subagent may use: default 12, hard cap 20, never below 1. */
export function clampSteps(maxSteps?: number): number {
  const n =
    typeof maxSteps === "number" && Number.isFinite(maxSteps) ? Math.floor(maxSteps) : DEFAULT_SUBAGENT_STEPS;
  if (n < 1) return 1;
  return Math.min(n, MAX_SUBAGENT_STEPS);
}

function subagentTitle(task: string): string {
  const words = task.split(/\s+/).filter((word) => word !== "").slice(0, 8).join(" ");
  const suffix = words.length > 60 ? words.slice(0, 57) + "..." : words;
  return `subagent: ${suffix}`;
}

/** Most child events forwarded to the parent per delegated run. */
export const SUBAGENT_EVENT_CAP = 40;
/** Longest text field (summary, notice, child answer) a forwarded event keeps. */
export const SUBAGENT_EVENT_TEXT_CAP = 300;

function clip(text: unknown): string {
  const s = typeof text === "string" ? text : "";
  return s.length > SUBAGENT_EVENT_TEXT_CAP ? s.slice(0, SUBAGENT_EVENT_TEXT_CAP - 3) + "..." : s;
}

/**
 * Reduce one child event to its bounded, forwardable form, or null when the
 * parent should not see it (deltas, usage, diffs, turn boundaries).
 */
export function boundChildEvent(ev: RuntimeEvent): RuntimeEvent | null {
  switch (ev.type) {
    case "tool.card": {
      let args = ev.args;
      try {
        if (JSON.stringify(args).length > 400) args = { truncated: clip(JSON.stringify(args)) };
      } catch {
        args = {};
      }
      return {
        type: "tool.card",
        callId: ev.callId,
        name: clip(ev.name),
        args,
        status: ev.status,
        ...(ev.summary !== undefined ? { summary: clip(ev.summary) } : {}),
      };
    }
    case "notice":
      return { type: "notice", message: clip(ev.message) };
    case "error":
      return { type: "error", message: clip(ev.message) };
    case "assistant.done":
      return { type: "assistant.done", text: clip(ev.text) };
    default:
      return null;
  }
}

export interface NestedRunOptions {
  /** Receives bounded child events wrapped as `subagent.event` (parent stream). */
  onEvent?: (ev: RuntimeEvent) => void;
  workspace: string;
  task: string;
  maxSteps?: number;
  model: string;
  provider: Provider;
  kernel: KernelClient;
  store: SessionStore;
  signal: AbortSignal;
  /**
   * Accepted for caller compatibility and deliberately NOT forwarded to the
   * child: children receive no parent session leases (docs/09 R-tools-32 —
   * grants, never leases). A child effect needing approval re-enters the
   * approval path; passing leases here changes nothing.
   */
  sessionLeases?: Lease[];
  /** The parent's instance approval handler; the process one when absent. */
  approve?: ApprovalHandler;
  /** NF-073: the parent run's ledger — the child gets its own step slice but shares the ceiling. */
  ledger?: BudgetLedger;
}

/**
 * Run one delegated task to completion in a child session and return the
 * subagent's final text. Never throws: failures come back as the ToolResult.
 */
export async function runNested(opts: NestedRunOptions): Promise<ToolResult> {
  const task = typeof opts?.task === "string" ? opts.task.trim() : "";
  if (task === "") return { ok: false, output: "", error: "task is required" };
  const title = subagentTitle(task);
  const session = opts.store.createSession(title);
  let forwarded = 0;
  const deps: LoopDeps = {
    workspace: opts.workspace,
    sessionId: session.id,
    model: opts.model,
    provider: opts.provider,
    kernel: opts.kernel,
    store: opts.store,
    signal: opts.signal,
    // The child's transcript lands in its own session. A bounded subset of its
    // events (tool cards, notices, errors, final text) is also forwarded to the
    // parent as `subagent.event`, capped per run so a chatty child cannot flood
    // the parent's stream.
    callbacks: {
      onEvent: (ev) => {
        if (opts.onEvent === undefined) return;
        const bounded = boundChildEvent(ev);
        if (bounded === null) return;
        if (forwarded > SUBAGENT_EVENT_CAP) return;
        forwarded += 1;
        const out: RuntimeEvent =
          forwarded > SUBAGENT_EVENT_CAP
            ? { type: "notice", message: "child events capped" }
            : bounded;
        try {
          opts.onEvent({ type: "subagent.event", agentId: session.id, name: "agent", depth: 1, event: out });
        } catch {
          /* a sink failure must not fail the delegated run */
        }
      },
    },
    // R-tools-32: the child inherits no parent leases — only the parent's
    // approval handler, so its own effects can ask. Combined with the child's
    // own session id below, an owner-scoped 'always' lease minted for the
    // parent (kernel.ts/kernel guard.rs) does not answer the child's checks
    // either: the child re-enters approval in both transports.
    sessionLeases: [],
    approve: opts.approve ?? getApprovalHandler(),
    systemOverride: SUBAGENT_SYSTEM_PROMPT,
    // Base seven only: a subagent delegates to no one and drives no previews.
    toolFilter: (name) => (BASE_TOOL_NAMES as readonly string[]).includes(name),
    maxProviderCalls: clampSteps(opts.maxSteps),
    // NF-073: the child's step slice sits under the parent's shared ceiling.
    ledger: opts.ledger !== undefined ? opts.ledger.child({ maxSteps: clampSteps(opts.maxSteps) }) : undefined,
    // No `delegate`: a subagent can never spawn subagents.
  };
  // H1 subagent.start/subagent.stop (the child session boundary): OBSERVATION
  // hooks (H4) loaded once here. Any H9 note they return is already recorded as
  // an attributed event by the runner; it is not injected into the child's
  // request (the child drives its own run). A hook here can never block the
  // delegated run.
  const hooks = loadHooks(opts.workspace);
  const subagentDetail = { childSessionId: session.id, task: taskHead(task) };
  await runLifecycleHooks(hooks, {
    point: "subagentStart",
    sessionId: session.id,
    workspace: opts.workspace,
    detail: subagentDetail,
  });
  const { text, aborted, exit } = await runTurn(deps, task);
  await runLifecycleHooks(hooks, {
    point: "subagentStop",
    sessionId: session.id,
    workspace: opts.workspace,
    detail: { ...subagentDetail, terminal: exit.terminal, aborted },
  });
  try {
    // runTurn titles by first message; the subagent title is the better label.
    opts.store.touchSession(session.id, title);
  } catch {
    /* a cosmetic title must not fail the run */
  }
  const trimmed = text.trim();
  if (aborted) {
    return {
      ok: false,
      output: trimmed.slice(0, SUBAGENT_OUTPUT_CAP),
      error: "subagent run aborted",
    };
  }
  if (exit.terminal === "budget_exhausted" || exit.terminal === "timeout") {
    return {
      ok: false,
      output: trimmed.slice(0, SUBAGENT_OUTPUT_CAP),
      error: `subagent run stopped: budget exhausted (${exit.detail ?? "unknown"})`,
    };
  }
  if (trimmed === "") {
    return { ok: false, output: "(subagent produced no output)", error: "subagent produced no output" };
  }
  const output =
    trimmed.length > SUBAGENT_OUTPUT_CAP ? trimmed.slice(0, SUBAGENT_OUTPUT_CAP) + "\n[truncated]" : trimmed;
  return { ok: true, output };
}
