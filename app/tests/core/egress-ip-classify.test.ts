/**
 * egress-ip-classify.test.ts — advisory non-public-IP classifier for the
 * forward dial path (codex is_non_public_ip / grok egress ADAPT). Pure, no IO.
 */
import { describe, expect, test } from "bun:test";
import {
  isNonPublicIp,
  parseIpLiteral,
  type IpClass,
} from "../../src/core/egress-ip-classify";

describe("advisory IP classifier", () => {
  test("public addresses are public", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
      expect(isNonPublicIp(ip)).toBe(false);
    }
  });

  test("loopback / private / link-local / metadata are non-public", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1",
      "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1",
    ]) {
      expect(isNonPublicIp(ip), ip).toBe(true);
    }
  });

  test("parseIpLiteral classifies v4/v6/invalid", () => {
    expect(parseIpLiteral("127.0.0.1")?.class).toBe("loopback");
    expect(parseIpLiteral("10.1.2.3")?.class).toBe("private");
    expect(parseIpLiteral("169.254.169.254")?.class).toBe("link_local");
    expect(parseIpLiteral("not-an-ip")).toBeUndefined();
  });

  test("unknown class is conservative (non-public) for fail-closed advisory use", () => {
    expect(isNonPublicIp("garbage")).toBe(true);
  });
});
