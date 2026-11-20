import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { admitSpendLedgerWrite } from "../../src/core/spend-ledger";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("spend ledger under-admission (ruling 583)", () => {
  test("admitSpendLedgerWrite refuses deny before write", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-spend-deny-"));
    roots.push(workspace);
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-spend" }]),
        "utf8",
      );
      const refused = await admitSpendLedgerWrite(workspace);
      expect(refused).toMatch(/denied|test-deny-spend/i);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });
});
