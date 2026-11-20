import { afterEach, describe, expect, test } from "bun:test";
import type { LiveSteering, LiveSteerClaim, Provider, ProviderEvent, ProviderRequest } from "../../src/contracts";
import {
  modelSupportsResponsesSteer,
  productResponsesSteerEnabled,
  wrapProviderWithResponsesSteer,
} from "../../src/core/providers/responses-steer-product";
import type { SteerSocket, SteerSocketFactory } from "../../src/core/providers/responses-steer-wire";

const prev = process.env.HZ_RESPONSES_STEER;
afterEach(() => {
  if (prev === undefined) delete process.env.HZ_RESPONSES_STEER;
  else process.env.HZ_RESPONSES_STEER = prev;
});

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
}

function socketFactory(): { factory: SteerSocketFactory; get socket(): FakeSocket } {
  let socket!: FakeSocket;
  const factory: SteerSocketFactory = (url, headers) => {
    socket = new FakeSocket(url, headers);
    queueMicrotask(() => socket.open());
    return socket;
  };
  return { factory, get socket() { return socket; } };
}

function stubProvider(): Provider {
  return {
    name: "openai",
    async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      yield { type: "text", text: "hi" };
      yield { type: "done", stopReason: "end" };
    },
  };
}

class ManualSteering implements LiveSteering {
  #claims: LiveSteerClaim[] = [];
  #waiters: Array<() => void> = [];
  push(text: string): LiveSteerClaim {
    let settled = false;
    const claim: LiveSteerClaim = {
      messages: [text],
      accept: () => {
        settled = true;
      },
      reject: () => {
        settled = true;
      },
    };
    Object.defineProperty(claim, "settled", { get: () => settled });
    this.#claims.push(claim);
    for (const w of this.#waiters.splice(0)) w();
    return claim;
  }
  async wait(signal: AbortSignal): Promise<void> {
    if (this.#claims.length > 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(new Error("aborted"));
      };
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(() => {
        cleanup();
        resolve();
      });
    });
  }
  async claim(signal: AbortSignal): Promise<LiveSteerClaim | undefined> {
    if (signal.aborted) return undefined;
    return this.#claims.shift();
  }
}

describe("product Responses steer opt-in (C-9)", () => {
  test("HZ_RESPONSES_STEER flag parsing", () => {
    expect(productResponsesSteerEnabled({ HZ_RESPONSES_STEER: "1" })).toBe(true);
    expect(productResponsesSteerEnabled({ HZ_RESPONSES_STEER: "true" })).toBe(true);
    expect(productResponsesSteerEnabled({})).toBe(false);
    expect(modelSupportsResponsesSteer("gpt-6-astra")).toBe(true);
    expect(modelSupportsResponsesSteer("gpt-4o")).toBe(false);
  });

  test("wrap sets liveSteering and opens WS when opt-in + GPT-6 + liveSteering request", async () => {
    const socks = socketFactory();
    const wrapped = wrapProviderWithResponsesSteer(stubProvider(), {
      apiKey: "sk-test",
      socketFactory: socks.factory,
      env: { HZ_RESPONSES_STEER: "1" },
    });
    expect(wrapped.liveSteering).toBe(true);

    const steering = new ManualSteering();
    const ac = new AbortController();
    const events: ProviderEvent[] = [];
    const stream = wrapped.stream({
      model: "gpt-6-astra",
      system: "s",
      messages: [],
      tools: [],
      signal: ac.signal,
      liveSteering: steering,
    });
    for await (const ev of stream) events.push(ev);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(socks.socket.headers.Authorization).toBe("Bearer sk-test");
  });

  test("wrap is a no-op when flag unset", () => {
    const inner = stubProvider();
    const wrapped = wrapProviderWithResponsesSteer(inner, {
      apiKey: "sk-test",
      env: {},
    });
    expect(wrapped).toBe(inner);
    expect(wrapped.liveSteering).toBeUndefined();
  });
});
