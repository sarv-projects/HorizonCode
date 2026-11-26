import { describe, expect, test } from "bun:test";
import type { AskUserRequest } from "../../src/contracts";
import { askUserTool } from "../../src/tools/ask-user";
import { mockToolContext } from "./helpers";

describe("ask_user", () => {
  test("injected askUser returns the handler answer", async () => {
    const seen: AskUserRequest[] = [];
    const ctx = mockToolContext({
      askUser: async (req) => {
        seen.push(req);
        return "picked-b";
      },
    });
    const result = await askUserTool.execute(
      { question: "Which?", options: ["a", "b"] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("picked-b");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.question).toBe("Which?");
    expect(seen[0]?.options?.map((o) => o.label)).toEqual(["a", "b"]);
  });

  test("structured option objects with context", async () => {
    const seen: AskUserRequest[] = [];
    const ctx = mockToolContext({
      askUser: async (req) => {
        seen.push(req);
        return "go";
      },
    });
    const result = await askUserTool.execute(
      {
        question: "Proceed?",
        context: "No prod access yet",
        options: [
          { label: "go", description: "try anyway", recommended: true },
          { label: "wait" },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(seen[0]?.context).toBe("No prod access yet");
    expect(seen[0]?.options?.[0]?.recommended).toBe(true);
  });

  test("approve fallback maps yes to the default option", async () => {
    const ctx = mockToolContext({ approve: true });
    const result = await askUserTool.execute(
      { question: "Pick one", options: ["first", "second"], default: "second" },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("second");
    expect(ctx.approveCalls).toHaveLength(1);
    expect(ctx.approveCalls[0]?.detail).toContain("Pick one");
    expect(ctx.approveCalls[0]?.detail).toContain("1. first");
  });

  test("without askUser or options, fails closed", async () => {
    const ctx = mockToolContext();
    const result = await askUserTool.execute({ question: "Open ended?" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no askUser handler");
  });

  test("user decline on approve fallback", async () => {
    const ctx = mockToolContext({ approve: false });
    const result = await askUserTool.execute({ question: "Go?", options: ["yes", "no"] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("declined");
  });

  test("multi_select parses comma-separated indices and labels", async () => {
    const ctx = mockToolContext({
      askUser: async () => "1, 3",
    });
    const result = await askUserTool.execute(
      {
        question: "Select multiple features",
        options: ["auth", "payments", "analytics", "search"],
        multi_select: true,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("auth, analytics");
  });

  test("timeout_ms falls back to default when user takes too long", async () => {
    const ctx = mockToolContext({
      askUser: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "slow answer";
      },
    });
    const result = await askUserTool.execute(
      {
        question: "Continue?",
        options: ["yes", "no"],
        default: "yes",
        timeout_ms: 20,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("yes");
  });

  test("timeout_ms fails when user times out and no default provided", async () => {
    const ctx = mockToolContext({
      askUser: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return "slow answer";
      },
    });
    const result = await askUserTool.execute(
      {
        question: "Continue?",
        options: ["yes", "no"],
        timeout_ms: 20,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });
});