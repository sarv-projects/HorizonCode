import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import {
  DEFAULT_HISTORY_MESSAGE_LIMIT,
  estimateHistoryTokens,
  HISTORY_TOKEN_PRESSURE,
  tokenAwareHistoryLimit,
} from "../../src/core/history-token-budget";

function msgs(n: number, content: string): ChatMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content,
  })) as ChatMsg[];
}

describe("tokenAwareHistoryLimit (ruling 668)", () => {
  test("keeps default when under pressure budget", () => {
    const history = msgs(40, "short");
    expect(tokenAwareHistoryLimit(history, 128_000)).toBe(DEFAULT_HISTORY_MESSAGE_LIMIT);
  });

  test("allows more than default for many short messages under budget", () => {
    const history = msgs(120, "x");
    const limit = tokenAwareHistoryLimit(history, 128_000);
    expect(limit).toBeGreaterThan(DEFAULT_HISTORY_MESSAGE_LIMIT);
    expect(limit).toBeLessThanOrEqual(200);
  });

  test("shrinks when oversized tool results overflow pressure budget", () => {
    const fat = "y".repeat(40_000);
    const history = msgs(30, fat);
    expect(estimateHistoryTokens(history)).toBeGreaterThan(20_000);
    const limit = tokenAwareHistoryLimit(history, 32_000);
    expect(limit).toBeLessThan(30);
    expect(limit).toBeGreaterThanOrEqual(16);
  });

  test("default pressure fraction is 0.7 of context window", () => {
    expect(HISTORY_TOKEN_PRESSURE).toBe(0.7);
    const window = 10_000;
    const budget = window * HISTORY_TOKEN_PRESSURE;
    const perMsg = Math.ceil((budget + 500) / 25);
    const history = msgs(25, "z".repeat(perMsg * 4));
    expect(estimateHistoryTokens(history)).toBeGreaterThan(budget);
    const limit = tokenAwareHistoryLimit(history, window);
    expect(limit).toBeLessThan(25);
  });

  test("at exactly budget keeps default limit for short history", () => {
    const history = msgs(50, "ok");
    const window = Math.ceil(estimateHistoryTokens(history) / HISTORY_TOKEN_PRESSURE) + 1000;
    expect(tokenAwareHistoryLimit(history, window)).toBe(DEFAULT_HISTORY_MESSAGE_LIMIT);
  });
});
