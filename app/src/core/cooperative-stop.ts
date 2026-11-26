/**
 * cooperative-stop.ts — port of opencode COOPERATIVE_STOP grace window (Group B).
 * Source: repo_take/opencode/packages/core/src/session/runner/step.ts:106-117,370.
 *
 * A user stop asks each cancelable tool to settle its own call (triggerCancel),
 * immediately interrupts tools WITHOUT a cancel handle, waits up to the grace
 * window for the rest, then hard-interrupts any that did not settle. Pure async
 * helper: interrupt/settle/trigger are injected, timeout is injectable. No
 * authority, no contract change.
 */

export const COOPERATIVE_STOP_MS = 5000;

export interface ToolRun {
  /** Signal the tool to stop itself; false means it has no cooperative cancel. */
  triggerCancel(): boolean;
  /** Resolves when the tool has settled on its own. */
  settle(): Promise<void>;
  /** Hard interrupt (last resort). */
  interrupt(): void;
}

export interface CooperativeStopResult {
  cooperativelySettled: number;
  forceInterrupted: number;
}

export interface CooperativeStopOptions {
  timeoutMs?: number;
}

export async function cooperativeStop(
  runs: readonly ToolRun[],
  opts: CooperativeStopOptions = {},
): Promise<CooperativeStopResult> {
  const immediate: ToolRun[] = [];
  const cancelable: ToolRun[] = [];
  for (const toolRun of runs) {
    if (toolRun.triggerCancel()) cancelable.push(toolRun);
    else immediate.push(toolRun);
  }
  // Tools with no cooperative cancel are interrupted right away.
  for (const toolRun of immediate) toolRun.interrupt();

  const timeoutMs = opts.timeoutMs ?? COOPERATIVE_STOP_MS;
  const settledFlags = cancelable.map(() => false);
  const tracked = cancelable.map((toolRun, index) =>
    toolRun.settle().then(
      () => {
        settledFlags[index] = true;
      },
      () => {
        /* a rejected settle is not a cooperative success */
      },
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
  });
  await Promise.race([Promise.all(tracked).then(() => "all-settled" as const), deadline]);
  if (timer !== undefined) clearTimeout(timer);

  const cooperativelySettled = settledFlags.filter(Boolean).length;
  const stillOutstanding = settledFlags.length - cooperativelySettled;
  // Any tool that did not settle within the grace window is hard-interrupted.
  cancelable.forEach((toolRun, index) => {
    if (!settledFlags[index]) toolRun.interrupt();
  });
  return {
    cooperativelySettled,
    forceInterrupted: immediate.length + stillOutstanding,
  };
}
