/** Wave 0 RC-18 learn.* / goal.updated / session.moved (rulings 450–454). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import { createRuntime } from "../../src/core";
import { curate } from "../../src/core/curator";
import { runEvalSet } from "../../src/core/evals";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";
import { stateRoot } from "../../src/core/paths";

function loadRows(file: string): Array<Record<string, any>> {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("RC-18 learn / goal / session.moved", () => {
  let workspace = "";

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = "";
  });

  test("send emits hz.learn.trajectory.recorded (452)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-traj-"));
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      await runtime.send("hello", { onEvent() {} });
      const rows = loadRows(sessionEventsPath(workspace, runtime.sessionId));
      const traj = rows.filter((r) => r.type === EventTypes.learnTrajectoryRecorded);
      expect(traj.length).toBeGreaterThanOrEqual(1);
      expect(traj[0]?.payload?.rootSessionId).toBe(runtime.sessionId);
      expect(typeof traj[0]?.payload?.eventCount).toBe("number");
    } finally {
      await runtime.close();
    }
  });

  test("setGoal emits hz.goal.updated (453)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-goal-"));
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "allow", reason: "test-allow-goal" }]),
        "utf8",
      );
      const runtime = await createRuntime({ workspace, mock: true });
      try {
        expect(typeof runtime.setGoal).toBe("function");
        await runtime.setGoal!("ship the RC-18 catalogue");
        const rows = loadRows(sessionEventsPath(workspace, runtime.sessionId));
        const goals = rows.filter((r) => r.type === EventTypes.goalUpdated);
        expect(goals).toHaveLength(1);
        expect(goals[0]?.payload?.statement).toBe("ship the RC-18 catalogue");
        expect(goals[0]?.payload?.status).toBe("active");
        expect(runtime.goalStatement?.()).toBe("ship the RC-18 catalogue");
      } finally {
        await runtime.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("curate + live Runtime projects hz.learn.proposal.created (450)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-prop-"));
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      const stateDir = stateRoot(workspace);
      mkdirSync(stateDir, { recursive: true });
      const curated = curate(
        [
          {
            kind: "memory",
            title: "Prefer digestOf",
            body: "Use the canonical JSON helper for stable digests.",
            evidence: ["evt-1"],
            reads: [],
          },
        ],
        { stateDir, transcriptIds: ["evt-1"] },
      );
      expect(curated.appended.length).toBe(1);
      await new Promise((r) => setTimeout(r, 50));
      const rows = loadRows(sessionEventsPath(workspace, runtime.sessionId));
      const props = rows.filter((r) => r.type === EventTypes.learnProposalCreated);
      expect(props.length).toBeGreaterThanOrEqual(1);
      expect(props[0]?.payload?.proposalId).toBe(curated.appended[0]!.digest);
    } finally {
      await runtime.close();
    }
  });

  test("runEvalSet + live Runtime projects hz.learn.eval.completed (451)", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-eval-"));
    const runtime = await createRuntime({ workspace, mock: true });
    try {
      await runEvalSet([], {
        executor: async () => ({ terminal: "succeeded" as const, finalAnswer: "" }),
        forbiddenTexts: [],
      });
      await new Promise((r) => setTimeout(r, 50));
      const rows = loadRows(sessionEventsPath(workspace, runtime.sessionId));
      const evals = rows.filter((r) => r.type === EventTypes.learnEvalCompleted);
      expect(evals.length).toBeGreaterThanOrEqual(1);
      expect(evals[0]?.payload?.gate).toBe("pass");
    } finally {
      await runtime.close();
    }
  });

  test("relocated workspace emits hz.session.moved on resume start (454)", async () => {
    const first = mkdtempSync(path.join(tmpdir(), "hz-moved-a-"));
    const runtime = await createRuntime({ workspace: first, mock: true });
    const sessionId = runtime.sessionId;
    await runtime.close();

    // Copy state to a new absolute path (simulates relocated checkout).
    workspace = mkdtempSync(path.join(tmpdir(), "hz-moved-b-"));
    const { cpSync } = await import("node:fs");
    for (const name of [".hz", ".hzcode"]) {
      const src = path.join(first, name);
      try {
        cpSync(src, path.join(workspace, name), { recursive: true });
      } catch {
        /* layout may be only one of the two */
      }
    }
    rmSync(first, { recursive: true, force: true });

    const resumed = await createRuntime({ workspace, sessionId, mock: true });
    try {
      const rows = loadRows(sessionEventsPath(workspace, sessionId));
      const moved = rows.filter((r) => r.type === EventTypes.sessionMoved);
      expect(moved.length).toBeGreaterThanOrEqual(1);
      expect(moved[0]?.payload?.movedFrom?.directory).toBe(path.resolve(first));
      expect(moved[0]?.payload?.movedTo?.directory).toBe(path.resolve(workspace));
    } finally {
      await resumed.close();
    }
  });
});
