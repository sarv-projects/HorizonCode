import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tlsMitmPosture } from "../../src/core/egress-tls-mitm";
import {
  egressTlsInterceptRefuseForward,
  writeHermeticInterceptCaMaterial,
} from "../../src/core/egress-tls-intercept-ca";
import {
  egressTlsInterceptCaConfigured,
  egressTlsInterceptEnabled,
  tlsInterceptStubPosture as stubOnly,
} from "../../src/core/egress-tls-intercept";

describe("egress TLS intercept stub honesty", () => {
  test("intercept off by default", () => {
    expect(egressTlsInterceptEnabled({})).toBe(false);
    expect(stubOnly({}).posture).toBe("off");
  });

  test("intercept without CA is unavailable", () => {
    const p = stubOnly({ HZ_EGRESS_TLS_INTERCEPT: "1" });
    expect(p.posture).toBe("unavailable");
    expect(p.detail.toLowerCase()).toContain("no ca");
    expect(p.detail).not.toContain("enforced");
  });

  test("intercept with loadable CA is advisory stub with fail-closed refuse", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-intercept-ca-"));
    const { caCertPath } = writeHermeticInterceptCaMaterial(dir);
    try {
      const env = { HZ_EGRESS_TLS_INTERCEPT: "1", HZ_EGRESS_TLS_INTERCEPT_CA: caCertPath };
      expect(egressTlsInterceptCaConfigured(env)).toBe(true);
      expect(egressTlsInterceptRefuseForward(env)).toBe(true);
      const p = stubOnly(env);
      expect(p.posture).toBe("advisory-stub");
      expect(p.detail.toLowerCase()).toContain("advisory");
      expect(p.detail.toLowerCase()).toContain("refuses");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mitm posture distinguishes peek vs intercept stub", () => {
    const peek = tlsMitmPosture({ HZ_EGRESS_FORWARD: "1", HZ_EGRESS_TLS_PEEK: "1" });
    expect(peek.tlsPeek).toBe(true);
    expect(peek.tlsIntercept).toBe(false);
    const intercept = tlsMitmPosture({
      HZ_EGRESS_FORWARD: "1",
      HZ_EGRESS_TLS_INTERCEPT: "1",
    });
    expect(intercept.tlsIntercept).toBe(true);
    expect(intercept.tlsInterceptCa).toBe(false);
    expect(intercept.detail.toLowerCase()).toContain("without ca");
  });
});
