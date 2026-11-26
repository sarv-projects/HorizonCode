/**
 * code-mode-vm.ts — minimal genuine stack bytecode VM (opencode VM ADAPT).
 * Source: repo_take/opencode/packages/codemode/src/vm/opcodes.ts (Op enum).
 *
 * A REAL interpreter over a meaningful subset of the upstream opcodes, with
 * upstream-identical values: constants, stack ops, arithmetic/comparison,
 * locals, control (jumps/return), CELLS + CLOSURES + CALL (a frame stack), and
 * fuel metering via `createFuelMeter`. No closures-capture mutation limits, no
 * imports/generators/async host bridge — those remain the full VM/PTC surface.
 * Zero runtime deps, no eval.
 */

import { createFuelMeter, tickFuel, type FuelMeter } from "./vm-fuel-meter";
import type { ModuleRegistry } from "./code-mode-modules";

/** Subset of the upstream `Op` enum, values kept identical for parity. */
export const Op = {
  PUSH_UNDEF: 0,
  PUSH_NULL: 1,
  PUSH_BOOL: 2,
  PUSH_INT: 3,
  PUSH_CONST: 4,
  POP: 5,
  DUP: 7,
  GET_LOCAL: 10,
  PUT_LOCAL: 11,
  IMPORT: 24,
  GET_PROP: 25,
  NEW_CELL: 13,
  GET_CELL: 15,
  PUT_CELL: 16,
  GET_UPVAL: 17,
  CLOSURE: 22,
  ADD: 43,
  SUB: 44,
  MUL: 45,
  LT: 46,
  LE: 47,
  GT: 48,
  GE: 49,
  SEQ: 50,
  SNE: 51,
  JUMP: 59,
  JUMP_IF_FALSE: 61,
  JUMP_IF_TRUE: 62,
  RETURN: 67,
  NOP: 68,
  CALL: 70,
} as const;

export interface BytecodeProgram {
  words: number[];
  consts: unknown[];
  localCount?: number;
}

export interface VmResult {
  value: unknown;
  halted: "return" | "out_of_fuel" | "end";
  fuel: number;
  steps: number;
}

export interface VmOptions {
  initialFuel?: number;
  now?: () => number;
  /** Injected module registry for the IMPORT opcode; absent = imports refused. */
  modules?: ModuleRegistry;
}

const VM_FUNCTION_BRAND = Symbol("HzVmFunction");
const BLOCKED_PROPS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CELLS = 1024;

interface Cell { v: unknown }
interface FunctionObj { [VM_FUNCTION_BRAND]: true; start: number; upvals: Cell[] }

function isFunction(v: unknown): v is FunctionObj {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<symbol, unknown>)[VM_FUNCTION_BRAND] === true
  );
}

function truthy(v: unknown): boolean {
  if (typeof v === "string") return v !== "";
  return Boolean(v);
}

