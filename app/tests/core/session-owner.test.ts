/**
 * session-owner.test.ts — the cross-process exclusive session lease.
 *
 * The audit finding: `createRuntime` repaired the transcript and settled a
 * `running` admission UNCONDITIONALLY, so a second hzcode process could mark a
 * live turn unknown and rewrite rows under the first writer. These tests hold
 * the lease through a real, separately-spawned `sleep` process (a live foreign
 * pid), prove the second acquisition is refused without touching the queue,
 * then kill it and prove the stale owner is taken over and only THEN recovered.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { hostname } from "node:os";
import * as path from "node:path";
import { AdmissionQueue } from "../../src/core/admission";
import { createRuntime } from "../../src/core/index";
import { SessionStore } from "../../src/core/session";
import {
  acquireOwner,
  acquireOwnedSession,
  claimSessionForRecovery,
  currentOwnerIdentity,
  isOwnerLive,
  readBootId,
  readProcessStartTicks,
  readSessionOwner,
  releaseOwner,
  SessionOwnedError,
  touchOwner,
  type OwnerIdentity,
  type SessionOwnerRecord,
} from "../../src/core/session-owner";
import { cleanupTemps, tempDir } from "./helpers";

const children: Subprocess[] = [];
const stores: SessionStore[] = [];

afterAll(() => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  cleanupTemps();
});

function openStore(workspace: string): SessionStore {
  const store = new SessionStore(workspace);
  stores.push(store);
  return store;
}

/** A real live process we can point the lease at, plus its true identity. */
function liveForeignOwner(): { child: Subprocess; identity: OwnerIdentity } {
  const child = spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  const ticks = readProcessStartTicks(child.pid);
  return {
    child,
    identity: {
      pid: child.pid,
      bootId: readBootId(),
      startTicks: ticks,
      host: hostname(),
    },
  };
}

async function stopChild(child: Subprocess): Promise<void> {
  try {
    child.kill();
  } catch {
    /* already dead */
  }
  try {
    await child.exited;
  } catch {
    /* reaped */
  }
}

/**
 * A real second PROCESS that tries to acquire the session: 0 = acquired,
 * 3 = refused with a SessionOwnedError. Its exit hook releases an acquired row.
 */
function ownerChild(workspace: string, sessionId: string): Subprocess {
  const appRoot = path.resolve(import.meta.dir, "../..");
  const sessionModule = path.join(appRoot, "src/core/session.ts");
  const ownerModule = path.join(appRoot, "src/core/session-owner.ts");
  const script =
    `import { SessionStore } from ${JSON.stringify(sessionModule)}; ` +
    `import { acquireOwnedSession } from ${JSON.stringify(ownerModule)}; ` +
    "const store = new SessionStore(process.env.HZ_OWNER_WS); " +
    "try { " +
    "  acquireOwnedSession(store, process.env.HZ_OWNER_SESSION, { heartbeat: false }); " +
    '  console.log("acquired"); ' +
    "  process.exit(0); " +
    "} catch (err) { " +
    '  console.log("refused:" + (err && err.name ? err.name : String(err))); ' +
    "  process.exit(3); " +
    "}";
  const child = spawn(["bun", "-e", script], {
    cwd: appRoot,
    env: { ...process.env, HZ_OWNER_WS: workspace, HZ_OWNER_SESSION: sessionId },
    stdout: "pipe",
    stderr: "ignore",
  });
  children.push(child);
  return child;
}

function childResult(child: Subprocess): Promise<{ stdout: string; exitCode: number }> {
  return Promise.all([new Response(child.stdout).text(), child.exited]).then(([stdout, exitCode]) => ({
    stdout,
    exitCode,
  }));
}

/** A fake record for isOwnerLive edge cases (no database needed). */
function record(overrides: Partial<SessionOwnerRecord> = {}): SessionOwnerRecord {
  return {
    sessionId: "session-1",
    pid: process.pid,
    bootId: readBootId(),
    startTicks: readProcessStartTicks(process.pid),
    epoch: "epoch-1",
    heartbeatAt: new Date().toISOString(),
    host: hostname(),
    ...overrides,
  };
}

