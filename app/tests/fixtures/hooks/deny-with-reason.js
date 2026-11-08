#!/usr/bin/env bun
/**
 * hook fixture: validates the pre_tool input shape, then denies, naming the
 * tool and argument it saw. The reason is how the tests prove the input line
 * really arrived with the declared fields — a wrong shape exits non-zero and
 * the call fails closed instead.
 */
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
} catch {
  process.exit(7); // input was not one JSON object
}
const ok =
  input !== null &&
  typeof input === "object" &&
  input.event === "pre_tool" &&
  typeof input.sessionId === "string" &&
  input.sessionId !== "" &&
  typeof input.callId === "string" &&
  input.callId !== "" &&
  typeof input.tool === "string" &&
  input.tool !== "" &&
  input.args !== null &&
  typeof input.args === "object" &&
  Object.keys(input).sort().join(",") === "args,callId,event,sessionId,tool";
if (!ok) process.exit(8);
const where = typeof input.args.path === "string" ? input.args.path : "?";
process.stdout.write(JSON.stringify({ decision: "deny", reason: `fixture says no: ${input.tool} on ${where}` }) + "\n");
