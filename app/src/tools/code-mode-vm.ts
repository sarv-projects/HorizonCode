/**
 * code-mode-vm.ts — deferred `code_mode_vm` tool.
 *
 * Runs a bytecode program through the coherent, metered VM (CodeModeExecution →
 * interpreter + fuel meter + cell host) as PURE computation. NO host functions
 * are registered (no module registry, no async host bridge), so a program
 * cannot touch FS, network or tools — it can only compute a value from the
 * supplied words/consts. This makes the VM stack production-reachable without
 * touching the security-sensitive `code_mode` JS-in-sandbox path.
 *
 * Strictly bounded: program length, const-pool size and fuel are capped so a
 * model-supplied program cannot burn unbounded CPU/memory.
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { CodeModeExecution } from "../core/code-mode-execution";
import { Op, type BytecodeProgram } from "../core/code-mode-vm";

const MAX_WORDS = 10_000;
const MAX_CONSTS = 1_000;
const MAX_LOCAL_COUNT = 1_024;
export const MAX_STRING_LEN = 1_048_576;
const MAX_FUEL = 1_000_000;
const DEFAULT_FUEL = 10_000;

/**
 * Guard against exponential string-doubling OOM DoS via Op.ADD before invoking
 * the VM interpreter (which lives in core/code-mode-vm.ts):
 * - Reject any string constant exceeding MAX_STRING_LEN.
 * - Reject programs that combine non-empty string constants with Op.ADD inside
 *   a backward jump loop, or unrolled Op.ADD chains whose worst-case doubling
 *   exceeds MAX_STRING_LEN.
 */
function checkStringAddBound(words: number[], consts: unknown[]): string | undefined {
  let maxConstStrLen = 0;
  for (const c of consts) {
    if (typeof c === "string") {
      if (c.length > MAX_STRING_LEN) {
        return `string constant length exceeds MAX_STRING_LEN (${MAX_STRING_LEN})`;
      }
      if (c.length > maxConstStrLen) maxConstStrLen = c.length;
    }
  }
  if (maxConstStrLen === 0) return undefined;

  let addCount = 0;
  let hasBackwardJump = false;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === Op.ADD) addCount += 1;
    if (w === Op.JUMP || w === Op.JUMP_IF_FALSE || w === Op.JUMP_IF_TRUE) {
      const target = words[i + 1];
      if (typeof target === "number" && target <= i) {
        hasBackwardJump = true;
      }
      i += 1;
    } else if (
      w === Op.PUSH_BOOL ||
      w === Op.PUSH_INT ||
      w === Op.PUSH_CONST ||
      w === Op.GET_LOCAL ||
      w === Op.PUT_LOCAL ||
      w === Op.GET_CELL ||
      w === Op.PUT_CELL ||
      w === Op.GET_UPVAL ||
      w === Op.IMPORT ||
      w === Op.GET_PROP
    ) {
      i += 1;
    }
  }
  if (addCount > 0 && hasBackwardJump) {
    return `string concatenation with Op.ADD inside a loop is refused (MAX_STRING_LEN=${MAX_STRING_LEN})`;
  }
  if (addCount > 0 && maxConstStrLen * Math.pow(2, Math.min(addCount, 31)) > MAX_STRING_LEN) {
    return `potential string concatenation exceeds MAX_STRING_LEN (${MAX_STRING_LEN})`;
  }
  return undefined;
}

function validProgram(raw: unknown): { program: BytecodeProgram; fuel: number } | string {
  if (raw === null || typeof raw !== "object") return "words must be an array of instruction numbers";
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.words)) return "words must be an array of instruction numbers";
  if (obj.words.length === 0 || obj.words.length > MAX_WORDS) return `words length must be 1..${MAX_WORDS}`;
  if (obj.words.some((w) => typeof w !== "number" || !Number.isFinite(w))) {
    return "every word must be a finite number";
  }
  const consts = obj.consts === undefined ? [] : obj.consts;
  if (!Array.isArray(consts) || consts.length > MAX_CONSTS) return `consts must be an array of at most ${MAX_CONSTS}`;
  const fuel = obj.fuel === undefined ? DEFAULT_FUEL : obj.fuel;
  if (typeof fuel !== "number" || !Number.isFinite(fuel) || fuel < 1 || fuel > MAX_FUEL) {
    return `fuel must be a number in 1..${MAX_FUEL}`;
  }
  if (obj.localCount !== undefined) {
    if (
      typeof obj.localCount !== "number" ||
      !Number.isFinite(obj.localCount) ||
      obj.localCount < 0 ||
      Math.floor(obj.localCount) > MAX_LOCAL_COUNT
    ) {
      return `localCount must be a number in 0..${MAX_LOCAL_COUNT}`;
    }
  }
  const localCount = obj.localCount === undefined ? 0 : Math.floor(obj.localCount as number);
  const strErr = checkStringAddBound(obj.words as number[], consts);
  if (strErr !== undefined) return strErr;
  return {
    program: { words: obj.words as number[], consts, localCount },
    fuel: Math.floor(fuel),
  };
}

export const codeModeVmTool: Tool = {
  name: "code_mode_vm",
  description:
    "Run a bounded bytecode program through a metered pure VM (no file, network or tool access) to compute a result deterministically. Supply words (opcodes + operands), consts and optional fuel.",
  parameters: {
    type: "object",
    properties: {
      words: { type: "array", items: { type: "number" }, description: "Instruction words (opcodes and operands)." },
      consts: { type: "array", description: "Constant pool referenced by PUSH_CONST." },
      localCount: { type: "number", description: "Number of local slots (default 0)." },
      fuel: { type: "number", description: "Instruction budget, 1..1000000 (default 10000)." },
    },
    required: ["words"],
  },
  exposure: "deferred",
  searchInfo: { keywords: ["bytecode", "vm", "compute", "code mode", "metered", "pure"] },
  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = validProgram(args);
    if (typeof parsed === "string") return { ok: false, output: "", error: parsed };
    try {
      // Validate the program through the coherent execution seam (cell + fuel),
      // then run it. No hosts/modules are registered — computation only.
      const exec = new CodeModeExecution({ initialFuel: parsed.fuel, now: () => 0 });
      exec.create("tool-vm");
      const result = exec.runBytecode("tool-vm", parsed.program);
      if (typeof result.value === "string" && result.value.length > MAX_STRING_LEN) {
        return { ok: false, output: "", error: `result string exceeds MAX_STRING_LEN (${MAX_STRING_LEN})` };
      }
      const shown = result.value === undefined ? "undefined" : JSON.stringify(result.value);
      return {
        ok: true,
        output: `halted=${result.halted} fuel=${result.fuel} steps=${result.steps} value=${shown}`,
      };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  },
};
