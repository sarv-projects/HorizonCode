/**
 * owner-worker-spawn.ts — C-12 real owner↔worker OS pipe (Linux).
 *
 * Extends the PURE protocol in `owner-worker-control-pipe.ts` (rulings 22/471/
 * 492) with a real `spawnOwned`/`Bun.spawn` subprocess over NDJSON stdio frames:
 *
 *   owner:  spawn worker → publish bootstrap → verify hello/identity → FIFO reserve
 *   worker: read bootstrap → echo hello (own born identity + secret + epoch)
 *           → read reserve → emit a `finished` turn frame
 *
 * Before any work is reserved the owner ALSO proves the worker is a DESCENDANT
 * of the owner by walking the Linux `/proc/<pid>/stat` ppid chain (bounded depth,
 * injectable reader). The identity handshake refuses a recycled pid / stale
 * boot / mismatched secret or epoch via the existing `OwnerWorkerHandshake`.
 *
 * Product wiring is OPT-IN: `HZ_OWNER_WORKER_PIPE=1` and a configured worker
 * argv (`HZ_OWNER_WORKER_CMD`, JSON array). Off = zero behavior change. macOS /
 * Windows ancestor proving and full R170 cross-process atomicity remain EXTERNAL
 * residuals — on those platforms the ancestor check refuses with a named reason.
 * No network is opened; no claim of shell-net egress enforcement.
 */

import * as path from "node:path";
import type { ProcessFacts } from "./worker-identity";
import { readProcessFacts, recordIdentity, verifyIdentity } from "./worker-identity";
import {
  ControlPipeFramer,
  OwnerWorkerHandshake,
  encodeFrame,
  makeBootstrap,
  makeTurnFrame,
  type DecodeResult,
  type OwnerWorkerBootstrap,
  type OwnerWorkerFrame,
  type OwnerWorkerTurnFrame,
} from "./owner-worker-control-pipe";
import { newId } from "../contracts";
import { ownerWorkerTurnPreflight, readDarwinPpid } from "./owner-worker-ancestor-honesty";
import { spawnOwned } from "./owned-spawn";

/**
 * With `strict: false` the `ok` discriminant does not narrow, so these helpers
 * extract the reason/value of a `DecodeResult` safely (the shape is closed and
 * defined in owner-worker-control-pipe.ts).
 */
function failReason<T>(result: DecodeResult<T>, fallback = "unknown failure"): string {
  return (result as { ok: boolean; reason?: string }).ok === false
    ? (result as { reason: string }).reason
    : fallback;
}
function okValue<T>(result: DecodeResult<T>): T {
  return (result as { value: T }).value;
}

/** Opt-in product gate for the per-turn owner/worker pipe. */
export const OWNER_WORKER_PIPE_ENV = "HZ_OWNER_WORKER_PIPE";
/** JSON array of argv for the worker subprocess (default: this app's child mode). */
export const OWNER_WORKER_CMD_ENV = "HZ_OWNER_WORKER_CMD";

export function ownerWorkerPipeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OWNER_WORKER_PIPE_ENV] === "1";
}

/** Hidden worker mode flag (the spawned child re-execs this module). */
export const OWNER_WORKER_CHILD_FLAG = "--owner-worker-child";

/** Bounded ancestor walk so a corrupt /proc cycle cannot hang the owner. */
export const ANCESTOR_MAX_DEPTH = 16;

/* ------------------------ ancestor-chain proving ------------------------- */

export interface AncestorVerdict {
  ok: boolean;
  /** The walked pid chain, worker first, ending at the owner when ok. */
  chain: number[];
  reason?: string;
  /** True when the check could not run (non-Linux) vs a positive refusal. */
  unavailable?: boolean;
}

/**
 * Prove that `workerPid` descends from `ownerPid` by walking `/proc` ppid links,
 * at most `ANCESTOR_MAX_DEPTH` hops. The final link must be the owner itself —
 * reaching pid 1 (init) or a cycle is a refusal, never a pass. `readFacts` is
 * injectable for hermetic tests. On non-Linux there is no /proc, so the check
 * is UNAVAILABLE and returns ok:false with a named residual.
 */
export type AncestorWalkOpts = {
  readFacts?: (pid: number) => ProcessFacts | undefined;
  /** macOS reduced walk: parent pid only (defaults to `readDarwinPpid` when absent). */
  readPpid?: (pid: number) => number | undefined;
  maxDepth?: number;
  platform?: string;
};

function resolvePpidReader(
  platform: string,
  opts: AncestorWalkOpts,
): ((pid: number) => number | undefined) | "unavailable" {
  if (opts.readPpid !== undefined) return opts.readPpid;
  if (opts.readFacts !== undefined) return (pid) => opts.readFacts!(pid)?.ppid;
  if (platform === "linux") return (pid) => readProcessFacts(pid)?.ppid;
  if (platform === "darwin") return readDarwinPpid;
  return "unavailable";
}

