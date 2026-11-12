import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveRegistryCredential } from "../../src/core/config";
import { writeOAuthToken } from "../../src/core/auth/store";

describe("registry oauth credential", () => {
  test("resolveRegistryCredential reads oauth store", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-home-"));
    try {
      writeOAuthToken(
        {
          provider: "myhost",
          accessToken: "tok",
          obtainedAt: new Date().toISOString(),
        },
        home,
      );
      const { credential } = resolveRegistryCredential(
        { id: "myhost", baseUrl: "http://127.0.0.1:8080", protocol: "openai-chat" },
        { HOME: home },
      );
      expect(credential).toEqual({ kind: "oauth", accessToken: "tok", refreshToken: undefined, expiresAt: undefined });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
