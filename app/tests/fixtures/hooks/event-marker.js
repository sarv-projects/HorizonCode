#!/usr/bin/env bun
/**
 * event-marker.js — an order-proof fixture for the loop-level lifecycle tests.
 * It reads its one input line, appends `<event>` (the input's `event` field) to
 * the log file named by argv[2], then allows/observes. Used to prove that
 * lifecycle hooks fire at the right time and in the right order relative to
 * tool.pre and to each other.
 *
 * argv: [bun, event-marker.js, <logFile>]
 */

import { appendFileSync } from "node:fs";

const logFile = process.argv[2];

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
} catch {
  /* record "?" below */
}

const event = input && typeof input === "object" && typeof input.event === "string" ? input.event : "?";
try {
  appendFileSync(logFile, event + "\n");
} catch {
  /* the test asserts on the file; a write failure fails the test */
}

// A pre_tool marker must allow (deciding point); everything else observes.
if (event === "pre_tool") {
  process.stdout.write('{"decision":"allow"}\n');
} else {
  process.stdout.write('{"decision":"observe"}\n');
}