export function workerIsDescendantOf(
  workerPid: number,
  ownerPid: number,
  opts: AncestorWalkOpts = {},
): AncestorVerdict {
  const platform = opts.platform ?? process.platform;
  const maxDepth = opts.maxDepth ?? ANCESTOR_MAX_DEPTH;
  if (platform === "win32") {
    return {
      ok: false,
      chain: [],
      unavailable: true,
      reason: "ancestor proving unavailable on win32 (Windows parent-walk residual — no reduced prove path)",
    };
  }
  const readPpid = resolvePpidReader(platform, opts);
  if (readPpid === "unavailable") {
    return {
      ok: false,
      chain: [],
      unavailable: true,
      reason: `ancestor proving unavailable on ${platform} (macOS/Windows residual)`,
    };
  }
  if (!Number.isInteger(workerPid) || workerPid <= 0 || !Number.isInteger(ownerPid) || ownerPid <= 0) {
    return { ok: false, chain: [], reason: "ancestor check needs positive integer pids" };
  }
  const chain: number[] = [];
  const seen = new Set<number>();
  let current = workerPid;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    chain.push(current);
    if (current === ownerPid) return { ok: true, chain };
    if (current === 1 || current === 0) break;
    if (seen.has(current)) return { ok: false, chain, reason: "ppid cycle in ancestor chain" };
    seen.add(current);
    const ppid = readPpid(current);
    if (ppid === undefined) {
      const gone =
        platform === "linux"
          ? `/proc/${current}/stat unavailable (worker gone or /proc absent)`
          : platform === "darwin"
            ? `ps could not read ppid for pid ${current} (worker gone or macOS ps residual)`
            : `parent pid unavailable for ${current}`;
      return { ok: false, chain, reason: gone };
    }
    current = ppid;
  }
  return { ok: false, chain, reason: `owner pid ${ownerPid} not in the worker's ancestor chain (max depth ${maxDepth})` };
}

/* --------------------- injectable pipe IO + handshake -------------------- */

/** The async byte transport the handshake is driven over (real or fake). */
export interface OwnerWorkerPipeIo {
  /** Write one NDJSON frame line to the worker's stdin. */
  publish(line: string): Promise<void> | void;
  /** Read and decode the next complete frame from the worker's stdout. */
  readFrame(): Promise<OwnerWorkerFrame>;
}

export interface OwnerWorkerHandshakeOpts {
  bootstrap: OwnerWorkerBootstrap;
  ownerPid: number;
  io: OwnerWorkerPipeIo;
  /** Override the live identity check (tests with synthetic identities). */
  liveCheck?: (identity: { pid: number; startTicks: number }) => { ok: boolean; reason?: string };
  readFacts?: (pid: number) => ProcessFacts | undefined;
  platform?: string;
}

export type OwnerWorkerOpenVerdict =
  | { ok: true; state: "verified" | "reserved"; reserve: ReturnType<OwnerWorkerHandshake["reserveWork"]> }
  | { ok: false; reason: string };

/**
 * Drive the closed publish → hello/verify(+ancestor) → FIFO reserve sequence
 * over an injectable IO. This is the real protocol wiring; the OS pipe adapter
 * below supplies actual stdio, and tests supply a fake worker subprocess.
 */
