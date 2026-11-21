import { describe, expect, it } from "bun:test";
import { canMergeFront, canMergeFollower, combinePrefixLength, combineQueuedMessages, joinTexts } from "../../src/core/prompt-combine";

describe("prompt-combine (stolen from grok-build xai-prompt-queue)", () => {
  it("merges plain user prompts with double newlines", () => {
    const queue = ["first request", "second detail", "third constraint"];
    const result = combineQueuedMessages(queue);
    expect(result.combinedCount).toBe(3);
    expect(result.head).toBe("first request\n\nsecond detail\n\nthird constraint");
    expect(result.remaining).toEqual([]);
  });

  it("stops merging before a slash command", () => {
    const queue = ["write a function", "add tests", "/status", "another request"];
    const result = combineQueuedMessages(queue);
    expect(result.combinedCount).toBe(2);
    expect(result.head).toBe("write a function\n\nadd tests");
    expect(result.remaining).toEqual(["/status", "another request"]);
  });

  it("takes slash command singly if it is at the front", () => {
    const queue = ["/model", "user message"];
    const result = combineQueuedMessages(queue);
    expect(result.combinedCount).toBe(1);
    expect(result.head).toBe("/model");
    expect(result.remaining).toEqual(["user message"]);
  });

  it("handles single message or empty gracefully", () => {
    expect(combineQueuedMessages(["hello"])).toEqual({
      head: "hello",
      remaining: [],
      combinedCount: 1,
    });
    expect(combineQueuedMessages([])).toEqual({
      head: "",
      remaining: [],
      combinedCount: 0,
    });
  });
});
