import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  applyLoopbackNoProxy,
  flushStreamsAndExit,
  installSignalAndExitHandlers,
  remapWindowsPort,
  watchStdinClose,
  type FlushableStream,
  type WatchableStdin,
} from "../src/core/cli-hygiene";

describe("applyLoopbackNoProxy", () => {
  test("populates both NO_PROXY and no_proxy with loopback entries when unset", () => {
    const env: Record<string, string | undefined> = {};
    const merged = applyLoopbackNoProxy(env);
    expect(merged).toBe("127.0.0.1,localhost,::1");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
  });

  test("merges and deduplicates existing NO_PROXY and no_proxy entries", () => {
    const env: Record<string, string | undefined> = {
      NO_PROXY: "corp.internal, localhost , ,10.0.0.0/8",
      no_proxy: "127.0.0.1, corp.internal, .local",
    };
    const merged = applyLoopbackNoProxy(env);
    expect(merged).toBe("corp.internal,localhost,10.0.0.0/8,127.0.0.1,.local,::1");
    expect(env.NO_PROXY).toBe(merged);
    expect(env.no_proxy).toBe(merged);
  });

  test("is idempotent across repeated invocations", () => {
    const env: Record<string, string | undefined> = { NO_PROXY: "example.com" };
    const first = applyLoopbackNoProxy(env);
    const second = applyLoopbackNoProxy(env);
    expect(second).toBe(first);
    expect(env.NO_PROXY).toBe("example.com,127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("example.com,127.0.0.1,localhost,::1");
  });
});

describe("remapWindowsPort", () => {
  test("remaps ports >= 0x8000 into 0x7000 | (port & 0xfff) on win32", () => {
    expect(remapWindowsPort(0xc0de, "win32")).toBe(0x70de);
    expect(remapWindowsPort(0xc0df, "win32")).toBe(0x70df);
    expect(remapWindowsPort(0x8000, "win32")).toBe(0x7000);
    expect(remapWindowsPort(0xffff, "win32")).toBe(0x7fff);
  });

  test("leaves ports unchanged on non-Windows platforms", () => {
    expect(remapWindowsPort(0xc0de, "linux")).toBe(0xc0de);
    expect(remapWindowsPort(0xc0de, "darwin")).toBe(0xc0de);
    expect(remapWindowsPort(0x8000, "linux")).toBe(0x8000);
  });

  test("leaves ephemeral port 0 and ports < 0x8000 unchanged on win32", () => {
    expect(remapWindowsPort(0, "win32")).toBe(0);
    expect(remapWindowsPort(8080, "win32")).toBe(8080);
    expect(remapWindowsPort(0x7fff, "win32")).toBe(0x7fff);
  });
});

describe("flushStreamsAndExit", () => {
  test("waits for stdout and stderr end callbacks before exiting", async () => {
    const order: string[] = [];
    const makeStream = (name: string, delayMs: number): FlushableStream => ({
      end(cb?: () => void) {
        setTimeout(() => {
          order.push(name);
          cb?.();
        }, delayMs);
      },
    });

    await flushStreamsAndExit(42, 500, {
      stdout: makeStream("stdout", 10),
      stderr: makeStream("stderr", 20),
      exit: (code) => order.push(`exit:${code}`),
    });

    expect(order).toEqual(["stdout", "stderr", "exit:42"]);
  });

  test("bounds blocked pipe flush by timeoutMs and still exits", async () => {
    const exits: number[] = [];
    const blocked: FlushableStream = {
      end() {
        // Simulates a blocked downstream pipe that never drains.
      },
    };

    const start = Date.now();
    await flushStreamsAndExit(7, 40, {
      stdout: blocked,
      stderr: blocked,
      exit: (code) => exits.push(code),
    });
    const elapsed = Date.now() - start;

    expect(exits).toEqual([7]);
    expect(elapsed).toBeLessThan(400);
  });

  test("handles already-ended or throwing streams cleanly", async () => {
    const exits: number[] = [];
    await flushStreamsAndExit(0, 100, {
      stdout: { writableEnded: true, end: () => { throw new Error("should not call"); } },
      stderr: { end: () => { throw new Error("EPIPE"); } },
      exit: (code) => exits.push(code),
    });
    expect(exits).toEqual([0]);
  });
});

describe("installSignalAndExitHandlers", () => {
  test("maps SIGTERM to exit code 143 and sets terminated=true", async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    const forced: number[] = [];
    let shutdownSignal: string | undefined;

    const ctrl = installSignalAndExitHandlers({
      target,
      deadlineMs: 500,
      onShutdown: async (sig) => {
        shutdownSignal = sig;
        await new Promise((r) => setTimeout(r, 10));
      },
      exit: (code) => exits.push(code),
      forceExit: (code) => forced.push(code),
    });

    target.emit("SIGTERM");
    expect(ctrl.terminated).toBe(true);
    expect(ctrl.shuttingDown).toBe(true);
    expect(ctrl.signal).toBe("SIGTERM");
    expect(ctrl.resolveExitCode(0)).toBe(143);
    expect(ctrl.resolveExitCode(130)).toBe(143);

    await new Promise((r) => setTimeout(r, 30));
    expect(shutdownSignal).toBe("SIGTERM");
    expect(exits).toEqual([143]);
    expect(forced).toEqual([]);
    ctrl.dispose();
  });

  test("maps SIGINT to exit code 130 without marking terminated", async () => {
    const target = new EventEmitter();
    const exits: number[] = [];

    const ctrl = installSignalAndExitHandlers({
      target,
      deadlineMs: 500,
      onShutdown: async () => {},
      exit: (code) => exits.push(code),
      forceExit: () => {},
    });

    target.emit("SIGINT");
    expect(ctrl.terminated).toBe(false);
    expect(ctrl.shuttingDown).toBe(true);
    expect(ctrl.resolveExitCode(0)).toBe(130);

    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([130]);
    ctrl.dispose();
  });

  test("enforces immediate exit(1) on second signal during teardown", () => {
    const target = new EventEmitter();
    const forced: number[] = [];
    const stderr: string[] = [];

    const ctrl = installSignalAndExitHandlers({
      target,
      deadlineMs: 5_000,
      onShutdown: () => new Promise(() => {}), // hangs
      stderrWrite: (chunk) => stderr.push(chunk),
      exit: () => {},
      forceExit: (code) => forced.push(code),
    });

    target.emit("SIGTERM");
    expect(forced).toEqual([]);

    target.emit("SIGTERM");
    expect(forced).toEqual([1]);
    expect(stderr.some((line) => line.includes("again during shutdown"))).toBe(true);
    ctrl.dispose();
  });

  test("enforces shutdown deadline when teardown hangs", async () => {
    const target = new EventEmitter();
    const forced: number[] = [];
    const stderr: string[] = [];

    const ctrl = installSignalAndExitHandlers({
      target,
      deadlineMs: 40,
      onShutdown: () => new Promise(() => {}), // hangs
      stderrWrite: (chunk) => stderr.push(chunk),
      exit: () => {},
      forceExit: (code) => forced.push(code),
    });

    target.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 80));

    expect(forced).toEqual([1]);
    expect(stderr.some((line) => line.includes("shutdown did not finish"))).toBe(true);
    ctrl.dispose();
  });

  test("respects handleSigint: false and cleans up listeners on dispose", () => {
    const target = new EventEmitter();
    const exits: number[] = [];

    const ctrl = installSignalAndExitHandlers({
      target,
      handleSigint: false,
      exit: (code) => exits.push(code),
      forceExit: () => {},
    });

    target.emit("SIGINT");
    expect(ctrl.shuttingDown).toBe(false);
    expect(exits).toEqual([]);

    ctrl.dispose();
    target.emit("SIGTERM");
    expect(ctrl.terminated).toBe(false);
    expect(exits).toEqual([]);
  });
});

