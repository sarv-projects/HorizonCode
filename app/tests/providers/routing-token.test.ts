/**
 * routing-token.test.ts -- data-driven sticky routing token (plan Task 1).
 * The token identifies an endpoint configuration, never a security boundary.
 */
import { describe, expect, test } from "bun:test";
import { routingToken, sameRoutingRoute } from "../../src/core/providers/routing-token";

describe("sticky routing token", () => {
  test("stable for identical config, changes with any routing-relevant field", () => {
    const a = { provider: "openai", baseUrl: "https://api.example/v1", accountLabel: "work" };
    expect(routingToken(a)).toBe(routingToken({ ...a }));
    expect(routingToken(a)).not.toBe(routingToken({ ...a, baseUrl: "https://other.example/v1" }));
    expect(routingToken(a)).not.toBe(routingToken({ ...a, accountLabel: "personal" }));
    expect(routingToken(a)).not.toBe(routingToken({ ...a, provider: "anthropic" }));
  });

  test("normalizes trailing slash, query, fragment and case; ignores model", () => {
    const a = { provider: "openai", baseUrl: "https://API.Example/v1/", accountLabel: "" };
    expect(routingToken(a)).toBe(routingToken({ ...a, baseUrl: "https://api.example/v1?x=1#frag" }));
    expect(sameRoutingRoute(a, { ...a, model: "gpt-x" } as never)).toBe(true);
  });

  test("never includes credential-like fields", () => {
    const a = { provider: "openai", baseUrl: "https://api.example/v1" };
    expect(routingToken(a)).toBe(
      routingToken({ ...a, apiKey: "sk-secret" } as never),
    );
  });
});
