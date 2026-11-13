import { describe, expect, test } from "bun:test";
import { truncatedToolCallMessage } from "../../../src/core/guards/truncated-tool-batch";

describe("truncatedToolCallMessage", () => {
  test("names the tool and cites output token limit", () => {
    const msg = truncatedToolCallMessage("read");
    expect(msg).toContain("read");
    expect(msg).toContain("output token limit");
    expect(msg).toContain("not executed");
  });
});
