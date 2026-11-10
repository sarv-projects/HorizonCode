/**
 * subagent-boundary.test.ts — C2: explicit subagent.start / subagent.end events.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "../../src/contracts";
import { createRuntime } from "../../src/core/index";
import { createScriptedProvider, textTurn, toolCallTurn } from "../../src/core/providers/scripted";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

describe("subagent.start / subagent.end", () => {
  test("a delegated run is bracketed by start and end with outcome, time and tool count", async () => {
    const workspace = tempDir("hz-subbound-");
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      (runtime as unknown as { provider: unknown }).provider = createScriptedProvider([
        toolCallTurn({ name: "agent", args: { task: "list files" } }),
        toolCallTurn({ name: "glob", args: { pattern: "*" } }),
        textTurn("child report"),
        textTurn("parent done"),
      ]);
      runtime.setApprovalHandler(async () => true);
      const seen: RuntimeEvent[] = [];
      await runtime.send("delegate", { onEvent: (ev) => seen.push(ev) });
      const start = seen.find((e) => e.type === "subagent.start");
      const end = seen.find((e) => e.type === "subagent.end");
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      if (start?.type !== "subagent.start" || end?.type !== "subagent.end") throw new Error("unreachable");
      expect(start.task).toBe("list files");
      expect(start.agentId).toBe(end.agentId);
      expect(end.status).toBe("completed");
      expect(end.tools).toBe(1);
      expect(end.durationMs).toBeGreaterThanOrEqual(0);
      expect(seen.indexOf(start)).toBeLessThan(seen.indexOf(end));
    } finally {
      await runtime.close();
    }
  }, 30000);
});
