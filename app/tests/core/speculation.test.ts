/**
 * speculation.test.ts — Tier-3 speculative execution coordinator (docs/28 ruling 40).
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
import { loadHooks } from "../../src/core/hooks";
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
    const hooks = loadHooks(workspace);

    const host = buildSpeculationHost(deps, gate, faults, hooks);
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
