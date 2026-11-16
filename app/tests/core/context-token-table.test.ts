import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { COMPACTION_SEPARATOR, SUMMARY_HEADING } from "../../src/core/compaction";
import {
  contextChunkRows,
  extractCompactionSummary,
  renderContextTokenTable,
} from "../../src/core/context-token-table";
import { estimateTokens } from "../../src/core/output-budget";
import { HARNESS_PRICE_TABLE_REVISION } from "../../src/core/usage-cost";

const usage = {
  model: "m",
  window: 100_000,
  estimatedInput: 9000,
  maxOutput: 4096,
  messages: 2,
  historyLimit: 80,
};

describe("context token table (I-2 reduced)", () => {
  test("renders chunk rows with hints", () => {
    const history: ChatMsg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const rows = contextChunkRows(history, "system text", usage, "mock");
    const text = renderContextTokenTable(rows);
    expect(text).toContain("system rail");
    expect(text).toContain("next dispatch");
    expect(text).toContain("$");
    expect(text).toContain(HARNESS_PRICE_TABLE_REVISION);
    expect(text).toContain("not provider invoice");
  });

  test("extractCompactionSummary isolates the labelled block", () => {
    const summary = `${SUMMARY_HEADING}\n3 of 10 messages left the window.`;
    const content = `## Pinned\nx${COMPACTION_SEPARATOR}${summary}${COMPACTION_SEPARATOR}keep me`;
    expect(extractCompactionSummary(content)).toBe(summary);
    expect(extractCompactionSummary("plain user")).toBeUndefined();
  });

  test("compaction summary is its own row and not double-counted in user turns", () => {
    const summaryBody = `${SUMMARY_HEADING}\n${"elided work notes. ".repeat(80)}`;
    const userTail = "please continue";
    const content = `## Pinned\nok${COMPACTION_SEPARATOR}${summaryBody}${COMPACTION_SEPARATOR}${userTail}`;
    const history: ChatMsg[] = [
      { role: "user", content },
      { role: "assistant", content: "ack" },
    ];
    const rows = contextChunkRows(history, "sys", usage, "openai");
    const compaction = rows.find((r) => r.kind === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction!.label).toBe("compaction summary");
    expect(compaction!.tokens).toBe(estimateTokens(summaryBody));
    expect(compaction!.usd).toBeGreaterThan(0);
    expect(compaction!.hint).toContain("elided");

    const remainder = content.replace(summaryBody, "");
    const userRow = rows.find((r) => r.label === "user turns");
    expect(userRow!.tokens).toBe(estimateTokens(remainder + "[]"));
    expect(userRow!.tokens).toBeLessThan(compaction!.tokens);

    // Without the heading, the same bytes fold into user turns (no compaction row).
    const unmarked = content.replace(SUMMARY_HEADING, "## Other heading");
    const folded = contextChunkRows([{ role: "user", content: unmarked }], "sys", undefined, "openai");
    expect(folded.find((r) => r.kind === "compaction")).toBeUndefined();
    expect(folded.find((r) => r.label === "user turns")!.tokens).toBe(
      estimateTokens(unmarked + "[]"),
    );

    const text = renderContextTokenTable(rows);
    expect(text).toContain("compaction summary");
    expect(text).toMatch(/\$\d+\.\d{4}/);
  });

  test("multiple compaction blocks get a count label", () => {
    const block = (n: number) =>
      `${SUMMARY_HEADING}\nblock ${n}${COMPACTION_SEPARATOR}u${n}`;
    const history: ChatMsg[] = [
      { role: "user", content: block(1) },
      { role: "assistant", content: "a" },
      { role: "user", content: block(2) },
    ];
    const rows = contextChunkRows(history, "s", undefined, "mock");
    const compaction = rows.find((r) => r.kind === "compaction");
    expect(compaction?.label).toBe("compaction summary (×2)");
  });
});
