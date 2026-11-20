import { describe, expect, test } from "bun:test";
import type { LiveSteering, LiveSteerClaim } from "../../src/contracts";
import {
  hermeticResponsesSteerWireSelfCheck,
  pumpResponsesSteering,
  ResponsesSteerWire,
  RESPONSES_WS_URL,
  type SteerSocket,
  type SteerSocketFactory,
} from "../../src/core/providers/responses-steer-wire";

class FakeSocket implements SteerSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  emit(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

async function opened(wire: ResponsesSteerWire, f: { socket: FakeSocket }): Promise<void> {
  const opening = wire.open();
  f.socket.open();
  await opening;
}

function factory(): { factory: SteerSocketFactory; socket: FakeSocket } {
  let socket!: FakeSocket;
  const factory: SteerSocketFactory = (url, headers) => {
    socket = new FakeSocket(url, headers);
    return socket;
  };
  return { factory, get socket() { return socket; } };
}

describe("Responses WebSocket response.steer wire (C-9)", () => {
  test("hermeticResponsesSteerWireSelfCheck passes offline (doctor)", () => {
    const check = hermeticResponsesSteerWireSelfCheck();
    expect(check.ok).toBe(true);
    expect(check.summary).toContain("hermetic wire protocol OK");
  });

  test("auth header + URL follow the documented protocol", async () => {
    const f = factory();
    const wire = new ResponsesSteerWire({ apiKey: "sk-test", responseId: "resp_1", socketFactory: f.factory });
    await opened(wire, f);
    expect(f.socket.url).toBe(RESPONSES_WS_URL);
    expect(f.socket.headers.Authorization).toBe("Bearer sk-test");
    wire.close();
  });

  test("sends only type/previous_response_id/input and resolves on accepted", async () => {
    const f = factory();
    const wire = new ResponsesSteerWire({ apiKey: "sk-test", responseId: "resp_1", socketFactory: f.factory });
    await opened(wire, f);
    const result = wire.steer("keep scope small");
    expect(JSON.parse(f.socket.sent[0]!)).toEqual({
      type: "response.steer",
      previous_response_id: "resp_1",
      input: "keep scope small",
    });
    f.socket.emit({ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } });
    expect(await result).toEqual({ accepted: true, steerId: "steer_1", pending: false, requiredInput: undefined });
    wire.close();
  });

  test("response.created updates the target response id", async () => {
    const f = factory();
    const wire = new ResponsesSteerWire({ apiKey: "sk-test", socketFactory: f.factory });
    await opened(wire, f);
    f.socket.emit({ type: "response.created", response: { id: "resp_42" } });
    expect(wire.responseId).toBe("resp_42");
    const result = wire.steer(["second instruction"]);
    expect(JSON.parse(f.socket.sent[0]!)).toEqual({
      type: "response.steer",
      previous_response_id: "resp_42",
      input: ["second instruction"],
    });
    f.socket.emit({ type: "response.steer.pending", steer: { id: "steer_2" }, required_input: [{ type: "function_call_output" }] });
    expect(await result).toMatchObject({ accepted: true, pending: true, steerId: "steer_2" });
    wire.close();
  });

  test("failed steer and timeout fail closed (caller rejects the claim)", async () => {
    const f = factory();
    const wire = new ResponsesSteerWire({
      apiKey: "sk-test",
      responseId: "resp_1",
      socketFactory: f.factory,
      ackTimeoutMs: 25,
    });
    await opened(wire, f);
    const failed = wire.steer("bad");
    f.socket.emit({ type: "response.steer.failed", steer: { id: "s" }, error: { code: "invalid_input", message: "bad input" } });
    expect(await failed).toMatchObject({ accepted: false, errorCode: "invalid_input" });

    const timedOut = await wire.steer("no ack");
    expect(timedOut.accepted).toBe(false);
    expect(timedOut.error).toContain("timed out");
    wire.close();
  });

  test("closes and unknown ids never reach the wire", async () => {
    const f = factory();
    const wire = new ResponsesSteerWire({ apiKey: "sk-test", responseId: "resp_1", socketFactory: f.factory });
    await opened(wire, f);
    expect((await wire.steer("")).accepted).toBe(false);
    expect(f.socket.sent).toHaveLength(0);
    wire.close();
    expect((await wire.steer("late")).accepted).toBe(false);
    const noId = new ResponsesSteerWire({ apiKey: "sk-test", socketFactory: f.factory });
    expect((await noId.steer("x")).accepted).toBe(false);
  });

  test("pump bridges claim/accept/reject ordering to the wire", async () => {
    const f = factory();
    const wire = new ResponsesSteerWire({ apiKey: "sk-test", responseId: "resp_1", socketFactory: f.factory });
    await opened(wire, f);
    const outcomes: string[] = [];
    const controller = new AbortController();
    let claimed = false;
    const steering: LiveSteering = {
      async wait(signal) {
        if (signal.aborted) return;
        // Yield a macrotask so timers (and the test's abort) can run.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
      async claim() {
        if (claimed) return undefined;
        claimed = true;
        return {
          messages: ["first"],
          accept: () => { outcomes.push("accepted"); },
          reject: () => { outcomes.push("rejected"); },
        } satisfies LiveSteerClaim;
      },
    };
    const pump = pumpResponsesSteering(steering, wire, controller.signal);
    await Bun.sleep(10);
    f.socket.emit({ type: "response.steer.accepted", steer: { id: "steer_ok" } });
    await Bun.sleep(10);
    controller.abort();
    await pump;
    expect(outcomes).toEqual(["accepted"]);
    expect(outcomes).not.toContain("rejected");
    wire.close();
  });
});
