#!/usr/bin/env bun
/** hook fixture: valid allow JSON line then non-zero exit (post_tool observation failure). */
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write('{"decision":"allow"}\n');
process.exit(3);