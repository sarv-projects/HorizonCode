/**
 * ptc-cell-host.ts — PTC cell lifecycle controls
 * (deepseek-harness / codex code-mode-host cell model ADAPT).
 *
 * Pure cell registry with `yield` / `wait` / `terminate` transitions over a
 * bounded number of active cells (MAX_ACTIVE_CELLS = 2048 per upstream). A cell
 * is running, yielded (suspended awaiting a host call) or terminated. This is
 * the lifecycle seam of PTC — no code evaluation, no V8 binding, no authority.
 */

export const MAX_ACTIVE_CELLS = 2048;

export type CellState = "running" | "yielded" | "terminated";

export interface PtcCellHostOptions {
  maxActive?: number;
}

export class PtcCellHost {
  private readonly cells = new Map<string, CellState>();
  private readonly maxActive: number;

  constructor(opts: PtcCellHostOptions = {}) {
    this.maxActive = Math.max(1, Math.floor(opts.maxActive ?? MAX_ACTIVE_CELLS));
  }

  /** Create a running cell; refuses past the active cap. */
  create(id: string): CellState {
    if (id.trim() === "") throw new Error("HZ_PRECONDITION_FAILED: cell id is empty");
    const existing = this.cells.get(id);
    if (existing !== undefined && existing !== "terminated") {
      throw new Error(`HZ_PRECONDITION_FAILED: cell ${id} already exists (${existing})`);
    }
    if (this.activeCount() >= this.maxActive) {
      throw new Error(`HZ_PRECONDITION_FAILED: active cell cap ${this.maxActive} reached`);
    }
    this.cells.set(id, "running");
    return "running";
  }

  state(id: string): CellState | undefined {
    return this.cells.get(id);
  }

  require(id: string, expected: CellState): void {
    const state = this.cells.get(id);
    if (state === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown cell ${id}`);
    if (state !== expected) {
      throw new Error(`HZ_PRECONDITION_FAILED: cell ${id} is ${state}, expected ${expected}`);
    }
  }

  yield(id: string): CellState {
    this.require(id, "running");
    this.cells.set(id, "yielded");
    return "yielded";
  }

  wait(id: string): CellState {
    this.require(id, "yielded");
    this.cells.set(id, "running");
    return "running";
  }

  terminate(id: string): CellState {
    const state = this.cells.get(id);
    if (state === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown cell ${id}`);
    if (state === "terminated") return "terminated"; // idempotent
    this.cells.set(id, "terminated");
    return "terminated";
  }

  /** Cells currently running (yielded/terminated excluded). */
  activeCount(): number {
    let n = 0;
    for (const s of this.cells.values()) if (s === "running") n += 1;
    return n;
  }

  total(): number {
    return this.cells.size;
  }
}
