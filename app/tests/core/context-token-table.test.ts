import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { contextChunkRows, renderContextTokenTable } from "../../src/core/context-token-table";

describe("context token table (I-2 reduced)", () => {
  test("renders chunk rows with hints", () => {
    const history: ChatMsg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const rows = contextChunkRows(history, "system text", { model: "m", window: 100_000, estimatedInput: 9000, maxOutput: 4096, messages: 2, historyLimit: 80 }, "mock");
    const text = renderContextTokenTable(rows);
    expect(text).toContain("system rail");
    expect(text).toContain("next dispatch");
    expect(text).toContain("$");
  });
});
