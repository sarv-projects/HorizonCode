import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { postmortemsDir, recordPostmortem } from "../../src/core/postmortem";
import { runEvalCli, type EvalCliIo } from "../../src/eval-run";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

function capture(): { lines: string[]; errors: string[]; io: EvalCliIo } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l) => lines.push(l), err: (l) => errors.push(l) } };
}

function casesFile(entries: unknown[]): string {
  const file = path.join(tempDir("hz-eval-cli-"), "cases.json");
  writeFileSync(file, JSON.stringify(entries), "utf8");
  return file;
}

test("a passing case file publishes its numbers and exits 0", async () => {
  const c = capture();
  const code = await runEvalCli(
    ["--cases", casesFile([{ id: "c1", task: "say hi", assertions: [{ kind: "terminal", value: "succeeded" }] }]), "--forbidden", "SECRET-VALUE"],
    c.io,
  );
  const text = c.lines.join("\n");
  expect(code).toBe(0);
  expect(text).toContain("PASS c1");
  expect(text).toContain("terminal=succeeded");
  expect(text).toContain("eval cases passed");
  expect(text).toContain("summary: 1 case(s), 1 passed, 0 failed");
}, 30000);

test("an assertion the run does not satisfy fails the case and exits 1", async () => {
  const c = capture();
  const code = await runEvalCli(
    ["--cases", casesFile([{ id: "c2", task: "say hi", assertions: [{ kind: "terminal", value: "failed" }] }]), "--forbidden", "SECRET-VALUE"],
    c.io,
  );
  const text = c.lines.join("\n");
  expect(code).toBe(1);
  expect(text).toContain("FAIL c2");
  expect(text).toContain("terminal:");
  expect(text).toContain("summary: 1 case(s), 0 passed, 1 failed");
}, 30000);

test("an empty --forbidden list is refused before any execution", async () => {
  const c = capture();
  const code = await runEvalCli(["--cases", casesFile([{ id: "c3", task: "say hi" }])], c.io);
  expect(code).toBe(2);
  expect(c.errors.join("\n")).toContain("--forbidden is required");
  expect(c.lines).toEqual([]);
});

test("a corrupt post-mortem store is a refusal, never an empty set", async () => {
  const stateDir = tempDir("hz-eval-cli-");
  const c = capture();
  const code = await runEvalCli(["--postmortems", stateDir, "--forbidden", "NOPE"], c.io);
  expect(code).toBe(2);
  expect(c.errors.join("\n")).toContain("no runnable cases");

  const junk = path.join(postmortemsDir(stateDir), "broken.json");
  mkdirSync(path.dirname(junk), { recursive: true });
  writeFileSync(junk, "not json", "utf8");
  const c2 = capture();
  const code2 = await runEvalCli(["--postmortems", stateDir, "--forbidden", "NOPE"], c2.io);
  expect(code2).toBe(2);
  expect(c2.errors.join("\n")).toContain("corrupt");
});

test("a recorded post-mortem becomes a graded case (traceable id, honest verdict)", async () => {
  const stateDir = tempDir("hz-eval-cli-");
  const record = await recordPostmortem({
    stateDir,
    sessionId: "sess-cli",
    terminal: "failed",
    detail: "provider_error",
    transcript: [
      { seq: 1, role: "system", text: "rail" },
      { seq: 2, role: "user", text: "fix the parser test" },
      { seq: 3, role: "assistant", text: "on it" },
    ],
    toolCalls: ["read", "edit"],
    failureClass: "provider_error",
    now: 1_760_000_000_000,
  });
  const c = capture();
  const code = await runEvalCli(["--postmortems", stateDir, "--forbidden", "NOPE-NOT-PRESENT"], c.io);
  const text = c.lines.join("\n");
  // The derived case asserts the recorded terminal (failed); the mock run ends
  // succeeded, so the case must FAIL honestly rather than pass by construction.
  expect(code).toBe(1);
  expect(text).toContain(`FAIL eval-from-${record.id}`);
  expect(text).toContain("terminal:");
}, 30000);
