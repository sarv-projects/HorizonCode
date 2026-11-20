/**
 * Under-admission seams: opt-in durable todos, handoff_resume merges, and
 * MEMORY.md sync must not mutate disk without an fs.write Guard decision.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { handoffDbPath } from "../../src/core/memory/handoff";
import { MEMORY_FILE } from "../../src/core/memory/manifest";
import { memoryDbPathForBank } from "../../src/core/memory/store";
import { stateRoot } from "../../src/core/paths";
import { handoffCreateTool, handoffResumeTool } from "../../src/tools/handoff";
import { memoryForgetTool, memoryRememberTool } from "../../src/tools/memory-write";
import { repoMapCachePath } from "../../src/tools/repo-map-cache";
import { repoMapTool } from "../../src/tools/repo-map";
import { todoTool } from "../../src/tools/todo";
import { makeWorkspace, mockToolContext } from "./helpers";

const prevDurable = process.env.HZ_TODO_DURABLE;
const prevMemoryMd = process.env.HZ_MEMORY_SYNC_MEMORY_MD;

beforeEach(() => {
  process.env.HZ_TODO_DURABLE = "1";
  process.env.HZ_MEMORY_SYNC_MEMORY_MD = "1";
});

afterEach(() => {
  if (prevDurable === undefined) delete process.env.HZ_TODO_DURABLE;
  else process.env.HZ_TODO_DURABLE = prevDurable;
  if (prevMemoryMd === undefined) delete process.env.HZ_MEMORY_SYNC_MEMORY_MD;
  else process.env.HZ_MEMORY_SYNC_MEMORY_MD = prevMemoryMd;
});

describe("under-admission guard seams", () => {
  test("todo add with HZ_TODO_DURABLE=1 guards handoffs.db and refuses on deny", async () => {
    const ws = makeWorkspace();
    const db = handoffDbPath(ws);
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (action) =>
        action.kind === "fs.write" && action.target === db
          ? { decision: "deny", reason: "test-deny-durable" }
          : { decision: "allow" },
    });

    const r = await todoTool.execute({ action: "add", text: "ship under-admission" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error ?? r.output).toMatch(/denied|test-deny-durable/i);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === db)).toBe(true);
    expect(existsSync(db)).toBe(false);
  });

  test("todo add with HZ_TODO_DURABLE=1 persists only after allow", async () => {
    const ws = makeWorkspace();
    const db = handoffDbPath(ws);
    const ctx = mockToolContext({ cwd: ws, workspace: ws, decision: "allow" });
    const r = await todoTool.execute({ action: "add", text: "persist me" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === db)).toBe(true);
    expect(existsSync(db)).toBe(true);
  });

  test("handoff_create guards handoffs.db and refuses on deny", async () => {
    const ws = makeWorkspace();
    const db = handoffDbPath(ws);
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (action) =>
        action.kind === "fs.write" && action.target === db
          ? { decision: "deny", reason: "test-deny-handoff-create" }
          : { decision: "allow" },
    });

    const r = await handoffCreateTool.execute({ summary: "should not persist" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error ?? r.output).toMatch(/denied|test-deny-handoff-create/i);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === db)).toBe(true);
    expect(existsSync(db)).toBe(false);
  });

  test("handoff_resume merge_durable_branch guards fs.write and refuses on deny", async () => {
    const ws = makeWorkspace();
    const db = handoffDbPath(ws);
    mkdirSync(path.dirname(db), { recursive: true });
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (action) =>
        action.kind === "fs.write" && action.target === db
          ? { decision: "deny", reason: "test-deny-merge" }
          : { decision: "allow" },
    });

    const r = await handoffResumeTool.execute({ merge_durable_branch: "other-branch" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error ?? r.output).toMatch(/denied|test-deny-merge/i);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === db)).toBe(true);
  });

  test("memory_remember MEMORY.md sync guards the manifest path and refuses on deny", async () => {
    const ws = makeWorkspace();
    const md = path.join(stateRoot(ws), MEMORY_FILE);
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (action) =>
        action.kind === "fs.write" && action.target === md
          ? { decision: "deny", reason: "test-deny-memory-md" }
          : { decision: "allow" },
    });

    const r = await memoryRememberTool.execute({ content: "fact under admission" }, ctx);
    // DB write may succeed under allow; MEMORY.md must not appear after deny.
    expect(existsSync(md)).toBe(false);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === md)).toBe(true);
    // Either overall fail or ok without MEMORY.md update — never silent append.
    if (r.ok) {
      expect(r.output).not.toMatch(/MEMORY\.md index updated/);
    } else {
      expect(r.error ?? r.output).toMatch(/denied|test-deny-memory-md/i);
    }
    if (existsSync(md)) {
      expect(readFileSync(md, "utf8")).not.toContain("fact under admission");
    }
  });

  test("memory_remember guards memory.db and refuses on deny (ruling 554)", async () => {
    const ws = makeWorkspace();
    const db = memoryDbPathForBank(ws, "project");
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (action) =>
        action.kind === "fs.write" && action.target === db
          ? { decision: "deny", reason: "test-deny-memory-db" }
          : { decision: "allow" },
    });
    const r = await memoryRememberTool.execute({ content: "should not land in bank" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error ?? r.output).toMatch(/denied|test-deny-memory-db/i);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === db)).toBe(true);
    expect(existsSync(db)).toBe(false);
  });

  test("memory_forget guards memory.db and refuses on deny (ruling 554)", async () => {
    const ws = makeWorkspace();
    const db = memoryDbPathForBank(ws, "project");
    const allowCtx = mockToolContext({ cwd: ws, workspace: ws, decision: "allow" });
    await memoryRememberTool.execute({ content: "forget-me-under-admission" }, allowCtx);
    expect(existsSync(db)).toBe(true);
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (action) =>
        action.kind === "fs.write" && action.target === db
          ? { decision: "deny", reason: "test-deny-memory-forget" }
          : { decision: "allow" },
    });
    const r = await memoryForgetTool.execute({ content: "forget-me-under-admission" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error ?? r.output).toMatch(/denied|test-deny-memory-forget/i);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === db)).toBe(true);
  });

  test("repo_map skips durable cache write when fs.write denied (ruling 564)", async () => {
    const ws = makeWorkspace();
    writeFileSync(path.join(ws, "main.ts"), "export function hello() { return 1; }\n", "utf8");
    const cache = repoMapCachePath(ws);
    const ctx = mockToolContext({
      cwd: ws,
      workspace: ws,
      decision: (action) =>
        action.kind === "fs.write" && action.target === cache
          ? { decision: "deny", reason: "test-deny-repo-map-cache" }
          : { decision: "allow" },
    });
    const r = await repoMapTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.guardCalls.some((a) => a.kind === "fs.write" && a.target === cache)).toBe(true);
    expect(existsSync(cache)).toBe(false);
  });
});
