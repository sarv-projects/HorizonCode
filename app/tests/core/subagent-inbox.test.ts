/**
 * subagent-inbox.test.ts — bounded typed subagent mailbox (claude-code/opencode
 * task-board + mailbox ADAPT). Uses AgentId identity; per-agent FIFO, capped.
 */
import { describe, expect, test } from "bun:test";
import { AgentId } from "../../src/core/subagent-delivery";
import {
  SubagentInbox,
  type InboxMessage,
} from "../../src/core/subagent-inbox";

describe("bounded subagent inbox", () => {
  const a = AgentId.mint("agent-a").asStr();
  const b = AgentId.mint("agent-b").asStr();

  test("per-agent FIFO delivery; agents are isolated", () => {
    const box = new SubagentInbox();
    box.post(a, "m1");
    box.post(a, "m2");
    box.post(b, "other");
    expect(box.drain(a).map((m) => m.body)).toEqual(["m1", "m2"]);
    expect(box.drain(b).map((m) => m.body)).toEqual(["other"]);
    expect(box.drain(a)).toEqual([]);
  });

  test("bounded per-agent capacity: oldest dropped when full, with a dropped counter", () => {
    const box = new SubagentInbox({ perAgentCap: 2 });
    box.post(a, "1");
    box.post(a, "2");
    box.post(a, "3"); // drops "1"
    expect(box.drain(a).map((m) => m.body)).toEqual(["2", "3"]);
    expect(box.droppedCount(a)).toBe(1);
  });

  test("global message cap is enforced", () => {
    const box = new SubagentInbox({ globalCap: 3 });
    expect(() => {
      box.post(a, "1"); box.post(a, "2"); box.post(b, "3"); box.post(b, "4");
    }).toThrow(/cap|full/i);
  });

  test("messages carry a monotonic id and recipient identity", () => {
    const box = new SubagentInbox();
    const m = box.post(a, "hello");
    expect(m.id).toMatch(/^im-/);
    expect(m.to).toBe(a);
    expect(m.seq).toBe(1);
  });
});
