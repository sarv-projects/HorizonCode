import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { compactHistory, tokensIn } from "../../src/core/compaction";
import {
  compactHistoryWithTokenFit,
  historyProviderTokenBudget,
  tokenAwareHistoryLimit,
} from "../../src/core/history-token-budget";

function alts(n: number, userText: string, assistantText = "ok"): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: "user", content: `${userText}#${i}` });
    out.push({ role: "assistant", content: assistantText });
  }
  return out;
}

describe("compactHistoryWithTokenFit (ruling 729)", () => {
  test("historyProviderTokenBudget uses HISTORY_TOKEN_PRESSURE", () => {
    expect(historyProviderTokenBudget(10_000)).toBe(7_000);
  });

  test("passes through when the compacted view already fits", () => {
    const history = alts(30, "short");
    const window = 128_000;
    const limit = tokenAwareHistoryLimit(history, window);
    const fitted = compactHistoryWithTokenFit(history, { limit }, window);
    expect(fitted.tokenFitApplied).toBe(false);
    expect(fitted.limit).toBe(limit);
    expect(fitted.result.compacted).toBe(history.length > limit);
    expect(tokensIn(fitted.result.history)).toBeLessThanOrEqual(historyProviderTokenBudget(window));
  });

  test("shrinks the window when fat tool turns still overflow the budget after compaction", () => {
    const fat = "w".repeat(6_000);
    const history = alts(14, fat);
    const window = 20_000;
    const limit = 20;
    const before = compactHistory(history, { limit });
    expect(before.compacted).toBe(true);
    expect(tokensIn(before.history)).toBeGreaterThan(historyProviderTokenBudget(window));

    const fitted = compactHistoryWithTokenFit(history, { limit }, window);
    expect(fitted.tokenFitApplied).toBe(true);
    expect(fitted.limit).toBeLessThan(limit);
    expect(tokensIn(fitted.result.history)).toBeLessThanOrEqual(historyProviderTokenBudget(window));
    expect(fitted.result.compacted).toBe(true);
  });
});