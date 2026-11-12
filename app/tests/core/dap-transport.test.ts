/** DAP TCP listen parsing + connect (docs/33 §5.1). */

import { afterAll, describe, expect, test } from "bun:test";
import {
  connectDapTcp,
  findDapListenEndpoint,
  parseDapListenLine,
  waitForDapListenEndpoint,
} from "../../src/core/dap/transport";

describe("parseDapListenLine", () => {
  test("parses dlv / js-debug / codelldb announcements", () => {
    expect(parseDapListenLine("DAP server listening at: 127.0.0.1:54321")).toEqual({
      host: "127.0.0.1",
      port: 54321,
    });
    expect(parseDapListenLine("API server listening at: 127.0.0.1:2345")).toEqual({
      host: "127.0.0.1",
      port: 2345,
    });
    expect(parseDapListenLine("listening on 0.0.0.0:9999")).toEqual({ host: "127.0.0.1", port: 9999 });
    expect(parseDapListenLine("nope")).toBeNull();
  });

  test("findDapListenEndpoint scans multiline buffers", () => {
    const buf = "boot...\nDAP server listening at: 127.0.0.1:4242\nmore\n";
    expect(findDapListenEndpoint(buf)).toEqual({ host: "127.0.0.1", port: 4242 });
  });
});

describe("connectDapTcp", () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
      open() {},
      close() {},
      error() {},
    },
  });
  const port = server.port;

  afterAll(() => {
    server.stop(true);
  });

  test("round-trips bytes over TCP", async () => {
    const pipe = await connectDapTcp({ host: "127.0.0.1", port });
    const got: Uint8Array[] = [];
    const pump = pipe.pump((chunk) => got.push(chunk));
    pipe.write(new TextEncoder().encode("ping"));
    await Bun.sleep(50);
    pipe.close();
    await pump;
    const text = new TextDecoder().decode(
      got.reduce((acc, c) => {
        const next = new Uint8Array(acc.length + c.length);
        next.set(acc);
        next.set(c, acc.length);
        return next;
      }, new Uint8Array()),
    );
    expect(text).toContain("ping");
  });

  test("waitForDapListenEndpoint reads from a chunk stream", async () => {
    const chunks = [
      new TextEncoder().encode("starting\n"),
      new TextEncoder().encode(`DAP server listening at: 127.0.0.1:${port}\n`),
    ];
    const endpoint = await waitForDapListenEndpoint(async () => chunks.shift() ?? null, 2_000);
    expect(endpoint).toEqual({ host: "127.0.0.1", port });
  });
});
