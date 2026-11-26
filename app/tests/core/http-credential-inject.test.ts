/**
 * http-credential-inject.test.ts — MITM broker HTTP-level credential injection
 * into the DECRYPTED request (codex/grok "must steal" MITM piece). Pure: inject
 * scoped credential headers into an HTTP/1.1 request's header block, leaving
 * the body byte-identical. Never logs the secret.
 */
import { describe, expect, test } from "bun:test";
import {
  injectCredentialHeaders,
  type CredentialHeaderRule,
} from "../../src/core/http-credential-inject";
import { CredentialBroker } from "../../src/core/egress-credential-broker";

const broker = new CredentialBroker([
  { id: "api-key", header: "authorization", value: "Bearer sk-secret-999" },
  { id: "other", header: "x-api-key", value: "other-secret" },
]);

const RULES: CredentialHeaderRule[] = [
  { host: "api.example.com", header: "authorization", secretId: "api-key" },
];

function request(host: string, extra = ""): string {
  return `GET /v1/path HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: test\r\n${extra}\r\n{"body":"kept"}`;
}

describe("HTTP credential injection into decrypted request", () => {
  test("injects a scoped credential header before the blank line; body byte-identical", () => {
    const out = injectCredentialHeaders(request("api.example.com"), "api.example.com", broker, RULES);
    expect(out).toContain("authorization: Bearer sk-secret-999");
    expect(out).toContain('{"body":"kept"}');
    expect(out.indexOf("authorization:")).toBeLessThan(out.indexOf("\r\n\r\n"));
  });

  test("does NOT inject for a non-matching host", () => {
    const out = injectCredentialHeaders(request("other.example.com"), "other.example.com", broker, RULES);
    expect(out).not.toContain("sk-secret-999");
  });

  test("does not duplicate an existing header of the same name", () => {
    const out = injectCredentialHeaders(
      request("api.example.com", "Authorization: Bearer existing\r\n"),
      "api.example.com", broker, RULES,
    );
    expect(out.match(/authorization:/gi)).toHaveLength(1);
    expect(out).toContain("Bearer existing");
  });

  test("unknown secret id is a typed refusal (fail closed)", () => {
    expect(() => injectCredentialHeaders(
      request("api.example.com"), "api.example.com", broker,
      [{ host: "api.example.com", header: "authorization", secretId: "missing" }],
    )).toThrow(/unknown secret/i);
  });

  test("a request with no header terminator is refused", () => {
    expect(() => injectCredentialHeaders("GET / HTTP/1.1\r\nHost: x", "x", broker, RULES))
      .toThrow(/terminator|malformed/i);
  });

  test("host match is case-insensitive", () => {
    const out = injectCredentialHeaders(request("API.EXAMPLE.COM"), "API.EXAMPLE.COM", broker, RULES);
    expect(out).toContain("Bearer sk-secret-999");
  });
});
