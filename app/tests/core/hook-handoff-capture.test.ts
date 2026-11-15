import { describe, expect, test } from "bun:test";
import {
  formatHookAuditLine,
  hookAuditBlockForHandoff,
  hookAuditLinesFromSessionJsonl,
  recordHookAuditLine,
  resetHookAuditForTests,
} from "../../src/core/hook-handoff-capture";
import { kernelStateDir } from "../../src/core/paths";
import { sanitizeStream } from "../../src/core/kernel";
import { createHandoff, resetHandoffsForTests, resumeHandoff } from "../../src/core/memory/handoff";
import { handoffCreateTool } from "../../src/tools/handoff";
import { mockToolContext } from "../tools/helpers";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

describe("hook handoff capture", () => {
  test("formats decision and failure lines", () => {
    expect(formatHookAuditLine("hook.decision", { tool: "shell", hook: "h1", decision: "allow" })).toBe(
      "[allow] shell via h1",
    );
    expect(formatHookAuditLine("hook.decision", { tool: "write", hook: "h2", decision: "deny", reason: "blocked" })).toBe(
      "[deny] write via h2: blocked",
    );
    expect(formatHookAuditLine("hook.failure", { tool: "read", hook: "h3", error: "timeout" })).toBe(
      "[failure] read via h3: timeout",
    );
  });

  test("ring buffer caps and block render", () => {
    resetHookAuditForTests();
    const sid = "sess-hook-cap";
    for (let i = 0; i < 40; i += 1) {
      recordHookAuditLine(sid, "hook.decision", { tool: "t", hook: `h${i}`, decision: "allow" });
    }
    const block = hookAuditBlockForHandoff(sid);
    expect(block).toContain("Hook audit");
    expect(block.split("\n").filter((l) => l.startsWith("- ")).length).toBe(16);
  });

  test("replays hook lines from session events jsonl when ring is empty", () => {
    resetHookAuditForTests();
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-hnd-jsonl-"));
    try {
      const sessionId = "jsonl-sess";
      const eventsDir = path.join(kernelStateDir(workspace), "events");
      mkdirSync(eventsDir, { recursive: true });
      const logPath = path.join(eventsDir, `${sanitizeStream(`session:${sessionId}`)}.jsonl`);
      const row = JSON.stringify({
        type: "hook.decision",
        payload: { tool: "write", hook: "policy", decision: "deny", reason: "from log" },
      });
      writeFileSync(logPath, `${row}\n`, "utf8");
      expect(hookAuditLinesFromSessionJsonl(workspace, sessionId)).toEqual(["[deny] write via policy: from log"]);
      const block = hookAuditBlockForHandoff(sessionId, workspace);
      expect(block).toContain("from log");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("handoff_create appends hook audit into context", async () => {
    resetHookAuditForTests();
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-hnd-hook-"));
    try {
      resetHandoffsForTests(workspace);
      recordHookAuditLine("handoff-sess", "hook.decision", {
        tool: "shell",
        hook: "policy.sh",
        decision: "deny",
        reason: "rm blocked",
      });
      const ctx = mockToolContext({ cwd: workspace, sessionId: "handoff-sess" });
      const out = await handoffCreateTool.execute({ summary: "end with hooks" }, ctx);
      expect(out.ok).toBe(true);
      const resumed = resumeHandoff(workspace);
      const ctxSection = resumed.top_sections.find((s) => s.section_name === "context");
      expect(ctxSection?.section_text).toContain("Hook audit");
      expect(ctxSection?.section_text).toContain("rm blocked");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});