/** Execute one frame (a program region) recursively; CALL creates a new frame. */
function runFrame(
  program: BytecodeProgram,
  startPc: number,
  locals: unknown[],
  cells: Cell[],
  upvals: Cell[],
  initial: FuelMeter,
  clock: () => number,
  depth: number,
  modules: ModuleRegistry | undefined,
): VmResult {
  if (depth > 64) throw new Error("HZ_VM_FAULT: call depth exceeded");
  const words = program.words;
  const consts = program.consts ?? [];
  const stack: unknown[] = [];
  let meter = initial;
  let pc = startPc;
  let steps = 0;

  const pop = (): unknown => {
    if (stack.length === 0) throw new Error("HZ_VM_FAULT: stack underflow");
    return stack.pop();
  };
  const operand = (at: number): number => {
    if (at >= words.length) throw new Error("HZ_VM_FAULT: truncated operand");
    return words[at]!;
  };
  const cellAt = (idx: number, pool: Cell[], label: string): Cell => {
    const c = pool[idx];
    if (c === undefined) throw new Error(`HZ_VM_FAULT: unknown ${label} index ${idx}`);
    return c;
  };

  while (pc < words.length) {
    const r = tickFuel(meter, 1, clock());
    meter = r.state;
    if (r.verdict === "suspend") {
      return { value: stack[stack.length - 1], halted: "out_of_fuel", fuel: meter.fuel, steps };
    }
    const op = words[pc]!;
    steps += 1;
    switch (op) {
      case Op.PUSH_UNDEF: stack.push(undefined); pc += 1; break;
      case Op.PUSH_NULL: stack.push(null); pc += 1; break;
      case Op.PUSH_BOOL: stack.push(Boolean(operand(pc + 1))); pc += 2; break;
      case Op.PUSH_INT: stack.push(operand(pc + 1)); pc += 2; break;
      case Op.PUSH_CONST: {
        const i = operand(pc + 1);
        stack.push(i >= 0 && i < consts.length ? consts[i] : undefined);
        pc += 2;
        break;
      }
      case Op.IMPORT: {
        const idx = operand(pc + 1);
        const name = idx >= 0 && idx < consts.length ? String(consts[idx]) : "";
        const mod = modules?.get(name);
        if (mod === undefined) throw new Error(`HZ_VM_FAULT: unknown module ${name}`);
        stack.push(mod);
        pc += 2;
        break;
      }
      case Op.GET_PROP: {
        const idx = operand(pc + 1);
        const key = idx >= 0 && idx < consts.length ? String(consts[idx]) : "";
        if (BLOCKED_PROPS.has(key)) {
          throw new Error(`HZ_VM_FAULT: forbidden property access ${key}`);
        }
        const obj = pop();
        if (obj === null || typeof obj !== "object") throw new Error("HZ_VM_FAULT: GET_PROP on non-object");
        stack.push(Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined);
        pc += 2;
        break;
      }
      case Op.POP: pop(); pc += 1; break;
      case Op.DUP: {
        if (stack.length === 0) throw new Error("HZ_VM_FAULT: stack underflow");
        stack.push(stack[stack.length - 1]);
        pc += 1;
        break;
      }
      case Op.ADD: case Op.SUB: case Op.MUL:
      case Op.LT: case Op.LE: case Op.GT: case Op.GE:
      case Op.SEQ: case Op.SNE: {
        const b = pop() as number;
        const a = pop() as number;
        switch (op) {
          case Op.ADD: {
            if (typeof a === "string" || typeof b === "string") {
              const sa = String(a);
              const sb = String(b);
              if (sa.length + sb.length > 1_048_576) {
                throw new Error("HZ_VM_FAULT: string length limit exceeded");
              }
              stack.push(sa + sb);
            } else {
              stack.push((a as number) + (b as number));
            }
            break;
          }
          case Op.SUB: stack.push((a as number) - (b as number)); break;
          case Op.MUL: stack.push((a as number) * (b as number)); break;
          case Op.LT: stack.push(a < b); break;
          case Op.LE: stack.push(a <= b); break;
          case Op.GT: stack.push(a > b); break;
          case Op.GE: stack.push(a >= b); break;
          case Op.SEQ: stack.push(a === b); break;
          case Op.SNE: stack.push(a !== b); break;
        }
        pc += 1;
        break;
      }
      case Op.PUT_LOCAL: {
        const idx = operand(pc + 1);
        if (idx < 0 || idx >= locals.length) throw new Error("HZ_VM_FAULT: local index out of range");
        locals[idx] = pop();
        pc += 2;
        break;
      }
      case Op.GET_LOCAL: {
        const idx = operand(pc + 1);
        if (idx < 0 || idx >= locals.length) throw new Error("HZ_VM_FAULT: local index out of range");
        stack.push(locals[idx]);
        pc += 2;
        break;
      }
      case Op.NEW_CELL: {
        const idx = operand(pc + 1);
        if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_CELLS) {
          throw new Error(`HZ_VM_FAULT: cell index out of range ${idx}`);
        }
        cells[idx] = { v: undefined };
        pc += 2;
        break;
      }
      case Op.PUT_CELL: {
        const idx = operand(pc + 1);
        cellAt(idx, cells, "cell").v = pop();
        pc += 2;
        break;
      }
      case Op.GET_CELL: {
        const idx = operand(pc + 1);
        stack.push(cellAt(idx, cells, "cell").v);
        pc += 2;
        break;
      }
      case Op.GET_UPVAL: {
        const idx = operand(pc + 1);
        stack.push(cellAt(idx, upvals, "upval").v);
        pc += 2;
        break;
      }
      case Op.CLOSURE: {
        const start = operand(pc + 1);
        const n = operand(pc + 2);
        const captured: Cell[] = [];
        for (let i = 0; i < n; i += 1) captured.push(cellAt(operand(pc + 3 + i), cells, "cell"));
        stack.push({ [VM_FUNCTION_BRAND]: true, start, upvals: captured } satisfies FunctionObj);
        pc += 3 + n;
        break;
      }
      case Op.CALL: {
        const argc = operand(pc + 1);
        const args: unknown[] = [];
        for (let i = 0; i < argc; i += 1) args.unshift(pop());
        const callee = pop();
        if (!isFunction(callee)) throw new Error("HZ_VM_FAULT: CALL target is not a function");
        const sub = runFrame(program, callee.start, args, cells, callee.upvals, meter, clock, depth + 1, modules);
        meter = { ...meter, fuel: sub.fuel };
        if (sub.halted === "out_of_fuel") {
          return { value: sub.value, halted: "out_of_fuel", fuel: meter.fuel, steps: steps + sub.steps };
        }
        stack.push(sub.value);
        pc += 2;
        break;
      }
      case Op.JUMP: pc = operand(pc + 1); break;
      case Op.JUMP_IF_FALSE: {
        const target = operand(pc + 1);
        pc = truthy(pop()) ? pc + 2 : target;
        break;
      }
      case Op.JUMP_IF_TRUE: {
        const target = operand(pc + 1);
        pc = truthy(pop()) ? target : pc + 2;
        break;
      }
      case Op.NOP: pc += 1; break;
      case Op.RETURN:
        return { value: pop(), halted: "return", fuel: meter.fuel, steps };
      default:
        throw new Error(`HZ_VM_FAULT: unsupported opcode ${op}`);
    }
  }
  return { value: stack[stack.length - 1], halted: "end", fuel: meter.fuel, steps };
}

export function runBytecode(program: BytecodeProgram, opts: VmOptions = {}): VmResult {
  const clock = opts.now ?? (() => 0); // deterministic by default (see ruling 831)
  const meter = createFuelMeter({ initial: opts.initialFuel, now: clock });
  const locals: unknown[] = new Array(Math.max(0, program.localCount ?? 0)).fill(undefined);
  return runFrame(program, 0, locals, [], [], meter, clock, 0, opts.modules);
}
