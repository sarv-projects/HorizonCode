/**
 * task-board-orchestrator.ts — Autonomous Multi-Agent Task-Board Driver
 *
 * Implements full autonomous multi-agent task execution under WIP=1 rules.
 * Stolen & adapted from repo_take/learn-harness-engineering (Lectures 08 & 14),
 * repo_take/claude-code (task board / subagent mailbox), and repo_take/deepseek-harness.
 *
 * Features:
 *   - Enforces WIP = 1: exactly one task active at any time.
 *   - Dynamic coordinator/worker agent dispatch with AgentId tracking.
 *   - Subagent inbox messaging integration.
 *   - External verification check before transitioning task from in_progress to passed.
 *   - Bounded retries with actionable feedback propagation.
 */

import { SubagentInbox } from "./subagent-inbox";

export interface OrchestratorTask {
  id: string;
  name: string;
  description: string;
  usesFiles?: string[];
  dependencies?: string[];
  status?: "pending" | "in_progress" | "passed" | "failed";
  attempts?: number;
  feedback?: string;
  output?: string;
}

export interface TaskDeadlockReport {
  deadlocked: boolean;
  cycles: string[][];
  unresolvable: string[];
}

export function detectTaskDeadlocks(tasks: readonly OrchestratorTask[]): TaskDeadlockReport {
  const taskIds = new Set(tasks.map((t) => t.id));
  const unresolvable: string[] = [];
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    const deps = t.dependencies ?? [];
    const validDeps: string[] = [];
    for (const d of deps) {
      if (!taskIds.has(d)) {
        if (!unresolvable.includes(d)) unresolvable.push(d);
      } else {
        validDeps.push(d);
      }
    }
    adj.set(t.id, validDeps);
  }

  const visited = new Map<string, 0 | 1 | 2>();
  for (const t of tasks) visited.set(t.id, 0);

  const cycles: string[][] = [];
  const currentPath: string[] = [];

  function dfs(node: string) {
    visited.set(node, 1);
    currentPath.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      const state = visited.get(neighbor) ?? 0;
      if (state === 1) {
        const cycleStartIndex = currentPath.indexOf(neighbor);
        cycles.push([...currentPath.slice(cycleStartIndex), neighbor]);
      } else if (state === 0) {
        dfs(neighbor);
      }
    }

    currentPath.pop();
    visited.set(node, 2);
  }

  for (const t of tasks) {
    if (visited.get(t.id) === 0) {
      dfs(t.id);
    }
  }

  return {
    deadlocked: cycles.length > 0 || unresolvable.length > 0,
    cycles,
    unresolvable,
  };
}

export interface WorkerRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface TaskVerificationResult {
  ok: boolean;
  feedback?: string;
}

export interface TaskBoardOrchestratorOptions {
  inbox?: SubagentInbox;
  tasks: OrchestratorTask[];
  coordinatorId?: string;
  workerIdPrefix?: string;
  maxAttemptsPerTask?: number;
  runWorker: (workerId: string, task: OrchestratorTask) => Promise<WorkerRunResult>;
  verifyTask?: (task: OrchestratorTask) => Promise<TaskVerificationResult>;
  onTaskTransition?: (task: OrchestratorTask, from: string, to: string) => void;
}

export interface OrchestrationResult {
  ok: boolean;
  tasks: readonly OrchestratorTask[];
  completedCount: number;
  failedCount: number;
  rounds: number;
  deadlocked?: boolean;
  deadlockReport?: TaskDeadlockReport;
}

export class TaskBoardOrchestrator {
  private readonly inbox: SubagentInbox;
  private readonly tasks: OrchestratorTask[];
  private coordinatorId: string;
  private readonly workerIdPrefix: string;
  private readonly maxAttemptsPerTask: number;
  private readonly runWorker: (workerId: string, task: OrchestratorTask) => Promise<WorkerRunResult>;
  private readonly verifyTask?: (task: OrchestratorTask) => Promise<TaskVerificationResult>;
  private readonly onTaskTransition?: (task: OrchestratorTask, from: string, to: string) => void;

  constructor(opts: TaskBoardOrchestratorOptions) {
    this.inbox = opts.inbox ?? new SubagentInbox();
    this.tasks = opts.tasks.map((t) => ({
      ...t,
      status: t.status ?? "pending",
      attempts: t.attempts ?? 0,
    }));
    this.coordinatorId = opts.coordinatorId ?? "coordinator";
    this.workerIdPrefix = opts.workerIdPrefix ?? "worker";
    this.maxAttemptsPerTask = Math.max(1, opts.maxAttemptsPerTask ?? 3);
    this.runWorker = opts.runWorker;
    this.verifyTask = opts.verifyTask;
    this.onTaskTransition = opts.onTaskTransition;
  }

  setCoordinator(newCoordinatorId: string): void {
    const prev = this.coordinatorId;
    this.coordinatorId = newCoordinatorId;
    this.inbox.post(
      this.coordinatorId,
      `Coordinator reassigned from ${prev} to ${this.coordinatorId}`,
    );
  }

