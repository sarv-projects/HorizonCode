import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { credentialFromStore, readOAuthToken, writeOAuthToken } from "../../src/core/auth/store";

let home = "";
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("oauth store", () => {
  test("round-trip at mode 0600", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-"));
    writeOAuthToken({ provider: "anthropic", accessToken: "tok", obtainedAt: new Date().toISOString() }, home);
    const file = path.join(home, ".config", "horizon", "oauth", "anthropic.json");
    expect((statSync(file).mode & 0o777) === 0o600).toBe(true);
    const cred = credentialFromStore("anthropic", home);
    expect(cred?.kind).toBe("oauth");
    expect(readOAuthToken("nope", home)).toBeUndefined();
  });
});
