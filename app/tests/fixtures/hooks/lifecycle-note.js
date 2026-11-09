#!/usr/bin/env bun
/**
 * lifecycle-note.js — an observation hook for a lifecycle point (session/turn/
 * compaction/subagent). It validates that it received a lifecycle input line
 * (an `event` and a `detail` object, and NO `tool`), then returns an H9 context
 * note naming the event it saw. Observation-only; it never blocks (H4).
 */

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
} catch {
  process.exit(7);
}

const keys = input !== null && typeof input === "object" ? Object.keys(input).sort().join(",") : "";
const ok =
  input !== null &&
  typeof input === "object" &&
  keys === "detail,event,sessionId" &&
  typeof input.event === "string" &&
  input.event !== "" &&
  typeof input.sessionId === "string" &&
  input.detail !== null &&
  typeof input.detail === "object";
if (!ok) process.exit(8);

process.stdout.write(JSON.stringify({ decision: "observe", context: `lifecycle hook saw ${input.event}` }) + "\n");
