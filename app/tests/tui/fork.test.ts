/** /fork and /sessions (FEAT-004): the slash handler against a fake runtime. */
import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/contracts";
import { runForkCommand } from "../../src/tui/interactive";
import { createRenderer } from "../../src/tui/render";
import { strip } from "../../src/tui/style";

function harness(extras: Record<string, unknown>) {
  const chunks: string[] = [];
  const renderer = createRenderer({ wrap: false, out: (c: string) => void chunks.push(c) });
  const runtime = { sessionId: "cur", ...extras } as unknown as Runtime;
  return {
    plain: () => strip(chunks.join("")),
    run: (name: string, arg = "") => runForkCommand(name, arg, runtime, renderer),
  };
}

describe("/fork and /sessions", () => {
  test("/fork forks then switches to the child; /fork n cuts at the checkpoint message index", async () => {
    const calls: Array<number | undefined> = [];
    const switched: string[] = [];
    const h = harness({
      forkSession: async (at?: number) => {
        calls.push(at);
        return { id: "child", title: "t", created: "", updated: "", forkedFrom: { sessionId: "cur", messageIndex: 3, parentSeq: 1 } };
      },
      switchSession: (id: string) => void switched.push(id),
      checkpoints: () => [{ n: 1, at: 0, label: "", changes: [], messageIndex: 6 }],
    });
    expect(await h.run("fork")).toBe(true);
    expect(await h.run("fork", "1")).toBe(true);
    expect(calls).toEqual([undefined, 6]);
    expect(switched).toEqual(["child", "child"]);
    expect(h.plain()).toContain("forked cur -> child");
    await h.run("fork", "9");
    expect(h.plain()).toContain("no checkpoint 9");
  });

  test("/sessions shows fork lineage and marks the current session", async () => {
    const h = harness({
      sessions: () => [
        { id: "cur", title: "work (fork)", created: "", updated: "", forkedFrom: { sessionId: "root", messageIndex: 4, parentSeq: 2 } },
        { id: "root", title: "work", created: "", updated: "" },
      ],
    });
    await h.run("sessions");
    const out = h.plain();
    expect(out).toContain("* cur");
    expect(out).toContain("fork of root at message 4");
    expect(out).toContain("root  work");
  });

  test("an old core without the hooks degrades with a typed line", async () => {
    const h = harness({});
    expect(await h.run("fork")).toBe(true);
    expect(h.plain()).toContain("not supported");
    expect(await h.run("plan")).toBe(false);
  });
});
