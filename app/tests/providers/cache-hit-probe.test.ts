import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compareCacheProbeSamples,
  parseCacheProbeUsage,
  probeCacheHit,
  type CacheProbeSample,
} from "../../src/core/providers/cache-hit-probe";

function fakeFetch(samples: CacheProbeSample[]): typeof fetch {
  let i = 0;
  return (async () => {
    const usage = samples[i++] ?? samples[samples.length - 1];
    return new Response(
      JSON.stringify({
        usage: {
          prompt_tokens: usage!.inputTokens,
          completion_tokens: usage!.outputTokens,
          prompt_tokens_details: { cached_tokens: usage!.cachedTokens },
          completion_tokens_details: { reasoning_tokens: usage!.completionReasoningTokens ?? 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("cache-hit probe parse/compare (hermetic)", () => {
  test("parseCacheProbeUsage reads prompt_tokens_details.cached_tokens", () => {
    const s = parseCacheProbeUsage({
      prompt_tokens: 50,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(s.cachedTokens).toBe(40);
    expect(s.inputTokens).toBe(50);
  });

  test("parseCacheProbeUsage falls back across dialect fields", () => {
    expect(parseCacheProbeUsage({ prompt_cache_hit_tokens: 7 }).cachedTokens).toBe(7);
    expect(parseCacheProbeUsage({ cached_tokens: 3 }).cachedTokens).toBe(3);
    expect(parseCacheProbeUsage({ cache_read_input_tokens: 11 }).cachedTokens).toBe(11);
  });

  test("compareCacheProbeSamples refuses claim when both sends report zero cached", () => {
    const z = { inputTokens: 1, cachedTokens: 0, outputTokens: 1 };
    const c = compareCacheProbeSamples(z, z);
    expect(c.cacheHitObserved).toBe(false);
    expect(c.note).toContain("do not claim");
  });

  test("compareCacheProbeSamples documents warmed-first-send without claiming rising hit", () => {
    const warm = { inputTokens: 1, cachedTokens: 64, outputTokens: 1 };
    const c = compareCacheProbeSamples(warm, warm);
    expect(c.cacheHitObserved).toBe(false);
    expect(c.note).toContain("warmed the prefix");
  });
});

describe("cache-hit probe (B-4 live measurement seam)", () => {
  test("observes a rising cached-token count on an identical prefix", async () => {
    const result = await probeCacheHit({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "m",
      system: "stable prefix",
      fetch: fakeFetch([
        { inputTokens: 100, cachedTokens: 0, outputTokens: 1 },
        { inputTokens: 100, cachedTokens: 64, outputTokens: 1 },
      ]),
    });
    expect(result.cacheHitObserved).toBe(true);
    expect(result.note).toContain("0 -> 64");
  });

  test("does not claim a hit when no provider cache data exists", async () => {
    const result = await probeCacheHit({
      baseUrl: "https://example.invalid",
      apiKey: "k",
      model: "m",
      system: "prefix",
      fetch: fakeFetch([
        { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
        { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
      ]),
    });
    expect(result.cacheHitObserved).toBe(false);
    expect(result.note).toContain("do not claim");
  });

  test("HTTP failure fails closed", async () => {
    let threw = false;
    try {
      await probeCacheHit({
        baseUrl: "https://example.invalid",
        apiKey: "k",
        model: "m",
        system: "p",
        fetch: (async () => new Response("no", { status: 401 })) as typeof fetch,
      });
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("401");
    }
    expect(threw).toBe(true);
  });
});

describe.skipIf(process.env.HZ_LIVE_CACHE !== "1")("cache-hit probe: live NVIDIA NIM", () => {
  test("real provider reports cached tokens for a repeated prefix", async () => {
    const fromEnv = process.env.NVIDIA_API_KEY;
    let key = fromEnv;
    if (!key) {
      try {
        const envFile = readFileSync(join(homedir(), ".config", "horizon", "env"), "utf8");
        key = envFile.split("\n").find((l) => l.startsWith("NVIDIA_API_KEY="))?.slice("NVIDIA_API_KEY=".length);
      } catch {
        /* no env file */
      }
    }
    expect(key ?? "").not.toBe("");
    const result = await probeCacheHit({
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: key!,
      model: "minimaxai/minimax-m3.1-flash",
      system: "You are a cache probe. Reply with exactly OK. Keep this prefix byte-stable.",
    });
    expect(result.first.inputTokens).toBeGreaterThan(0);
    // NVIDIA's OpenAI-compatible endpoint reports cached tokens from the first
    // send; accept either evidence shape but require real reported cache data.
    expect(result.first.cachedTokens > 0 || result.second.cachedTokens > 0 || result.cacheHitObserved).toBe(true);
  }, 60_000);
});
