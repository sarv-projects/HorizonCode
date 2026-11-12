import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeOAuthToken } from "../../src/core/auth/store";
import { createOpenAiCompatibleProvider } from "../../src/core/providers/openai-compatible";
import { sseFrame, sseResponse } from "./helpers";

describe("openai-compatible oauth refresh on 401", () => {
  test("retries once after refresh", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-401-"));
    try {
      writeOAuthToken(
        {
          provider: "oauthhost",
          accessToken: "stale",
          refreshToken: "rtok",
          obtainedAt: new Date().toISOString(),
        },
        home,
      );
      let chatCalls = 0;
      const original = globalThis.fetch;
      globalThis.fetch = (async (url, init) => {
        const u = String(url);
        if (u.endsWith("/token")) {
          return new Response(JSON.stringify({ access_token: "fresh" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        chatCalls += 1;
        if (chatCalls === 1) {
          expect(init?.headers && (init.headers as Record<string, string>).authorization).toBe("Bearer stale");
          return new Response("unauthorized", { status: 401 });
        }
        expect(init?.headers && (init.headers as Record<string, string>).authorization).toBe("Bearer fresh");
        const body = sseFrame({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
        return sseResponse(body);
      }) as typeof fetch;

      const provider = createOpenAiCompatibleProvider({
        name: "oauthhost",
        baseUrl: "https://api.example",
        credential: { kind: "oauth", accessToken: "stale", refreshToken: "rtok" },
        oauth: {
          clientId: "cid",
          authorizeUrl: "https://api.example/authorize",
          tokenUrl: "https://api.example/token",
        },
        home,
      });

      const events: string[] = [];
      const ac = new AbortController();
      for await (const e of provider.stream({
        model: "m1",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: ac.signal,
      })) {
        if (e.type === "text") events.push(e.text);
        if (e.type === "error") events.push(`err:${e.message}`);
      }
      expect(chatCalls).toBe(2);
      expect(events.join("")).toContain("ok");
      globalThis.fetch = original;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
