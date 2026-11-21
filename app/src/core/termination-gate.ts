/**
 * termination-gate.ts — Three-Layer Termination Gate
 *
 * Implements the termination verification pattern from Harness Engineering Lecture 09
 * ("Preventing Agents from Declaring Victory Too Early").
 *
 * Systematic bias in AI agents causes premature completion declarations: agents "feel"
 * done when code is typed, but real correctness requires externalized, execution-based
 * validation across three layers:
 *   - Layer 1: Syntax & Static Analysis (tsc, eslint, cargo check, ruff, mypy)
 *   - Layer 2: Unit & Behavioral Tests (bun test, pytest, cargo test, jest)
 *   - Layer 3: System-level / Runtime Probe (app startup check, health endpoint, E2E)
 *
 * When an agent attempts to end a turn after mutating files without executing verification
 * (or after a failing check), this gate intercepts completion, provides actionable
 * diagnostics, and gives the agent a bounded opportunity to verify before settling.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isVerificationShellCommand } from "./verification-shell";

export const TERMINATION_GATE_INTERCEPT_EVENT = "run.termination_gate_intercept";

export interface TerminationCheckEvaluation {
  /** True when the agent meets the termination criteria. */
  canTerminate: boolean;
  /** Primary layer causing refusal when canTerminate is false. */
  failingLayer?: "syntax" | "tests" | "runtime" | "unverified";
  /** Actionable feedback text to inject into the conversation. */
  feedback?: string;
  /** Short human-readable notice. */
  notice?: string;
}

export function terminationGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.HZ_TERMINATION_GATE === "0") return false;
  return env.HZ_TERMINATION_GATE === "1" || env.HZ_TERMINATION_GATE === "true";
}

/**
 * Inspects a workspace to suggest the primary verification command for Layer 1 & 2.
 */
export function detectWorkspaceVerificationCommand(workspace: string): string | undefined {
  try {
    const pkgPath = path.join(workspace, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return "bun test (or npm test)";
      if (pkg.scripts?.check) return "bun run check";
      if (pkg.scripts?.typecheck) return "bun run typecheck";
      return "bun test";
    }
    if (fs.existsSync(path.join(workspace, "Cargo.toml"))) {
      return "cargo test && cargo check";
    }
    if (fs.existsSync(path.join(workspace, "pyproject.toml")) || fs.existsSync(path.join(workspace, "requirements.txt"))) {
      return "pytest";
    }
  } catch {
    // best-effort detection
  }
  return undefined;
}

/**
 * Evaluates whether a turn that modified files is eligible to declare victory.
 *
 * @param changedPaths List of files modified in this turn
 * @param verifiedCommand Verification command executed, if any
 * @param lastCommandExitCode Exit code of the verification command, if known
 * @param workspace Path to the active workspace
 */
export function evaluateTerminationGate(params: {
  changedPaths: readonly string[];
  verifiedCommand?: string;
  lastCommandExitCode?: number | null;
  workspace: string;
}): TerminationCheckEvaluation {
  const { changedPaths, verifiedCommand, lastCommandExitCode, workspace } = params;

  // If no files changed, there are no unverified mutations to block.
  if (changedPaths.length === 0) {
    return { canTerminate: true };
  }

  const shown = changedPaths.slice(0, 4).join(", ");
  const more = changedPaths.length > 4 ? ` and ${changedPaths.length - 4} more` : "";
  const suggestedCmd = detectWorkspaceVerificationCommand(workspace);
  const cmdHint = suggestedCmd ? ` (e.g. \`${suggestedCmd}\`)` : "";

  // Failure Mode A: A verification command was executed, but it failed!
  if (verifiedCommand !== undefined && typeof lastCommandExitCode === "number" && lastCommandExitCode !== 0) {
    return {
      canTerminate: false,
      failingLayer: "tests",
      notice: `termination gate: verification command failed with exit code ${lastCommandExitCode}`,
      feedback:
        `[termination-gate] Premature victory prevented (Harness Engineering Lecture 09).\n` +
        `Your verification command \`${verifiedCommand}\` failed with exit code ${lastCommandExitCode}.\n` +
        `You modified ${changedPaths.length} file(s) (${shown}${more}) but tests are not passing. ` +
        `Fix the reported errors and re-run verification before concluding your task.`,
    };
  }

  // Failure Mode B: Files were mutated, but NO verification command was executed at all!
  if (verifiedCommand === undefined) {
    return {
      canTerminate: false,
      failingLayer: "unverified",
      notice: `termination gate: preventing premature victory — model must verify changed files`,
      feedback:
        `[termination-gate] Premature victory prevented (Harness Engineering Lecture 09).\n` +
        `You modified ${changedPaths.length} file(s) (${shown}${more}) but did not execute verification.\n` +
        `Required verification layers:\n` +
        `  - Layer 1 (Syntax/Types): verify syntax and static analysis pass\n` +
        `  - Layer 2 (Tests): run unit and behavioral tests${cmdHint}\n` +
        `  - Layer 3 (Runtime): verify runtime startup or execution flow\n` +
        `Execute verification in the shell to prove changes are functional before declaring victory.`,
    };
  }

  return { canTerminate: true };
}
