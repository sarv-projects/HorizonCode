/**
 * guardian.ts — Tier-3 guardian action classifier (docs/28 ruling 41).
 *
 * An OPTIONAL per-action pass: given a proposed action and the task
 * instructions, a classifier returns an allow / flag / deny judgment.
 * Mirrors codex guardian/ (review_session, score_authorization, routing,
 * coverage, classifier_instructions; research/compare-codex-grok.md §1.9).
 *
 * THE ADVISORY CONTRACT.
 *  - ADVISORY BY DEFAULT. `reviewAction` reports the judgment, but a `deny`
 *    or `flag` verdict NEVER silently vetoes the action: `blocked` is false
 *    and `mode` is "advisory". The verdict is surfaced for the host to show
 *    or record.
 *  - ENFORCING only when EXPLICITLY configured: `{ mode: "enforce" }` (or the
 *    `HORIZON_GUARDIAN=enforce` env flag via `guardianModeFromEnv`). Then, and
 *    only then, a `deny` sets `blocked: true`. `flag` never blocks.
 *  - A classifier that throws never blocks, even when enforcing: the failure
 *    is surfaced as a `flag` with reason `classifier-error:<code>`.
 *  - The guardian only judges. It does not replace the kernel guard
 *    (`GuardAction` admission), never widens authority, and performs no I/O.
 *
 * EXTENDS review.ts, does not duplicate it: it reuses the review fork's
 * origin stamp, its closed read-only tool posture (`REVIEW_FORK_TOOLS`) as the
 * model path's declared tool subset, and its typed-error pattern (a class with
 * a stable machine-readable `reason`).
 *
 * CLASSIFIERS.
 *  - `deterministicClassifier`: rule based, no provider; for tests and as the
 *    fallback.
 *  - `createGuardianClassifier({ model })`: CAPABILITY-DETECTED. A model-backed
 *    classifier is returned only when a `GuardianModelCapability` is present;
 *    otherwise the deterministic classifier is returned.
 *
 * Wiring: none in loop.ts. The guardian is an opt-in pass invoked by the
 * host, so turn semantics are unchanged. Types are local (no contracts.ts
 * change); `GuardAction`/`GuardKind` are only consumed.
 */

import type { GuardAction, GuardKind } from "../contracts";
import { REVIEW_FORK_ORIGIN, REVIEW_FORK_TOOLS, type ReviewForkTool } from "./review";

export type GuardianVerdict = "allow" | "flag" | "deny";
export const GUARDIAN_VERDICTS: readonly GuardianVerdict[] = ["allow", "flag", "deny"];

export interface GuardianJudgment {
  verdict: GuardianVerdict;
  reason: string;
  /** Optional 0..1 confidence. */
  score?: number;
}

export interface ProposedAction {
  /** The tool that would run. */
  tool: string;
  /** The guard kind the action would be admitted as. */
  kind: GuardKind;
  /** Target summary: path, command, url, ... */
  target: string;
  args?: Record<string, unknown>;
}

/** Build a ProposedAction from a kernel GuardAction. */
export function proposedFromGuardAction(tool: string, action: GuardAction): ProposedAction {
  return { tool, kind: action.kind, target: action.target, ...(action.detail ? { args: action.detail } : {}) };
}

export interface GuardianClassifier {
  readonly name: string;
  classify(proposed: ProposedAction, instructions: string): GuardianJudgment | Promise<GuardianJudgment>;
}

export type GuardianMode = "advisory" | "enforce";

export interface GuardianOptions {
  /** Default "advisory". Only the literal "enforce" makes a deny block. */
  mode?: GuardianMode;
}

export interface GuardianReview {
  judgment: GuardianJudgment;
  mode: GuardianMode;
  /** True only when mode is "enforce" and the verdict is "deny". */
  blocked: boolean;
  /** True when the verdict is flag/deny (worth surfacing). */
  surfaced: boolean;
  classifier: string;
  origin: typeof REVIEW_FORK_ORIGIN;
}

/* ------------------------------ typed error ------------------------------ */

export type GuardianErrorReason = "invalid-input" | "invalid-model-output" | "capability-absent";

export class GuardianError extends Error {
  readonly reason: GuardianErrorReason;
  readonly detail: string;

  constructor(reason: GuardianErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "GuardianError";
    this.reason = reason;
    this.detail = detail;
  }
}

/* -------------------------------- config -------------------------------- */

/** HORIZON_GUARDIAN=enforce opts in; anything else (or unset) is advisory. */
export function guardianModeFromEnv(env: Record<string, string | undefined> = process.env): GuardianMode {
  return env.HORIZON_GUARDIAN?.trim().toLowerCase() === "enforce" ? "enforce" : "advisory";
}

/* --------------------------- deterministic path --------------------------- */

