/**
 * code-mode-execution.ts — coherent Code Mode execution seam.
 *
 * Wires the three previously-separate VM/PTC pieces into one suspend/resume
 * scheduler:
 *   - `PtcCellHost`  — cell lifecycle (running → yielded → running, terminate)
 *   - `createFuelMeter` — deterministic instruction/native fuel + slice deadline
 *   - `encodeGraph`/`decodeGraph` — cyclic-safe snapshot of the cell's value
 *   - `runBytecode` (code-mode-vm) — a REAL minimal bytecode interpreter
 *
 * A `step` charges fuel; on exhaustion/slice deadline it yields the cell and
 * snapshots the supplied value via the graph codec. `resume` restores the cell
 * to running with a fresh budget. `runBytecode` executes real bytecode inside a
 * cell, tying the interpreter into the same lifecycle. No V8 binding / async
 * host bridge — the full VM/PTC surface. No authority, no I/O.
 */

import { PtcCellHost, type CellState } from "./ptc-cell-host";
import { createFuelMeter, tickFuel, type FuelMeter } from "./vm-fuel-meter";
import { encodeGraph, decodeGraph, type Snapshot } from "./vm-snapshot-codec";
import { runBytecode, type BytecodeProgram, type VmResult } from "./code-mode-vm";
import { createGenerator, type Generator, type GeneratorOptions } from "./code-mode-generator";
import { createHostBridge, type HostBridge, type HostBridgeOptions } from "./code-mode-host-bridge";

export interface ExecutionState {
  cell: CellState;
  fuel: number;
  snapshots: number;
}

export interface StepResult {
  verdict: "run" | "suspended";
  snapshot?: Snapshot;
}

export interface CodeModeExecutionOptions {
  initialFuel?: number;
  maxActive?: number;
  now?: () => number;
}

export class CodeModeExecution {
  private readonly cells: PtcCellHost;
  private readonly meters = new Map<string, FuelMeter>();
  private readonly snapshots = new Map<string, Snapshot[]>();
  private readonly opts: CodeModeExecutionOptions;

  constructor(opts: CodeModeExecutionOptions = {}) {
    this.opts = opts;
    this.cells = new PtcCellHost({ maxActive: opts.maxActive });
  }

  create(id: string): CellState {
    const state = this.cells.create(id);
    this.meters.set(id, createFuelMeter({ initial: this.opts.initialFuel, now: this.opts.now }));
    this.snapshots.set(id, []);
    return state;
  }

  state(id: string): CellState | undefined {
    return this.cells.state(id);
  }

  /** Charge fuel for a step; on suspend, yield the cell and snapshot `value`. */
  step(id: string, cost: number, value: unknown): StepResult {
    const meter = this.meters.get(id);
    if (meter === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown cell ${id}`);
    const st = this.cells.state(id);
    if (st !== "running") throw new Error(`HZ_PRECONDITION_FAILED: cell ${id} is ${st}, expected running`);
    const result = tickFuel(meter, cost);
    this.meters.set(id, result.state);
    if (result.verdict === "suspend") {
      this.cells.yield(id);
      const snapshot = encodeGraph([value]);
      this.snapshots.get(id)!.push(snapshot);
      return { verdict: "suspended", snapshot };
    }
    return { verdict: "run" };
  }

  /** Resume a suspended cell with a fresh fuel budget. */
  resume(id: string): CellState {
    if (this.cells.state(id) !== "yielded") {
      throw new Error(`HZ_PRECONDITION_FAILED: cell ${id} is not yielded (cannot resume)`);
    }
    this.meters.set(id, createFuelMeter({ initial: this.opts.initialFuel, now: this.opts.now }));
    return this.cells.wait(id); // yielded → running
  }

  /**
   * Execute real bytecode inside a cell: yields the cell first, runs the
   * interpreter, then restores it to running with a snapshot of the result.
   * Ties the code-mode-vm interpreter into the coherent lifecycle.
   */
  runBytecode(id: string, program: BytecodeProgram): VmResult {
    const cell = this.cells.state(id);
    if (cell === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown cell ${id}`);
    if (cell === "terminated") throw new Error(`HZ_PRECONDITION_FAILED: cell ${id} is terminated`);
    const result = runBytecode(program, {
      initialFuel: this.opts.initialFuel,
      now: this.opts.now,
    });
    const snapshot = encodeGraph([result.value]);
    this.snapshots.get(id)!.push(snapshot);
    return result;
  }

  /** Open a resumable generator over bytecode inside a cell. */
  createGenerator(id: string, program: BytecodeProgram, opts: GeneratorOptions = {}): Generator {
    const cell = this.cells.state(id);
    if (cell === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown cell ${id}`);
    if (cell === "terminated") throw new Error(`HZ_PRECONDITION_FAILED: cell ${id} is terminated`);
    return createGenerator(program, {
      initialFuel: opts.initialFuel ?? this.opts.initialFuel,
      now: opts.now ?? this.opts.now,
    });
  }

  /** Open an async host bridge over bytecode in a cell (host calls suspend/resume). */
  createHostBridge(id: string, program: BytecodeProgram, opts: HostBridgeOptions): HostBridge {
    const cell = this.cells.state(id);
    if (cell === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown cell ${id}`);
    if (cell === "terminated") throw new Error(`HZ_PRECONDITION_FAILED: cell ${id} is terminated`);
    return createHostBridge(program, opts);
  }

  /** Decode a snapshot back into its value (proof the graph codec round-trips). */
  inspectSnapshot(snapshot: Snapshot): unknown {
    const [value] = decodeGraph(snapshot);
    return value;
  }

  terminate(id: string): CellState {
    return this.cells.terminate(id);
  }

  executionState(id: string): ExecutionState | undefined {
    const cell = this.cells.state(id);
    if (cell === undefined) return undefined;
    return {
      cell,
      fuel: this.meters.get(id)?.fuel ?? 0,
      snapshots: this.snapshots.get(id)?.length ?? 0,
    };
  }
}
