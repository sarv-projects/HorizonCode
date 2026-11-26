/**
 * code-mode-generator.ts — resumable generator engine (opencode YIELD/RESUME/YSTAR ADAPT).
 * Source: repo_take/opencode/packages/codemode/src/vm/{generators.ts,opcodes.ts}.
 *
 * A genuine execution engine for generator bytecode with EXPLICIT suspended
 * frames: `next(value)` runs until YIELD ({value, done:false}, saving pc+stack)
 * or RETURN/end ({value, done:true}); a resume value is pushed onto the stack
 * (`x = yield`). `YSTAR` (85) delegates to a sub-program: the child's yields
 * surface as the parent's and the child's final value is pushed back onto the
 * parent stack. Fuel is metered across the whole lifetime. No async host
 * bridge — that remains the full VM surface. No eval.
 */

import { Op, type BytecodeProgram } from "./code-mode-vm";
import { createFuelMeter, tickFuel, type FuelMeter } from "./vm-fuel-meter";

const YIELD = 82;
const YSTAR = 85;

export interface GeneratorStep {
  value?: unknown;
  done: boolean;
  halted?: "out_of_fuel";
}

export interface GeneratorOptions {
  initialFuel?: number;
  now?: () => number;
}

interface SuspendedFrame {
  pc: number;
  stack: unknown[];
}

export interface Generator {
  next(resumeValue?: unknown): GeneratorStep;
  readonly done: boolean;
}

/** A program may declare delegate sub-programs referenced by YSTAR operands. */
export interface GeneratorProgram extends BytecodeProgram {
  delegates?: readonly BytecodeProgram[];
}

interface ChildState {
  child: Generator;
  awaitingFinal: boolean;
}

export function createGenerator(program: GeneratorProgram, opts: GeneratorOptions = {}): Generator {
  const clock = opts.now ?? (() => 0);
  let meter: FuelMeter = createFuelMeter({ initial: opts.initialFuel, now: clock });
  let frame: SuspendedFrame = { pc: 0, stack: [] };
  let finished = false;
  const delegates = program.delegates ?? [];
  const childStack: ChildState[] = [];

  const step = (resumeValue?: unknown): GeneratorStep => {
    if (finished) return { value: undefined, done: true };
    // A suspended YSTAR child owns the next resume: its yields are ours and its
    // final value is pushed back onto the parent stack when it completes.
    while (childStack.length > 0) {
      const top = childStack[childStack.length - 1]!;
      const childStep = top.child.next(resumeValue);
      resumeValue = undefined; // consumed by the child, never forwarded twice
      if (!childStep.done) return { value: childStep.value, done: false };
      frame.stack.push(childStep.value);
      childStack.pop();
    }
    // Resuming the parent after a plain YIELD: push the caller's value.
    if (resumeValue !== undefined) frame.stack.push(resumeValue);
    const pop = (): unknown => {
      if (frame.stack.length === 0) throw new Error("HZ_VM_FAULT: stack underflow");
      return frame.stack.pop();
    };
    const operand = (at: number): number => {
      if (at >= program.words.length) throw new Error("HZ_VM_FAULT: truncated operand");
      return program.words[at]!;
    };

    while (frame.pc < program.words.length) {
      const r = tickFuel(meter, 1, clock());
      meter = r.state;
      if (r.verdict === "suspend") {
        finished = true;
        return { value: frame.stack[frame.stack.length - 1], done: true, halted: "out_of_fuel" };
      }
      const op = program.words[frame.pc]!;
      switch (op) {
        case Op.PUSH_INT: frame.stack.push(operand(frame.pc + 1)); frame.pc += 2; break;
        case Op.PUSH_CONST: {
          const i = operand(frame.pc + 1);
          frame.stack.push(i >= 0 && i < (program.consts ?? []).length ? program.consts![i] : undefined);
          frame.pc += 2;
          break;
        }
        case Op.PUSH_NULL: frame.stack.push(null); frame.pc += 1; break;
        case Op.PUSH_BOOL: frame.stack.push(Boolean(operand(frame.pc + 1))); frame.pc += 2; break;
        case Op.PUSH_UNDEF: frame.stack.push(undefined); frame.pc += 1; break;
        case Op.POP: pop(); frame.pc += 1; break;
        case Op.DUP:
          if (frame.stack.length === 0) throw new Error("HZ_VM_FAULT: stack underflow");
          frame.stack.push(frame.stack[frame.stack.length - 1]);
          frame.pc += 1;
          break;
        case Op.ADD: case Op.SUB: case Op.MUL:
        case Op.LT: case Op.LE: case Op.GT: case Op.GE:
        case Op.SEQ: case Op.SNE: {
          const b = pop() as number;
          const a = pop() as number;
          switch (op) {
            case Op.ADD: frame.stack.push((a as number) + (b as number)); break;
            case Op.SUB: frame.stack.push((a as number) - (b as number)); break;
            case Op.MUL: frame.stack.push((a as number) * (b as number)); break;
            case Op.LT: frame.stack.push(a < b); break;
            case Op.LE: frame.stack.push(a <= b); break;
            case Op.GT: frame.stack.push(a > b); break;
            case Op.GE: frame.stack.push(a >= b); break;
            case Op.SEQ: frame.stack.push(a === b); break;
            case Op.SNE: frame.stack.push(a !== b); break;
          }
          frame.pc += 1;
          break;
        }
        case YIELD: {
          const value = pop();
          frame.pc += 1;
          return { value, done: false };
        }
        case YSTAR: {
          const idx = operand(frame.pc + 1);
          const sub = delegates[idx];
          if (sub === undefined) throw new Error(`HZ_VM_FAULT: missing yield* delegate ${idx}`);
          const child = createGenerator(sub, { initialFuel: meter.fuel, now: clock });
          childStack.push({ child, awaitingFinal: true });
          frame.pc += 2;
          // Drive the child on the next resume (same call path as a plain YIELD).
          const childStep = child.next(resumeValue);
          resumeValue = undefined;
          if (!childStep.done) return { value: childStep.value, done: false };
          frame.stack.push(childStep.value);
          childStack.pop();
          break;
        }
        case Op.JUMP: frame.pc = operand(frame.pc + 1); break;
        case Op.JUMP_IF_FALSE: {
          const target = operand(frame.pc + 1);
          frame.pc = pop() ? frame.pc + 2 : target;
          break;
        }
        case Op.JUMP_IF_TRUE: {
          const target = operand(frame.pc + 1);
          frame.pc = pop() ? target : frame.pc + 2;
          break;
        }
        case Op.NOP: frame.pc += 1; break;
        case Op.RETURN: {
          const value = pop();
          finished = true;
          return { value, done: true };
        }
        default:
          throw new Error(`HZ_VM_FAULT: unsupported opcode ${op}`);
      }
    }
    finished = true;
    return { value: frame.stack[frame.stack.length - 1], done: true };
  };

  return {
    next: step,
    get done(): boolean {
      return finished;
    },
  };
}
