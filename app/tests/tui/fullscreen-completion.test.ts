import { describe, expect, test } from "bun:test";
import {
  applyFullscreenCompletionKey,
  buildFullscreenCompletionFrame,
  initialFullscreenCompletionState,
  shouldShowFullscreenCompletion,
} from "../../src/tui/fullscreen-completion";

describe("fullscreen completion overlay (ruling 284)", () => {
  const ctx = { workspace: "/tmp", commands: ["help", "sessions", "unknown"] as const };

  test("shouldShow detects slash prefix", () => {
    expect(shouldShowFullscreenCompletion("/ses")).toBe(true);
    expect(shouldShowFullscreenCompletion("hello")).toBe(false);
  });

  test("tab apply completes slash command", () => {
    const line = "/ses";
    const state = initialFullscreenCompletionState(line, ctx);
    expect(state).toBeDefined();
    const step = applyFullscreenCompletionKey(line, state!, { kind: "confirm" });
    expect(step.outcome).toEqual({ kind: "apply", completedLine: "/sessions" });
  });

  test("frame renders hits", () => {
    const state = initialFullscreenCompletionState("/h", ctx)!;
    const buf = buildFullscreenCompletionFrame({ width: 50, height: 6, state });
    expect(buf.height).toBe(6);
  });
});
