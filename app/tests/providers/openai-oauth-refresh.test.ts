import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeOAuthToken } from "../../src/core/auth/store";
import { createOpenAiCompatibleProvider } from "../../src/core/providers/openai-compatible";
import { sseFrame, sseResponse, startServer } from "./helpers";

describe("openai-compatible oauth refresh on 401", () => {
  test("retries once after refresh", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-401-"));
    let chatCalls = 0;
    // Use the local canned server instead of stubbing globalThis.fetch: a
    // failed assertion in one test file must never leak a fetch stub into the
    // other provider tests when Bun runs multiple files in one process.
    const server = startServer((req) => {
      if (req.path === "/token") {
        return new Response(JSON.stringify({ access_token: "fresh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        expect(req.headers.authorization).toBe("Bearer stale");
        return new Response("unauthorized", { status: 401 });
      }
      expect(req.headers.authorization).toBe("Bearer fresh");
      const body = sseFrame({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
      return sseResponse(body);
    });
    try {
      await writeOAuthToken(
        {
          provider: "oauthhost",
          accessToken: "stale",
          refreshToken: "rtok",
          obtainedAt: new Date().toISOString(),
        },
        home,
      );
      const provider = createOpenAiCompatibleProvider({
        name: "oauthhost",
        baseUrl: server.baseUrl,
        credential: { kind: "oauth", accessToken: "stale", refreshToken: "rtok" },
        oauth: {
          clientId: "cid",
          authorizeUrl: `${server.baseUrl}/authorize`,
          tokenUrl: `${server.baseUrl}/token`,
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
    } finally {
      server.stop();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Windows may keep the credential file handle briefly; temp cleanup
        // is not a product assertion.
      }
    }
  });
});
