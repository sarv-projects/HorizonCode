/**
 * crash-diagnostics.test.ts — Group G crash diagnostic data model (grok port).
 * Maps persisted fault-injection exit codes to an honest structured record.
 * Never claims "symbolicated" without symbols.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyKernelExit,
  formatCrashNotice,
  type KernelCrashRecord,
} from "../../src/core/crash-diagnostics";

describe("crash diagnostics (grok port)", () => {
  test("exit 86 (after prepare) is recoverable; 87/88 are UNKNOWN fail-closed", () => {
    expect(classifyKernelExit(86)?.recoverable).toBe(true);
    expect(classifyKernelExit(87)?.recoverable).toBe(false);
    expect(classifyKernelExit(88)?.recoverable).toBe(false);
    expect(classifyKernelExit(87)?.verdict).toBe("UNKNOWN");
  });

  test("unknown exit codes are not fabricated into a classification", () => {
    expect(classifyKernelExit(42)).toBeUndefined();
    expect(classifyKernelExit(0)).toBeUndefined();
  });

  test("notice names the boundary and never claims symbolication", () => {
    const record: KernelCrashRecord = {
      exitCode: 87,
      boundary: "after_executing",
      effectId: "eff-1",
      verdict: "UNKNOWN",
      recoverable: false,
      symbolsAvailable: false,
      at: "2026-11-22T00:00:00.000Z",
    };
    const notice = formatCrashNotice(record);
    expect(notice).toContain("after_executing");
    expect(notice).toContain("UNKNOWN");
    expect(notice).not.toMatch(/symbolicat/i);
  });
});
