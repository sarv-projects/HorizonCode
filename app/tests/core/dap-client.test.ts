import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DapClient } from "../../src/core/dap/client";
import { attachSession, launchSession, stepSession } from "../../src/core/dap/session";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/fake-dap-server.ts");

describe("dap client", () => {
  let proc: ReturnType<typeof spawn> | undefined;

  afterEach(() => {
    proc?.kill();
    proc = undefined;
  });

  function connect(): DapClient {
    proc = spawn("bun", [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    if (!proc.stdin || !proc.stdout) throw new Error("no stdio");
    const client = new DapClient({
      write: (frame) => {
        proc?.stdin?.write(frame);
      },
      requestTimeoutMs: 5_000,
    });
    proc.stdout.on("data", (chunk: Buffer) => client.push(new Uint8Array(chunk)));
    return client;
  }

  test("reads stack and variables from fake adapter", async () => {
    const client = connect();
    await client.ready();
    const frames = await client.stack();
    expect(frames.length).toBe(1);
    expect(frames[0]?.name).toBe("main");
    const locals = await client.locals(frames[0]!.id);
    expect(locals).toEqual([{ name: "x", value: "42" }]);
  });

  test("initialize waits for initialized event (oh-my-pi sequencing)", async () => {
    const client = connect();
    const caps = await client.initialize();
    expect(caps.supportsConfigurationDoneRequest).toBe(true);
    await client.configurationDone();
  });

  test("setBreakpoints against fake adapter", async () => {
    const client = connect();
    await client.ready();
    await expect(client.setBreakpoints("/app.ts", [3, 7])).resolves.toBeUndefined();
  });
});

describe("dap session launch (oh-my-pi ordering)", () => {
  let proc: ReturnType<typeof spawn> | undefined;

  afterEach(() => {
    proc?.kill();
    proc = undefined;
  });

  test("launch waits for configurationDone then stopped", async () => {
    proc = spawn("bun", [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    if (!proc.stdin || !proc.stdout) throw new Error("no stdio");
    const client = new DapClient({
      write: (frame) => {
        proc?.stdin?.write(frame);
      },
      requestTimeoutMs: 5_000,
    });
    proc.stdout.on("data", (chunk: Buffer) => client.push(new Uint8Array(chunk)));

    const result = await launchSession(client, { program: "/app.js", args: ["--test"], stopTimeoutMs: 5_000 });
    expect(result.stopped).toBe(true);
    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("entry");
    expect(result.frames[0]?.name).toBe("main");
  });

  test("stepOver after launch waits for next stopped (oh-my-pi #step)", async () => {
    proc = spawn("bun", [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    if (!proc.stdin || !proc.stdout) throw new Error("no stdio");
    const client = new DapClient({
      write: (frame) => {
        proc?.stdin?.write(frame);
      },
      requestTimeoutMs: 5_000,
    });
    proc.stdout.on("data", (chunk: Buffer) => client.push(new Uint8Array(chunk)));

    await launchSession(client, { program: "/app.js", stopTimeoutMs: 5_000 });
    const stepped = await stepSession(client, "next");
    expect(stepped.stopped).toBe(true);
    expect(stepped.stopReason).toBe("step");
    expect(stepped.frames[0]?.name).toBe("main");
  });

  test("continue after launch waits for stopped", async () => {
    proc = spawn("bun", [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    if (!proc.stdin || !proc.stdout) throw new Error("no stdio");
    const client = new DapClient({
      write: (frame) => {
        proc?.stdin?.write(frame);
      },
      requestTimeoutMs: 5_000,
    });
    proc.stdout.on("data", (chunk: Buffer) => client.push(new Uint8Array(chunk)));

    await launchSession(client, { program: "/app.js", stopTimeoutMs: 5_000 });
    const cont = await stepSession(client, "continue");
    expect(cont.stopped).toBe(true);
    expect(cont.stopReason).toBe("breakpoint");
  });

  test("attach waits for configurationDone then stopped (oh-my-pi attach)", async () => {
    proc = spawn("bun", [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    if (!proc.stdin || !proc.stdout) throw new Error("no stdio");
    const client = new DapClient({
      write: (frame) => {
        proc?.stdin?.write(frame);
      },
      requestTimeoutMs: 5_000,
    });
    proc.stdout.on("data", (chunk: Buffer) => client.push(new Uint8Array(chunk)));

    const result = await attachSession(client, { pid: 4242, stopTimeoutMs: 5_000 });
    expect(result.stopped).toBe(true);
    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("entry");
    expect(result.target).toBe("attach:pid=4242");
    expect(result.frames[0]?.name).toBe("main");
  });
});
