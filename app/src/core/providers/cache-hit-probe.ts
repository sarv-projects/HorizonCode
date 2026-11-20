/**
 * cache-hit-probe.ts — live cache-hit measurement for OpenAI-compatible hosts.
 *
 * The harness's local prefix estimate (`anthropic-cache-measure.ts`) only counts
 * bytes; it cannot prove a provider actually served the prefix from cache. This
 * module performs the minimum real check: send the SAME stable prefix twice to a
 * provider that reports `prompt_tokens_details.cached_tokens` and compare the
 * reported cache hits. Fail closed on ambiguity — never present a local byte
 * count as a measured hit.
 *
 * No dependency: `fetch` is injectable and the hermetic tests use a fake.
 * The live test is opt-in (`HZ_LIVE_CACHE=1`) and reads credentials from the
 * user env file, never from a committed fixture.
 */

export interface CacheProbeRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** The stable prefix that must be byte-identical across both sends. */
  system: string;
  userText?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface CacheProbeSample {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  completionReasoningTokens?: number;
}

export interface CacheProbeResult {
  first: CacheProbeSample;
  second: CacheProbeSample;
  /** True when the second send reported a strictly larger cached-token count. */
  cacheHitObserved: boolean;
  /** Diagnostic, never a success claim when false. */
  note: string;
}

function chatCompletionsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return root.endsWith("/v1") ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
}

/** Parse provider `usage` blobs across OpenAI-compatible cache-token dialects (hermetic / doctor). */
export function parseCacheProbeUsage(usage: unknown): CacheProbeSample {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.prompt_tokens),
    cachedTokens:
      num(details.cached_tokens) || num(u.prompt_cache_hit_tokens) || num(u.cached_tokens) || num(u.cache_read_input_tokens),
    outputTokens: num(u.completion_tokens),
    completionReasoningTokens: num(completionDetails.reasoning_tokens) || undefined,
  };
}

async function send(req: CacheProbeRequest, doFetch: typeof fetch): Promise<CacheProbeSample> {
  const response = await doFetch(chatCompletionsUrl(req.baseUrl), {
    method: "POST",
    signal: req.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 16,
      stream: false,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.userText ?? "ping" },
      ],
    }),
  });
  if (!response.ok) throw new Error(`cache probe HTTP ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { usage?: unknown };
  return parseCacheProbeUsage(body.usage);
}

/** Compare two provider samples — never claims a hit unless cached tokens strictly rise. */
export function compareCacheProbeSamples(
  first: CacheProbeSample,
  second: CacheProbeSample,
): Pick<CacheProbeResult, "cacheHitObserved" | "note"> {
  const cacheHitObserved = second.cachedTokens > first.cachedTokens;
  const note = cacheHitObserved
    ? `cached tokens rose ${first.cachedTokens} -> ${second.cachedTokens} on the identical prefix`
    : first.cachedTokens > 0
      ? `first send already reported ${first.cachedTokens} cached tokens; provider warmed the prefix before the second send`
      : "no cached tokens reported on either send — do not claim a cache hit";
  return { cacheHitObserved, note };
}

export interface HermeticCacheHitProbeSelfCheck {
  ok: boolean;
  /** Short human summary for doctor / CLI. */
  summary: string;
  cases: number;
  failures: string[];
}

/** Offline parse/compare sanity — no network, no API keys. */
export function hermeticCacheHitProbeSelfCheck(): HermeticCacheHitProbeSelfCheck {
  const failures: string[] = [];
  const tryCase = (name: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  tryCase("openai prompt_tokens_details", () => {
    const s = parseCacheProbeUsage({
      prompt_tokens: 12,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 8 },
    });
    if (s.cachedTokens !== 8) throw new Error(`expected 8, got ${s.cachedTokens}`);
  });
  tryCase("deepseek prompt_cache_hit_tokens", () => {
    const s = parseCacheProbeUsage({ prompt_cache_hit_tokens: 16, prompt_tokens: 20, completion_tokens: 2 });
    if (s.cachedTokens !== 16) throw new Error(`expected 16, got ${s.cachedTokens}`);
  });
  tryCase("compare rising hit", () => {
    const c = compareCacheProbeSamples(
      { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      { inputTokens: 1, cachedTokens: 9, outputTokens: 1 },
    );
    if (!c.cacheHitObserved) throw new Error("expected hit");
  });
  tryCase("compare zero — fail closed", () => {
    const c = compareCacheProbeSamples(
      { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
      { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
    );
    if (c.cacheHitObserved) throw new Error("must not claim hit");
    if (!c.note.includes("do not claim")) throw new Error("note must refuse claim");
  });
  tryCase("compare warmed-first-send", () => {
    const c = compareCacheProbeSamples(
      { inputTokens: 1, cachedTokens: 32, outputTokens: 1 },
      { inputTokens: 1, cachedTokens: 32, outputTokens: 1 },
    );
    if (c.cacheHitObserved) throw new Error("must not treat warmed first send as rising hit");
  });

  const cases = 5;
  const ok = failures.length === 0;
  return {
    ok,
    cases,
    failures,
    summary: ok
      ? `hermetic parse/compare OK (${cases} cases)`
      : `hermetic self-check failed: ${failures.join("; ")}`,
  };
}

export function liveCacheProbeRequested(env: Record<string, string | undefined>): boolean {
  const v = env.HZ_LIVE_CACHE;
  if (typeof v !== "string") return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "on";
}

/**
 * Send the same prefix twice and report whether the second send observed a
 * cache hit. Some providers cache from the first send (both samples already
 * show cached tokens); in that case `first.cachedTokens > 0` is the evidence
 * and `cacheHitObserved` stays false — the caller reads `note` to see why.
 */
export async function probeCacheHit(req: CacheProbeRequest): Promise<CacheProbeResult> {
  const doFetch = req.fetch ?? fetch;
  const first = await send(req, doFetch);
  const second = await send(req, doFetch);
  const { cacheHitObserved, note } = compareCacheProbeSamples(first, second);
  return { first, second, cacheHitObserved, note };
}
