import { describe, expect, test } from "bun:test";
import { egressProxyFromEnv, mergeEgressProxyEnv, normalizeEgressProxyUrl } from "../../src/core/egress-env";
import { startEgressConnectStub } from "../../src/core/egress-connect-stub";

describe("egress proxy env", () => {
  test("normalizes host:port", () => {
    expect(normalizeEgressProxyUrl("127.0.0.1:8888")).toBe("http://127.0.0.1:8888");
    expect(egressProxyFromEnv({ HZ_EGRESS_PROXY: "http://127.0.0.1:9" })).toBe("http://127.0.0.1:9");
  });

  test("mergeEgressProxyEnv does not overwrite existing proxy vars", () => {
    const merged = mergeEgressProxyEnv({ HZ_EGRESS_PROXY: "127.0.0.1:9", HTTP_PROXY: "http://custom:1" });
    expect(merged.HTTP_PROXY).toBe("http://custom:1");
    expect(merged.HTTPS_PROXY).toBe("http://127.0.0.1:9");
  });

  test("connect stub refuses CONNECT", async () => {
    const stub = await startEgressConnectStub(0);
    try {
      const res = await fetch(stub.url, { method: "CONNECT" });
      expect(res.status).toBe(403);
    } finally {
      stub.stop();
    }
  });
});
