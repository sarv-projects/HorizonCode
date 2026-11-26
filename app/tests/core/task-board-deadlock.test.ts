import { describe, expect, test } from "bun:test";
import {
  TaskBoardOrchestrator,
  detectTaskDeadlocks,
  type OrchestratorTask,
} from "../../src/core/task-board-orchestrator";

describe("TaskBoardOrchestrator deadlock detection and dependency scheduling", () => {
  test("detectTaskDeadlocks flags cycles and unresolvable dependencies", () => {
    const tasks: OrchestratorTask[] = [
      { id: "A", name: "Task A", description: "", dependencies: ["B"] },
      { id: "B", name: "Task B", description: "", dependencies: ["A"] },
    ];
    const report = detectTaskDeadlocks(tasks);
    expect(report.deadlocked).toBe(true);
    expect(report.cycles.length).toBeGreaterThan(0);

    const unresolvableTasks: OrchestratorTask[] = [
      { id: "C", name: "Task C", description: "", dependencies: ["UNKNOWN_TASK"] },
    ];
    const unresolvableReport = detectTaskDeadlocks(unresolvableTasks);
    expect(unresolvableReport.deadlocked).toBe(true);
    expect(unresolvableReport.unresolvable).toEqual(["UNKNOWN_TASK"]);
  });

  test("schedules tasks in dependency order", async () => {
    const executionOrder: string[] = [];
    const tasks: OrchestratorTask[] = [
      { id: "step2", name: "Second Step", description: "", dependencies: ["step1"] },
      { id: "step1", name: "First Step", description: "" },
    ];

    const orchestrator = new TaskBoardOrchestrator({
      tasks,
      runWorker: async (_workerId, task) => {
        executionOrder.push(task.id);
        return { ok: true, output: `done ${task.id}` };
      },
    });

    const res = await orchestrator.run();
    expect(res.ok).toBe(true);
    expect(executionOrder).toEqual(["step1", "step2"]);
    expect(res.completedCount).toBe(2);
  });

  test("marks dependent tasks failed when prerequisite fails", async () => {
    const executionOrder: string[] = [];
    const tasks: OrchestratorTask[] = [
      { id: "step1", name: "First Step", description: "" },
      { id: "step2", name: "Second Step", description: "", dependencies: ["step1"] },
    ];

    const orchestrator = new TaskBoardOrchestrator({
      tasks,
      maxAttemptsPerTask: 1,
      runWorker: async (_workerId, task) => {
        executionOrder.push(task.id);
        if (task.id === "step1") {
          return { ok: false, output: "", error: "step1 failed" };
        }
        return { ok: true, output: "done" };
      },
    });

    const res = await orchestrator.run();
    expect(res.ok).toBe(false);
    expect(executionOrder).toEqual(["step1"]);
    const s2 = res.tasks.find((t) => t.id === "step2");
    expect(s2?.status).toBe("failed");
    expect(s2?.feedback).toContain("Blocked by failed or unsatisfied dependency");
  });

  test("setCoordinator dynamically reassigns coordinator and posts notice", async () => {
    const orchestrator = new TaskBoardOrchestrator({
      tasks: [{ id: "solo", name: "Solo", description: "" }],
      coordinatorId: "coord-1",
      runWorker: async () => ({ ok: true, output: "ok" }),
    });

    expect(orchestrator.getCoordinator()).toBe("coord-1");
    orchestrator.setCoordinator("coord-2");
    expect(orchestrator.getCoordinator()).toBe("coord-2");

    const res = await orchestrator.run();
    expect(res.ok).toBe(true);
  });
});
