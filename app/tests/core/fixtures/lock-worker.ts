/**
 * Child-process worker for file-lock.test.ts. Each mode is one real OS process
 * contending with its siblings. Result is printed as one JSON line.
 *   counter <lockPath> <counterFile> <n>   locked read-modify-write increments
 *   events  <stateDir> <stream> <n>         LocalKernel.appendEvent x n
 *   journal <workspace> <tag> <n>           recordChange x n
 *   edit    <workspace> <file> <old> <new>  the real edit tool
 *   tool    <workspace> <name> <json args>  write | apply_patch | ast_edit (reads the file first)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { withFileLockSync } from "../../../src/core/file-lock";
import { LocalKernel } from "../../../src/core/kernel";
import { recordChange } from "../../../src/tools/change-journal";
import { applyPatchTool } from "../../../src/tools/apply-patch";
import { astEditTool } from "../../../src/tools/ast-edit";
import { editTool } from "../../../src/tools/edit";
import { readTool } from "../../../src/tools/read";
import { writeTool } from "../../../src/tools/write";

const [mode, a, b, c, d] = process.argv.slice(2);

if (mode === "counter") {
  for (let i = 0; i < Number(c); i += 1) {
    withFileLockSync(a!, () => {
      const v = Number(readFileSync(b!, "utf8"));
      // Widen the race window: without mutual exclusion updates are lost.
      Bun.sleepSync(1);
      writeFileSync(b!, String(v + 1));
    });
  }
  console.log(JSON.stringify({ ok: true }));
} else if (mode === "events") {
  const kernel = new LocalKernel({ stateDir: a! });
  for (let i = 0; i < Number(c); i += 1) await kernel.appendEvent(b!, { type: "t", payload: { pid: process.pid, i } });
  console.log(JSON.stringify({ ok: true }));
} else if (mode === "journal") {
  for (let i = 0; i < Number(c); i += 1) {
    recordChange(`s-${b}`, {
      path: `${a}/${b}-${i}.txt`,
      rel: `${b}-${i}.txt`,
      before: null,
      afterSha256: "0".repeat(64),
      at: Date.now(),
      tool: "write",
    });
  }
  console.log(JSON.stringify({ ok: true }));
} else if (mode === "edit" || mode === "tool") {
  const ws = a!;
  const ctx = {
    cwd: ws,
    workspace: ws,
    sessionId: `edit-${process.pid}`,
    signal: new AbortController().signal,
    guard: async () => ({ decision: "allow" as const }),
    approve: async () => true,
    receipt: async () => ({}) as never,
  };
  if (mode === "edit") {
    console.log(JSON.stringify(await editTool.execute({ path: b!, old: c!, new: d! }, ctx as never)));
  } else {
    const args = JSON.parse(c!) as Record<string, unknown>;
    if (typeof args.path === "string") await readTool.execute({ path: args.path }, ctx as never);
    const tool = { write: writeTool, apply_patch: applyPatchTool, ast_edit: astEditTool }[b as "write"];
    console.log(JSON.stringify(await tool.execute(args, ctx as never)));
  }
}
