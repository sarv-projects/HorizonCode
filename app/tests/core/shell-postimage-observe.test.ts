import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/core/canon";
import {
  ABSENT_POSTIMAGE_DIGEST,
  DIRECTORY_POSTIMAGE_DIGEST,
  computeReceiptPostimage,
  observePostimageDigest,
  parseReducedShellFsMutate,
  postimagePathForTool,
  receiptPostimageFields,
} from "../../src/core/receipt-postimage";
import { probePostimageReplay } from "../../src/core/effect-postimage-replay";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";
import { effectHostNoAmbientFallbackEnabled } from "../../src/core/effect-host-posture";
import { effectHostMcpReadOnlyStrictEnabled } from "../../src/core/effect-host-mcp-invoke";

describe("shell postimage observe & replay (Ruling 886)", () => {
  test("parseReducedShellFsMutate parses reduced shell argv shapes", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-shell-parse-"));
    try {
      expect(parseReducedShellFsMutate({ command: "touch foo.txt" }, ws)).toEqual({
        shape: "touch",
        targetPath: path.resolve(ws, "foo.txt"),
      });

      expect(parseReducedShellFsMutate({ command: "rm -f old.txt" }, ws)).toEqual({
        shape: "rm",
        targetPath: path.resolve(ws, "old.txt"),
      });
      expect(parseReducedShellFsMutate({ command: "rm note.txt" }, ws)).toEqual({
        shape: "rm",
        targetPath: path.resolve(ws, "note.txt"),
      });
      expect(parseReducedShellFsMutate({ command: "rm a.txt b.txt" }, ws)).toBeUndefined();
      expect(parseReducedShellFsMutate({ command: "./rm note.txt" }, ws)).toBeUndefined();

      expect(parseReducedShellFsMutate({ command: "mkdir sub" }, ws)).toEqual({
        shape: "mkdir",
        targetPath: path.resolve(ws, "sub"),
      });

      expect(parseReducedShellFsMutate({ command: "mkdir -p deeply/nested" }, ws)).toEqual({
        shape: "mkdir_p",
        targetPath: path.resolve(ws, "deeply/nested"),
      });

      expect(parseReducedShellFsMutate({ command: "cp src.txt dst.txt" }, ws)).toEqual({
        shape: "cp",
        sourcePath: path.resolve(ws, "src.txt"),
        targetPath: path.resolve(ws, "dst.txt"),
      });

      expect(parseReducedShellFsMutate({ command: "mv -f a.txt b.txt" }, ws)).toEqual({
        shape: "mv",
        sourcePath: path.resolve(ws, "a.txt"),
        targetPath: path.resolve(ws, "b.txt"),
      });
      expect(parseReducedShellFsMutate({ command: "rmdir empty" }, ws)).toEqual({
        shape: "rmdir",
        targetPath: path.resolve(ws, "empty"),
      });
      expect(parseReducedShellFsMutate({ command: "truncate sized.txt" }, ws)).toEqual({
        shape: "truncate",
        targetPath: path.resolve(ws, "sized.txt"),
      });
      expect(parseReducedShellFsMutate({ command: "truncate -s 4 sized.txt" }, ws)).toEqual({
        shape: "truncate",
        targetPath: path.resolve(ws, "sized.txt"),
      });
      expect(parseReducedShellFsMutate({ command: "install src.txt dst.txt" }, ws)).toEqual({
        shape: "install",
        sourcePath: path.resolve(ws, "src.txt"),
        targetPath: path.resolve(ws, "dst.txt"),
      });
      expect(parseReducedShellFsMutate({ command: "rmdir -p empty" }, ws)).toBeUndefined();
      expect(parseReducedShellFsMutate({ command: "truncate -s 4k sized.txt" }, ws)).toBeUndefined();
      expect(parseReducedShellFsMutate({ command: "install -d dir" }, ws)).toBeUndefined();

      // Compound, arbitrary or escaping commands return undefined
      expect(parseReducedShellFsMutate({ command: "echo hello" }, ws)).toBeUndefined();
      expect(parseReducedShellFsMutate({ command: "touch /outside/file.txt" }, ws)).toBeUndefined();
      expect(parseReducedShellFsMutate({ command: "rm -rf dir" }, ws)).toBeUndefined();
      expect(parseReducedShellFsMutate({ command: "curl https://example.com" }, ws)).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("observes postimages for touch, mkdir, rm -f, cp, mv", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-shell-obs-"));
    try {
      // 1. touch
      const touchedFile = path.join(ws, "touched.txt");
      writeFileSync(touchedFile, "");
      const touchObs = computeReceiptPostimage("shell", { command: "touch touched.txt" }, ws, true);
      expect(touchObs?.observationStable).toBe(true);
      expect(touchObs?.path).toBe(touchedFile);
      expect(touchObs?.digest).toBe(sha256Hex(Buffer.from("")));

      // 2. mkdir
      const dirPath = path.join(ws, "mydir");
      mkdirSync(dirPath, { recursive: true });
      const mkdirObs = computeReceiptPostimage("shell", { command: "mkdir mydir" }, ws, true);
      expect(mkdirObs?.observationStable).toBe(true);
      expect(mkdirObs?.path).toBe(dirPath);
      expect(mkdirObs?.digest).toBe(DIRECTORY_POSTIMAGE_DIGEST);
      expect(mkdirObs?.rows).toBeUndefined();

      const nested = path.join(ws, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      const nestedObs = computeReceiptPostimage("shell", { command: "mkdir -p a/b/c" }, ws, true);
      expect(nestedObs?.observationStable).toBe(true);
      expect(nestedObs?.path).toBe(nested);
      expect(nestedObs?.rows?.map((row) => row.path)).toEqual([
        path.join(ws, "a"),
        path.join(ws, "a", "b"),
        nested,
      ]);
      expect(nestedObs?.rows?.every((row) => row.digest === DIRECTORY_POSTIMAGE_DIGEST)).toBe(true);

      // 3. rm -f
      const removedFile = path.join(ws, "removed.txt");
      // File does not exist on disk
      const rmObs = computeReceiptPostimage("shell", { command: "rm -f removed.txt" }, ws, true);
      expect(rmObs?.observationStable).toBe(true);
      expect(rmObs?.path).toBe(removedFile);
      expect(rmObs?.digest).toBe(ABSENT_POSTIMAGE_DIGEST);

      const plainRemoved = path.join(ws, "plain-removed.txt");
      const plainRmObs = computeReceiptPostimage("shell", { command: "rm plain-removed.txt" }, ws, true);
      expect(plainRmObs?.observationStable).toBe(true);
      expect(plainRmObs?.path).toBe(plainRemoved);
      expect(plainRmObs?.digest).toBe(ABSENT_POSTIMAGE_DIGEST);

      // 4. cp
      const cpSrc = path.join(ws, "cp-src.txt");
      const cpDst = path.join(ws, "cp-dst.txt");
      writeFileSync(cpSrc, "cp-content");
      writeFileSync(cpDst, "cp-content");
      const cpObs = computeReceiptPostimage("shell", { command: "cp cp-src.txt cp-dst.txt" }, ws, true);
      expect(cpObs?.observationStable).toBe(true);
      expect(cpObs?.path).toBe(cpDst);
      expect(cpObs?.digest).toBe(sha256Hex(Buffer.from("cp-content")));

      // 5. mv
      const mvDst = path.join(ws, "mv-dst.txt");
      writeFileSync(mvDst, "mv-content");
      const mvObs = computeReceiptPostimage("shell", { command: "mv old.txt mv-dst.txt" }, ws, true);
      expect(mvObs?.observationStable).toBe(true);
      expect(mvObs?.path).toBe(mvDst);
      expect(mvObs?.digest).toBe(sha256Hex(Buffer.from("mv-content")));

      const rmdirObs = computeReceiptPostimage("shell", { command: "rmdir empty" }, ws, true);
      expect(rmdirObs?.observationStable).toBe(true);
      expect(rmdirObs?.path).toBe(path.join(ws, "empty"));
      expect(rmdirObs?.digest).toBe(ABSENT_POSTIMAGE_DIGEST);

      const truncated = path.join(ws, "sized.txt");
      writeFileSync(truncated, "abcd");
      const truncateObs = computeReceiptPostimage("shell", { command: "truncate -s 4 sized.txt" }, ws, true);
      expect(truncateObs?.observationStable).toBe(true);
      expect(truncateObs?.path).toBe(truncated);
      expect(truncateObs?.digest).toBe(sha256Hex(Buffer.from("abcd")));

      const installed = path.join(ws, "installed.txt");
      writeFileSync(installed, "payload");
      const installObs = computeReceiptPostimage("shell", { command: "install src.txt installed.txt" }, ws, true);
      expect(installObs?.observationStable).toBe(true);
      expect(installObs?.path).toBe(installed);
      expect(installObs?.digest).toBe(sha256Hex(Buffer.from("payload")));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("probePostimageReplay verifies shell receipts and detects drift", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-shell-rep-"));
    const rcPath = receiptsPath(ws);
    mkdirSync(path.dirname(rcPath), { recursive: true });
    try {
      const file = path.join(ws, "out.txt");
      writeFileSync(file, "hello-shell");
      const digest = sha256Hex(Buffer.from("hello-shell"));

      const receipt = {
        id: "rc-shell-1",
        effectId: "eff-1",
        tool: "shell",
        postimagePath: file,
        postimageDigest: digest,
      };
      writeFileSync(rcPath, JSON.stringify(receipt) + "\n", "utf8");

      const cleanReport = probePostimageReplay(ws);
      expect(cleanReport.failures).toHaveLength(0);

      // Drift content
      writeFileSync(file, "tampered-shell");
      const failReport = probePostimageReplay(ws);
      expect(failReport.failures).toHaveLength(1);
      expect(failReport.failures[0]?.tool).toBe("shell");
      expect(failReport.failures[0]?.storedDigest).toBe(digest);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("HZ_EFFECT_HOST_STRICT activates both fallback refusal and mcp strict", () => {
    const envStrict = { HZ_EFFECT_HOST_STRICT: "1" };
    expect(effectHostNoAmbientFallbackEnabled(envStrict)).toBe(true);
    expect(effectHostMcpReadOnlyStrictEnabled(envStrict)).toBe(true);

    const envUnset = {};
    expect(effectHostNoAmbientFallbackEnabled(envUnset)).toBe(false);
    // Ruling 919 makes read-only MCP refusal the default while EffectHost is on.
    expect(effectHostMcpReadOnlyStrictEnabled(envUnset)).toBe(true);

    const envOptOut = { HZ_EFFECT_HOST_MCP_READONLY_STRICT: "0" };
    expect(effectHostMcpReadOnlyStrictEnabled(envOptOut)).toBe(false);
  });
});
