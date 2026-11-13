/**
 * tool-batch-fifo.ts — NF-072 batch scheduling with explicit FIFO segment order (F6).
 *
 * `batchSegments` classifies a committed tool batch; `runClassedToolBatchFifo`
 * runs those segments in model order (FIFO). Shared segments still run
 * concurrently (all-settled); exclusive calls are single-call barriers.
 */

import type { ToolCall } from "../contracts";
import { getTool } from "../tools";

export type ToolBatchFifoOutcome = { aborted: boolean; fatal: boolean };

/**
 * NF-072 batch scheduling. Every tool carries a concurrency class: `shared`
 * calls in one batch run concurrently; an `exclusive` call is its own barrier
 * (`docs/24` NF-072). Unknown tools are pure error paths and share.
 */
export function concurrencyClassOf(name: string): "shared" | "exclusive" {
  return getTool(name)?.concurrencyClass === "exclusive" ? "exclusive" : "shared";
}

/** Split a batch into execution segments: a shared run, then an exclusive barrier, then the next run. */
export function batchSegments(calls: ToolCall[]): ToolCall[][] {
  const segments: ToolCall[][] = [];
  let shared: ToolCall[] = [];
  for (const call of calls) {
    if (concurrencyClassOf(call.name) === "exclusive") {
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
  },
): Promise<ToolBatchFifoOutcome> {
  let aborted = false;
  let fatal = false;
  for (const segment of batchSegments(calls)) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    await Promise.all(
      segment.map((call) =>
        options.runCall(call).catch((err) => {
          if (options.onCallError) {
            const verdict = options.onCallError(call, err);
            if (verdict === "fatal") fatal = true;
          }
        }),
      ),
    );
    if (fatal) break;
  }
  return { aborted, fatal };
}