  getCoordinator(): string {
    return this.coordinatorId;
  }

  async run(): Promise<OrchestrationResult> {
    const initialDeadlock = detectTaskDeadlocks(this.tasks);
    if (initialDeadlock.deadlocked) {
      for (const t of this.tasks) {
        if (t.status === "pending") {
          t.status = "failed";
          t.feedback = "Dependency cycle or unresolvable prerequisite detected";
        }
      }
      return {
        ok: false,
        tasks: this.tasks,
        completedCount: this.tasks.filter((t) => t.status === "passed").length,
        failedCount: this.tasks.filter((t) => t.status === "failed").length,
        rounds: 0,
        deadlocked: true,
        deadlockReport: initialDeadlock,
      };
    }

    let rounds = 0;
    let workerCounter = 0;

    while (true) {
      // Find the next task to work on
      let nextTask = this.tasks.find((t) => t.status === "in_progress");
      if (!nextTask) {
        nextTask = this.tasks.find((t) => {
          if (t.status !== "pending") return false;
          const deps = t.dependencies ?? [];
          return deps.every((depId) => {
            const depTask = this.tasks.find((dt) => dt.id === depId);
            return depTask !== undefined && depTask.status === "passed";
          });
        });
      }

      if (!nextTask) {
        const remainingPending = this.tasks.filter((t) => t.status === "pending");
        if (remainingPending.length > 0) {
          for (const t of remainingPending) {
            t.status = "failed";
            t.feedback = "Blocked by failed or unsatisfied dependency";
          }
        }
        break;
      }

      rounds += 1;
      workerCounter += 1;
      const workerId = `${this.workerIdPrefix}-${workerCounter}`;

      // Transition to in_progress
      const prevStatus = nextTask.status ?? "pending";
      nextTask.status = "in_progress";
      nextTask.attempts = (nextTask.attempts ?? 0) + 1;
      if (prevStatus !== "in_progress" && this.onTaskTransition) {
        this.onTaskTransition(nextTask, prevStatus, "in_progress");
      }

      // Notify inbox
      this.inbox.post(
        workerId,
        `Task assigned: ${nextTask.name} (Attempt ${nextTask.attempts}/${this.maxAttemptsPerTask})`,
      );

      // Execute worker
      let workerRes: WorkerRunResult;
      try {
        workerRes = await this.runWorker(workerId, nextTask);
      } catch (err) {
        workerRes = {
          ok: false,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }

      nextTask.output = workerRes.output;

      if (!workerRes.ok) {
        nextTask.feedback = workerRes.error ?? "Worker execution failed";
        if (nextTask.attempts >= this.maxAttemptsPerTask) {
          nextTask.status = "failed";
          if (this.onTaskTransition) {
            this.onTaskTransition(nextTask, "in_progress", "failed");
          }
          this.inbox.post(
            this.coordinatorId,
            `Task failed permanently: ${nextTask.name} (${nextTask.feedback})`,
          );
        } else {
          this.inbox.post(
            this.coordinatorId,
            `Worker failed attempt ${nextTask.attempts} on ${nextTask.name}, will retry.`,
          );
        }
        continue;
      }

      // Run verification if provided
      let verified = true;
      let verificationFeedback: string | undefined;

      if (this.verifyTask) {
        try {
          const v = await this.verifyTask(nextTask);
          verified = v.ok;
          verificationFeedback = v.feedback;
        } catch (err) {
          verified = false;
          verificationFeedback = err instanceof Error ? err.message : String(err);
        }
      }

      if (verified) {
        nextTask.status = "passed";
        nextTask.feedback = undefined;
        if (this.onTaskTransition) {
          this.onTaskTransition(nextTask, "in_progress", "passed");
        }
        this.inbox.post(
          this.coordinatorId,
          `Task verified and passed: ${nextTask.name}`,
        );
      } else {
        nextTask.feedback = verificationFeedback ?? "Verification failed";
        if (nextTask.attempts >= this.maxAttemptsPerTask) {
          nextTask.status = "failed";
          if (this.onTaskTransition) {
            this.onTaskTransition(nextTask, "in_progress", "failed");
          }
          this.inbox.post(
            this.coordinatorId,
            `Task failed verification limit: ${nextTask.name} (${nextTask.feedback})`,
          );
        } else {
          this.inbox.post(
            this.coordinatorId,
            `Task verification failed on attempt ${nextTask.attempts}: ${nextTask.feedback}, scheduling retry.`,
          );
        }
      }
    }

    const completedCount = this.tasks.filter((t) => t.status === "passed").length;
    const failedCount = this.tasks.filter((t) => t.status === "failed").length;

    return {
      ok: failedCount === 0 && completedCount === this.tasks.length,
      tasks: this.tasks,
      completedCount,
      failedCount,
      rounds,
    };
  }
}
