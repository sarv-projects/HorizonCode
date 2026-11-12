/**
 * managed-runtime.test.ts — the NF-071 acceptance suite (docs/24 §12.2 item 63).
 *
 *   "a worker proves identity before work is reserved; an interrupted turn's
 *    input is admitted once and `unknown` halts followers instead of replaying;
 *    a SIGKILL of the owner leaves no orphaned child tree (the supervisor
 *    fires); a corrupt spawn ledger quarantines instead of reading as empty."
 *
 * Real processes throughout: the supervisor test starts a fake owner and a
 * detached worker tree, SIGKILLs the owner, and observes the whole tree die.
 * Timing-sensitive assumptions are called out where they exist; the death
 * assertions below use a 5 s ceiling because the supervisor polls at 100 ms and
 * behaves differently on a loaded machine.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { AdmissionQueue } from "../../src/core/admission";
import { kernelStateDir, readSpawnLedger, spawnLedgerPath, spawnOwned } from "../../src/core/owned-spawn";
import { SessionStore } from "../../src/core/session";
import { startOwnerDeathSupervisor } from "../../src/core/supervisor";
import {
  birthIdentityOf,
  identityFromBirth,
  readProcessFacts,
  recordIdentity,
  verifyIdentity,
} from "../../src/core/worker-identity";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll `check` every 25 ms up to `timeoutMs`; true when it ever passed. */
async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

/** Read a whole stream to its end (used for short-lived test children). */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) text += decoder.decode(value, { stream: true });
    }
  } catch {
    /* stream closed by a kill */
  }
  return text;
}

/** Read until `pattern` appears (or the stream ends); leaves the reader locked. */
async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) text += decoder.decode(value, { stream: true });
      if (pattern.test(text)) break;
    }
  } catch {
    /* stream closed by a kill */
  }
  return text;
}

/* ----------------------------- the spawn ledger ----------------------------- */