describe("session-owner: exclusive acquisition", () => {
  test("a second acquisition is refused while the first owner is live", () => {
    const workspace = tempDir("hz-owner-live-");
    const firstStore = openStore(workspace);
    const secondStore = openStore(workspace);
    const session = firstStore.createSession("owned");
    const { child, identity } = liveForeignOwner();

    const first = acquireOwner(firstStore, session.id, identity);
    expect(first.acquired).toBe(true);
    expect(readSessionOwner(secondStore, session.id)?.pid).toBe(child.pid);

    const second = acquireOwner(secondStore, session.id, currentOwnerIdentity());
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.owner.pid).toBe(child.pid);

    expect(() =>
      acquireOwnedSession(secondStore, session.id, { identity: currentOwnerIdentity(), heartbeat: false }),
    ).toThrow(SessionOwnedError);
    // The refusal touched nothing: the live owner's row is unchanged.
    expect(readSessionOwner(secondStore, session.id)?.pid).toBe(child.pid);
  });

  test("release allows reacquisition (and is epoch-scoped)", async () => {
    const workspace = tempDir("hz-owner-release-");
    const store = openStore(workspace);
    const session = store.createSession("release");
    const { child, identity } = liveForeignOwner();

    const first = acquireOwner(store, session.id, identity);
    expect(first.acquired).toBe(true);
    const epoch = first.acquired ? first.owner.epoch : "";

    // A shutdown from a different epoch must never delete the current lease.
    expect(releaseOwner(store, session.id, "not-the-epoch")).toBe(false);
    expect(readSessionOwner(store, session.id)?.epoch).toBe(epoch);

    await stopChild(child);
    expect(releaseOwner(store, session.id, epoch)).toBe(true);
    expect(readSessionOwner(store, session.id)).toBeNull();

    const again = acquireOwner(store, session.id, currentOwnerIdentity());
    expect(again.acquired).toBe(true);
    if (again.acquired) expect(releaseOwner(store, session.id, again.owner.epoch)).toBe(true);
  });

  test("a provably dead pid is taken over", () => {
    const workspace = tempDir("hz-owner-stale-pid-");
    const store = openStore(workspace);
    const session = store.createSession("stale-pid");

    const dead: OwnerIdentity = {
      pid: 999_999_999,
      bootId: readBootId(),
      startTicks: 1,
      host: hostname(),
    };
    expect(acquireOwner(store, session.id, dead).acquired).toBe(true);

    const takeover = acquireOwner(store, session.id, currentOwnerIdentity());
    expect(takeover.acquired).toBe(true);
    if (takeover.acquired) {
      expect(takeover.tookOver).toBe(true);
      expect(takeover.owner.pid).toBe(process.pid);
    }
    expect(readSessionOwner(store, session.id)?.pid).toBe(process.pid);
  });

  test("a different boot id proves the owner is stale even when the pid is alive", () => {
    const workspace = tempDir("hz-owner-stale-boot-");
    const store = openStore(workspace);
    const session = store.createSession("stale-boot");

    // Record OUR live pid, but from a previous boot: the machine restarted and
    // the pid now belongs to this process, not the recorded writer.
    const oldBoot = acquireOwner(store, session.id, {
      pid: process.pid,
      bootId: "boot-id-from-a-previous-boot",
      startTicks: readProcessStartTicks(process.pid),
      host: hostname(),
    });
    expect(oldBoot.acquired).toBe(true);

    const takeover = acquireOwner(store, session.id, currentOwnerIdentity());
    expect(takeover.acquired).toBe(true);
    if (takeover.acquired) expect(takeover.tookOver).toBe(true);
  });

  test.skipIf(process.platform !== "linux")("a start-ticks mismatch proves pid reuse", () => {
    const workspace = tempDir("hz-owner-ticks-");
    const store = openStore(workspace);
    const session = store.createSession("pid-reuse");
    const ticks = readProcessStartTicks(process.pid);
    expect(ticks).not.toBeNull();

    const old = acquireOwner(store, session.id, {
      pid: process.pid,
      bootId: readBootId(),
      startTicks: (ticks ?? 0) + 1, // same pid, older process
      host: hostname(),
    });
    expect(old.acquired).toBe(true);

    // isOwnerLive alone must call it dead; acquire then takes it over.
    const row = readSessionOwner(store, session.id);
    expect(row).not.toBeNull();
    expect(isOwnerLive(row!)).toBe(false);

    const takeover = acquireOwner(store, session.id, currentOwnerIdentity());
    expect(takeover.acquired).toBe(true);
    if (takeover.acquired) expect(takeover.tookOver).toBe(true);
  });

  test("isOwnerLive fails closed on uncertainty and foreign hosts", () => {
    expect(isOwnerLive(record({ host: "some-other-machine" }))).toBe(true);
    expect(isOwnerLive(record({ pid: 0 }))).toBe(true);
    expect(isOwnerLive(record({ pid: 999_999_999 }))).toBe(false);
    expect(isOwnerLive(record({ bootId: "different-boot" }))).toBe(false);
    if (process.platform === "linux") {
      const ticks = readProcessStartTicks(process.pid) ?? 0;
      expect(isOwnerLive(record({ startTicks: ticks + 1 }))).toBe(false);
    }
  });

  test("the lease survives a store reopen and heartbeat touches update the row", () => {
    const workspace = tempDir("hz-owner-durable-");
    const first = openStore(workspace);
    const session = first.createSession("durable");
    const acquired = acquireOwner(first, session.id, currentOwnerIdentity());
    expect(acquired.acquired).toBe(true);
    expect(touchOwner(first, session.id, acquired.acquired ? acquired.owner.epoch : undefined)).toBe(true);
    first.close();

    const reopened = openStore(workspace);
    const row = readSessionOwner(reopened, session.id);
    expect(row?.pid).toBe(process.pid);
    expect(releaseOwner(reopened, session.id, row?.epoch)).toBe(true);
    expect(readSessionOwner(reopened, session.id)).toBeNull();
  });

  test("a clean process exit releases the lease through the exit hook", async () => {
    const workspace = tempDir("hz-owner-exit-");
    const parent = openStore(workspace);
    const session = parent.createSession("exit-hook");
    parent.close();

    const appRoot = path.resolve(import.meta.dir, "../..");
    const sessionModule = path.join(appRoot, "src/core/session.ts");
    const ownerModule = path.join(appRoot, "src/core/session-owner.ts");
    const script =
      `import { SessionStore } from ${JSON.stringify(sessionModule)}; ` +
      `import { acquireOwnedSession } from ${JSON.stringify(ownerModule)}; ` +
      "const store = new SessionStore(process.env.HZ_OWNER_WS); " +
      'const lease = acquireOwnedSession(store, process.env.HZ_OWNER_SESSION, { heartbeat: false }); ' +
      'console.log("owned:" + lease.epoch);';
    const child = spawn(["bun", "-e", script], {
      cwd: appRoot,
      env: { ...process.env, HZ_OWNER_WS: workspace, HZ_OWNER_SESSION: session.id },
      stdout: "pipe",
      stderr: "ignore",
    });
    children.push(child);

    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("owned:");

    // The child never called release(): the process-exit hook did, leaving no
    // stale row for the next open.
    const store = openStore(workspace);
    expect(readSessionOwner(store, session.id)).toBeNull();
    const reacquired = acquireOwner(store, session.id, currentOwnerIdentity());
    expect(reacquired.acquired).toBe(true);
    if (reacquired.acquired) expect(releaseOwner(store, session.id, reacquired.owner.epoch)).toBe(true);
  }, 30_000);

  test("a real second process is refused while the parent holds the lease", async () => {
    const workspace = tempDir("hz-owner-cross-process-");
    const store = openStore(workspace);
    const session = store.createSession("cross-process");
    const lease = acquireOwnedSession(store, session.id, { heartbeat: false });
    try {
      const refused = await childResult(ownerChild(workspace, session.id));
      expect(refused.exitCode).toBe(3);
      expect(refused.stdout).toContain("refused:SessionOwnedError");
      // The refusal did not disturb the parent's row.
      expect(readSessionOwner(store, session.id)?.pid).toBe(process.pid);
    } finally {
      lease.release();
    }

    // The first process is gone from the row only because it released; the
    // next process can acquire, and its own exit hook frees the session.
    const allowed = await childResult(ownerChild(workspace, session.id));
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain("acquired");
    expect(readSessionOwner(store, session.id)).toBeNull();
  }, 60_000);
});

