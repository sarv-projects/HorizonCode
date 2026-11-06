/**
 * `code_mode` — run a JavaScript program that chains tool calls.
 *
 * The program runs in an isolated Bun subprocess (codemode-child.ts) with one
 * capability: `tools.call(name, args)`. Every call comes back here, goes
 * through the guard (deny > ask > allow, with the regular approval prompt) and
 * leaves a receipt exactly like a direct tool call would. Big tool outputs can
 * therefore be filtered and reduced inside the program instead of landing in
 * the model's context.
 *
 * Only the seven base tools are reachable from a program — no `code_mode`
 * inside `code_mode`, no `agent`, no `preview`.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { GuardAction, GuardDecision, Tool, ToolContext, ToolResult } from "../contracts";
import { canonicalJson, sha256Hex } from "../core/canon";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { shellTool } from "./shell";
import { todoTool } from "./todo";
import { writeTool } from "./write";

const CHILD = path.join(import.meta.dir, "codemode-child.ts");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const LOG_CAP = 20_000;
const RESULT_CAP = 8_000;

/** The tools a program may call. Base seven only — never code_mode itself. */
const BASE_TOOLS = new Map<string, Tool>([
  ["read", readTool],
  ["write", writeTool],
  ["edit", editTool],
  ["grep", grepTool],
  ["glob", globTool],
  ["shell", shellTool],
  ["todo", todoTool],
]);

/**
 * The guard action a call implies — the same mapping the loop uses for direct
 * calls, kept local because tools never import core/loop (that would be a
 * cycle). Kept in sync with `guardActionFor` by the codemode test suite.
 */
function actionForCall(name: string, args: Record<string, unknown>, cwd: string): GuardAction | undefined {
  const argString = (...names: string[]): string | undefined => {
    for (const key of names) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return undefined;
  };
  const resolved = (value: string): string => path.resolve(cwd, value);
  switch (name) {
    case "read": {
      const file = argString("path", "file");
      return file ? { kind: "fs.read", target: resolved(file) } : undefined;
    }
    case "glob":
    case "grep": {
      const root = argString("path", "dir", "cwd") ?? ".";
      return { kind: "fs.read", target: resolved(root) };
    }
    case "write":
    case "edit": {
      const file = argString("path", "file_path", "file");
      return file ? { kind: "fs.write", target: resolved(file) } : undefined;
    }
    case "shell":
    case "bash": {
      const command = argString("command", "cmd");
      return command ? { kind: "shell.exec", target: command } : undefined;
    }
    default:
      return undefined;
  }
}