describe("spawn ledger", () => {
  test("spawnOwned records a row and returns the live subprocess", async () => {
    const workspace = tempDir("hz-nf071-ledger-");
    const stateDir = kernelStateDir(workspace);
    const { proc, entry, identity } = await spawnOwned(["sh", "-c", "echo ledger-ok"], {
      stateDir,
      label: "test:ledger",
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      longLived: false,
    });
    const output = await readAll(proc.stdout);
    await proc.exited;
    expect(output.trim()).toBe("ledger-ok");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(false);
    expect(read.entries.length).toBe(1);
    const row = read.entries[0];
    expect(row.pid).toBe(proc.pid);
    expect(row.label).toBe("test:ledger");
    expect(row.cmd).toBe("sh -c echo ledger-ok");
    expect(row.birthIdentity).toBe(birthIdentityOf(identity));
    expect(identityFromBirth(row.birthIdentity)).toEqual(identity);
    expect(typeof row.pgid === "number" && row.pgid > 0).toBe(true);
    expect(row.ts.length).toBeGreaterThan(0);
  });

  test("a corrupt ledger quarantines instead of reading as empty", async () => {
    const workspace = tempDir("hz-nf071-corrupt-");
    const stateDir = kernelStateDir(workspace);
    const file = spawnLedgerPath(stateDir);
    mkdirSync(path.dirname(file), { recursive: true });
    const goodRow = JSON.stringify({ pid: 1, pgid: 1, birthIdentity: "1@1", label: "ok", ts: "t", cmd: "x" });
    writeFileSync(file, `${goodRow}\nnot json at all\n`, "utf8");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(true);
    expect(read.entries).toEqual([]);
    expect(read.quarantinedTo).toBeDefined();
    expect(read.reason).toContain("line 2");
    expect(existsSync(file)).toBe(false);
    const quarantined = read.quarantinedTo as string;
    expect(path.basename(quarantined)).toMatch(/^spawns\.jsonl\.corrupt-\d+$/);
    // The bytes are preserved for inspection — quarantined, never dropped.
    expect(readFileSync(quarantined, "utf8")).toContain("not json at all");

    // The refusal is not sticky: a fresh empty ledger is healthy, and a later
    // spawn writes a clean file rather than appending to a quarantined one.
    expect(await readSpawnLedger(stateDir)).toEqual({ entries: [], corrupt: false });
    const { proc } = await spawnOwned(["true"], {
      stateDir,
      label: "test:after-quarantine",
      stdio: { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      longLived: false,
    });
    await proc.exited;
    const fresh = await readSpawnLedger(stateDir);
    expect(fresh.corrupt).toBe(false);
    expect(fresh.entries.map((row) => row.label)).toEqual(["test:after-quarantine"]);
  });

  test("a structurally invalid row also quarantines", async () => {
    const workspace = tempDir("hz-nf071-corrupt-shape-");
    const stateDir = kernelStateDir(workspace);
    const file = spawnLedgerPath(stateDir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ pid: "not-a-number" })}\n`, "utf8");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(true);
    expect(read.entries).toEqual([]);
    expect(read.reason).toContain("not a spawn row");
  });
});

/* ------------------------------- worker identity ------------------------------- */

describe("worker identity", () => {
  test("a live worker proves identity; pid reuse and death are refused", async () => {
    const workspace = tempDir("hz-nf071-identity-");
    const { proc } = await spawnOwned(["sleep", "300"], {
      stateDir: kernelStateDir(workspace),
      label: "test:identity",
      stdio: { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    });
    try {
      const identity = recordIdentity(proc.pid);
      expect(identity).toBeDefined();
      expect(identity?.pid).toBe(proc.pid);
      expect(identity?.startTicks).toBeGreaterThan(0);
      expect(verifyIdentity(identity)).toEqual({ ok: true });

      // pid reuse: the same pid number with a different birth is a different
      // process — refused, not accepted as "the same worker".
      const reused = verifyIdentity({ pid: proc.pid, startTicks: (identity?.startTicks ?? 0) + 1 });
      expect(reused.ok).toBe(false);
      expect(reused.reason).toContain("reused");

      // A pid with no /proc entry at all is refused (and an absent record too).
      expect(verifyIdentity({ pid: 2 ** 30, startTicks: 1 }).ok).toBe(false);
      expect(verifyIdentity(undefined).ok).toBe(false);
      expect(verifyIdentity(null).ok).toBe(false);
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await Promise.race([proc.exited, sleep(2000)]);
    }
  });
});

/* --------------------------- owner-death supervisor --------------------------- */

describe("owner-death supervisor", () => {
  test("SIGKILL of the owner leaves no orphaned child tree (the supervisor fires)", async () => {
    const workspace = tempDir("hz-nf071-supervisor-");
    const stateDir = kernelStateDir(workspace);

    // (a) A fake owner that does nothing but exist. Passing ownerPid to
    // spawnOwned is step (b): long-lived spawns start the owner-death
    // supervisor themselves, watching this owner.
    const owner = Bun.spawn({ cmd: ["sleep", "300"], stdio: ["ignore", "ignore", "ignore"] });
    const spawned = await spawnOwned(["sh", "-c", "sleep 300 & echo GC=$!; sleep 300"], {
      stateDir,
      label: "test:supervisor",
      ownerPid: owner.pid,
      detached: true,
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    });
    const worker = spawned.proc;
    const workerPid = worker.pid;
    let grandchildPid = -1;
    try {
      // The worker prints its background child's pid before settling in to sleep.
      const banner = await readUntil(worker.stdout, /GC=\d+/);
      const match = /GC=(\d+)/.exec(banner);
      expect(match).not.toBeNull();
      grandchildPid = Number(match?.[1]);
      expect(grandchildPid).toBeGreaterThan(0);

      // Identity proven while alive; detached → the worker leads its own group,
      // which is exactly what the supervisor's `kill -9 -WORKER` needs.
      const identity = recordIdentity(workerPid);
      expect(verifyIdentity(identity).ok).toBe(true);
      expect(readProcessFacts(workerPid)?.pgid).toBe(workerPid);
      expect(spawned.entry.pgid).toBe(workerPid);
      expect(alive(workerPid)).toBe(true);
      expect(alive(grandchildPid)).toBe(true);

      // (c) Fire SIGKILL at the owner.
      // Timing-sensitive: the supervisor polls at 100 ms, so detection has a
      // ~0.1 s floor and can be slower on a loaded machine. The 5 s ceiling
      // below is test slack, not a product promise.
      const killedAt = Date.now();
      process.kill(owner.pid, "SIGKILL");

      // (d) The whole tree must go: the worker itself and the grandchild it
      // backgrounded (reparented when the worker dies).
      const gone = await waitUntil(() => !alive(workerPid) && !alive(grandchildPid), 5000);
      const latency = Date.now() - killedAt;
      console.log(`[nf-071] SIGKILL of the owner -> worker tree gone in ${latency}ms`);
      expect(gone).toBe(true);
      expect(alive(workerPid)).toBe(false);
      expect(alive(grandchildPid)).toBe(false);
    } finally {
      // (e) Cleanup whatever the assertions caught mid-flight.
      try {
        process.kill(-workerPid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        worker.kill("SIGKILL");
      } catch {
        /* gone */
      }
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      await Promise.race([worker.exited, sleep(2000)]);
      await Promise.race([owner.exited, sleep(2000)]);
    }
  });

  test("the supervisor exits when the worker exits, without touching the owner", async () => {
    const owner = Bun.spawn({ cmd: ["sleep", "300"], stdio: ["ignore", "ignore", "ignore"] });
    const worker = Bun.spawn({ cmd: ["sleep", "300"], detached: true, stdio: ["ignore", "ignore", "ignore"] });
    const supervisor = startOwnerDeathSupervisor({ ownerPid: owner.pid, workerPid: worker.pid });
    try {
      expect(supervisor.pid).toBeGreaterThan(0);
      // Both alive → the supervisor stays up (timing-sensitive: 250 ms is well
      // inside the 300 s both processes sleep for).
      await sleep(250);
      expect(alive(supervisor.pid)).toBe(true);

      worker.kill("SIGKILL");
      await worker.exited;
      const exited = await Promise.race([supervisor.exited.then(() => true), sleep(3000).then(() => false)]);
      expect(exited).toBe(true);
      expect(alive(owner.pid)).toBe(true); // the owner was never in scope for a kill
    } finally {
      supervisor.stop();
      try {
        process.kill(owner.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        worker.kill("SIGKILL");
      } catch {
        /* gone */
      }
      await Promise.race([owner.exited, sleep(2000)]);
    }
  });
});

/* ----------------------------- admission FIFO ----------------------------- */

describe("admission FIFO", () => {
  test(
    "admit-once by id; explicit queued -> running -> settled transitions",
    () => {
    const workspace = tempDir("hz-nf071-admit-");
    const store = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(store);
      expect(queue.admit("s1", "first input", "adm-1")).toBe("adm-1");
      // Same id, different text: nothing is inserted and nothing is rewritten.
      expect(queue.admit("s1", "a different text", "adm-1")).toBe("adm-1");
      let rows = queue.list("s1");
      expect(rows.length).toBe(1);
      expect(rows[0].input).toBe("first input");
      expect(rows[0].state).toBe("queued");

      expect(queue.begin("adm-1")).toBe(true);
      expect(queue.begin("adm-1")).toBe(false); // never begins twice
      expect(queue.list("s1", "running").length).toBe(1);

      expect(queue.settle("adm-1", "done", "exit 0")).toBe(true);
      // A settled row is terminal for the machine: no re-settlement, no replay.
      expect(queue.settle("adm-1", "unknown", "retry?")).toBe(false);
      rows = queue.list("s1");
      expect(rows[0].state).toBe("done");
      expect(rows[0].evidence).toBe("exit 0");

      // Dedupe is by id only: the same text under a new id is a new admission.
      queue.admit("s1", "first input", "adm-2");
      expect(queue.list("s1").length).toBe(2);
      expect(queue.list("s2")).toEqual([]);
    } finally {
      store.close();
    }
  },
  15_000,
  );

  test("an unknown row halts followers; resolve('drop') unblocks", () => {
    const workspace = tempDir("hz-nf071-halt-");
    const store = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(store);
      queue.admit("s1", "turn a", "a");
      queue.admit("s1", "turn b", "b");
      queue.admit("s1", "turn c", "c");
      expect(queue.nextRunnable("s1")).toEqual({ runnable: true, row: expect.objectContaining({ id: "a" }) });
      expect(queue.begin("a")).toBe(true);

      // The turn died mid-flight: its effect may or may not have happened.
      expect(queue.settle("a", "unknown", "worker died mid-turn")).toBe(true);
      expect(queue.nextRunnable("s1")).toEqual({ runnable: false, halted: true, blockedBy: "a" });
      // Followers cannot start around the halt, even by asking directly.
      expect(queue.begin("b")).toBe(false);
      expect(queue.begin("c")).toBe(false);

      // The explicit human/integrator resolution is the only way out.
      const dropped = queue.resolve("a", "drop");
      expect(dropped?.state).toBe("cancelled");
      expect(dropped?.evidence).toContain("resolve:drop");
      expect(queue.nextRunnable("s1")).toEqual({ runnable: true, row: expect.objectContaining({ id: "b" }) });
      expect(queue.begin("b")).toBe(true);
      queue.settle("b", "done");
      expect(queue.nextRunnable("s1")).toEqual({ runnable: true, row: expect.objectContaining({ id: "c" }) });
    } finally {
      store.close();
    }
  });

  test("resolve('requeue') puts an unknown row back in its place and it blocks again", () => {
    const workspace = tempDir("hz-nf071-requeue-");
    const store = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(store);
      queue.admit("s1", "turn a", "a");
      queue.admit("s1", "turn b", "b");
      queue.begin("a");
      queue.settle("a", "unknown");
      expect(queue.resolve("a", "requeue")?.state).toBe("queued");
      expect(queue.nextRunnable("s1")).toEqual({ runnable: true, row: expect.objectContaining({ id: "a" }) });
      expect(queue.begin("a")).toBe(true);
      // Non-unknown rows cannot be "resolved" — resolution is for halted rows.
      expect(queue.resolve("b", "requeue")).toBeUndefined();
      expect(queue.resolve("nope", "drop")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("recoverInterrupted marks running -> unknown with evidence, across a reopen", () => {
    const workspace = tempDir("hz-nf071-recover-");
    const first = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(first);
      expect(queue.admit("s1", "interrupted turn", "run-1")).toBe("run-1");
      expect(queue.begin("run-1")).toBe(true);
    } finally {
      first.close();
    }

    // Persistence across reopen: a new store (and queue) on the same db path.
    const second = new SessionStore(workspace);
    try {
      const queue = new AdmissionQueue(second);
      expect(queue.list("s1").map((row) => [row.id, row.state])).toEqual([["run-1", "running"]]);

      // Startup recovery: a running row means the process restarted mid-turn.
      expect(queue.recoverInterrupted("s1")).toEqual(["run-1"]);
      const recovered = queue.list("s1")[0];
      expect(recovered.state).toBe("unknown");
      expect(recovered.evidence).toBe("interrupted");
      expect(queue.recoverInterrupted("s1")).toEqual([]); // idempotent

      // The recovered turn halts its follower instead of replaying it.
      queue.admit("s1", "follower", "run-2");
      expect(queue.nextRunnable("s1")).toEqual({ runnable: false, halted: true, blockedBy: "run-1" });
      expect(queue.begin("run-2")).toBe(false);
      expect(queue.resolve("run-1", "drop")?.state).toBe("cancelled");
      expect(queue.nextRunnable("s1")).toEqual({ runnable: true, row: expect.objectContaining({ id: "run-2" }) });

      // And an idle queue reports itself idle, not halted.
      expect(queue.nextRunnable("other-session")).toEqual({ runnable: false, halted: false });
    } finally {
      second.close();
    }
  });
});