describe("watchStdinClose", () => {
  test("triggers onClose once when stdin ends or closes", async () => {
    const stream = new PassThrough();
    let calls = 0;
    const dispose = watchStdinClose(() => {
      calls += 1;
    }, stream);

    stream.end();
    await new Promise((r) => setTimeout(r, 20));
    stream.destroy();
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toBe(1);
    dispose();
  });

  test("triggers immediately when stdin is already ended or destroyed", () => {
    let calls = 0;
    const endedStdin: WatchableStdin = {
      once: () => {},
      readableEnded: true,
    };
    const dispose = watchStdinClose(() => {
      calls += 1;
    }, endedStdin);

    expect(calls).toBe(1);
    dispose();
  });

  test("stops listening after dispose and respects resume: false", () => {
    const emitter = new EventEmitter();
    let resumed = false;
    let calls = 0;
    const fakeStdin: WatchableStdin = {
      once: (ev, fn) => emitter.once(ev, fn),
      off: (ev, fn) => emitter.off(ev, fn),
      resume: () => {
        resumed = true;
      },
    };

    const dispose = watchStdinClose(
      () => {
        calls += 1;
      },
      fakeStdin,
      { resume: false },
    );
    expect(resumed).toBe(false);

    dispose();
    emitter.emit("end");
    emitter.emit("close");
    expect(calls).toBe(0);
  });
});