function clampTimeout(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
  if (n < 1) return 1;
  return Math.min(n, MAX_TIMEOUT_MS);
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n[truncated]` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "(unserializable result)";
  }
}

interface WireMessage {
  rpc?: unknown;
  rpcId?: unknown;
  name?: unknown;
  args?: unknown;
  done?: unknown;
  result?: unknown;
  error?: unknown;
}

export const codemodeTool: Tool = {
  name: "code_mode",
  description:
    "Run a JavaScript program in an isolated Bun subprocess to chain tool calls, filter large outputs, and " +
    "compute. Use `await tools.call(name, args)` to call tools; console.log is collected; `return` a value to get it back.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Async function body. `tools.call(name, args)` bridges to the tools; return the value you want back." },
      timeout_ms: { type: "number", description: `Wall-clock budget (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
    },
    required: ["code"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const code = typeof args.code === "string" ? args.code : "";
    if (code.trim() === "") return { ok: false, output: "", error: "code is required" };
    const timeoutMs = clampTimeout(args.timeout_ms);
    const started = Date.now();

    return await new Promise<ToolResult>((resolve) => {
      const logs: string[] = [];
      let logBytes = 0;
      let calls = 0;
      let settled = false;
      let stdoutBuffer = "";
      let stderrTail = "";
      let rpcChain: Promise<void> = Promise.resolve();

      const child = spawn(process.execPath || "bun", ["run", CHILD], {
        cwd: ctx.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ctx.signal.removeEventListener("abort", onAbort);
        } catch {
          /* listener was never added */
        }
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, output: `code_mode timed out after ${timeoutMs}ms`, error: "timed out" });
      }, timeoutMs);
      const onAbort = (): void => {
        finish({ ok: false, output: "code_mode aborted", error: "aborted" });
      };
      try {
        ctx.signal.addEventListener("abort", onAbort);
      } catch {
        /* an exotic signal without listeners: the timeout still applies */
      }

      const tail = (): string => {
        const text = `${stderrTail !== "" ? stderrTail + "\n" : ""}${logs.join("\n")}`.trim();
        return text === "" ? "" : `\n--- output ---\n${truncate(text, 2000)}`;
      };

      const reply = (rpcId: unknown, result: ToolResult): void => {
        if (typeof rpcId !== "number") return;
        try {
          child.stdin.write(JSON.stringify({ rpcId, result }) + "\n");
        } catch {
          /* child gone; its exit path reports the failure */
        }
      };

      const runTool = async (tool: Tool, callArgs: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const result = await tool.execute(callArgs, ctx);
          if (result === null || typeof result !== "object") {
            return { ok: false, output: "tool returned nothing", error: "tool returned nothing" };
          }
          return { ok: result.ok === true, output: typeof result.output === "string" ? result.output : "", error: result.error };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, output: `tool failed: ${message}`, error: message };
        }
      };

      const handleRpc = async (message: WireMessage): Promise<void> => {
        const name = typeof message.name === "string" ? message.name : "";
        const callArgs =
          message.args !== null && typeof message.args === "object" && !Array.isArray(message.args)
            ? (message.args as Record<string, unknown>)
            : {};
        const tool = BASE_TOOLS.get(name);
        if (!tool) {
          reply(message.rpcId, { ok: false, output: `unknown tool: ${name}`, error: `unknown tool "${name}"` });
          return;
        }

        const action = actionForCall(name, callArgs, ctx.cwd);
        if (action) {
          let decision: GuardDecision;
          try {
            decision = await ctx.guard(action);
          } catch (err) {
            const message2 = err instanceof Error ? err.message : String(err);
            reply(message.rpcId, { ok: false, output: `DENIED by policy: guard unavailable (${message2})`, error: "guard unavailable" });
            return;
          }
          if (decision.decision === "deny") {
            const reason = decision.reason ?? action.kind;
            reply(message.rpcId, { ok: false, output: `DENIED by policy: ${reason}`, error: `DENIED by policy: ${reason}` });
            return;
          }
          if (decision.decision === "ask") {
            let approved = false;
            try {
              approved = await ctx.approve({ title: `code_mode: ${name}`, detail: action.target, kind: action.kind });
            } catch {
              approved = false;
            }
            if (!approved) {
              reply(message.rpcId, { ok: false, output: "DECLINED by the user", error: "DECLINED by the user" });
              return;
            }
          }
        }

        calls += 1;
        const result = await runTool(tool, callArgs);
        try {
          await ctx.receipt({
            action: "tool.execute",
            tool: name,
            argsDigest: sha256Hex(canonicalJson(callArgs)),
            resultDigest: sha256Hex(result.output),
          });
        } catch {
          /* a receipt failure must not fail the program's call */
        }
        reply(message.rpcId, result);
      };

      const handleLine = (line: string): void => {
        if (line.trim() === "") return;
        let message: WireMessage;
        try {
          message = JSON.parse(line) as WireMessage;
        } catch {
          pushLog(line);
          return;
        }
        if (message === null || typeof message !== "object") {
          pushLog(line);
          return;
        }
        if (message.rpc === "tool.call") {
          // Serialize RPC handling: receipts and approvals stay ordered.
          rpcChain = rpcChain.then(() => handleRpc(message));
          return;
        }
        if (message.done === true) {
          const ms = Date.now() - started;
          const resultText = truncate(safeJson(message.result), RESULT_CAP);
          const logText = logs.length > 0 ? `\n--- logs ---\n${truncate(logs.join("\n"), LOG_CAP)}` : "";
          finish({ ok: true, output: `code_mode: ${calls} tool call(s) in ${ms}ms${logText}\n--- result ---\n${resultText}` });
          return;
        }
        if (message.done === false) {
          const error = typeof message.error === "string" ? message.error : "program failed";
          finish({ ok: false, output: `code_mode error: ${error}${tail()}`, error });
          return;
        }
        pushLog(line);
      };

      const pushLog = (line: string): void => {
        if (logBytes >= LOG_CAP) return;
        const slice = line.slice(0, LOG_CAP - logBytes);
        logBytes += slice.length + 1;
        logs.push(slice);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let index = stdoutBuffer.indexOf("\n");
        while (index >= 0) {
          const line = stdoutBuffer.slice(0, index);
          stdoutBuffer = stdoutBuffer.slice(index + 1);
          handleLine(line);
          index = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
      });
      child.on("error", (err: Error) => {
        finish({ ok: false, output: `failed to start the code runner: ${err.message}`, error: err.message });
      });
      child.on("exit", (exitCode: number | null) => {
        if (!settled) {
          finish({ ok: false, output: `code runner exited (code ${exitCode}) before finishing${tail()}`, error: `runner exited (${exitCode})` });
        }
      });

      // Hand the program over; anything after this line is a tool reply.
      try {
        child.stdin.write(JSON.stringify({ init: { code } }) + "\n");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finish({ ok: false, output: `failed to send the program: ${message}`, error: message });
      }
    });
  },
};
