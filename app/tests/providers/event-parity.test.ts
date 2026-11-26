/**
 * event-parity.test.ts -- pinned 18-variant provider event parity assessment
 * (plan Task 5). Counts are never claimed as full parity.
 */
import { describe, expect, test } from "bun:test";
import {
  PROVIDER_EVENT_PARITY,
  providerEventParityReport,
} from "../../src/core/providers/event-parity";

const LOCAL_KINDS = ["text", "thinking", "tool_call", "notice", "quirks", "done", "error"];

describe("provider event parity assessment", () => {
  test("18 unique classified rows, all decisions accounted for", () => {
    expect(PROVIDER_EVENT_PARITY).toHaveLength(18);
    expect(new Set(PROVIDER_EVENT_PARITY.map((r) => r.upstream)).size).toBe(18);
    const report = providerEventParityReport();
    expect(report.total).toBe(18);
    expect(report.covered + report.additiveNeeded + report.outOfScope).toBe(18);
    expect(report.covered + report.additiveNeeded).toBeGreaterThan(0);
  });

  test("every covered row maps to a real ProviderEvent kind", () => {
    for (const row of PROVIDER_EVENT_PARITY.filter((r) => r.decision === "covered")) {
      expect(LOCAL_KINDS).toContain(row.local);
    }
  });

  test("additive-needed rows never claim coverage", () => {
    for (const row of PROVIDER_EVENT_PARITY.filter((r) => r.decision === "additive_needed")) {
      expect(row.note.length).toBeGreaterThan(0);
      expect(row.local === undefined || row.local === "").toBe(true);
    }
  });
});
