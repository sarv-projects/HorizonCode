/**
 * `code_mode` — run a JavaScript program that chains tool calls.
 *
 * The program runs in a Bun subprocess (codemode-child.ts). What confines it is
 * the contract, not the process boundary: the only way it reaches the tools is
 * `tools.call(name, args)`, every call comes back here, goes through the guard
 * (deny > ask > allow, with the regular approval prompt) and leaves a receipt
 * exactly like a direct tool call would. The child inherits a scrubbed
 * environment (no credential-shaped names), and its console output travels on a
 * tagged channel, so a logged JSON object can never be mistaken for a control
 * frame. Big tool outputs can therefore be filtered and reduced inside the
 * program instead of landing in the model's context.
 *
 * Only the seven base tools are reachable from a program — no `code_mode`
 * inside `code_mode`, no `agent`, no `preview`.
 */

import * as path from "node:path";
import type { GuardAction, GuardDecision, Tool, ToolContext, ToolResult } from "../contracts";
import { canonicalJson, sha256Hex } from "../core/canon";
import { kernelStateDir, spawnOwned, type OwnedProc } from "../core/owned-spawn";
import { scrubEnv } from "./helpers";
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
 * cycle). Exported so the codemode test suite pins it against `guardActionFor`
 * case by case instead of trusting a comment.
 */
export function actionForCall(name: string, args: Record<string, unknown>, cwd: string): GuardAction | undefined {
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
  log?: unknown;
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

  // NF-072: a lifecycle tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const code = typeof args.code === "string" ? args.code : "";
    if (code.trim() === "") return { ok: false, output: "", error: "code is required" };
    if (ctx.signal.aborted) return { ok: false, output: "code_mode aborted", error: "aborted" };
    const timeoutMs = clampTimeout(args.timeout_ms);
    const started = Date.now();

    // NF-071: the single spawn path. The runner is long-lived (up to the timeout
    // above), so the owner-death supervisor starts with it — a SIGKILL of hzcode
    // cannot leave the runner, or anything it spawned, behind.
    let proc: OwnedProc;
    try {
      ({ proc } = await spawnOwned([process.execPath || "bun", "run", CHILD], {
        stateDir: kernelStateDir(ctx.workspace),
        label: "code_mode",
        cwd: ctx.cwd,
        env: scrubEnv(),
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        detached: true,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `failed to start the code runner: ${message}`, error: message };
    }

    return await new Promise<ToolResult>((resolve) => {
      const child = proc;
      const logs: string[] = [];
      let logBytes = 0;
      let calls = 0;
      let settled = false;
      let stdoutBuffer = "";
      let stderrTail = "";
      let rpcChain: Promise<void> = Promise.resolve();

      // Inner tool calls get their own controller: a code_mode timeout or abort
      // must also stop work already delegated to a tool (an in-flight `shell`),
      // not just the program that requested it.
      const inner = new AbortController();
      const innerCtx: ToolContext = { ...ctx, signal: inner.signal };

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
          inner.abort();
        } catch {
          /* nothing waiting on it */
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

      // Bun's stdin is a FileSink: write() may buffer, so every frame is
      // followed by a flush — a small init line that never flushed would leave
      // the runner waiting forever.
      const writeText = (text: string): void => {
        try {
          const sink = child.stdin as unknown as { write(data: string): number; flush(): Promise<number> };
          sink.write(text);
          void sink.flush().catch(() => {
            /* child gone; its exit path reports the failure */
          });
        } catch {
          /* child gone; its exit path reports the failure */
        }
      };

      const reply = (rpcId: unknown, result: ToolResult): void => {
        if (typeof rpcId !== "number") return;
        writeText(JSON.stringify({ rpcId, result }) + "\n");
      };

      const runTool = async (tool: Tool, callArgs: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const result = await tool.execute(callArgs, innerCtx);
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
        let leaseId: string | undefined;
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
              approved = await ctx.approve({ title: `code_mode: ${name}`, detail: action.target, kind: action.kind }, action);
            } catch {
              approved = false;
            }
            if (!approved) {
              reply(message.rpcId, { ok: false, output: "DECLINED by the user", error: "DECLINED by the user" });
              return;
            }
          }
          leaseId = decision.leaseId;
        }

        calls += 1;
        const result = await runTool(tool, callArgs);
        try {
          await ctx.receipt({
            action: "tool.execute",
            tool: name,
            argsDigest: sha256Hex(canonicalJson(callArgs)),
            resultDigest: sha256Hex(result.output),
            leaseId,
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
        // Console output travels tagged ({"log": "..."}), so a program that logs
        // a JSON object shaped like a frame cannot end itself early or invent a
        // result. Anything untagged is a direct stdout write and stays a log.
        if (typeof message.log === "string") {
          pushLog(message.log);
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

      const stdoutPump = (async (): Promise<void> => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            stdoutBuffer += decoder.decode(value, { stream: true });
            let index = stdoutBuffer.indexOf("\n");
            while (index >= 0) {
              const line = stdoutBuffer.slice(0, index);
              stdoutBuffer = stdoutBuffer.slice(index + 1);
              handleLine(line);
              index = stdoutBuffer.indexOf("\n");
            }
          }
        } catch {
          /* stream closed by a kill */
        }
      })();
      void (async (): Promise<void> => {
        const reader = child.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value !== undefined) stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-2000);
          }
        } catch {
          /* stream closed by a kill */
        }
      })();
      void child.exited.then((exitCode) => {
        // Drain stdout before reporting the exit: the final frame is often still
        // in flight when the process ends, and dropping it would turn a real
        // result into a false "exited before finishing".
        void stdoutPump.then(() => {
          if (!settled) {
            finish({ ok: false, output: `code runner exited (code ${exitCode}) before finishing${tail()}`, error: `runner exited (${exitCode})` });
          }
        });
      });

      // Hand the program over; anything after this line is a tool reply.
      writeText(JSON.stringify({ init: { code } }) + "\n");
    });
  },
};
