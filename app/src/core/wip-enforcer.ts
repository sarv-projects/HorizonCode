/**
 * wip-enforcer.ts — WIP = 1 Scope Enforcer
 *
 * Implements the single-active-feature / WIP=1 enforcement pattern from
 * Harness Engineering Lectures 07 & 08 ("Why Agents Overreach and Under-Finish"
 * and "Why Feature Lists are Harness Primitives").
 *
 * Agents systematically fail on multi-task projects when they start new tasks
 * before finishing and verifying in-progress work. If `feature_list.json` or
 * a structured task plan is present in the workspace, this gate enforces:
 *   1. Exactly one active feature in progress at any time (WIP = 1).
 *   2. Refuses taking on a second in-progress task before the active one passes verification.
 *   3. Enforces that features marked "done" or "passes" carry verification evidence.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface FeatureItem {
  id: string;
  name?: string;
  description?: string;
  status?: "pending" | "in_progress" | "active" | "done" | "passed";
  passes?: boolean;
  verification?: string[];
  [key: string]: unknown;
}

export interface WipCheckResult {
  allowed: boolean;
  activeCount: number;
  activeFeatures: FeatureItem[];
  violations: string[];
}

export const WIP_ENFORCER_FILE = "feature_list.json";

/**
 * Checks whether the workspace has a feature list and validates WIP = 1.
 */
export function checkWorkspaceWip(workspace: string): WipCheckResult {
  const filePath = path.join(workspace, WIP_ENFORCER_FILE);
  if (!fs.existsSync(filePath)) {
    return { allowed: true, activeCount: 0, activeFeatures: [], violations: [] };
  }

  let features: FeatureItem[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      features = parsed as FeatureItem[];
    } else if (parsed && Array.isArray(parsed.features)) {
      features = parsed.features as FeatureItem[];
    } else {
      return {
        allowed: false,
        activeCount: 0,
        activeFeatures: [],
        violations: ["feature_list.json must contain a top-level array or { features: [...] }"],
      };
    }
  } catch (err) {
    return {
      allowed: false,
      activeCount: 0,
      activeFeatures: [],
      violations: [`feature_list.json is malformed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const activeFeatures: FeatureItem[] = [];
  const violations: string[] = [];

  for (const f of features) {
    const isActive = f.status === "in_progress" || f.status === "active";
    if (isActive) {
      activeFeatures.push(f);
    }

    // Lecture 08 check: marked passed/done without verification evidence
    const isDone = f.status === "done" || f.status === "passed" || f.passes === true;
    const hasVerification = Array.isArray(f.verification) && f.verification.length > 0;
    if (isDone && !hasVerification) {
      violations.push(`Feature [${f.id}] marked done/passed without verification evidence in 'verification' field.`);
    }
  }

  // Lecture 07 check: WIP > 1 (overreaching)
  if (activeFeatures.length > 1) {
    const ids = activeFeatures.map((f) => f.id).join(", ");
    violations.push(
      `WIP = 1 violation: ${activeFeatures.length} features are currently active (${ids}). ` +
        `Only one feature may be active at a time to prevent context fragmentation.`,
    );
  }

  return {
    allowed: violations.length === 0,
    activeCount: activeFeatures.length,
    activeFeatures,
    violations,
  };
}
