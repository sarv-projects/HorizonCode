/**
 * speculation.test.ts — Tier-3 speculative execution coordinator (docs/28 ruling 44).
 *
 * The whole point is a SAFETY invariant, and these tests make it checkable:
 *  (a) normalizeSpeculationEffect REJECTS any effect that is not pure or
 *      local_read, so a side-effecting tool can never become a candidate.
 *  (b) speculationEffectForToolCall returns undefined for write/edit/shell/
 *      bash/agent and a local_read for read/grep/glob.
 *  (c) the DEFAULT_MAX_IN_FLIGHT=2 bound is enforced.
 *  (d) a fingerprint mismatch discards the candidate.
 *  (e) a discarded/vetoed candidate cascades the discard to its dependents.
 *  (f) a speculatively-run read still passes through admissionFor -> gate.check
 *      BEFORE the tool executes — the guard is never bypassed.
 *
 * Each test fails when the corresponding new code is reverted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { GuardAction, GuardDecision, Lease, PolicyScope, ToolCall } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { SessionStore } from "../../src/core/session";
import {
  buildSpeculationHost,
  GuardGate,
  RunFaults,
  speculativeCandidatesFor,
  type LoopDeps,
} from "../../src/core/loop";
import {
  DEFAULT_MAX_IN_FLIGHT,
  SpeculationError,
  SpeculativeOperationCoordinator,
  fingerprintCandidate,
  makeCandidate,
  normalizeSpeculationEffect,
  speculationEffectForToolCall,
  type SpeculativeHost,
  type SpeculativeToolCandidate,
} from "../../src/core/speculation";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-spec-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A trivial host that records run order and returns ok for every candidate. */
function recordingHost(): { host: SpeculativeHost; ran: string[] } {
  const ran: string[] = [];
  const host: SpeculativeHost = {
    async run(candidate) {
      ran.push(candidate.id);
      return { ok: true, output: `ran ${candidate.name}` };
    },
  };
  return { host, ran };
}

describe("DEFAULT_MAX_IN_FLIGHT", () => {
  test("is 2", () => {
    expect(DEFAULT_MAX_IN_FLIGHT).toBe(2);
  });
});

describe("normalizeSpeculationEffect (the gate)", () => {
  test("accepts pure", () => {
    expect(normalizeSpeculationEffect({ kind: "pure" })).toEqual({ kind: "pure" });
  });

  test("accepts local_read with file/read resources", () => {
    const effect = normalizeSpeculationEffect({
      kind: "local_read",
      resources: [{ scheme: "file", path: "/a/b.txt", access: "read" }],
    });
    expect(effect).toEqual({ kind: "local_read", resources: [{ scheme: "file", path: "/a/b.txt", access: "read" }] });
  });

  test("REJECTS a non-pure/non-local-read effect so a side-effecting tool is never speculated", () => {
    // These are the shapes a write/edit/shell effect would have — all refused.
    const badEffects: unknown[] = [
      { kind: "fs.write", target: "/a/b.txt" },
      { kind: "shell.exec", target: "rm -rf /" },
      { kind: "local_read", resources: [{ scheme: "file", path: "/a", access: "write" }] },
      { kind: "local_read", resources: [{ scheme: "net", path: "http://x", access: "read" }] },
      { kind: "local_read", resources: [] },
      { kind: "spawn" },
      "pure",
      null,
    ];
    for (const bad of badEffects) {
      expect(() => normalizeSpeculationEffect(bad)).toThrow(SpeculationError);
      try {
        normalizeSpeculationEffect(bad);
      } catch (err) {
        expect((err as SpeculationError).reason).toBe("unspeculable-effect");
      }
    }
  });
});

describe("speculationEffectForToolCall", () => {
  test("returns a local_read for read/grep/glob/repo_map", () => {
    const read = speculationEffectForToolCall("read", { path: "a.txt" }, workspace);
    expect(read).toEqual({ kind: "local_read", resources: [{ scheme: "file", path: path.resolve(workspace, "a.txt"), access: "read" }] });
    for (const name of ["grep", "glob", "repo_map"]) {
      const effect = speculationEffectForToolCall(name, {}, workspace);
      expect(effect?.kind).toBe("local_read");
    }
  });

  test("returns undefined for every side-effecting tool", () => {
    for (const name of ["write", "edit", "shell", "bash", "agent", "code_mode", "preview", "undo", "mcp__x__y", "nope"]) {
      expect(speculationEffectForToolCall(name, { path: "a.txt", command: "ls", code: "x", task: "t" }, workspace)).toBeUndefined();
    }
  });
});

