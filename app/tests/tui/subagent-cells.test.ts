import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRenderer } from "../../src/tui/render";
import { colorEnabled, setColorEnabled, strip } from "../../src/tui/style";

let was = false;
beforeAll(() => {
  was = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(was));

function render(rich: boolean, events: unknown[]): string {
  const chunks: string[] = [];
  const r = createRenderer({ wrap: false, rich, out: (c) => void chunks.push(c) });
  for (const e of events) r.handle(e as never);
  return strip(chunks.join(""));
}

const start = { type: "subagent.start", agentId: "s1", name: "agent", depth: 1, task: "list files" };
const end = { type: "subagent.end", agentId: "s1", name: "agent", depth: 1, status: "completed", durationMs: 4200, tools: 3 };

describe("subagent boundary cells", () => {
  test("with no tool card the events draw the running and completed cells", () => {
    const out = render(true, [start, end]);
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("Subagent running: \u201clist files\u201d");
    expect(lines[1]).toContain("Subagent completed in 4.2s: \u201clist files\u201d \u00b7 3 tools");
  });

  test("failed and cancelled carry the reason / state", () => {
    const failed = render(true, [start, { ...end, status: "failed", reason: "budget_exhausted", tools: 0 }]);
    expect(failed).toContain("Subagent failed in 4.2s (budget_exhausted)");
    const cancelled = render(true, [start, { ...end, status: "cancelled", tools: 0 }]);
    expect(cancelled).toContain("Subagent cancelled in 4.2s");
  });

  test("with the agent tool card there is exactly one running and one completed line", () => {
    const out = render(true, [
      { type: "tool.card", callId: "c1", name: "agent", args: { task: "list files" }, status: "running" },
      start,
      end,
      { type: "tool.card", callId: "c1", name: "agent", args: { task: "list files" }, status: "ok", summary: "done" },
    ]);
    expect(out.match(/Subagent running/g)?.length).toBe(1);
    expect(out.match(/Subagent completed in 4\.2s/g)?.length).toBe(1);
    expect(out).toContain("3 tools");
  });

  test("plain mode ignores both events", () => {
    expect(render(false, [start, end])).toBe("");
  });
});