describe("session-owner: recovery only after ownership", () => {
  test("recoverInterrupted does not run against a live owner", async () => {
    const workspace = tempDir("hz-owner-recovery-live-");
    const store = openStore(workspace);
    const session = store.createSession("live-recovery");
    store.appendMessage(session.id, { role: "user", content: "do the thing" });
    store.appendMessage(session.id, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "shell", arguments: "{}" }],
    });
    const admissions = new AdmissionQueue(store);
    const admissionId = admissions.admit(session.id, "interrupted turn", "run-1");
    expect(admissions.begin(admissionId)).toBe(true);

    const { child, identity } = liveForeignOwner();
    const owner = acquireOwner(store, session.id, identity);
    expect(owner.acquired).toBe(true);
    const before = store.messageCount(session.id);

    expect(() =>
      claimSessionForRecovery(store, session.id, { identity: currentOwnerIdentity(), heartbeat: false }),
    ).toThrow(SessionOwnedError);

    // NOTHING was repaired while a live writer held the session.
    expect(admissions.get(admissionId)?.state).toBe("running");
    expect(store.messageCount(session.id)).toBe(before);
    expect(store.history(session.id).filter((m) => m.role === "tool")).toHaveLength(0);
    expect(readSessionOwner(store, session.id)?.pid).toBe(child.pid);

    // Crash-style: the owner dies. Only now may the stale lease be taken over
    // and the two repairs run.
    await stopChild(child);
    const claim = claimSessionForRecovery(store, session.id, {
      identity: currentOwnerIdentity(),
      heartbeat: false,
    });
    expect(claim.tookOver).toBe(true);
    expect(claim.repaired.repaired).toBe(1);
    expect(claim.interrupted).toEqual([admissionId]);
    expect(admissions.get(admissionId)?.state).toBe("unknown");
    expect(admissions.get(admissionId)?.evidence).toBe("interrupted");
    expect(store.history(session.id).some((m) => m.role === "tool" && m.toolCallId === "call-1")).toBe(true);
    expect(claim.lease.release()).toBe(true);
    expect(readSessionOwner(store, session.id)).toBeNull();
  }, 30_000);

  test("a reexecTail claim still requires ownership", () => {
    const workspace = tempDir("hz-owner-reexec-");
    const store = openStore(workspace);
    const session = store.createSession("reexec");
    const owner = acquireOwner(store, session.id, currentOwnerIdentity());
    expect(owner.acquired).toBe(true);

    const claim = claimSessionForRecovery(store, session.id, { reexecTail: true, heartbeat: false });
    expect(claim.repaired.repaired).toBe(0);
    expect(claim.lease.epoch).toBe(owner.acquired ? owner.owner.epoch : "");
    expect(claim.lease.release()).toBe(true);
  });
});

