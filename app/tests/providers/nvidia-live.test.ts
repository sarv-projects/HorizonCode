/**
 * Optional live NVIDIA NIM check — skipped when `NVIDIA_API_KEY` is unset.
 * Proves API reachability (models list). Optional chat: `HZ_NVIDIA_CHAT_PROBE=1` uses `HZ_NVIDIA_CHAT_MODEL`
 * (default `minimaxai/minimax-m3.1-flash`), not `.env` `HZ_MODEL`.
 */
import { describe, expect, test } from "bun:test";
import { openAiChatCompletionsUrl } from "../../src/core/providers/openai";

const key = typeof process.env.NVIDIA_API_KEY === "string" ? process.env.NVIDIA_API_KEY.trim() : "";
const live = key !== "" ? describe : describe.skip;

live("NVIDIA NIM live (keyed)", () => {
  test("lists models (connection)", async () => {
    const base = process.env.HZ_BASE_URL?.replace(/\/+$/, "") ?? "https://integrate.api.nvidia.com";
    const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data?.length ?? 0) > 0).toBe(true);
  });

  test(
    "optional chat probe when HZ_NVIDIA_CHAT_PROBE=1",
    async () => {
      if (process.env.HZ_NVIDIA_CHAT_PROBE !== "1") return;
      /** Probe model is explicit so a stale `.env` `HZ_MODEL` does not force EOL ids. */
      const model = process.env.HZ_NVIDIA_CHAT_MODEL?.trim() || "minimaxai/minimax-m3.1-flash";
      const base = process.env.HZ_BASE_URL?.replace(/\/+$/, "") ?? "https://integrate.api.nvidia.com";
      const url = openAiChatCompletionsUrl(base.endsWith("/v1") ? base : `${base}/v1`);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120_000);
      try {
        const res = await fetch(url, {
          method: "POST",
          signal: ac.signal,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply with exactly: pong" }],
            max_tokens: 16,
          }),
        });
        const text = await res.text();
        expect(res.ok, `chat ${res.status}: ${text.slice(0, 240)}`).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    },
    130_000,
  );

  test("openAiChatCompletionsUrl accepts /v1 roots", () => {
    expect(openAiChatCompletionsUrl("https://integrate.api.nvidia.com/v1")).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions",
    );
    expect(openAiChatCompletionsUrl("https://integrate.api.nvidia.com")).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions",
    );
  });
});
