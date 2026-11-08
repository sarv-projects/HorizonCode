#!/usr/bin/env bun
/**
 * hook fixture: drains its input, then never answers — the timeout path. The
 * host must kill it (and its group) at the configured timeout and fail closed.
 */
for await (const _chunk of process.stdin) {
  /* drain the one input line */
}
await new Promise((resolve) => setTimeout(resolve, 60_000));
process.stdout.write('{"decision":"allow"}\n');
