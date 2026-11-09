#!/usr/bin/env bun
/**
 * grep-to-rg-validator.js — a WORKED EXAMPLE pre_tool validator hook in
 * HorizonCode's JSON-line hook contract (docs/15 §2.4 H1 tool.pre). It mirrors
 * Claude Code's bash_command_validator_example.py, but speaks the ratified
 * JSON-line protocol instead of exit codes: one JSON line in on stdin, one JSON
 * line out on stdout.
 *
 * It inspects a `shell`/`bash` tool call's command. If the command uses `grep`
 * (or `find ... -exec grep`) where ripgrep (`rg`) would be faster and safer, it
 * DENIES with a reason the model can read (H2 — a hook may deny, never allow).
 * An `rg` command, or any non-grep command, is allowed.
 *
 * This hook deliberately does nothing but validate: it never rewrites the
 * command (no argument rewriting in v1), it only says yes or no.
 */

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
} catch {
  // A malformed input is itself a protocol failure; exit non-zero so the engine
  // fails closed at the deciding point (H3) rather than guessing.
  process.exit(7);
}

if (input === null || typeof input !== "object" || input.event !== "pre_tool") {
  process.exit(8);
}

const tool = typeof input.tool === "string" ? input.tool : "";
const args = input.args !== null && typeof input.args === "object" ? input.args : {};
const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";

function allow() {
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\n");
}

// Only shell/bash calls carry a command to inspect; everything else is allowed.
if ((tool !== "shell" && tool !== "bash") || command === "") {
  allow();
  process.exit(0);
}

// A standalone `grep` invocation (not `rg`, not a flag like `--grep`): match
// grep as a whole word at a command boundary. `find ... -exec grep` counts too.
const usesGrep = /(^|[|&;]|\s)grep\b/.test(command) && !/\brg\b/.test(command);
const usesFindExecGrep = /\bfind\b[^|&;]*-exec\s+grep\b/.test(command);

if (usesGrep || usesFindExecGrep) {
  deny(`use rg instead of grep: ripgrep is faster and respects .gitignore. Rewrite "${command}" with rg.`);
  process.exit(0);
}

allow();
process.exit(0);
