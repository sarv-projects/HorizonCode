/**
 * egress-dial-pin.test.ts -- advisory dial-time DNS rebind re-check
 * (plan Task 12). No live DNS; no egress decision widened.
 */
import { describe, expect, test } from "bun:test";
import {
  EgressRebindRefused,
  assertDialAddressStillPinned,
  pinExpired,
  resolveAndPin,
} from "../../src/core/egress-dial-pin";

const deps = (answers: readonly string[], now = 1000) => ({
  resolve: async () => answers,
  now: () => now,
});

describe("dial-time DNS pin", () => {
  test("rebind to another address is refused before dial; expired pin refreshes", async () => {
    const answers = ["1.2.3.4"];
    const pin = await resolveAndPin("example.com", 443, deps(answers));
    expect(() => assertDialAddressStillPinned(pin, "1.2.3.4")).not.toThrow();
    expect(() => assertDialAddressStillPinned(pin, "5.6.7.8")).toThrow(EgressRebindRefused);
    expect(pinExpired(pin, 31_001)).toBe(true);
    expect(pinExpired(pin, 30_000)).toBe(false);
  });

  test("resolver returning nothing or a non-IP literal fails closed", async () => {
    await expect(resolveAndPin("example.com", 443, deps([]))).rejects.toThrow(/no addresses/i);
    await expect(resolveAndPin("example.com", 443, deps(["not-an-ip"]))).rejects.toThrow(/ip/i);
  });

  test("refuseNonPublic rejects a resolved loopback/private address (advisory SSRF guard)", async () => {
    await expect(resolveAndPin("x.example", 443, {
      resolve: async () => ["169.254.169.254"],
      now: () => 0,
      refuseNonPublic: true,
    })).rejects.toThrow(/non-public/i);
    // opt-in: default still allows it
    await expect(resolveAndPin("x.example", 443, {
      resolve: async () => ["169.254.169.254"],
      now: () => 0,
    })).resolves.toBeDefined();
  });

  test("IPv6 answers are accepted and names in the error", async () => {
    const pin = await resolveAndPin("example.com", 443, deps(["2001:db8::1"]));
    expect(() => assertDialAddressStillPinned(pin, "2001:db8::1")).not.toThrow();
    try {
      assertDialAddressStillPinned(pin, "1.2.3.4");
      throw new Error("should have refused");
    } catch (err) {
      expect((err as Error).message).toContain("example.com");
      expect((err as Error).message).toContain("443");
    }
  });
});
