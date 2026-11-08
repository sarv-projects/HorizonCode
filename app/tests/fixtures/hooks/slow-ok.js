#!/usr/bin/env bun
/**
 * hook fixture: reads its input, waits 700 ms, then allows. Proves a hook
 * slower than "instant" still passes inside its configured timeout (and that
 * the timeout is per hook, not a race).
 */
for await (const _chunk of process.stdin) {
  /* drain the one input line */
}
await new Promise((resolve) => setTimeout(resolve, 700));
process.stdout.write('{"decision":"allow"}\n');
