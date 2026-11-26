/**
 * oauth-credential-pin.test.ts — OAuth account identity maps to a stable durable pin.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { credentialFromStore, readOAuthToken, writeOAuthToken } from "../../src/core/auth/store";

const DEMO_ACCOUNT_PIN = "7eaed0a0f77d41f5d1407fa52943db41a81f4dd1aac47fdb57f42d2834f8b219";

test("OAuth credential pin stays stable across token rotation and separates accounts", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "hz-oauth-pin-"));
  try {
    await writeOAuthToken({ provider: "demo", accessToken: "bearer-a", obtainedAt: new Date().toISOString(), accountId: "acct-42" }, home);
    const initial = readOAuthToken("demo", home);
    expect(initial?.credentialPinHash).toBe(DEMO_ACCOUNT_PIN);
    expect(credentialFromStore("demo", home)).toMatchObject({ credentialPinHash: DEMO_ACCOUNT_PIN });

    await writeOAuthToken({ provider: "demo", accessToken: "bearer-b", obtainedAt: new Date().toISOString(), accountId: "acct-42" }, home);
    expect(readOAuthToken("demo", home)?.credentialPinHash).toBe(initial?.credentialPinHash);

    await writeOAuthToken({ provider: "demo", accessToken: "bearer-c", obtainedAt: new Date().toISOString(), accountId: "acct-99" }, home);
    expect(readOAuthToken("demo", home)?.credentialPinHash).not.toBe(initial?.credentialPinHash);
  } finally {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* Windows SQLite handle cleanup may complete asynchronously. */
    }
  }
});
