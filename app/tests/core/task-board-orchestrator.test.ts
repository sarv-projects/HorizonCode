import { describe, expect, it } from "bun:test";
import { SubagentInbox } from "../../src/core/subagent-inbox";
import {
  TaskBoardOrchestrator,
  type OrchestratorTask,
  type WorkerRunResult,
} from "../../src/core/task-board-orchestrator";

describe("TaskBoardOrchestrator", () => {
  it("orchestrates tasks sequentially under WIP=1 rule with inbox messaging", async () => {
    const inbox = new SubagentInbox();
    const tasks: OrchestratorTask[] = [
      { id: "feat-1", name: "Feature 1", description: "First feature" },
      { id: "feat-2", name: "Feature 2", description: "Second feature" },
    ];

    const dispatched: string[] = [];
    const verified: string[] = [];

    const orchestrator = new TaskBoardOrchestrator({
      inbox,
      tasks,
      coordinatorId: "coordinator-main",
      workerIdPrefix: "worker-agent",
      runWorker: async (workerId, task) => {
        dispatched.push(task.id);
        // Post progress to inbox
        inbox.post(workerId, `Working on ${task.name}`);
        return { ok: true, output: `Completed ${task.id}` };
      },
      verifyTask: async (task) => {
        verified.push(task.id);
        return { ok: true };
      },
    });

    const result = await orchestrator.run();

    expect(result.ok).toBe(true);
    expect(result.completedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(dispatched).toEqual(["feat-1", "feat-2"]);
    expect(verified).toEqual(["feat-1", "feat-2"]);
    expect(result.tasks.every((t) => t.status === "passed")).toBe(true);
  });

  it("handles verification failure and retries up to maxAttempts", async () => {
    const inbox = new SubagentInbox();
    const tasks: OrchestratorTask[] = [
      { id: "feat-flaky", name: "Flaky Feature", description: "Fails first time" },
    ];

    let attempts = 0;
    const orchestrator = new TaskBoardOrchestrator({
      inbox,
      tasks,
      maxAttemptsPerTask: 2,
      runWorker: async (_workerId, _task) => {
        attempts += 1;
        return { ok: true, output: `Attempt ${attempts}` };
      },
      verifyTask: async (_task) => {
        if (attempts === 1) {
          return { ok: false, feedback: "Missing unit test verification" };
        }
        return { ok: true };
      },
    });

    const result = await orchestrator.run();

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(result.tasks[0]?.status).toBe("passed");
    expect(result.tasks[0]?.attempts).toBe(2);
  });

  it("fails task cleanly when max attempts are exhausted", async () => {
    const inbox = new SubagentInbox();
    const tasks: OrchestratorTask[] = [
      { id: "feat-fail", name: "Failing Feature", description: "Always fails" },
    ];

    const orchestrator = new TaskBoardOrchestrator({
      inbox,
      tasks,
      maxAttemptsPerTask: 2,
      runWorker: async () => ({ ok: true, output: "done" }),
      verifyTask: async () => ({ ok: false, feedback: "Tests still failing" }),
    });

    const result = await orchestrator.run();

    expect(result.ok).toBe(false);
    expect(result.completedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.tasks[0]?.status).toBe("failed");
    expect(result.tasks[0]?.feedback).toContain("Tests still failing");
  });
});
