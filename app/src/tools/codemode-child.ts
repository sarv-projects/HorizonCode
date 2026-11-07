/**
 * codemode-child.ts — the program runner behind the `code_mode` tool.
 *
 * Protocol (NDJSON over stdio, deliberately tiny):
 *   parent -> child   {"init":{"code":"..."}}                 once, first
 *   child  -> parent  {"rpc":"tool.call","rpcId":N,"name":..,"args":{..}}
 *   parent -> child   {"rpcId":N,"result":{"ok":..,"output":..,"error":..}}
 *   child  -> parent  {"log":"..."}                            console output
 *   child  -> parent  {"done":true,"result":<json>}            exactly once, last
 *   child  -> parent  {"done":false,"error":"..."}             on a program error
 *
 * Console output is tagged ({"log": ...}) rather than sent as bare lines: a
 * program that logs a JSON object shaped like a control frame must not be able
 * to end itself early or invent a result. (A program that writes to stdout
 * directly can still emit anything — that channel is the program's own — but
 * the ordinary console path can no longer produce false frames.)
 *
 * The user program is one async function body: `tools.call(name, args)` is the
 * bridge back to the parent (which enforces the guard, approvals and receipts),
 * `console` output streams to the parent as log lines, and the function's return
 * value becomes the result. The child never knows which tools exist: the parent
 * answers every call, including "unknown tool".
 */

interface RpcResult {
  ok: boolean;
  output: string;
  error?: string;
}

const LOG_CAP = 20000;

/* ------------------------------ stdio ------------------------------ */

let stdinBuffer = "";
let initSeen = false;
const pending = new Map<number, (result: RpcResult) => void>();

function writeLine(text: string): void {
  try {
    process.stdout.write(text + "\n");
  } catch {
    /* parent gone; the exit below will finish the job */
  }
}

function flushAndExit(code: number): void {
  // One last write, then leave only once it has drained.
  try {
    process.stdout.write("", () => process.exit(code));
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
  writeLine(
    JSON.stringify({
      rpc: "tool.call",
      rpcId,
      name: typeof name === "string" ? name : String(name ?? ""),
      args: args !== null && typeof args === "object" && !Array.isArray(args) ? args : {},
    }),
  );
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

/** A console line is a tagged stdout line to the parent; capped in total. */
function logLine(parts: unknown[]): void {
  if (logBytes >= LOG_CAP) return;
  const text = parts.map(fmt).join(" ");
  const slice = text.slice(0, LOG_CAP - logBytes);
  logBytes += slice.length + 1;
  writeLine(JSON.stringify({ log: slice }));
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
    writeLine(JSON.stringify({ done: false, error: message }));
    flushAndExit(1);
    return;
  }
  let safe: unknown = result === undefined ? null : result;
  try {
    JSON.stringify(safe);
  } catch {
    safe = "(unserializable result)";
  }
  writeLine(JSON.stringify({ done: true, result: safe }));
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
