/**
 * `code_mode` — run a JavaScript program that chains tool calls.
 *
 * The program runs in a Bun subprocess (codemode-child.ts). What confines it is
 * the contract, not the process boundary: the only way it reaches the tools is
 * `tools.call(name, args)`, every call comes back here, goes through the guard
 * (deny > ask > allow, with the regular approval prompt) carrying the canonical
 * digest of the exact arguments it is about to execute — so an approval granted
 * for one set of arguments never covers a different set — and leaves a receipt
 * exactly like a direct tool call would. The child inherits a scrubbed
 * environment, and every control frame it sends carries a per-run frame key
 * (grammar below) — so a logged JSON object, or a program writing
 * `{"done":true}` to stdout itself, is ordinary output and cannot end the run.
 * Big tool outputs can therefore be filtered and reduced inside the program
 * instead of landing in the model's context.
 *
 * Only the seven base tools are reachable from a program — no `code_mode`
 * inside `code_mode`, no `agent`, no `preview`.
 *
 * Frame grammar, one control frame per stdout line (upstream is keyed and
 * downstream carries no key — the program cannot inject into its own stdin):
 *
 *   child  -> parent   <bootstrap> {"hello":{"frameKey":"<64 hex>"}}   once, at child load
 *   child  -> parent   <run key> {"rpc":"tool.call","rpcId":N,...}
 *   parent -> child    {"rpcId":N,"result":{...}}
 *   child  -> parent   <run key> {"log":"..."}
 *   child  -> parent   <run key> {"done":true|false,...}
 *
 * A control frame is `<key> <json>`: a key, one space, the JSON. The bootstrap
 * nonce travels in the child's environment (HZ_CODEMODE_FRAME_KEY) and frames
 * exactly one line — the handshake — after which it is retired; the run key is
 * generated inside the child and lives only there. The parent holds the program
 * back until it has accepted the handshake, so no model code runs, and no byte
 * a program writes is sent, before the run key is in force. A frame needs the
 * key in force, so the parent finds one by searching the stdout buffer for the
 * key token: an occurrence is authentic (the key is secret — only the shim can
 * write it), and everything before it is program output. A program write with
 * no trailing newline therefore cannot glue the key to program bytes and hide
 * the frame; the shim also newline-prefixes a frame after a non-newline-
 * terminated program write (belt and braces). Everything a program writes
 * itself has no key and is kept as output, never as a frame; output shaped like
 * a frame is annotated in the log so an attempt is visible.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { GuardAction, GuardDecision, Tool, ToolContext, ToolResult } from "../contracts";
import { canonicalJson, digestOf, sha256Hex } from "../core/canon";
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
/** How long a freshly started child has to present its frame key. */
const HANDSHAKE_TIMEOUT_MS = 5_000;
const LOG_CAP = 20_000;
const RESULT_CAP = 8_000;

/**
 * The environment name the bootstrap nonce travels in. The child reads it and
 * deletes it before any model code runs, and uses it to frame exactly one line.
 * Note the name ends in `KEY` on purpose: `scrubEnv()` strips credential-shaped
 * names, so this value can never leak onward through another spawn — and the
 * assignment below must therefore stay *after* the scrub, not before it.
 */
export const FRAME_KEY_ENV = "HZ_CODEMODE_FRAME_KEY";

/** Frame keys are 32 random bytes as lowercase hex (64 characters). */
const FRAME_KEY_BYTES = 32;
const FRAME_KEY_RE = /^[0-9a-f]{64}$/;
/** A frame key's length in characters. */
const FRAME_KEY_CHARS = 64;
/**
 * How much un-newlined program output the parent holds before flushing the
 * excess as opaque output. A frame key split across reads is at most 64 chars
 * and is always kept back, so a real frame cannot be torn by the flush.
 */
export const STDOUT_TAIL_MAX = 64 * 1024;

/** A fresh frame key. Kept in step with the copy in codemode-child.ts. */
function newFrameKey(): string {
  return randomBytes(FRAME_KEY_BYTES).toString("hex");
}

function isFrameKey(value: unknown): value is string {
  return typeof value === "string" && FRAME_KEY_RE.test(value);
}

/**
 * True when a program-written line is shaped like a control frame. Such a line
 * can only ever be output — a frame needs the key in force — but naming it in
 * the run's log makes an attempted forgery visible to whoever reads the output,
 * and the line itself is preserved after the notice.
 */
