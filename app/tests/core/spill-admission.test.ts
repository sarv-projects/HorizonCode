import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { admitSpillWrite, planToolOutputCap } from "../../src/core/output-budget";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("spill under-admission (ruling 584)", () => {
  test("admitSpillWrite refuses deny before materialise", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-spill-deny-"));
    roots.push(workspace);
    const spillFile = path.join(workspace, ".hz", "state", "spills", "deadbeef.txt");
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-spill" }]),
        "utf8",
      );
      const refused = await admitSpillWrite(spillFile, workspace);
      expect(refused).toMatch(/denied|test-deny-spill/i);
      expect(existsSync(spillFile)).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("planToolOutputCap offers spill without writing", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-spill-plan-"));
    roots.push(workspace);
    const spillDir = path.join(workspace, "spills");
    const full = "spill-me\n".repeat(400);
    const plan = planToolOutputCap(full, { maxBytes: 64, maxTokens: 16, spillDir });
    expect(plan.spill?.file.startsWith(spillDir + path.sep)).toBe(true);
    expect(existsSync(plan.spill!.file)).toBe(false);
  });
});
