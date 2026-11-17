/** cost-reconciliation.test.ts — F-4 invoice parsing + reconciliation (pure). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  CostReconciliationError,
  parseInvoiceCsv,
  parseInvoiceExport,
  parseInvoiceJson,
  reconcileCosts,
  type RecordedCostEntry,
} from "../../src/core/cost-reconciliation";

const FIXTURES = path.resolve(import.meta.dir, "../fixtures");

function recorded(model: string, costUsd: number, source: RecordedCostEntry["costSource"] = "harness-estimate"): RecordedCostEntry {
  return { model, period: "2026-11", costUsd, costSource: source };
}

describe("invoice parsing (JSON / CSV fixtures)", () => {
  test("JSON fixture parses into per-model lines and totals", () => {
    const text = readFileSync(path.join(FIXTURES, "invoice-sample.json"), "utf8");
    const inv = parseInvoiceJson(text);
    expect(inv.format).toBe("json");
    expect(inv.lines).toHaveLength(2);
    expect(inv.totals["minimaxai/minimax-m3.1-flash|2026-11"]).toBeCloseTo(0.000123, 9);
  });

  test("CSV fixture parses identically to JSON for the same data", () => {
    const inv = parseInvoiceCsv(readFileSync(path.join(FIXTURES, "invoice-sample.csv"), "utf8"));
    expect(inv.format).toBe("csv");
    expect(inv.totals).toEqual(parseInvoiceJson(readFileSync(path.join(FIXTURES, "invoice-sample.json"), "utf8")).totals);
  });

  test("format sniffing routes JSON and CSV", () => {
    expect(parseInvoiceExport('[{"model":"m","period":"2026-11","costUsd":1}]').format).toBe("json");
    expect(parseInvoiceExport("model,period,costUsd\nm,2026-11,1").format).toBe("csv");
  });

  test("quoted CSV cells with commas and escaped quotes", () => {
    const inv = parseInvoiceCsv('model,period,costUsd\n"model, with comma","p""q",2.5');
    expect(inv.lines[0]).toEqual({ model: "model, with comma", period: 'p"q', costUsd: 2.5 });
  });
});

describe("fail closed on malformed input", () => {
  test.each([
    ["malformed JSON", () => parseInvoiceJson("{not json")],
    ["wrong JSON shape", () => parseInvoiceJson('{"nope":1}')],
    ["missing field", () => parseInvoiceJson('[{"model":"m","period":"2026-11"}]')],
    ["negative cost", () => parseInvoiceJson('[{"model":"m","period":"2026-11","costUsd":-1}]')],
    ["string cost", () => parseInvoiceJson('[{"model":"m","period":"2026-11","costUsd":"x"}]')],
    ["blank model", () => parseInvoiceJson('[{"model":"  ","period":"2026-11","costUsd":1}]')],
    ["CSV missing column", () => parseInvoiceCsv("model,period\nm,p")],
    ["CSV bad cost", () => parseInvoiceCsv("model,period,costUsd\nm,p,abc")],
  ])("refuses %s with a typed error", (_label, fn) => {
    expect(fn).toThrow(CostReconciliationError);
  });

  test("error carries a machine-readable reason", () => {
    try {
      parseInvoiceJson("{bad");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CostReconciliationError);
      expect((err as CostReconciliationError).reason).toBe("invalid-json");
    }
  });
});

describe("reconcileCosts", () => {
  test("matches recorded cost to invoice within tolerance", () => {
    const inv = parseInvoiceJson('[{"model":"m","period":"2026-11","costUsd":1}]');
    const report = reconcileCosts(inv, [recorded("m", 1.0000004)]);
    expect(report.ok).toBe(true);
    expect(report.matched).toHaveLength(1);
    expect(report.mismatched).toHaveLength(0);
    expect(report.matched[0]!.recordedSources).toContain("harness-estimate");
  });

  test("reports a mismatch with a signed delta and a reason", () => {
    const inv = parseInvoiceJson('[{"model":"m","period":"2026-11","costUsd":1}]');
    const report = reconcileCosts(inv, [recorded("m", 1.5, "reported")]);
    expect(report.ok).toBe(false);
    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]!.deltaUsd).toBeCloseTo(0.5, 9);
    expect(report.mismatched[0]!.reason).toContain("differs");
  });

  test("groups multiple invoice lines and multiple recorded entries by key", () => {
    const inv = parseInvoiceCsv("model,period,costUsd\nm,2026-11,1\nm,2026-11,2\nn,2026-11,3");
    const report = reconcileCosts(inv, [recorded("m", 1), recorded("m", 2), recorded("n", 3)]);
    expect(report.matched).toHaveLength(2);
    expect(report.invoiceTotalUsd).toBeCloseTo(6, 9);
    expect(report.recordedTotalUsd).toBeCloseTo(6, 9);
  });

  test("flags keys present on only one side", () => {
    const inv = parseInvoiceJson('[{"model":"m","period":"2026-11","costUsd":1}]');
    const report = reconcileCosts(inv, [recorded("other", 2)]);
    expect(report.onlyInInvoice.map((r) => r.model)).toEqual(["m"]);
    expect(report.onlyInRecorded.map((r) => r.model)).toEqual(["other"]);
    expect(report.ok).toBe(false);
  });

  test("rejects invalid recorded entries and tolerance", () => {
    const inv = parseInvoiceJson('[{"model":"m","period":"2026-11","costUsd":1}]');
    expect(() => reconcileCosts(inv, [{ ...recorded("m", 1), costUsd: -2 }])).toThrow(CostReconciliationError);
    expect(() => reconcileCosts(inv, [recorded("m", 1)], -1)).toThrow(CostReconciliationError);
  });
});
