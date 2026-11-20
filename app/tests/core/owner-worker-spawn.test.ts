/**
 * C-12 — real owner↔worker OS pipe + spawnOwned product wiring (Linux).
 *
 * Hermetic coverage of the pure handshake (fake IO, no subprocess), the Linux
 * /proc ancestor-chain check (injected facts), the opt-in gate, and ONE real
 * Bun.spawn subprocess running the worker child mode over NDJSON stdio — with
 * no provider and no network. macOS/Windows ancestor proving stays external.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { ProcessFacts } from "../../src/core/worker-identity";
import { makeBootstrap, makeHello, encodeFrame } from "../../src/core/owner-worker-control-pipe";
import {
  ANCESTOR_MAX_DEPTH,
  OWNER_WORKER_CHILD_FLAG,
  OWNER_WORKER_CMD_ENV,
  OWNER_WORKER_PIPE_ENV,
  isOwnerWorkerChildArgv,
  openOwnerWorkerHandshake,
  ownerWorkerPipeEnabled,
  parseOwnerWorkerCmd,
  runOwnerWorkerForTurn,
  workerIsDescendantOf,
  type OwnerWorkerPipeIo,
} from "../../src/core/owner-worker-spawn";

const WORKER = { pid: 4242, startTicks: 900 };
const BOOTSTRAP = makeBootstrap({
  profileId: "p",
  sessionId: "s",
  executionId: "e1",
  generation: 1,
  identity: WORKER,
  secret: "sekret",
  epoch: 7,
});

/** A fake worker that replies with a valid hello, then records the reserve. */
function fakeIo(reply = makeHello({ executionId: "e1", identity: WORKER, secret: "sekret", epoch: 7 })): {
  io: OwnerWorkerPipeIo;
  written: string[];
} {
  const written: string[] = [];
  let served = false;
  return {
    written,
    io: {
      publish: (line) => {
        written.push(line);
      },
      readFrame: async () => {
        if (served) throw new Error("no more frames");
        served = true;
        const encoded = encodeFrame(reply);
        if (!encoded.ok) throw new Error(encoded.reason);
        return JSON.parse((encoded as { value: string }).value);
      },
    },
  };
}

describe("C-12 opt-in gate + command decoding", () => {
  test("gate is off unless the env flag is exactly 1", () => {
    expect(ownerWorkerPipeEnabled({})).toBe(false);
    expect(ownerWorkerPipeEnabled({ [OWNER_WORKER_PIPE_ENV]: "1" })).toBe(true);
    expect(ownerWorkerPipeEnabled({ [OWNER_WORKER_PIPE_ENV]: "true" })).toBe(false);
  });

  test("worker cmd is a closed JSON array and the child flag is stable", () => {
    expect(OWNER_WORKER_CHILD_FLAG).toBe("--owner-worker-child");
    expect(isOwnerWorkerChildArgv(["x", OWNER_WORKER_CHILD_FLAG])).toBe(true);
    expect(isOwnerWorkerChildArgv([])).toBe(false);
    expect(parseOwnerWorkerCmd('["bun","w.ts"]')).toEqual(["bun", "w.ts"]);
    expect(parseOwnerWorkerCmd("not json")).toBeUndefined();
    expect(parseOwnerWorkerCmd('["bun",""]')).toBeUndefined();
    expect(parseOwnerWorkerCmd("[]")).toBeUndefined();
    expect(parseOwnerWorkerCmd(undefined)).toBeUndefined();
    void OWNER_WORKER_CMD_ENV;
  });

  test("turn path is disabled with no spawn when gate off", async () => {
    const result = await runOwnerWorkerForTurn({ workspace: "/tmp", stateDir: "/tmp/.hz", sessionId: "s", env: {} });
    expect(result.status).toBe("disabled");
    expect(result.pid).toBeUndefined();
  });
});

