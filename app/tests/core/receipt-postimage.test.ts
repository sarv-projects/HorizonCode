import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/core/canon";
import {
  assessPostimageObservation,
  computeReceiptPostimage,
  computeReceiptPostimageFromKernel,
  observePostimageDigest,
  postimageObservationNotice,
  postimagePathForTool,
  receiptPostimageFields,
} from "../../src/core/receipt-postimage";

describe("receipt postimage", () => {
  test("resolves workspace-relative write paths", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-post-"));
    try {
      const p = postimagePathForTool("write", { path: "a.txt" }, ws);
      expect(p).toBe(path.join(ws, "a.txt"));
      expect(postimagePathForTool("shell", { path: "a.txt" }, ws)).toBeUndefined();
      expect(postimagePathForTool("write", { path: "/etc/passwd" }, ws)).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("hashes file bytes after write with stable independent re-read", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-post2-"));
    try {
      mkdirSync(ws, { recursive: true });
      const file = path.join(ws, "b.txt");
      writeFileSync(file, "hello");
      const obs = computeReceiptPostimage("write", { path: "b.txt" }, ws, true);
      expect(obs?.digest).toBe(sha256Hex(Buffer.from("hello")));
      expect(obs?.observationStable).toBe(true);
      expect(observePostimageDigest(file)).toBe(obs?.digest);
      expect(receiptPostimageFields(obs)).toEqual({
        postimageDigest: obs!.digest,
        postimagePath: file,
      });
      expect(computeReceiptPostimage("write", { path: "b.txt" }, ws, false)).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("unstable observation when independent re-read digests disagree", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-post3-"));
    try {
      const file = path.join(ws, "c.txt");
      writeFileSync(file, "stable");
      const primary = sha256Hex(Buffer.from("stable"));
      const confirm = sha256Hex(Buffer.from("drift"));
      let n = 0;
      const obs = computeReceiptPostimage(
        "write",
        { path: "c.txt" },
        ws,
        true,
        () => (n++ === 0 ? primary : confirm),
      );
      expect(obs?.observationStable).toBe(false);
      expect(obs?.confirmDigest).toBe(confirm);
      expect(receiptPostimageFields(obs)).toBeUndefined();
      expect(postimageObservationNotice(obs!)).toContain("postimage observation unstable");
      expect(postimageObservationNotice(obs!)).toContain(file);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("assessPostimageObservation is fail-closed on missing digests", () => {
    expect(assessPostimageObservation("a", undefined)).toEqual({ observationStable: false });
    expect(assessPostimageObservation(undefined, "b")).toEqual({ observationStable: false });
    expect(assessPostimageObservation("same", "same")).toEqual({ observationStable: true });
  });

  test("kernel observe stable digest maps to receipt fields (ruling 280)", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-post-kernel-"));
    try {
      const dig = sha256Hex(Buffer.from("kernel-bytes"));
      writeFileSync(path.join(ws, "k.txt"), "kernel-bytes");
      const obs = computeReceiptPostimageFromKernel(
        "write",
        { path: "k.txt" },
        ws,
        true,
        { contentDigest: dig, postimageObservationStable: true },
      );
      expect(obs?.observationStable).toBe(true);
      expect(receiptPostimageFields(obs)).toEqual({ postimageDigest: dig, postimagePath: path.join(ws, "k.txt") });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