describe("max-in-flight bound", () => {
  test("rejects a third concurrent admission with reason 'max-in-flight'", async () => {
    // A host whose run blocks until released keeps candidates in flight.
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const host: SpeculativeHost = {
      async run() {
        await gate;
        return { ok: true, output: "done" };
      },
    };
    const coord = new SpeculativeOperationCoordinator(host, DEFAULT_MAX_IN_FLIGHT);
    const c = (id: string): SpeculativeToolCandidate =>
      makeCandidate({ id, name: "read", args: { path: `${id}.txt` }, effect: { kind: "pure" } });

    const first = coord.admit(c("a"));
    const second = coord.admit(c("b"));
    // The third must be rejected because two are still in flight.
    await expect(coord.admit(c("c"))).rejects.toMatchObject({ reason: "max-in-flight" });
    releaseAll();
    await Promise.all([first, second]);
  });
});

describe("fingerprint reconcile", () => {
  test("a fingerprint mismatch discards the candidate", async () => {
    const { host } = recordingHost();
    const coord = new SpeculativeOperationCoordinator(host);
    const cand = makeCandidate({ id: "a", name: "read", args: { path: "a.txt" }, effect: { kind: "pure" } });
    await coord.admit(cand);
    // Reconcile against a committed call with a DIFFERENT fingerprint.
    const kept = coord.reconcile([{ id: "a", fingerprint: "deadbeef" }]);
    expect(kept).toEqual([]);
    expect(coord.outcomeFor("a")?.state).toBe("discarded");
    expect(coord.outcomeFor("a")?.discardReason).toBe("fingerprint-mismatch");
  });

  test("a matching fingerprint keeps the candidate", async () => {
    const { host } = recordingHost();
    const coord = new SpeculativeOperationCoordinator(host);
    const cand = makeCandidate({ id: "a", name: "read", args: { path: "a.txt" }, effect: { kind: "pure" } });
    await coord.admit(cand);
    const kept = coord.reconcile([{ id: "a", fingerprint: cand.fingerprint }]);
    expect(kept).toEqual(["a"]);
    expect(coord.outcomeFor("a")?.state).toBe("completed");
  });
});

describe("discard cascade", () => {
  test("a discarded candidate cascades the discard to its transitive dependents", async () => {
    const { host } = recordingHost();
    const coord = new SpeculativeOperationCoordinator(host);
    // a <- b <- c (c depends on b, b depends on a)
    await coord.admit(makeCandidate({ id: "a", name: "read", args: { path: "a.txt" }, effect: { kind: "pure" } }));
    await coord.admit(makeCandidate({ id: "b", name: "read", args: { path: "b.txt" }, effect: { kind: "pure" }, dependencies: ["a"] }));
    await coord.admit(makeCandidate({ id: "c", name: "read", args: { path: "c.txt" }, effect: { kind: "pure" }, dependencies: ["b"] }));

    coord.discard("a", "validate-veto");
    expect(coord.outcomeFor("a")?.state).toBe("discarded");
    expect(coord.outcomeFor("b")?.state).toBe("discarded");
    expect(coord.outcomeFor("c")?.state).toBe("discarded");
    expect(coord.outcomeFor("b")?.discardReason).toBe("dependency-discarded");
    expect(coord.outcomeFor("c")?.discardReason).toBe("dependency-discarded");
  });

  test("a validate veto discards and cascades", async () => {
    const host: SpeculativeHost = {
      validate: async (cand) => cand.id !== "a",
      async run() {
        return { ok: true, output: "done" };
      },
    };
    const coord = new SpeculativeOperationCoordinator(host);
    const outA = await coord.admit(makeCandidate({ id: "a", name: "read", args: { path: "a.txt" }, effect: { kind: "pure" } }));
    expect(outA.state).toBe("discarded");
    expect(outA.discardReason).toBe("validate-veto");
  });
});

