import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { admitOAuthCredentialsDbWrite, credentialFromStore, readOAuthToken, writeOAuthToken } from "../../src/core/auth/store";

let home = "";
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("oauth store", () => {
  test("round-trip at mode 0600", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-"));
    await writeOAuthToken({ provider: "anthropic", accessToken: "tok", obtainedAt: new Date().toISOString() }, home);
    const file = path.join(home, ".config", "horizon", "credentials.db");
    expect((statSync(file).mode & 0o777) === 0o600).toBe(true);
    const cred = credentialFromStore("anthropic", home);
    expect(cred?.kind).toBe("oauth");
    expect(readOAuthToken("nope", home)).toBeUndefined();
  });

  test("admitOAuthCredentialsDbWrite refuses deny before persist (ruling 597)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-db-deny-"));
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(home, "no-such-hz-kernel");
    try {
      const kernelState = path.join(home, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-oauth-db" }]),
        "utf8",
      );
      const refused = await admitOAuthCredentialsDbWrite(home);
      expect(refused).toMatch(/denied|test-deny-oauth-db|oauth-credentials/i);
      const writeRefused = await writeOAuthToken(
        { provider: "anthropic", accessToken: "tok", obtainedAt: new Date().toISOString() },
        home,
      );
      expect(writeRefused).toMatch(/denied|test-deny-oauth-db|oauth-credentials/i);
      expect(readOAuthToken("anthropic", home)).toBeUndefined();
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

});
