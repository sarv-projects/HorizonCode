/** Cross-process advisory locking (core/file-lock.ts) with real child processes. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { acquireLockSync, LockTimeoutError, pidAlive, targetLockPath, withFileLock, withFileLockSync } from "../../src/core/file-lock";
import { reloadFromDisk } from "../../src/tools/change-journal";
import { LocalKernel } from "../../src/core/kernel";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-lock-test-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const WORKER = path.join(import.meta.dir, "fixtures", "lock-worker.ts");

function spawnWorker(...args: string[]) {
  return Bun.spawn(["bun", WORKER, ...args], { stdout: "pipe", stderr: "pipe" });
}
async function finish(p: ReturnType<typeof spawnWorker>): Promise<string> {
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`worker exited ${code}: ${err}`);
  return out.trim();
}
/** A pid that is certainly dead: a child that already exited. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

describe("file-lock unit", () => {
  test("acquire, exclude a live holder until timeout, release", () => {
    const lock = path.join(root(), "a.lock");
    const release = acquireLockSync(lock);
    expect(existsSync(lock)).toBe(true);
    // Held by THIS live pid: a second acquire must time out, naming the holder.
    let err: unknown;
    try {
      acquireLockSync(lock, { timeoutMs: 80 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as LockTimeoutError).holderPid).toBe(process.pid);
    release();
    expect(existsSync(lock)).toBe(false);
    acquireLockSync(lock, { timeoutMs: 80 })();
  });

  test("a lock held by a dead pid is stale and reclaimed", async () => {
    const lock = path.join(root(), "stale.lock");
    writeFileSync(lock, `${await deadPid()}\ndeadbeef\n`);
    const release = acquireLockSync(lock, { timeoutMs: 500 });
    expect(readFileSync(lock, "utf8").startsWith(`${process.pid}\n`)).toBe(true);
    release();
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(path.dirname(lock)).filter((f) => f.includes(".stale-"))).toEqual([]);
  });

  test("an empty lock is live inside the grace window and stale after it", () => {
    const lock = path.join(root(), "empty.lock");
    writeFileSync(lock, "");
    expect(() => acquireLockSync(lock, { timeoutMs: 60, emptyGraceMs: 60_000 })).toThrow(LockTimeoutError);
    acquireLockSync(lock, { timeoutMs: 500, emptyGraceMs: 0 })();
  });

  test("release never deletes a lock that now belongs to someone else", async () => {
    const lock = path.join(root(), "stolen.lock");
    const release = acquireLockSync(lock);
    writeFileSync(lock, `${process.pid}\nanother-token\n`);
    release();
    expect(readFileSync(lock, "utf8")).toContain("another-token");
  });

  test("withFileLock releases on throw; an uncreatable lock dir runs unlocked", async () => {
    const dir = root();
    const lock = path.join(dir, "t.lock");
    await expect(withFileLock(lock, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lock)).toBe(false);
    // The parent is a FILE: the lock cannot be created (ENOTDIR). The caller's own work still runs.
    writeFileSync(path.join(dir, "file"), "x");
    expect(withFileLockSync(path.join(dir, "file", "x.lock"), () => 7)).toBe(7);
  });

  test("pidAlive", async () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(await deadPid())).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });
});

describe("two real processes", () => {
  test("a locked read-modify-write loses no update (fails without the lock)", async () => {
    const dir = root();
    const counter = path.join(dir, "n");
    writeFileSync(counter, "0");
    const lock = path.join(dir, "n.lock");
    const procs = [spawnWorker("counter", lock, counter, "40"), spawnWorker("counter", lock, counter, "40")];
    await Promise.all(procs.map(finish));
    expect(readFileSync(counter, "utf8")).toBe("80");
  });

  test("kernel event appends from two processes keep one gapless hash chain", async () => {
    const stateDir = path.join(root(), "kstate");
    mkdirSync(stateDir, { recursive: true });
    const procs = [spawnWorker("events", stateDir, "s", "25"), spawnWorker("events", stateDir, "s", "25")];
    await Promise.all(procs.map(finish));
    const events = await new LocalKernel({ stateDir }).readEvents("s");
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    for (let i = 1; i < events.length; i += 1) expect(events[i]!.prevHash).toBe(events[i - 1]!.hash);
  });

  test("journal appends from two processes are all durable and intact", async () => {
    const ws = root();
    const procs = [spawnWorker("journal", ws, "a", "30"), spawnWorker("journal", ws, "b", "30")];
    await Promise.all(procs.map(finish));
    const load = reloadFromDisk(ws);
    expect(load.corrupt).toBe(false);
    expect(load.entries.length).toBe(60);
  });

  test("a second process's edit waits for the file lock, then reports a stale preimage instead of clobbering", async () => {
    const ws = root();
    const file = path.join(ws, "f.txt");
    writeFileSync(file, "alpha\n");
    const held = acquireLockSync(targetLockPath(ws, file));
    const child = spawnWorker("edit", ws, "f.txt", "alpha", "child-edit");
    // While the lock is held the child must NOT have written (fails if the edit tool takes no lock).
    await Bun.sleep(600);
    expect(readFileSync(file, "utf8")).toBe("alpha\n");
    // The lock holder (another "process") changes the file, then releases.
    writeFileSync(file, "alpha-changed-by-other-process\n");
    held();
    const result = JSON.parse(await finish(child));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("preimage changed");
    expect(readFileSync(file, "utf8")).toBe("alpha-changed-by-other-process\n");
  });

  const OTHER = "other-process-change\n";
  const cases: Array<[string, string, string, Record<string, unknown>]> = [
    ["write", "w.txt", "base\n", { path: "w.txt", content: "child\n", force: true }],
    ["apply_patch", "p.txt", "base\n", { input: "*** Begin Patch\n*** Update File: p.txt\n@@\n-base\n+child\n*** End Patch" }],
    ["ast_edit", "a.ts", "foo(1)\n", { path: "a.ts", pat: "foo($A)", out: "bar($A)" }],
  ];
  for (const [tool, name, initial, args] of cases) {
    test(`${tool} waits on the file lock and never clobbers another process's change`, async () => {
      const ws = root();
      const file = path.join(ws, name);
      writeFileSync(file, initial);
      const held = acquireLockSync(targetLockPath(ws, file));
      const child = spawnWorker("tool", ws, tool, JSON.stringify(args));
      await Bun.sleep(600);
      expect(readFileSync(file, "utf8")).toBe(initial);
      writeFileSync(file, OTHER);
      held();
      const result = JSON.parse(await finish(child));
      expect(result.ok).toBe(false);
      expect(result.error).toContain("preimage changed");
      expect(readFileSync(file, "utf8")).toBe(OTHER);
    });
  }

  test("an edit reclaims a lock left by a crashed (dead-pid) holder and succeeds", async () => {
    const ws = root();
    const file = path.join(ws, "g.txt");
    writeFileSync(file, "one\n");
    const lock = targetLockPath(ws, file);
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, `${await deadPid()}\ncrashed\n`);
    const result = JSON.parse(await finish(spawnWorker("edit", ws, "g.txt", "one", "two")));
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("two\n");
    expect(existsSync(lock)).toBe(false);
  });
});
