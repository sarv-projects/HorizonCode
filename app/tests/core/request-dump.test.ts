import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { admitRequestDumpWrite, maybeDumpProviderRequest } from "../../src/core/providers/request-dump";

const prev = process.env.HZ_DEBUG_REQUESTS;
let file: string;

afterEach(() => {
  if (prev === undefined) delete process.env.HZ_DEBUG_REQUESTS;
  else process.env.HZ_DEBUG_REQUESTS = prev;
  if (file) {
    try {
      rmSync(path.dirname(file), { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

describe("HZ_DEBUG_REQUESTS", () => {
  test("writes masked JSONL at mode 0600", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-req-dump-"));
    file = path.join(dir, "req.jsonl");
    process.env.HZ_DEBUG_REQUESTS = file;
    await maybeDumpProviderRequest("openai", { apiKey: "sk-secret-abc", messages: [] });
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const line = readFileSync(file, "utf8").trim();
    expect(line).toContain("openai");
    expect(line).not.toContain("sk-secret-abc");
    chmodSync(file, 0o600);
  });

  test("admitRequestDumpWrite refuses deny before append (rulings 612/614)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-req-dump-deny-"));
    file = path.join(dir, "req.jsonl");
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(dir, "no-such-hz-kernel");
    process.env.HZ_DEBUG_REQUESTS = file;
    try {
      const kernelState = path.join(dir, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-request-dump" }]),
        "utf8",
      );
      const refused = await admitRequestDumpWrite(file, dir);
      expect(refused).toMatch(/denied|test-deny-request-dump|request-dump/i);
      await maybeDumpProviderRequest("openai", { apiKey: "sk-secret", messages: [] });
      expect(existsSync(file)).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);
});