function looksLikeControlFrame(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return record.done !== undefined || record.rpc !== undefined || record.log !== undefined || record.hello !== undefined;
}

const UNKEYED_FRAME_NOTICE = "[code_mode] line shaped like a control frame without the run key — kept as output: ";

/**
 * Splits the child's stdout into control-frame lines and program output.
 *
 * A control frame is `<key> <json>`, and the key is in force here — so the
 * framer searches the buffer for the key token instead of requiring it at a
 * line start: everything before an authentic key occurrence is program output,
 * whether or not the program terminated that write with a newline. A line
 * carrying only a guessed or forged key never matches and stays output.
 *
 * The un-newlined tail is bounded: once it exceeds STDOUT_TAIL_MAX, the excess
 * is handed to `onLine` as opaque output, keeping the last FRAME_KEY_CHARS
 * bytes so a key split across chunks can still complete.
 */
export class StdoutFramer {
  private buffer = "";

  /** Bytes currently held back (un-newlined output or a frame in flight). */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  feed(chunk: string, activeKey: () => string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    for (;;) {
      const keyAt = this.buffer.indexOf(`${activeKey()} `);
      if (keyAt >= 0) {
        const before = this.buffer.slice(0, keyAt);
        if (before !== "") {
          for (const line of before.split("\n")) if (line.trim() !== "") onLine(line);
        }
        this.buffer = this.buffer.slice(keyAt);
        const end = this.buffer.indexOf("\n");
        if (end < 0) return; // the frame line is still in flight
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        onLine(frame);
        continue;
      }
      const end = this.buffer.indexOf("\n");
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.trim() !== "") onLine(line);
        continue;
      }
      if (this.buffer.length > STDOUT_TAIL_MAX + FRAME_KEY_CHARS) {
        const flush = this.buffer.slice(0, this.buffer.length - FRAME_KEY_CHARS);
        this.buffer = this.buffer.slice(-FRAME_KEY_CHARS);
        if (flush !== "") onLine(flush);
      }
      return;
    }
  }
}

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

/**
 * The bridge's guard action for one inner call: the mapped action PLUS the
 * canonical digest of the exact arguments the bridge is about to execute.
 *
 * The digest rides in `detail.argsDigest`, the field GuardGate keys its
 * same-turn approval cache on (loop.ts). Without it, a digest-less check fell
 * back to "already allowed in this turn" for any same-(kind,target) action:
 * approving a direct write of f.txt with content AAAA silently covered a
 * code_mode program's inner write of f.txt with content BBBB (wave-13 audit
 * finding 7). With it, only the exact (kind, target, args) approved before is
 * reused; different arguments re-ask.
 *
 * The digest is best-effort by construction: an argument object that cannot be
 * canonicalised (a cycle) keeps the digest off the action, and the guard then
 * treats the call as not-previously-approved rather than as approved.
 */
