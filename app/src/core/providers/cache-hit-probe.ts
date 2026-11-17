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

function sample(usage: unknown): CacheProbeSample {
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
  return sample(body.usage);
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
  const cacheHitObserved = second.cachedTokens > first.cachedTokens;
  const note = cacheHitObserved
    ? `cached tokens rose ${first.cachedTokens} -> ${second.cachedTokens} on the identical prefix`
    : first.cachedTokens > 0
      ? `first send already reported ${first.cachedTokens} cached tokens; provider warmed the prefix before the second send`
      : "no cached tokens reported on either send — do not claim a cache hit";
  return { first, second, cacheHitObserved, note };
}