const DENY_SHELL = [/\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i, /\bmkfs\b/i, /\bdd\s+if=.*\bof=\/dev\//i, /:\(\)\s*\{/];
const FLAG_SHELL = [/\bsudo\b/i, /\bchmod\b/i, /\bcurl\b[^|]*\|\s*(sh|bash)\b/i, /\bgit\s+push\b.*--force/i];
const SENSITIVE_PATH = [/(^|\/)\.env(\.|$)/, /(^|\/)\.ssh(\/|$)/, /id_rsa/, /(^|\/)\.git\/config$/];

/** Rule-based, provider-free classifier (tests + fallback). */
export const deterministicClassifier: GuardianClassifier = {
  name: "deterministic",
  classify(proposed) {
    const target = proposed.target;
    if (proposed.kind === "shell.exec") {
      if (DENY_SHELL.some((re) => re.test(target))) return { verdict: "deny", reason: "destructive shell command", score: 1 };
      if (FLAG_SHELL.some((re) => re.test(target))) return { verdict: "flag", reason: "privileged or risky shell command", score: 0.7 };
    }
    if ((proposed.kind === "fs.write" || proposed.kind === "fs.read") && SENSITIVE_PATH.some((re) => re.test(target))) {
      return proposed.kind === "fs.write"
        ? { verdict: "deny", reason: "write to a sensitive path", score: 0.9 }
        : { verdict: "flag", reason: "read of a sensitive path", score: 0.6 };
    }
    if (proposed.kind === "net.fetch" && !/^https:\/\//i.test(target)) {
      return { verdict: "flag", reason: "non-https network fetch", score: 0.5 };
    }
    return { verdict: "allow", reason: "no rule matched", score: 0 };
  },
};

/* ------------------------------- model path ------------------------------- */

/** The provider capability the model-backed path needs: text in, text out. */
export interface GuardianModelCapability {
  complete(prompt: string): Promise<string>;
}

/** Classifier instruction (codex classifier_instructions analogue). */
export function guardianPrompt(proposed: ProposedAction, instructions: string): string {
  const tools = REVIEW_FORK_TOOLS.map((t: ReviewForkTool) => t.name).join(", ");
  return [
    "You are a read-only action guardian. Judge whether the proposed action is consistent with the task instructions.",
    `You may not act (only ${tools} style reading is permitted); you only judge.`,
    `Task instructions:\n${instructions}`,
    `Proposed action: ${JSON.stringify({ tool: proposed.tool, kind: proposed.kind, target: proposed.target })}`,
    'Reply with ONLY JSON: {"verdict": "allow" | "flag" | "deny", "reason": string}',
  ].join("\n");
}

export function parseGuardianJudgment(raw: string): GuardianJudgment {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new GuardianError("invalid-model-output", "model output is not JSON");
  }
  const rec = value as Partial<GuardianJudgment> | null;
  if (rec === null || typeof rec !== "object" || !GUARDIAN_VERDICTS.includes(rec.verdict as GuardianVerdict) || typeof rec.reason !== "string") {
    throw new GuardianError("invalid-model-output", "model output lacks a valid verdict/reason");
  }
  return { verdict: rec.verdict as GuardianVerdict, reason: rec.reason };
}

export function modelClassifier(model: GuardianModelCapability): GuardianClassifier {
  if (model === null || typeof model !== "object" || typeof model.complete !== "function") {
    throw new GuardianError("capability-absent", "model capability must expose complete(prompt)");
  }
  return {
    name: "model",
    async classify(proposed, instructions) {
      return parseGuardianJudgment(await model.complete(guardianPrompt(proposed, instructions)));
    },
  };
}

/**
 * Capability-detected factory: model-backed only when a usable capability is
 * present; otherwise the deterministic classifier.
 */
export function createGuardianClassifier(opts: { model?: GuardianModelCapability | null } = {}): GuardianClassifier {
  const model = opts.model;
  if (model && typeof model.complete === "function") return modelClassifier(model);
  return deterministicClassifier;
}

/* -------------------------------- the pass -------------------------------- */

/**
 * Review one proposed action. Advisory by default: never blocks unless
 * `opts.mode === "enforce"` and the verdict is "deny".
 */
export async function reviewAction(
  proposed: ProposedAction,
  instructions: string,
  classifier: GuardianClassifier = deterministicClassifier,
  opts: GuardianOptions = {},
): Promise<GuardianReview> {
  if (proposed === null || typeof proposed !== "object" || typeof proposed.tool !== "string" || proposed.tool === "" || typeof proposed.target !== "string") {
    throw new GuardianError("invalid-input", "proposed action requires a non-empty tool and a string target");
  }
  if (typeof instructions !== "string") throw new GuardianError("invalid-input", "instructions must be a string");
  const mode: GuardianMode = opts.mode === "enforce" ? "enforce" : "advisory";

  let judgment: GuardianJudgment;
  try {
    judgment = await classifier.classify(proposed, instructions);
  } catch (err) {
    const code = err instanceof GuardianError ? err.reason : "unexpected";
    judgment = { verdict: "flag", reason: `classifier-error:${code}` };
  }
  return {
    judgment,
    mode,
    blocked: mode === "enforce" && judgment.verdict === "deny",
    surfaced: judgment.verdict !== "allow",
    classifier: classifier.name,
    origin: REVIEW_FORK_ORIGIN,
  };
}
