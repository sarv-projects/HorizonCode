/**
 * codemode-child.ts — the program runner behind the `code_mode` tool.
 *
 * Protocol (NDJSON over stdio, deliberately tiny; `<key>` is a frame key — see
 * the boundary note below):
 *   child  -> parent  <bootstrap> {"hello":{"frameKey":"<64 hex>"}}      once, at load
 *   parent -> child   {"init":{"code":"..."}}                           once, after the handshake
 *   child  -> parent  <run key> {"rpc":"tool.call","rpcId":N,"name":..,"args":{..}}
 *   parent -> child   {"rpcId":N,"result":{"ok":..,"output":..,"error":..}}
 *   child  -> parent  <run key> {"log":"..."}                             console output
 *   child  -> parent  <run key> {"done":true,"result":<json>}             exactly once, last
 *   child  -> parent  <run key> {"done":false,"error":"..."}              on a program error
 *
 * Control-frame boundary. Every frame this shim sends is one line of
 * `<key> <json>`: a per-run key, a single space, then JSON. The parent treats
 * only key-prefixed lines as control frames; every other line — whoever wrote
 * it, and whatever it contains — is ordinary program output. A program that
 * logs a frame-shaped object, calls process.stdout.write('{"done":true}'), or
 * writes to fd 1 itself therefore cannot end the run early or invent a result:
 * without the key those bytes are output, not a frame. Frames go through the
 * stdout writer captured at load time, so replacing process.stdout.write later
 * cannot silence or redirect the control channel either.
 *
 * Two keys, and why:
 *   - The BOOTSTRAP nonce arrives in the environment (HZ_CODEMODE_FRAME_KEY),
 *     is read and deleted here BEFORE any model code exists, and frames exactly
 *     one line: the handshake that presents the run key. The parent stops
 *     accepting it the moment that line lands. The bootstrap nonce is
 *     deliberately short-lived because the environment is not a secret store:
 *     the OS keeps the initial environment block readable (on Linux,
 *     /proc/self/environ) for the life of the process.
 *   - The RUN key is generated in this process and lives in closure scope. It
 *     is written only inside the handshake line and never to the environment,
 *     argv or any file, and the parent does not hand the program over until it
 *     has accepted it — so no model code runs, and no byte a program writes is
 *     sent, before the run key is in force.
 *
 * What this does NOT defend against, named rather than implied — Code Mode is
 * bridge-policed, not OS-sandboxed. The facts below were verified in this
 * runtime rather than assumed; re-check them if the spawn configuration changes.
 *   - Ambient process/Bun access: the program shares this process. It can write
 *     to fd 1 directly (`fs.writeSync(1, ...)`) — those bytes are output, never
 *     frames — and it can read its own stdin, which is how it sees the parent's
 *     plain-JSON replies (they carry no key) or starves them: a denial that
 *     leaves the run to fail closed rather than complete with a forged result.
 *     It cannot read its own stdout back: a `pipe` stdio is a socketpair in this
 *     runtime, so a direct read fails (EAGAIN/EBADF), a `net.Socket` wrapper
 *     over fd 1 receives nothing, and /proc/self/fd/1 refuses to re-open (ENXIO).
 *     The run key travels on that channel and resists that route; a runtime that
 *     used real pipes would let a program race the parent for its own frame
 *     bytes, which is why tests/core/codemode-frames.test.ts pins "a program
 *     cannot read back what it wrote to fd 1".
 *   - The environment: the bootstrap nonce is delivered in the environment, and
 *     the OS keeps the initial environment block readable (on Linux,
 *     /proc/self/environ) for the life of the process. That is exactly why it
 *     frames one line and is retired; reading it back later yields nothing. The
 *     run key never enters the environment, argv or any file.
 *   - In-process reflection: the run key lives in this process's memory, so a
 *     runtime facility that can inspect live frames or module scope could
 *     recover it. Only process isolation closes that (NF-016).
 *   - Everything outside the bridge: the program may touch the filesystem, the
 *     network and the CPU directly. Only tools.call is policed.
 *
 * The user program is one async function body: `tools.call(name, args)` is the
 * bridge back to the parent (which enforces the guard, approvals and receipts),
 * `console` output streams to the parent as log frames, and the function's
 * return value becomes the result. The child never knows which tools exist: the
 * parent answers every call, including "unknown tool".
 */

import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";

interface RpcResult {
  ok: boolean;
  output: string;
  error?: string;
}

const LOG_CAP = 20000;

/* ------------------------------ frame key ------------------------------ */

/**
 * Kept in step with codemode.ts. The two processes share no module on purpose:
 * this file runs at import time (it reads the environment and writes the
 * handshake), so codemode.ts must never import it.
 */
const FRAME_KEY_ENV = "HZ_CODEMODE_FRAME_KEY";
const FRAME_KEY_BYTES = 32;
const FRAME_KEY_RE = /^[0-9a-f]{64}$/;

/** 32 random bytes as lowercase hex: 64 characters, no space, no newline. */
function newFrameKey(): string {
  return randomBytes(FRAME_KEY_BYTES).toString("hex");
}

