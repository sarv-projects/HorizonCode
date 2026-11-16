import { describe, expect, test } from "bun:test";
import {
  formatAssemblyCancelNotice,
  ToolCallAssembler,
} from "../../src/core/providers/tool-call-assembly";

describe("ToolCallAssembler", () => {
  test("assembles index-keyed deltas then flushes completed calls", () => {
    const a = new ToolCallAssembler();
    a.pushDelta({ index: 0, id: "call_a", function: { name: "read", arguments: '{"p' } });
    a.pushDelta({ index: 0, function: { arguments: 'ath":"x"}' } });
    a.pushDelta({ index: 1, id: "call_b", function: { name: "glob", arguments: "" } });
    const done = a.flushCompleted();
    expect(done).toEqual([
      { id: "call_a", name: "read", arguments: '{"path":"x"}' },
      { id: "call_b", name: "glob", arguments: "{}" },
    ]);
    expect(a.size()).toBe(0);
  });

  test("cancel discards partials and never leaves flushable calls", () => {
    const a = new ToolCallAssembler();
    a.pushDelta({ index: 0, id: "call_x", function: { name: "read", arguments: '{"path":' } });
    a.pushDelta({ index: 1, id: "call_y", function: { name: "write", arguments: "{" } });
    const cancelled = a.cancel();
    expect(cancelled).toHaveLength(2);
    expect(cancelled[0]?.name).toBe("read");
    expect(cancelled[0]?.argsBytes).toBeGreaterThan(0);
    expect(a.size()).toBe(0);
    expect(a.flushCompleted()).toEqual([]);
    expect(formatAssemblyCancelNotice(cancelled)).toContain("assembly-cancel: discarded 2");
    expect(formatAssemblyCancelNotice(cancelled)).toContain("read");
  });
});
