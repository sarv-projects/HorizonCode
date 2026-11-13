import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalJson } from "../../src/core/canon";
import { migrateLegacyOAuthJsonFiles } from "../../src/core/auth/credential-db";
import {
  credentialFromStore,
  credentialsDbPath,
  oauthTokenPath,
  readOAuthToken,
  writeOAuthToken,
} from "../../src/core/auth/store";

let home = "";
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

describe("oauth credential sqlite", () => {
  test("round-trip in credentials.db at mode 0600", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-sqlite-"));
    writeOAuthToken({ provider: "anthropic", accessToken: "tok", obtainedAt: new Date().toISOString() }, home);
    const db = credentialsDbPath(home);
    expect(existsSync(db)).toBe(true);
    expect((statSync(db).mode & 0o777) === 0o600).toBe(true);
    expect(existsSync(oauthTokenPath("anthropic", home))).toBe(false);
    const cred = credentialFromStore("anthropic", home);
    expect(cred?.kind).toBe("oauth");
    expect(readOAuthToken("nope", home)).toBeUndefined();
  });

  test("concurrent writes serialize under credentials.db.lock", async () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-sqlite-lock-"));
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Promise.resolve().then(() =>
          writeOAuthToken(
            { provider: `p${i}`, accessToken: `tok-${i}`, obtainedAt: new Date().toISOString() },
            home,
          ),
        ),
      ),
    );
    for (let i = 0; i < 8; i++) {
      expect(readOAuthToken(`p${i}`, home)?.accessToken).toBe(`tok-${i}`);
    }
  });

  test("migrates legacy oauth/*.json when sqlite row is absent", () => {
    home = mkdtempSync(path.join(tmpdir(), "hz-oauth-migrate-"));
    const legacy = oauthTokenPath("legacy-provider", home);
    const dir = path.dirname(legacy);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      legacy,
      canonicalJson({
        provider: "legacy-provider",
        accessToken: "from-file",
        obtainedAt: "2020-01-01T00:00:00.000Z",
      }) + "\n",
      { mode: 0o600 },
    );
    chmodSync(dir, 0o700);
    const n = migrateLegacyOAuthJsonFiles(home);
    expect(n).toBe(1);
    const tok = readOAuthToken("legacy-provider", home);
    expect(tok?.accessToken).toBe("from-file");
  });
});
