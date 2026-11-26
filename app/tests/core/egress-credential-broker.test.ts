/**
 * egress-credential-broker.test.ts — MITM credential broker + body secret
 * substitution (codex/grok "must steal"). Credentials injected at the broker,
 * never written into a sandboxed child's env; substituted into the forwarded
 * body, with secrets redacted from any logged form.
 */
import { describe, expect, test } from "bun:test";
import {
  CredentialBroker,
  redactSecrets,
  substituteSecrets,
  type BrokerCredential,
} from "../../src/core/egress-credential-broker";

const CRED: BrokerCredential = {
  id: "openai-main",
  // The secret value is held only in the broker, never in a child env.
  header: "authorization",
  value: "sk-super-secret-123",
};

describe("egress credential broker (must-steal port)", () => {
  test("substitutes a secret placeholder into a body, once, without mutating input", () => {
    const body = '{"key":"${SECRET:openai-main}"}';
    const out = substituteSecrets(body, [CRED]);
    expect(out).toBe('{"key":"sk-super-secret-123"}');
    expect(body).toBe('{"key":"${SECRET:openai-main}"}'); // unchanged
  });

  test("an unknown secret id is refused, not silently dropped", () => {
    expect(() => substituteSecrets("${SECRET:unknown}", [CRED])).toThrow(/unknown secret/i);
  });

  test("redactSecrets removes every known secret from a log string", () => {
    const log = "req with sk-super-secret-123 and again sk-super-secret-123";
    expect(redactSecrets(log, [CRED])).not.toContain("sk-super-secret-123");
    expect(redactSecrets(log, [CRED])).toContain("[REDACTED]");
  });

  test("broker issues a scoped header and enumerates NO secret in child-env form", () => {
    const broker = new CredentialBroker([CRED]);
    expect(broker.headerFor("openai-main")).toEqual({ name: "authorization", value: "sk-super-secret-123" });
    expect(broker.childEnv()).toEqual({}); // no credential ever exported to child env
    expect(() => broker.headerFor("missing")).toThrow(/unknown secret/i);
  });

  test("an empty/blank secret value is refused", () => {
    expect(() => new CredentialBroker([{ ...CRED, value: "  " }])).toThrow(/empty|blank/i);
  });
});