export async function openOwnerWorkerHandshake(opts: OwnerWorkerHandshakeOpts): Promise<OwnerWorkerOpenVerdict> {
  const { bootstrap, io, ownerPid } = opts;
  const liveCheck =
    opts.liveCheck ??
    ((identity: { pid: number; startTicks: number }) => {
      const verified = verifyIdentity(identity);
      if (!verified.ok) return verified;
      return workerIsDescendantOf(identity.pid, ownerPid, {
        readFacts: opts.readFacts,
        platform: opts.platform,
      });
    });
  const handshake = new OwnerWorkerHandshake(bootstrap, { liveProcCheck: liveCheck });

  const published = handshake.publishBootstrap();
  if (!published.ok) return { ok: false, reason: failReason(published) };
  await io.publish(okValue(published));

  let helloFrame: OwnerWorkerFrame;
  try {
    helloFrame = await io.readFrame();
  } catch (err) {
    return { ok: false, reason: `reading worker hello failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const verdict = handshake.acceptHello(helloFrame);
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? "hello refused" };

  const reserve = handshake.reserveWork();
  if (!reserve.ok) return { ok: false, reason: failReason(reserve) };
  const reserveLine = encodeFrame(okValue(reserve));
  if (!reserveLine.ok) return { ok: false, reason: failReason(reserveLine) };
  await io.publish(okValue(reserveLine));
  return { ok: true, state: handshake.state === "reserved" ? "reserved" : "verified", reserve };
}

/* --------------------------- real OS pipe -------------------------------- */

export interface SpawnOwnerWorkerPipeOpts {
  cmd: string[];
  stateDir: string;
  label: string;
  scope: {
    profileId: string;
    sessionId: string;
    executionId?: string;
    generation?: number;
    epoch?: number;
    secret?: string;
  };
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Injectable reader for the ancestor check. */
  readFacts?: (pid: number) => ProcessFacts | undefined;
  platform?: string;
}

export interface OwnerWorkerPipeHandle {
  pid: number;
  birthIdentity: string | null;
  readFrame(): Promise<OwnerWorkerFrame>;
  publishTurnFrame(frame: OwnerWorkerTurnFrame): Promise<void>;
  close(): void;
}

/**
 * Open a real owner↔worker OS pipe. The worker is spawned via `spawnOwned`
 * (ledger + birth identity + owner-death supervision); stdio is NDJSON. The
 * owner publishes bootstrap, verifies hello/identity/ancestor, and reserves the
 * single FIFO slot BEFORE returning the handle. Any refusal kills the child.
 * `spawnOwned` is injected implicitly by the module; tests exercise the pure
 * handshake above with a fake subprocess instead of a live provider.
 */
export async function spawnOwnerWorkerPipe(opts: SpawnOwnerWorkerPipeOpts): Promise<OwnerWorkerPipeHandle> {
  if (!Array.isArray(opts.cmd) || opts.cmd.length === 0) throw new Error("spawnOwnerWorkerPipe: cmd required");
  const owned = await spawnOwned(opts.cmd, {
    stateDir: opts.stateDir,
    label: opts.label,
    cwd: opts.cwd,
    env: opts.env,
    sandboxWrap: false,
    longLived: true,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  });
  const pid = owned.entry.pid;
  const identity = owned.identity;
  if (identity === undefined) {
    owned.proc.kill("SIGKILL");
    throw new Error("spawnOwnerWorkerPipe: no live /proc identity for the worker (refusing an unverifiable worker)");
  }
  const bootstrap = makeBootstrap({
    profileId: opts.scope.profileId,
    sessionId: opts.scope.sessionId,
    executionId: opts.scope.executionId ?? newId(),
    generation: opts.scope.generation ?? 1,
    identity,
    secret: opts.scope.secret ?? newId(),
    epoch: opts.scope.epoch ?? 1,
  });

  const framer = new ControlPipeFramer();
  const decoder = new TextDecoder();
  const reader = owned.proc.stdout.getReader();
  const readFrame = async (): Promise<OwnerWorkerFrame> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("worker closed the pipe before sending a frame");
      for (const decoded of framer.push(decoder.decode(value, { stream: true }))) {
        if (!decoded.ok) throw new Error(`worker sent an invalid frame: ${failReason(decoded)}`);
        return okValue(decoded);
      }
    }
  };
  const stdin = (owned.proc as unknown as { stdin: { write(chunk: string): void } }).stdin;
  const publish = (line: string): void => stdin.write(`${line}\n`);

  const verdict = await openOwnerWorkerHandshake({
    bootstrap,
    ownerPid: process.pid,
    io: { publish, readFrame },
    readFacts: opts.readFacts,
    platform: opts.platform,
  });
  if (!verdict.ok) {
    owned.proc.kill("SIGKILL");
    throw new Error(`spawnOwnerWorkerPipe: ${(verdict as { reason: string }).reason}`);
  }

  let closed = false;
  return {
    pid,
    birthIdentity: owned.entry.birthIdentity,
    readFrame,
    publishTurnFrame: async (frame) => {
      const line = encodeFrame(frame);
      if (!line.ok) throw new Error(`cannot encode turn frame: ${failReason(line)}`);
      await publish(okValue(line));
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
      try {
        owned.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

/* ------------------- worker child mode (for real tests) ------------------ */

/**
 * Worker-side loop: read the bootstrap, echo a verified hello with THIS
 * process's born identity + secret + epoch, wait for the single reserve, then
 * emit a `finished` turn frame. Runs as `bun run <this file> --owner-worker-child`.
 */
export async function runOwnerWorkerChild(
  stdin: AsyncIterable<Uint8Array> | AsyncIterable<string>,
  stdout: (line: string) => void,
  opts: { secret?: string; epoch?: number } = {},
): Promise<void> {
  const framer = new ControlPipeFramer();
  const decoder = new TextDecoder();
  // ONE persistent async iterator across both reads: re-entering `for await`
  // closes stdin in Bun, so a second loop would abort before the reserve frame.
  const iterator = stdin[Symbol.asyncIterator]();
  const decodedQueue: OwnerWorkerFrame[] = [];
  const nextFrame = async (): Promise<OwnerWorkerFrame> => {
    for (;;) {
      if (decodedQueue.length > 0) return decodedQueue.shift();
      const { value, done } = await iterator.next();
      if (done) throw new Error("stdin closed before a frame arrived");
      const text = typeof value === "string" ? value : decoder.decode(value, { stream: true });
      for (const decoded of framer.push(text)) {
        if (!decoded.ok) throw new Error(`invalid frame: ${failReason(decoded)}`);
        decodedQueue.push(okValue(decoded));
      }
    }
  };
  const bootstrapFrame = await nextFrame();
  if (bootstrapFrame.kind !== "bootstrap") throw new Error("first frame was not a bootstrap");
  const bootstrap = bootstrapFrame as OwnerWorkerBootstrap;
  const identity = recordIdentity(process.pid);
  if (identity === undefined) throw new Error("no /proc identity for worker child");
  const hello = {
    v: bootstrap.v,
    kind: "hello" as const,
    executionId: bootstrap.executionId,
    pid: identity.pid,
    startTicks: identity.startTicks,
    secret: opts.secret ?? bootstrap.secret,
    epoch: opts.epoch ?? bootstrap.epoch,
  };
  const helloEncoded = encodeFrame(hello);
  if (!helloEncoded.ok) throw new Error(`cannot encode hello: ${failReason(helloEncoded)}`);
  stdout(okValue(helloEncoded));

  const reserveFrame = await nextFrame();
  if (reserveFrame.kind !== "reserve") throw new Error("second frame was not a reserve");
  const finished = makeTurnFrame({
    kind: "finished",
    executionId: bootstrap.executionId,
    payload: { identity: `${identity.pid}@${identity.startTicks}`, reserved: true },
  });
  const finishedEncoded = encodeFrame(finished);
  if (finishedEncoded.ok) stdout(okValue(finishedEncoded));
}

/* ------------------------- opt-in product path --------------------------- */

export interface TurnOwnerWorkerResult {
  status: "ok" | "refused" | "disabled";
  reason?: string;
  pid?: number;
  finished?: OwnerWorkerTurnFrame;
}

/**
 * Opt-in product path for ONE turn: when `HZ_OWNER_WORKER_PIPE=1`, spawn a
 * worker (default: this module's child mode), complete the handshake + reserve,
 * and read its `finished` frame. Gate OFF returns `{status:"disabled"}` with no
 * spawn. Live provider work over the pipe is NOT wired here; the child proves
 * identity + reserve only, so a turn never blocks on a model call.
 */
export async function runOwnerWorkerForTurn(opts: {
  workspace: string;
  stateDir: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TurnOwnerWorkerResult> {
  const env = opts.env ?? process.env;
  if (!ownerWorkerPipeEnabled(env)) return { status: "disabled" };
  const preflight = ownerWorkerTurnPreflight(process.platform, env);
  if (!preflight.ok) return { status: "refused", reason: preflight.reason };
  const cmd = parseOwnerWorkerCmd(env[OWNER_WORKER_CMD_ENV]) ?? [
    process.execPath,
    path.resolve(process.argv[1] ?? ""),
    OWNER_WORKER_CHILD_FLAG,
  ];
  let handle: OwnerWorkerPipeHandle | undefined;
  try {
    handle = await spawnOwnerWorkerPipe({
      cmd,
      stateDir: opts.stateDir,
      label: "owner-worker:turn",
      scope: { profileId: "default", sessionId: opts.sessionId },
      env: env as Record<string, string | undefined>,
    });
    const first = await handle.readFrame();
    if (first.kind !== "finished") return { status: "refused", reason: `worker sent ${first.kind}, expected finished`, pid: handle.pid };
    return { status: "ok", pid: handle.pid, finished: first as OwnerWorkerTurnFrame };
  } catch (err) {
    return { status: "refused", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    handle?.close();
  }
}

/** Decode the JSON-array worker command; undefined on anything malformed. */
export function parseOwnerWorkerCmd(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((p) => typeof p !== "string" || p === "")) {
      return undefined;
    }
    return parsed as string[];
  } catch {
    return undefined;
  }
}

/** Child-mode entry guard (no side effects when imported as a module). */
export function isOwnerWorkerChildArgv(argv: readonly string[] = process.argv.slice(2)): boolean {
  return argv.includes(OWNER_WORKER_CHILD_FLAG);
}

if (import.meta.main && isOwnerWorkerChildArgv()) {
  await runOwnerWorkerChild(process.stdin as AsyncIterable<Uint8Array>, (line) => process.stdout.write(`${line}\n`));
}
