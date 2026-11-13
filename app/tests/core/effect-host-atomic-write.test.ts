import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeBytesAtomicInSandbox } from "../../src/core/effect-host-atomic-write";

describe("effect-host atomic write", () => {
  test("writes via temp+rename and leaves no sibling temp", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-atomic-"));
    try {
      const target = path.join(sandbox, "nested/out.txt");
      await writeBytesAtomicInSandbox(sandbox, target, Buffer.from("atomic-283", "utf8"));
      expect(readFileSync(target, "utf8")).toBe("atomic-283");
      const nested = readdirSync(path.join(sandbox, "nested"));
      expect(nested).toEqual(["out.txt"]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("refuses target outside sandboxRoot", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "hz-eff-atomic-"));
    try {
      const outside = path.join(tmpdir(), `hz-out-${Date.now()}.txt`);
      await expect(writeBytesAtomicInSandbox(sandbox, outside, Buffer.from("x"))).rejects.toThrow(
        "sandboxRoot",
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