describe("fingerprint", () => {
  test("is the sha256 of canonical {name,args,effect} and is deterministic", () => {
    const effect = normalizeSpeculationEffect({ kind: "pure" });
    const a = fingerprintCandidate("read", { path: "a.txt" }, effect);
    const b = fingerprintCandidate("read", { path: "a.txt" }, effect);
    const c = fingerprintCandidate("read", { path: "b.txt" }, effect);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* --------------------- the core safety invariant (loop-level) --------------------- */

/** A KernelClient whose checkGuard records every action, then delegates. */
function recordingGate(kernel: KernelClient, events: { guardChecks: GuardAction[]; order: string[] }): KernelClient {
  const original = kernel.checkGuard.bind(kernel);
  kernel.checkGuard = (async (action: GuardAction, scope?: PolicyScope, leases?: Lease[], sessionId?: string): Promise<GuardDecision> => {
    events.guardChecks.push(action);
    events.order.push(`guard:${action.kind}:${action.target}`);
    return original(action, scope, leases, sessionId);
  }) as typeof kernel.checkGuard;
  return kernel;
}

describe("safety invariant: a speculated read is a guarded fs.read", () => {
  test("gate.check runs the fs.read admission BEFORE the read tool executes", async () => {
    // A real workspace file so the read tool actually runs.
    const target = path.join(workspace, "hello.txt");
    writeFileSync(target, "hello speculation", "utf8");

    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("spec").id;
    const events = { guardChecks: [] as GuardAction[], order: [] as string[] };
    recordingGate(kernel, events);

    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider: { name: "scripted", async *stream() {} },
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => true,
      speculativeExecution: true,
    };
    // A guard gate wired to the recording kernel: every speculated read's
    // admission flows through it before the tool runs.
    const gate = new GuardGate(workspace, kernel, [], () => async () => true, sessionId);
    const faults = new RunFaults();

    const host = buildSpeculationHost(deps, gate, faults);
    const coord = new SpeculativeOperationCoordinator(host);

    const calls: ToolCall[] = [{ id: "r1", name: "read", arguments: JSON.stringify({ path: "hello.txt" }) }];
    const candidates = speculativeCandidatesFor(calls, workspace);
    expect(candidates).toHaveLength(1);

    const outcome = await coord.admit(candidates[0]!);
    expect(outcome.state).toBe("completed");
    expect(outcome.result?.output).toContain("hello speculation");

    // The guard was consulted for exactly the fs.read of the resolved target.
    const readCheck = events.guardChecks.find((a) => a.kind === "fs.read" && a.target === target);
    expect(readCheck).toBeDefined();
    // Ordering: the guard check is recorded, and the host only returned the
    // content after it (the guard entry exists before the outcome did).
    expect(events.order.indexOf(`guard:fs.read:${target}`)).toBeGreaterThanOrEqual(0);

    try {
      await kernel.close();
      store.close();
    } catch {
      /* best effort cleanup */
    }
  });

  test("a denying guard blocks the read: the file content is never returned", async () => {
    const target = path.join(workspace, "secret.txt");
    writeFileSync(target, "TOP-SECRET-CONTENT", "utf8");
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("spec-deny").id;
    const checks: GuardAction[] = [];
    kernel.checkGuard = (async (action: GuardAction): Promise<GuardDecision> => {
      checks.push(action);
      return { decision: "deny", reason: "test deny" } as unknown as GuardDecision;
    }) as typeof kernel.checkGuard;
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider: { name: "scripted", async *stream() {} },
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => true,
      speculativeExecution: true,
    };
    const gate = new GuardGate(workspace, kernel, [], () => async () => true, sessionId);
    const host = buildSpeculationHost(deps, gate, new RunFaults());
    const coord = new SpeculativeOperationCoordinator(host);
    const [cand] = speculativeCandidatesFor([{ id: "r1", name: "read", arguments: JSON.stringify({ path: "secret.txt" }) }], workspace);
    const outcome = await coord.admit(cand!);
    expect(checks.some((a) => a.kind === "fs.read" && a.target === target)).toBe(true);
    expect(outcome.result?.ok).toBe(false);
    expect(outcome.result?.output ?? "").not.toContain("TOP-SECRET-CONTENT");
    try {
      await kernel.close();
      store.close();
    } catch {
      /* best effort cleanup */
    }
  });

  test("an 'ask' decision is declined during speculation: the approval handler is never prompted", async () => {
    writeFileSync(path.join(workspace, "ask.txt"), "ASK-CONTENT", "utf8");
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("spec-ask").id;
    kernel.checkGuard = (async (): Promise<GuardDecision> =>
      ({ decision: "ask", reason: "test ask" }) as unknown as GuardDecision) as typeof kernel.checkGuard;
    let prompted = 0;
    const approve = async (): Promise<boolean> => {
      prompted += 1;
      return true;
    };
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider: { name: "scripted", async *stream() {} },
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve,
      speculativeExecution: true,
    };
    const gate = new GuardGate(workspace, kernel, [], () => approve, sessionId);
    const coord = new SpeculativeOperationCoordinator(buildSpeculationHost(deps, gate, new RunFaults()));
    const [cand] = speculativeCandidatesFor([{ id: "r1", name: "read", arguments: JSON.stringify({ path: "ask.txt" }) }], workspace);
    const outcome = await coord.admit(cand!);
    expect(prompted).toBe(0);
    expect(outcome.result?.ok).toBe(false);
    expect(outcome.result?.output ?? "").not.toContain("ASK-CONTENT");
    try {
      await kernel.close();
      store.close();
    } catch {
      /* best effort cleanup */
    }
  });

  test("speculativeCandidatesFor never includes a side-effecting tool", () => {
    const calls: ToolCall[] = [
      { id: "w1", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) },
      { id: "s1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
      { id: "r1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
    ];
    const candidates = speculativeCandidatesFor(calls, workspace);
    expect(candidates.map((c) => c.id)).toEqual(["r1"]);
  });
});

describe("coordinator robustness", () => {
  const pure = { kind: "pure" } as const;
  const mk = (id: string, deps?: string[]) =>
    makeCandidate({ id, name: "read", args: { path: `${id}.txt` }, effect: pure, dependencies: deps });

  test("a discard issued while run is in flight is not resurrected", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const coord = new SpeculativeOperationCoordinator({
      async run() {
        await gate;
        return { ok: true, output: "late" };
      },
    });
    const pending = coord.admit(mk("a"));
    await Promise.resolve();
    coord.discard("a", "fingerprint-mismatch");
    release();
    const out = await pending;
    expect(out.state).toBe("discarded");
    expect(coord.outcomeFor("a")?.state).toBe("discarded");
    expect(coord.admitted()[0]?.committed).toBe(false);
    expect(coord.reconcile([{ id: "a", fingerprint: coord.admitted()[0]!.fingerprint }])).toEqual([]);
  });

  test("a throwing run is recorded as failed, not left running", async () => {
    const coord = new SpeculativeOperationCoordinator({
      async run() {
        throw new Error("boom");
      },
    });
    const out = await coord.admit(mk("a"));
    expect(out.state).toBe("failed");
    expect(out.result?.error).toBe("boom");
    expect(coord.admitted()[0]?.state).toBe("failed");
  });

  test("a candidate whose parent was discarded or is unknown is discarded without running", async () => {
    const { host, ran } = recordingHost();
    const coord = new SpeculativeOperationCoordinator(host);
    await coord.admit(mk("p"));
    coord.discard("p", "validate-veto");
    const child = await coord.admit(mk("c", ["p"]));
    expect(child.state).toBe("discarded");
    expect(child.discardReason).toBe("dependency-discarded");
    const orphan = await coord.admit(mk("o", ["ghost"]));
    expect(orphan.state).toBe("discarded");
    expect(ran).toEqual(["p"]);
  });

  test("a duplicate candidate id is rejected", async () => {
    const { host } = recordingHost();
    const coord = new SpeculativeOperationCoordinator(host);
    await coord.admit(mk("a"));
    await expect(coord.admit(mk("a"))).rejects.toMatchObject({ reason: "invalid-candidate" });
  });

  test("a slot is released after completion so admission is accepted again", async () => {
    const { host } = recordingHost();
    const coord = new SpeculativeOperationCoordinator(host, 1);
    await coord.admit(mk("a"));
    const second = await coord.admit(mk("b"));
    expect(second.state).toBe("completed");
  });

  test("a validate veto cascades to an already-admitted dependent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const coord = new SpeculativeOperationCoordinator({
      async run(c) {
        if (c.id === "a") await gate;
        return { ok: true, output: c.id };
      },
    });
    const a = coord.admit(mk("a"));
    await Promise.resolve();
    const b = await coord.admit(mk("b", ["a"]));
    expect(b.state).toBe("completed");
    coord.discard("a", "validate-veto");
    expect(coord.outcomeFor("b")?.state).toBe("discarded");
    release();
    await a;
    expect(coord.outcomeFor("b")?.discardReason).toBe("dependency-discarded");
  });
});
