import type { RuntimeEvent } from "../../../src/contracts";

/** A fixed event script exercising every renderer branch (used for the non-TTY byte-identity guard). */
export const PLAIN_SCRIPT: RuntimeEvent[] = [
  { type: "assistant.delta", text: "Let me look.\n" },
  { type: "assistant.done", text: "Let me look.\n" },
  { type: "tool.card", callId: "1", name: "read", args: { path: "src/a.ts" }, status: "running" },
  { type: "tool.card", callId: "1", name: "read", args: { path: "src/a.ts" }, status: "ok", summary: "export const a = 1;", detail: { durationMs: 12, count: 1 } },
  { type: "tool.card", callId: "2", name: "shell", args: { command: "npm test" }, status: "running" },
  { type: "tool.card", callId: "2", name: "shell", args: { command: "npm test" }, status: "error", summary: "exit 1", detail: { durationMs: 4200, output: "a\nb\nc\nd\ne\nf\ng", exitCode: 1 } },
  { type: "tool.card", callId: "3", name: "edit", args: { path: "src/a.ts", old: "a", new: "b\nc" }, status: "running" },
  { type: "tool.card", callId: "3", name: "edit", args: { path: "src/a.ts", old: "a", new: "b\nc" }, status: "ok", summary: "edited", preview: "--- a\n+++ b\n@@ -1 +1,2 @@\n-a\n+b\n+c" } as RuntimeEvent,
  { type: "subagent.event", agentId: "ag1", name: "agent", depth: 1, profile: "explore", event: { type: "tool.card", callId: "x", name: "read", args: { path: "z" }, status: "running" } },
  { type: "subagent.event", agentId: "ag1", name: "agent", depth: 1, event: { type: "assistant.done", text: "done" } },
  { type: "notice", message: "a notice" },
  { type: "turn.diff", turn: 1, files: 1, diff: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b", truncated: false },
  { type: "error", message: "boom" },
  { type: "assistant.delta", text: "Done." },
  { type: "assistant.done", text: "Done." },
  { type: "turn.done" },
];
