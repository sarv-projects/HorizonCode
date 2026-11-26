/**
 * human-principal-keys.test.ts -- local ed25519 approval keypair (docs/28 §14).
 * Honest scope: proves possession of a host-local key, NOT a cryptographic human.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  generateHumanKeyPair,
  humanKeyPaths,
  inspectLocalHumanKey,
  loadOrCreateHumanKeyPair,
  signApproval,
  verifyApproval,
} from "../../src/core/human-principal-keys";

describe("local human key posture (doctor)", () => {
  test("reports absence without creating files, then presence after creation", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-human-posture-"));
    try {
      const before = inspectLocalHumanKey(home);
      expect(before.present).toBe(false);
      expect(existsSync(humanKeyPaths(home).privateKey)).toBe(false);
      loadOrCreateHumanKeyPair(home);
      expect(inspectLocalHumanKey(home).present).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("human approval keypair", () => {
  test("signs and verifies an approval intent, refusing tampering", () => {
    const keys = generateHumanKeyPair();
    const intent = JSON.stringify({ sessionId: "s1", action: "fs.write", target: "a.txt" });
    const signature = signApproval(keys.privateKeyHex, intent);
    expect(verifyApproval(keys.publicKeyHex, intent, signature)).toBe(true);
    expect(verifyApproval(keys.publicKeyHex, intent + "!", signature)).toBe(false);
    expect(verifyApproval(keys.publicKeyHex, intent, "00".repeat(64))).toBe(false);
  });

  test("persists 0600 key files under the user config dir and refuses symlinks", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-human-key-"));
    try {
      const paths = humanKeyPaths(home);
      expect(paths.privateKey.startsWith(home)).toBe(true);
      const first = loadOrCreateHumanKeyPair(home);
      const second = loadOrCreateHumanKeyPair(home);
      expect(second.publicKeyHex).toBe(first.publicKeyHex);
      if (process.platform !== "win32") {
        expect(statSync(paths.privateKey).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }

    const hostile = mkdtempSync(path.join(tmpdir(), "hz-human-key-link-"));
    try {
      const paths = humanKeyPaths(hostile);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(path.join(hostile, "outside.key"), "outside");
      symlinkSync(path.join(hostile, "outside.key"), paths.privateKey);
      expect(() => loadOrCreateHumanKeyPair(hostile)).toThrow(/symlink/i);
    } finally {
      rmSync(hostile, { recursive: true, force: true });
    }
  });
});