describe("C-12 Linux /proc ancestor-chain proving", () => {
  const facts: Record<number, ProcessFacts> = {
    4242: { ppid: 500, pgid: 4242, startTicks: 900 },
    500: { ppid: 1, pgid: 500, startTicks: 100 },
  };
  const read = (pid: number) => facts[pid];

  test("a true descendant passes; the walked chain ends at the owner", () => {
    const verdict = workerIsDescendantOf(4242, 500, { readFacts: read, platform: "linux" });
    expect(verdict.ok).toBe(true);
    expect(verdict.chain).toEqual([4242, 500]);
  });

  test("a non-ancestor owner is refused; a cycle is refused", () => {
    expect(workerIsDescendantOf(4242, 999, { readFacts: read, platform: "linux" }).ok).toBe(false);
    const cyclic: Record<number, ProcessFacts> = {
      10: { ppid: 11, pgid: 10, startTicks: 1 },
      11: { ppid: 10, pgid: 11, startTicks: 1 },
    };
    expect(workerIsDescendantOf(10, 999, { readFacts: (pid) => cyclic[pid], platform: "linux" }).ok).toBe(false);
  });

  test("the walk is bounded", () => {
    expect(ANCESTOR_MAX_DEPTH).toBeGreaterThanOrEqual(8);
  });

  test("win32 is an unavailable refusal (Windows residual)", () => {
    const verdict = workerIsDescendantOf(4242, 500, { readFacts: read, platform: "win32" });
    expect(verdict.ok).toBe(false);
    expect(verdict.unavailable).toBe(true);
    expect(verdict.reason).toContain("win32");
  });

  test("darwin walks injectable ppid chain (reduced prove)", () => {
    const ppid: Record<number, number> = { 4242: 500, 500: 1 };
    const verdict = workerIsDescendantOf(4242, 500, {
      platform: "darwin",
      readPpid: (pid) => ppid[pid],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.unavailable).toBeUndefined();
  });

});

describe("C-12 publish → hello/verify → FIFO reserve handshake (fake IO)", () => {
  test("publishes bootstrap, verifies hello, and emits exactly one reserve", async () => {
    const { io, written } = fakeIo();
    const result = await openOwnerWorkerHandshake({
      bootstrap: BOOTSTRAP,
      ownerPid: 100,
      io,
      liveCheck: () => ({ ok: true }),
    });
    expect(result.ok).toBe(true);
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]).kind).toBe("bootstrap");
    expect(JSON.parse(written[1]).kind).toBe("reserve");
    expect(JSON.parse(written[1]).seq).toBe(1);
  });

  test("a mismatched secret/zero-epoch hello refuses before any reserve", async () => {
    const { io, written } = fakeIo(makeHello({ executionId: "e1", identity: WORKER, secret: "WRONG", epoch: 7 }));
    const result = await openOwnerWorkerHandshake({
      bootstrap: BOOTSTRAP,
      ownerPid: 100,
      io,
      liveCheck: () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    expect(written).toHaveLength(1); // only bootstrap was published
  });

  test("a failed ancestor/identity live check refuses before reserve", async () => {
    const { io, written } = fakeIo();
    const result = await openOwnerWorkerHandshake({
      bootstrap: BOOTSTRAP,
      ownerPid: 100,
      io,
      liveCheck: () => ({ ok: false, reason: "owner not in ancestor chain" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result as { reason: string }).reason).toContain("ancestor");
    expect(written).toHaveLength(1);
  });
});

describe("C-12 real Bun.spawn worker child over NDJSON stdio (no provider/network)", () => {
  test("owner publishes bootstrap → verifies hello → reserves; worker emits finished", async () => {
    const script = path.resolve(__dirname, "../../src/core/owner-worker-spawn.ts");
    const child = Bun.spawn([process.execPath, script, OWNER_WORKER_CHILD_FLAG], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdin = (child as unknown as { stdin: { write(s: string): void } }).stdin;
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const readFrame = async (): Promise<Record<string, unknown>> => {
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("child closed stdout");
        buffer += decoder.decode(value, { stream: true });
        const nl = buffer.indexOf("\n");
        if (nl >= 0) return JSON.parse(buffer.slice(0, nl));
      }
    };

    // 1) owner publishes bootstrap
    const bootLine = encodeFrame(BOOTSTRAP);
    expect(bootLine.ok).toBe(true);
    stdin.write((bootLine as { value: string }).value + "\n");

    // 2) owner verifies the worker's hello
    const hello = await readFrame();
    expect(hello.kind).toBe("hello");
    expect(hello.executionId).toBe("e1");
    expect(hello.secret).toBe("sekret");
    expect(hello.epoch).toBe(7);

    // 3) owner reserves the single FIFO slot
    const reserve = {
      v: 1,
      kind: "reserve",
      executionId: "e1",
      pid: WORKER.pid,
      startTicks: WORKER.startTicks,
      seq: 1,
    };
    stdin.write(JSON.stringify(reserve) + "\n");

    // 4) worker emits a finished turn frame
    const finished = await readFrame();
    expect(finished.kind).toBe("finished");
    expect(finished.executionId).toBe("e1");

    stdin.end?.();
    const exit = await child.exited;
    expect(exit).toBe(0);
  });
});
