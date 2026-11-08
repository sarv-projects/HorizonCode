#!/usr/bin/env bun
/**
 * hook fixture: validates the post_tool input shape and the excerpt cap, then
 * allows. The contents of the output are ignored by the host, but the shape is
 * pinned here: a wrong context exits non-zero and shows up as a notice.
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
  keys === "callId,event,ms,ok,outputExcerpt,sessionId,tool" &&
  input.event === "post_tool" &&
  typeof input.sessionId === "string" &&
  input.sessionId !== "" &&
  typeof input.callId === "string" &&
  input.callId !== "" &&
  typeof input.tool === "string" &&
  typeof input.ok === "boolean" &&
  typeof input.ms === "number" &&
  typeof input.outputExcerpt === "string" &&
  input.outputExcerpt.length <= 4096;
if (!ok) process.exit(8);
process.stdout.write('{"decision":"allow"}\n');
