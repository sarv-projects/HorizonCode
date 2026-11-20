import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admitPredsOutWrite, loadPredsFile, upsertPredsRecord } from "../../src/core/preds-writer";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("preds.json writer (J-1 reduced)", () => {
  test("upserts instances atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "hz-preds-"));
    roots.push(dir);
    const file = join(dir, "preds.json");
    upsertPredsRecord(file, {
      instance_id: "case-1",
      model_name_or_path: "mock",
      model_patch: "diff\n",
      exit_status: "succeeded",
    });
    const map = loadPredsFile(file);
    expect(map["case-1"]?.model_patch).toBe("diff\n");
    upsertPredsRecord(file, {
      instance_id: "case-2",
      model_name_or_path: "mock",
      model_patch: "other",
    });
    const next = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(next).sort()).toEqual(["case-1", "case-2"]);
  });

  test("admitPredsOutWrite refuses deny before write (ruling 579)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "hz-preds-deny-"));
    roots.push(workspace);
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-preds" }]),
        "utf8",
      );
      const file = join(workspace, "preds.json");
      const refused = await admitPredsOutWrite(file, workspace);
      expect(refused).toMatch(/denied|test-deny-preds/i);
      expect(existsSync(file)).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("admitPredsOutWrite covers metrics/approval paths (ruling 580)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "hz-metrics-deny-"));
    roots.push(workspace);
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-metrics" }]),
        "utf8",
      );
      for (const name of ["metrics.json", "approval.json"] as const) {
        const file = join(workspace, name);
        const refused = await admitPredsOutWrite(file, workspace);
        expect(refused).toMatch(/denied|test-deny-metrics/i);
        expect(existsSync(file)).toBe(false);
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("admitPredsOutWrite covers batch runner-config path (ruling 581)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "hz-batch-cfg-deny-"));
    roots.push(workspace);
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-batch-cfg" }]),
        "utf8",
      );
      const file = join(workspace, "job.runner-config.json");
      const refused = await admitPredsOutWrite(file, workspace);
      expect(refused).toMatch(/denied|test-deny-batch-cfg/i);
      expect(existsSync(file)).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("admitPredsOutWrite covers ratchet decision log path (ruling 582)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "hz-ratchet-deny-"));
    roots.push(workspace);
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-ratchet" }]),
        "utf8",
      );
      const file = join(workspace, "ratchet-decisions.jsonl");
      const refused = await admitPredsOutWrite(file, workspace);
      expect(refused).toMatch(/denied|test-deny-ratchet/i);
      expect(existsSync(file)).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });
});
