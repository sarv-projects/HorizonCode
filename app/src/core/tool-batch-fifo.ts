/**
 * tool-batch-fifo.ts — NF-072 batch scheduling with explicit FIFO segment order (F6).
 *
 * `batchSegments` classifies a committed tool batch; `runClassedToolBatchFifo`
 * runs those segments in model order (FIFO). Shared segments still run
 * concurrently (all-settled); exclusive calls are single-call barriers.
 */

import type { ToolCall } from "../contracts";
import type { CancelGate } from "./cancel-gate";
import { getTool } from "../tools";
import { agentCallIsShared } from "../tools/agent";

export type ToolBatchFifoOutcome = { aborted: boolean; fatal: boolean };

/** Default concurrency cap for a shared segment (plan Task 17). */
export const DEFAULT_MAX_BATCH_CONCURRENCY = 4;

/**
 * NF-072 batch scheduling. Every tool carries a concurrency class: `shared`
 * calls in one batch run concurrently; an `exclusive` call is its own barrier
 * (`docs/24` NF-072). Unknown tools are pure error paths and share.
 *
 * Ruling 663: `agent` with a read-only profile (explore/review/plan/never) is
 * shared so the parent can fan out parallel research subagents in one batch.
 */
export function concurrencyClassOf(
  name: string,
  args?: Record<string, unknown>,
): "shared" | "exclusive" {
  if (name === "agent" && agentCallIsShared(args)) return "shared";
  // shell_bg kill mutates process state — exclusive barrier; poll/output/list share.
  if (name === "shell_bg") {
    const op = typeof args?.op === "string" ? args.op.trim() : "";
    return op === "kill" ? "exclusive" : "shared";
  }
  return getTool(name)?.concurrencyClass === "exclusive" ? "exclusive" : "shared";
}

/** Split a batch into execution segments: a shared run, then an exclusive barrier, then the next run. */
export function batchSegments(calls: ToolCall[]): ToolCall[][] {
  const segments: ToolCall[][] = [];
  let shared: ToolCall[] = [];
  for (const call of calls) {
    let args: Record<string, unknown> | undefined;
    if (typeof call.arguments === "string" && call.arguments.trim() !== "") {
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = undefined;
      }
    }
    if (concurrencyClassOf(call.name, args) === "exclusive") {
      if (shared.length > 0) segments.push(shared);
      shared = [];
      segments.push([call]);
    } else {
      shared.push(call);
    }
  }
  if (shared.length > 0) segments.push(shared);
  return segments;
}

/**
 * Run an already-classified batch in strict segment FIFO. The `runCall` hook
 * owns per-call work (guard, execute, receipt); this helper only schedules.
 */
export async function runClassedToolBatchFifo(
  calls: ToolCall[],
  options: {
    signal?: AbortSignal;
    runCall: (call: ToolCall) => Promise<void>;
    onCallError?: (call: ToolCall, err: unknown) => void | "fatal";
    /** Cap on concurrent calls inside one shared segment (default 4). */
    maxConcurrency?: number;
    /** Optional cooperative gate consulted before each dispatch. */
    gate?: CancelGate;
  },
): Promise<ToolBatchFifoOutcome> {
  let aborted = false;
  let fatal = false;
  const cap = Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_BATCH_CONCURRENCY));
  let active = 0;
  const waiters: Array<() => void> = [];
  const wakeAll = (): void => {
    for (const wake of waiters.splice(0)) wake();
  };
  const acquire = async (): Promise<boolean> => {
    while (active >= cap) {
      await new Promise<void>((resolve) => waiters.push(resolve));
      if (options.signal?.aborted) {
        wakeAll(); // every queued caller must fail closed on abort
        return false;
      }
    }
    if (options.signal?.aborted) {
      wakeAll();
      return false;
    }
    active += 1;
    return true;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };

  for (const segment of batchSegments(calls)) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    await Promise.all(
      segment.map(async (call) => {
        let acquired = false;
        try {
          options.gate?.throwIfCancelled();
          if (!(await acquire())) {
            aborted = true;
            return;
          }
          acquired = true;
          options.gate?.throwIfCancelled();
          await options.runCall(call);
        } catch (err) {
          if (options.onCallError) {
            const verdict = options.onCallError(call, err);
            if (verdict === "fatal") fatal = true;
          }
        } finally {
          if (acquired) release();
        }
      }),
    );
    if (aborted || fatal) break;
  }
  return { aborted, fatal };
}
