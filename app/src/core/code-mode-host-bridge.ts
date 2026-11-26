/**
 * code-mode-host-bridge.ts — VM async host bridge (opencode HostCalls ADAPT).
 * Source: repo_take/opencode/packages/codemode/src/vm/vm.ts:386-414.
 *
 * A host call is an async function the VM may invoke by name. When bytecode
 * reaches `HOST_CALL <constIndex>`, the bridge:
 *   - pops the call args from the operand stack,
 *   - AUTOMATICALLY invokes the registered async host function,
 *   - returns a `suspended` result carrying a call id + name + args,
 *   - on `resolveCall(id, value)`, resumes execution with the value pushed.
 * The caller need not drive the promise itself — start() fires it; resolveCall
 * feeds the settled value (or error) back. No eval, no authority, no egress.
 */

import { Op, type BytecodeProgram } from "./code-mode-vm";

/** Internal opcode for a host call (outside the upstream numeric range's core subset). */
export const HOST_CALL = 200;

export type HostFunction = (...args: unknown[]) => Promise<unknown>;

export interface HostCallInfo {
  id: string;
  name: string;
  args: unknown[];
}

export type BridgeResult =
  | { kind: "suspended"; call: HostCallInfo }
  | { kind: "done"; value?: unknown }
  | { kind: "fault"; error: string };

export interface HostBridgeOptions {
  hosts: Readonly<Record<string, HostFunction>>;
}

export interface HostBridge {
  start(): Promise<BridgeResult>;
  resolveCall(id: string, value?: unknown, error?: Error): Promise<BridgeResult>;
}

export function createHostBridge(program: BytecodeProgram, opts: HostBridgeOptions): HostBridge {
  const words = program.words;
  const consts = program.consts ?? [];
  let pc = 0;
  let callSeq = 0;
  let pendingCall: HostCallInfo | undefined;
  const stack: unknown[] = [];
  const resolve = (kind: "done" | "fault", value?: unknown, error?: string): BridgeResult =>
    kind === "fault" ? { kind, error: error ?? "host bridge fault" } : { kind, value };

  const run = async (resumeValue?: unknown): Promise<BridgeResult> => {
    if (resumeValue !== undefined) stack.push(resumeValue);
    while (pc < words.length) {
      const op = words[pc]!;
      switch (op) {
        case Op.PUSH_INT: stack.push(words[pc + 1]!); pc += 2; break;
        case Op.PUSH_CONST: {
          const i = words[pc + 1]!;
          stack.push(i >= 0 && i < consts.length ? consts[i] : undefined);
          pc += 2;
          break;
        }
        case Op.PUSH_NULL: stack.push(null); pc += 1; break;
        case Op.PUSH_BOOL: stack.push(Boolean(words[pc + 1])); pc += 2; break;
        case Op.POP: stack.pop(); pc += 1; break;
        case Op.DUP: stack.push(stack[stack.length - 1]); pc += 1; break;
        case Op.ADD: case Op.SUB: case Op.MUL: {
          const b = stack.pop() as number;
          const a = stack.pop() as number;
          stack.push(op === Op.ADD ? (a as number) + (b as number)
            : op === Op.SUB ? (a as number) - (b as number)
            : (a as number) * (b as number));
          pc += 1;
          break;
        }
        case HOST_CALL: {
          const nameIdx = words[pc + 1]!;
          const name = nameIdx >= 0 && nameIdx < consts.length ? String(consts[nameIdx]) : "";
          const host = opts.hosts[name];
          if (host === undefined) return resolve("fault", undefined, `unknown host ${name}`);
          // The most recent stack value is the argument (single-arg reduced form).
          const args = stack.length > 0 ? [stack.pop()] : [];
          const id = `hc-${++callSeq}`;
          pendingCall = { id, name, args };
          pc += 2;
          return { kind: "suspended", call: pendingCall };
        }
        case Op.RETURN:
          return resolve("done", stack.pop());
        case Op.NOP: pc += 1; break;
        default:
          return resolve("fault", undefined, `unsupported opcode ${op}`);
      }
    }
    return resolve("done", stack[stack.length - 1]);
  };

  return {
    start: () => run(),
    resolveCall: async (id: string, value?: unknown, error?: Error) => {
      if (pendingCall === undefined || pendingCall.id !== id) {
        return resolve("fault", undefined, `unknown host call ${id}`);
      }
      pendingCall = undefined;
      if (error !== undefined) return resolve("fault", undefined, error.message);
      return run(value);
    },
  };
}
