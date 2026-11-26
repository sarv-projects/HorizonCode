/**
 * cancel-gate.ts -- cooperative cancel gate (plan Task 18).
 *
 * Reads signal.aborted on every call (no caching, no timers). Refuses NEW
 * dispatches only; it never cancels a receipt, record or already-running tool.
 */

export class CancelGateError extends Error {
  constructor() {
    super("cancelled before dispatch");
    this.name = "CancelGateError";
  }
}

export interface CancelGate {
  aborted(): boolean;
  throwIfCancelled(): void;
}

export function createCancelGate(signal?: AbortSignal): CancelGate {
  return {
    aborted: () => signal?.aborted === true,
    throwIfCancelled: () => {
      if (signal?.aborted === true) throw new CancelGateError();
    },
  };
}
