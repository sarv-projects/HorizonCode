/**
 * egress-proxy-token.test.ts — per-call MITM proxy tokens with exact revocation
 * (grok `revoke_exact` / codex per-call proxy credentials ADAPT). Pure, hermetic.
 */
import { describe, expect, test } from "bun:test";
import {
  ProxyTokenManager,
  TOKEN_BYTES,
} from "../../src/core/egress-proxy-token";

describe("egress proxy token manager (revoke_exact)", () => {
  test("issues a scoped token bound to an origin; it verifies", () => {
    const m = new ProxyTokenManager();
    const tok = m.issue("api.example.com", 443);
    expect(tok.token.length).toBeGreaterThanOrEqual(TOKEN_BYTES);
    expect(m.verify(tok.token, "api.example.com", 443)).toBe(true);
  });

  test("a token is origin-scoped: wrong host/port refuses", () => {
    const m = new ProxyTokenManager();
    const tok = m.issue("api.example.com", 443);
    expect(m.verify(tok.token, "other.example.com", 443)).toBe(false);
    expect(m.verify(tok.token, "api.example.com", 80)).toBe(false);
  });

  test("revoke_exact removes exactly one token; others survive", () => {
    const m = new ProxyTokenManager();
    const a = m.issue("a.example", 443);
    const b = m.issue("b.example", 443);
    expect(m.revokeExact(a.id)).toBe(true);
    expect(m.verify(a.token, "a.example", 443)).toBe(false);
    expect(m.verify(b.token, "b.example", 443)).toBe(true);
    expect(m.revokeExact(a.id)).toBe(false); // already revoked
  });

  test("expired tokens are refused", () => {
    let now = 1000;
    const m = new ProxyTokenManager({ now: () => now, ttlMs: 500 });
    const tok = m.issue("a.example", 443);
    now = 1400;
    expect(m.verify(tok.token, "a.example", 443)).toBe(true);
    now = 1501;
    expect(m.verify(tok.token, "a.example", 443)).toBe(false);
  });

  test("unknown tokens and empty origins are refused", () => {
    const m = new ProxyTokenManager();
    expect(m.verify("bogus", "a.example", 443)).toBe(false);
    expect(() => m.issue("", 443)).toThrow(/origin/i);
  });
});
