import { afterEach, describe, expect, test } from "bun:test";
import {
  parseAnthropicCacheKeepaliveMs,
  startAnthropicCacheKeepalive,
  type KeepaliveIntervalHandle,
  type KeepaliveScheduler,
} from "../../src/core/providers/anthropic-cache-keepalive";

describe("anthropic cache keep-alive", () => {
  const prev = process.env.HZ_ANTHROPIC_CACHE_KEEPALIVE_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.HZ_ANTHROPIC_CACHE_KEEPALIVE_MS;
    else process.env.HZ_ANTHROPIC_CACHE_KEEPALIVE_MS = prev;
  });

  test("disabled unless HZ_ANTHROPIC_CACHE_KEEPALIVE_MS is at least 60s", () => {
    expect(parseAnthropicCacheKeepaliveMs({})).toBeUndefined();
    expect(parseAnthropicCacheKeepaliveMs({ HZ_ANTHROPIC_CACHE_KEEPALIVE_MS: "1000" })).toBeUndefined();
    expect(parseAnthropicCacheKeepaliveMs({ HZ_ANTHROPIC_CACHE_KEEPALIVE_MS: "300000" })).toBe(300_000);
  });

  test("start returns stop without scheduling when disabled", () => {
    const stop = startAnthropicCacheKeepalive({ intervalMs: undefined });
    expect(typeof stop).toBe("function");
    stop();
  });

  test("onMeasure appends local prefix line", () => {
    const notices: string[] = [];
    const scheduler: KeepaliveScheduler = {
      setInterval: (fn) => {
        fn();
        return {};
      },
      clearInterval: () => undefined,
    };
    const stop = startAnthropicCacheKeepalive({
      intervalMs: 60_000,
      onNotice: (m) => notices.push(m),
      onMeasure: () => "cacheable prefix: 2/2 messages",
      scheduler,
    });
    stop();
    expect(notices[0]).toContain("cacheable prefix");
  });

  test("injected scheduler fires no-op notice on interval", () => {
    const notices: string[] = [];
    const pending: Array<{ fn: () => void; ms: number; handle: KeepaliveIntervalHandle }> = [];
    const scheduler: KeepaliveScheduler = {
      setInterval: (fn, ms) => {
        const handle: KeepaliveIntervalHandle = {};
        pending.push({ fn, ms, handle });
        return handle;
      },
      clearInterval: (handle) => {
        const idx = pending.findIndex((p) => p.handle === handle);
        if (idx >= 0) pending.splice(idx, 1);
      },
    };

    const stop = startAnthropicCacheKeepalive({
      intervalMs: 120_000,
      onNotice: (m) => notices.push(m),
      scheduler,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ms).toBe(120_000);
    pending[0]!.fn();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("no-op ping");
    stop();
    expect(pending).toHaveLength(0);
    pending[0]?.fn();
    expect(notices).toHaveLength(1);
  });
});
