/**
 * Hermetic DAP session e2e over TCP (docs/33 §5.1, docs/30 §8 #16; ruling 182).
 * No real dlv/js-debug — in-process Content-Length fake adapter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DapClient } from "../../src/core/dap/client";
import { launchSession, stepSession } from "../../src/core/dap/session";
import { connectDapTcp } from "../../src/core/dap/transport";
import { startFakeDapTcpServer, type FakeDapTcpServer } from "../fixtures/fake-dap-tcp";

describe("dap tcp session e2e", () => {
  let fake: FakeDapTcpServer | undefined;

  afterEach(() => {
    fake?.stop();
    fake = undefined;
  });

  test("launch → stack → continue → close over TCP", async () => {
    fake = startFakeDapTcpServer();
    const pipe = await connectDapTcp({ host: fake.host, port: fake.port });
    const client = new DapClient({
      write: (frame) => pipe.write(frame),
      requestTimeoutMs: 5_000,
    });
    const pump = pipe.pump((chunk) => client.push(chunk));

    const launched = await launchSession(client, { program: "/app.js", stopTimeoutMs: 5_000 });
    expect(launched.stopped).toBe(true);
    expect(launched.frames[0]?.name).toBe("main");

    const frames = await client.stack();
    expect(frames[0]?.name).toBe("main");
    const locals = await client.locals(frames[0]!.id);
    expect(locals[0]?.value).toBe("42");

    const cont = await stepSession(client, "continue", { stopTimeoutMs: 5_000 });
    expect(cont.stopped).toBe(true);
    expect(cont.stopReason).toBe("breakpoint");

    await client.sendRequest("disconnect", { terminateDebuggee: false });

    pipe.close();
    await pump;
    fake.stop();
    fake = undefined;
  });
});