/** The stdout writer, captured before model code (or anything else) can replace it. */
type StdoutWrite = (text: string, callback?: () => void) => unknown;
const writeStdout = process.stdout.write.bind(process.stdout) as unknown as StdoutWrite;

// Read the bootstrap nonce, then scrub it: both happen before any model code.
const bootstrapKey = process.env[FRAME_KEY_ENV] ?? "";
delete process.env[FRAME_KEY_ENV];

if (!FRAME_KEY_RE.test(bootstrapKey)) {
  // Started without the key its parent passes: refuse rather than run a program
  // whose frames the parent could never authenticate. writeSync so the message
  // is in the pipe before the exit, and a plain stderr line: stderr carries no
  // control frames in either direction.
  try {
    writeSync(
      2,
      `codemode-child: ${FRAME_KEY_ENV} is missing or malformed; refusing to run ` +
        "(this runner is only started by the code_mode tool)\n",
    );
  } catch {
    /* stderr gone: the exit status still refuses the run */
  }
  process.exit(3);
}

/** This run's frame key: in-process only (see the boundary note above). */
const runKey = newFrameKey();

/** One control frame: `<key> <json>`, through the captured writer. */
function writeFrame(message: unknown, key: string = runKey): void {
  try {
    writeStdout(`${key} ${JSON.stringify(message)}\n`);
  } catch {
    /* parent gone; the exit below will finish the job */
  }
}

// Present the run key before anything else can write. The parent answers with
// init — and only then runs the program — so this handshake is always the first
// line this process writes, and the bootstrap nonce has done its whole job.
writeFrame({ hello: { frameKey: runKey } }, bootstrapKey);

/* ------------------------------ stdio ------------------------------ */

let stdinBuffer = "";
let initSeen = false;
const pending = new Map<number, (result: RpcResult) => void>();

function flushAndExit(code: number): void {
  // One last write (through the captured writer), then leave only once it has
  // drained.
  try {
    writeStdout("", () => process.exit(code));
    setTimeout(() => process.exit(code), 250);
  } catch {
    process.exit(code);
  }
}

let rpcCounter = 0;

/** tools.call(name, args) — one request/response round trip with the parent. */
function callTool(name: unknown, args: unknown): Promise<RpcResult> {
  const rpcId = rpcCounter + 1;
  rpcCounter = rpcId;
  const promise = new Promise<RpcResult>((resolve) => {
    pending.set(rpcId, resolve);
  });
  writeFrame({
    rpc: "tool.call",
    rpcId,
    name: typeof name === "string" ? name : String(name ?? ""),
    args: args !== null && typeof args === "object" && !Array.isArray(args) ? args : {},
  });
  return promise;
}

/* ------------------------------ logging ------------------------------ */

let logBytes = 0;

function fmt(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** A console line is a tagged control frame to the parent; capped in total. */
function logLine(parts: unknown[]): void {
  if (logBytes >= LOG_CAP) return;
  const text = parts.map(fmt).join(" ");
  const slice = text.slice(0, LOG_CAP - logBytes);
  logBytes += slice.length + 1;
  writeFrame({ log: slice });
}

const captureConsole = {
  log: (...args: unknown[]) => logLine(args),
  info: (...args: unknown[]) => logLine(args),
  warn: (...args: unknown[]) => logLine(args),
  error: (...args: unknown[]) => logLine(args),
  debug: (...args: unknown[]) => logLine(args),
};

/* ------------------------------ the program ------------------------------ */

function handleLine(line: string): void {
  let message: { init?: { code?: unknown }; rpcId?: unknown; result?: unknown };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return; // not ours; stay quiet
  }
  if (message === null || typeof message !== "object") return;
  if (message.init && !initSeen) {
    initSeen = true;
    void runProgram(typeof message.init.code === "string" ? message.init.code : "");
    return;
  }
  if (typeof message.rpcId === "number" && message.result !== undefined) {
    const resolve = pending.get(message.rpcId);
    if (resolve) {
      pending.delete(message.rpcId);
      resolve(message.result as RpcResult);
    }
  }
}

type AsyncFnCtor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

async function runProgram(code: string): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFnCtor;
  let result: unknown;
  try {
    const program = new AsyncFunction("tools", "console", code);
    result = await program({ call: callTool }, captureConsole);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFrame({ done: false, error: message });
    flushAndExit(1);
    return;
  }
  let safe: unknown = result === undefined ? null : result;
  try {
    JSON.stringify(safe);
  } catch {
    safe = "(unserializable result)";
  }
  writeFrame({ done: true, result: safe });
  flushAndExit(0);
}

/* ------------------------------ wiring ------------------------------ */

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  stdinBuffer += chunk;
  let index = stdinBuffer.indexOf("\n");
  while (index >= 0) {
    const line = stdinBuffer.slice(0, index);
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (line.trim() !== "") handleLine(line);
    index = stdinBuffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  // The parent is gone: release every waiting call and stop.
  for (const resolve of pending.values()) resolve({ ok: false, output: "tool channel closed", error: "tool channel closed" });
  pending.clear();
  flushAndExit(1);
});