export function withInnerIntent(action: GuardAction, args: Record<string, unknown>, cwd: string): GuardAction {
  let argsDigest: string | undefined;
  try {
    argsDigest = digestOf(args);
  } catch {
    argsDigest = undefined;
  }
  // `cwd` is part of the identity of the call: the same relative path means a
  // different file in a different working directory.
  return { ...action, detail: { ...(action.detail ?? {}), cwd, argsDigest } };
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
  hello?: unknown;
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

    // The bootstrap half of the frame protocol: it travels in the child's
    // environment, frames the child's single handshake line, and is retired the
    // moment that line lands (see acceptHandshake below).
    const bootstrapKey = newFrameKey();

    // NF-071: the single spawn path. The runner is long-lived (up to the timeout
    // above), so the owner-death supervisor starts with it — a SIGKILL of hzcode
    // cannot leave the runner, or anything it spawned, behind.
    let proc: OwnedProc;
    try {
      ({ proc } = await spawnOwned([process.execPath || "bun", "run", CHILD], {
        stateDir: kernelStateDir(ctx.workspace),
        label: "code_mode",
        cwd: ctx.cwd,
        env: { ...scrubEnv(), [FRAME_KEY_ENV]: bootstrapKey },
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        detached: true,
        sandboxWrap: "auto",
        sandboxMode: "workspace-write",
        kernel: ctx.kernel,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `failed to start the code runner: ${message}`, error: message };
    }

    return await new Promise<ToolResult>((resolve) => {
      const child = proc;
      const logs: string[] = [];
      let logBytes = 0;
      let logTruncated = false;
      let calls = 0;
      let settled = false;
      let stderrTail = "";
      let rpcChain: Promise<void> = Promise.resolve();
      // The key in force: the bootstrap nonce until the handshake lands, the
      // child's own run key afterwards. A line prefixed with anything else — a
      // forged `{"done":true}` included — is program output, never a frame.
      let activeKey = bootstrapKey;
      let handshaken = false;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      // Sent only once the run key is known (see acceptHandshake): the program
      // starts after the framing that protects it is in force.
      const initLine = JSON.stringify({ init: { code } }) + "\n";

      // Inner tool calls get their own controller: a code_mode timeout or abort
      // must also stop work already delegated to a tool (an in-flight `shell`),
      // not just the program that requested it.
      const inner = new AbortController();
      const innerCtx: ToolContext = { ...ctx, signal: inner.signal };

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
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
      handshakeTimer = setTimeout(() => {
        finish({ ok: false, output: `code runner did not present a frame key within ${HANDSHAKE_TIMEOUT_MS}ms`, error: "no frame key" });
      }, HANDSHAKE_TIMEOUT_MS);
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
          const guarded = withInnerIntent(action, callArgs, ctx.cwd);
          let decision: GuardDecision;
          try {
            decision = await ctx.guard(guarded);
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
              approved = await ctx.approve({ title: `code_mode: ${name}`, detail: action.target, kind: action.kind }, guarded);
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

      /**
       * The one frame a child may send before the run key exists. Accepting it is
       * what hands the program over: no model code has run yet, so no
       * program-written byte can precede — or race — the handshake.
       */
      const acceptHandshake = (message: WireMessage): void => {
        const hello = message.hello;
        const presented = hello !== null && typeof hello === "object" ? (hello as { frameKey?: unknown }).frameKey : undefined;
        if (typeof presented !== "string" || !isFrameKey(presented)) {
          finish({ ok: false, output: "code runner presented an invalid frame key; refusing to run", error: "invalid frame key" });
          return;
        }
        handshaken = true;
        activeKey = presented; // the bootstrap nonce is retired here, for good
        if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
        writeText(initLine);
      };

      /** One parsed, key-prefixed control frame. */
      const handleFrame = (message: WireMessage, rawLine: string): void => {
        if (!handshaken) {
          acceptHandshake(message);
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
        // Console output travels tagged ({"log": "..."}) on the same keyed channel.
        if (typeof message.log === "string") {
          pushLog(message.log);
          return;
        }
        pushLog(rawLine);
      };

      /**
       * One stdout line from the child. Only a line prefixed with the key in force
       * is a control frame; every other line is the program's own output. A line
       * shaped like a frame that does not carry the key is still output — but it
       * is named, so an attempted forgery is visible in the run's logs instead of
       * silent.
       */
      const handleLine = (line: string): void => {
        if (line.trim() === "") return;
        const split = line.indexOf(" ");
        const key = split > 0 ? line.slice(0, split) : "";
        const body = split > 0 ? line.slice(split + 1) : line;
        if (key !== "" && key === activeKey) {
          let message: WireMessage;
          try {
            message = JSON.parse(body) as WireMessage;
          } catch {
            pushLog(line);
            return;
          }
          if (message === null || typeof message !== "object") {
            pushLog(line);
            return;
          }
          handleFrame(message, line);
          return;
        }
        pushLog(looksLikeControlFrame(body) ? `${UNKEYED_FRAME_NOTICE}${line}` : line);
      };

      const pushLog = (line: string): void => {
        if (logBytes >= LOG_CAP) {
          // The 20 KB output cap used to drop the rest silently; name it once.
          if (!logTruncated) {
            logTruncated = true;
            logs.push("[truncated]");
          }
          return;
        }
        const slice = line.slice(0, LOG_CAP - logBytes);
        logBytes += slice.length + 1;
        logs.push(slice);
      };

      const framer = new StdoutFramer();
      const stdoutPump = (async (): Promise<void> => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            framer.feed(decoder.decode(value, { stream: true }), () => activeKey, handleLine);
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
          if (settled) return;
          const stage = handshaken ? "before finishing" : "before presenting its frame key";
          finish({ ok: false, output: `code runner exited (code ${exitCode}) ${stage}${tail()}`, error: `runner exited (${exitCode})` });
        });
      });
    });
  },
};