describe("createRuntime: ownership gates the open path", () => {
  test("a live owner makes createRuntime fail typed and leaves the live turn alone", async () => {
    const workspace = tempDir("hz-owner-runtime-live-");
    const store = openStore(workspace);
    const session = store.createSession("live-runtime");
    store.appendMessage(session.id, { role: "user", content: "do the thing" });
    store.appendMessage(session.id, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "shell", arguments: "{}" }],
    });
    const admissions = new AdmissionQueue(store);
    const admissionId = admissions.admit(session.id, "interrupted turn", "run-1");
    expect(admissions.begin(admissionId)).toBe(true);

    const { child, identity } = liveForeignOwner();
    expect(acquireOwner(store, session.id, identity).acquired).toBe(true);
    store.close();

    let refused: unknown;
    try {
      const runtime = await createRuntime({ workspace, mock: true, sessionId: session.id });
      await runtime.close(); // should never happen: the live owner must refuse
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(SessionOwnedError);

    // The refusal ran NO recovery: the live owner's running admission and the
    // dangling tool call are exactly as the other process left them.
    const inspect = openStore(workspace);
    expect(new AdmissionQueue(inspect).get(admissionId)?.state).toBe("running");
    expect(inspect.history(session.id).filter((m) => m.role === "tool")).toHaveLength(0);
    expect(readSessionOwner(inspect, session.id)?.pid).toBe(child.pid);
    inspect.close();

    // Crash-style recovery after the owner really dies.
    await stopChild(child);
    const recovered = await createRuntime({ workspace, mock: true, sessionId: session.id });
    try {
      expect(recovered.sessionId).toBe(session.id);
    } finally {
      await recovered.close();
    }

    const after = openStore(workspace);
    expect(new AdmissionQueue(after).get(admissionId)?.state).toBe("unknown");
    expect(after.history(session.id).some((m) => m.role === "tool" && m.toolCallId === "call-1")).toBe(true);
    expect(readSessionOwner(after, session.id)).toBeNull();
  }, 120_000);

  test("switchSession refuses a live-owned session and releases the previous lease on a clean switch", async () => {
    const workspace = tempDir("hz-owner-runtime-switch-");
    const store = openStore(workspace);
    const current = store.createSession("current");
    const locked = store.createSession("locked");
    const free = store.createSession("free");
    const { child, identity } = liveForeignOwner();
    expect(acquireOwner(store, locked.id, identity).acquired).toBe(true);
    store.close();

    const runtime = await createRuntime({ workspace, mock: true, sessionId: current.id });
    try {
      expect(readSessionOwner(openStore(workspace), current.id)?.pid).toBe(process.pid);

      let refused: unknown;
      try {
        runtime.switchSession(locked.id);
      } catch (err) {
        refused = err;
      }
      expect(refused).toBeInstanceOf(SessionOwnedError);
      // The refused switch changed nothing: the runtime is still on `current`.
      expect(runtime.sessionId).toBe(current.id);

      runtime.switchSession(free.id);
      expect(runtime.sessionId).toBe(free.id);
      // The old lease is gone; the new session is owned by this process.
      const inspect = openStore(workspace);
      expect(readSessionOwner(inspect, current.id)).toBeNull();
      expect(readSessionOwner(inspect, free.id)?.pid).toBe(process.pid);
      inspect.close();
    } finally {
      await runtime.close();
      await stopChild(child);
    }

    const after = openStore(workspace);
    expect(readSessionOwner(after, free.id)).toBeNull();
    expect(readSessionOwner(after, locked.id)?.pid).toBe(child.pid); // stale row, killed by cleanup
    after.close();
  }, 120_000);
});
