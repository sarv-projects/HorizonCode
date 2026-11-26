/**
 * goal-runner.ts — Autonomous Dual-Agent Goal Driver Loop
 *
 * Stolen & adapted from:
 *   - repo_take/deepseek-harness/packages/goal/goal-round-driver/src/prompt.ts
 *   - repo_take/deepseek-harness/packages/goal/goal/src/runtime.ts
 *   - repo_take/learn-harness-engineering/docs/en/lectures/lecture-13-loop-engineering/
 *   - repo_take/learn-harness-engineering/docs/en/lectures/lecture-14-graph-engineering/
 *
 * Implements autonomous multi-round execution for `/goal <objective>`:
 * Runs iterations of planning, coding, and verification until the Three-Layer
 * Termination Gate passes clean (exit code 0) or user aborts.
 */

import type { Runtime } from "../contracts";
import type { GoalEvaluator, GoalEvaluatorVerdict } from "./goal-evaluator";
import { evaluateTerminationGate } from "./termination-gate";
import { bold, cyan, dim, green, red, yellow } from "../tui/style";

export interface GoalRunOptions {
  maxRounds?: number;
  workspace: string;
  signal?: AbortSignal;
  /**
   * Generator / Evaluator Separation: when supplied, an independent evaluator
   * reviews the round before the goal can be declared achieved. Absent = the
   * original same-session gate behaviour, byte-identical.
   */
  evaluator?: GoalEvaluator;
}

export interface GoalRunResult {
  status: "achieved" | "blocked" | "aborted" | "max_rounds_reached";
  objective: string;
  roundsRun: number;
  lastError?: string;
}

/**
 * Renders the model-visible continuation prompt for one same-session goal round.
 * Stolen from deepseek-harness goal-round-driver.
 */
export function renderGoalRoundPrompt(objective: string, round: number, maxRounds: number, previousFeedback?: string): string {
  let prompt = `<goal_round>\n` +
    `Objective: ${JSON.stringify(objective)}\n` +
    `Round: ${round}/${maxRounds}\n\n` +
    `Continue working autonomously toward the objective in this session.\n` +
    `Treat the current workspace files, tool results, and git status as authoritative.\n` +
    `Make concrete progress, run necessary edits, and execute verification commands.\n`;

  if (previousFeedback) {
    prompt += `\n[VERIFICATION FEEDBACK FROM PREVIOUS ROUND]:\n${previousFeedback}\n` +
      `Fix the failing checks above before proceeding.\n`;
  }

  prompt += `</goal_round>`;
  return prompt;
}

/**
 * Runs the autonomous goal driver loop in the active session.
 */
export async function runAutonomousGoalLoop(
  objective: string,
  runtime: Runtime,
  renderer: { line: (msg: string) => void; notice: (msg: string) => void },
  opts: GoalRunOptions
): Promise<GoalRunResult> {
  const maxRounds = opts.maxRounds ?? 5;
  const workspace = opts.workspace;
  const rt = runtime as any;

  if (typeof rt.setGoal === "function") {
    await rt.setGoal(objective, "active");
  }

  renderer.notice(bold(cyan(`◆ Goal Loop Started: `)) + objective);
  renderer.notice(dim(`  Autonomous iterations enabled (max rounds: ${maxRounds})`));
  renderer.notice(dim(`  Stopping condition: 3-Layer Verification Gate (Syntax → Tests → System probe)`));

  let currentFeedback: string | undefined = undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (opts.signal?.aborted) {
      renderer.notice(yellow(`Goal loop cancelled by user at round ${round}`));
      return { status: "aborted", objective, roundsRun: round - 1 };
    }

    renderer.notice(bold(`\n── Round ${round}/${maxRounds} ──────────────────────────────`));

    // 1. Dispatch prompt for this goal round
    const roundPrompt = renderGoalRoundPrompt(objective, round, maxRounds, currentFeedback);
    try {
      await runtime.send(roundPrompt, { onEvent: () => {} });
    } catch (err: any) {
      renderer.notice(red(`Assistant error in round ${round}: ${err?.message ?? String(err)}`));
      currentFeedback = `Execution error: ${err?.message ?? String(err)}`;
      continue;
    }

    // 2. Evaluator check: run Three-Layer Termination Gate
    renderer.notice(dim(`[evaluator] Evaluating Three-Layer Termination Gate...`));
    const changed = (rt.lastChangedPaths as readonly string[]) ?? [];
    const gateResult = evaluateTerminationGate({
      changedPaths: changed,
      verifiedCommand: rt.lastVerifiedCommand,
      lastCommandExitCode: rt.lastCommandExitCode ?? 0,
      workspace,
    });

    // Generator / Evaluator Separation: an independent evaluator must also
    // pass before a goal can be declared achieved. The local gate stays as a
    // necessary (not sufficient) condition; the evaluator never trusts the
    // generator's own state or narration.
    let evaluation: GoalEvaluatorVerdict | undefined = undefined;
    if (opts.evaluator !== undefined) {
      renderer.notice(dim(`[evaluator] Independent review of round ${round}...`));
      try {
        evaluation = await opts.evaluator.evaluate({
          objective,
          round,
          changedPaths: changed,
          gateFeedback: gateResult.feedback ?? gateResult.notice,
        });
      } catch (err) {
        evaluation = {
          verdict: "fail",
          reasons: [`evaluator error: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
      renderer.notice(
        evaluation.verdict === "pass"
          ? green(`[evaluator] Independent review passed`)
          : yellow(`[evaluator] Independent review withheld: ${evaluation.reasons.join("; ")}`),
      );
    }

    if (gateResult.canTerminate && (evaluation === undefined || evaluation.verdict === "pass")) {
      renderer.notice(green(`✔ Verification Gate Passed: Syntax clean, Tests pass`));
      renderer.notice(bold(green(`\n★ GOAL ACHIEVED: `)) + objective);

      if (typeof rt.setGoal === "function") {
        await rt.setGoal(objective, "achieved");
      }
      return { status: "achieved", objective, roundsRun: round };
    } else {
      const gateReason = gateResult.feedback ?? gateResult.notice ?? "Verification incomplete";
      const reason = evaluation?.verdict === "fail" ? evaluation.reasons.join("; ") : gateReason;
      renderer.notice(yellow(`⚠ Round ${round} verification incomplete: ${gateResult.notice ?? reason}`));
      currentFeedback = reason;
    }
  }

  renderer.notice(yellow(`\n⚠ Goal reached max rounds (${maxRounds}) without full verification.`));
  renderer.notice(dim(`Use /goal to inspect status or /changes to review staged work.`));
  return {
    status: "max_rounds_reached",
    objective,
    roundsRun: maxRounds,
    lastError: currentFeedback,
  };
}
