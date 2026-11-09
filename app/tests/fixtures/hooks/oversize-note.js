#!/usr/bin/env bun
/**
 * oversize-note.js — a post_tool observation hook that returns an H9 context
 * note far larger than MAX_HOOK_CONTEXT_BYTES. The engine must TRUNCATE it at
 * the byte bound (with the truncation marker) rather than drop it or treat the
 * oversize note as a failure. The output line itself stays well under the 64 KB
 * stdout flood bound, so this exercises the context-note bound, not the stdout
 * bound.
 */

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
} catch {
  process.exit(7);
}

// 20 000 'A's — comfortably over the ~4 KB context bound, under the 64 KB
// stdout bound.
const big = "A".repeat(20000);
process.stdout.write(JSON.stringify({ decision: "observe", context: big }) + "\n");
