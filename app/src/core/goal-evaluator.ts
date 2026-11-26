/**
 * goal-evaluator.ts -- Generator / Evaluator Separation for /goal runs
 * (docs/28 §14, Lecture 13/14).
 *
 * The generator must not grade its own work. This module gives the goal loop
 * an independent evaluator: its own system prompt, no tools, an optional
 * different model, and a strict verdict parser that fails closed. The caller
 * injects the evaluator, so tests need no provider, keys, or network.
 */
import type { Provider, ProviderRequest } from "../contracts";

export interface GoalEvaluationEvidence {
  objective: string;
  round: number;
  changedPaths: readonly string[];
  gateFeedback?: string;
  generatorSummary?: string;
}

export interface GoalEvaluatorVerdict {
  verdict: "pass" | "fail";
  reasons: string[];
}

export interface GoalEvaluator {
  evaluate(evidence: GoalEvaluationEvidence): Promise<GoalEvaluatorVerdict>;
}

export const EVALUATOR_SYSTEM_PROMPT = [
  "You are an independent evaluator of another agent's work.",
  "Do not trust the generator's claims or narrated success.",
  "Judge only the evidence supplied in the user message.",
  "An unverified claim is a failure, not a pass.",
  'Reply with exactly one JSON object: {"verdict":"pass"|"fail","reasons":["..."]}.',
  "No markdown, no prose outside the JSON object.",
].join("\n");

/** The model-visible evaluator task, deliberately distinct from the round prompt. */
export function renderEvaluatorRequest(evidence: GoalEvaluationEvidence): { system: string; prompt: string } {
  const lines = [
    "<independent_evaluation>",
    `Objective: ${JSON.stringify(evidence.objective)}`,
    `Round: ${evidence.round}`,
    `Changed paths: ${evidence.changedPaths.length > 0 ? evidence.changedPaths.join(", ") : "(none reported)"}`,
    `Local gate feedback: ${evidence.gateFeedback ?? "(none)"}`,
  ];
  if (evidence.generatorSummary) lines.push(`Generator summary: ${evidence.generatorSummary}`);
  lines.push(
    "Decide whether the objective is actually evidenced as complete.",
    "Return only the JSON verdict object.",
    "</independent_evaluation>",
  );
  return { system: EVALUATOR_SYSTEM_PROMPT, prompt: lines.join("\n") };
}

/** Strict parse: anything other than an explicit pass object is a fail. */
export function parseEvaluatorVerdict(text: string): GoalEvaluatorVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { verdict: "fail", reasons: ["evaluator output was not valid JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { verdict: "fail", reasons: ["evaluator output was not an object"] };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.verdict !== "pass" && obj.verdict !== "fail") {
    return { verdict: "fail", reasons: ["evaluator gave no explicit pass/fail verdict"] };
  }
  if (!Array.isArray(obj.reasons) || obj.reasons.length === 0 || obj.reasons.some((r) => typeof r !== "string")) {
    return { verdict: "fail", reasons: ["evaluator gave no usable reasons"] };
  }
  return { verdict: obj.verdict, reasons: obj.reasons as string[] };
}

export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
}

export interface EvidenceBackedEvaluatorOptions extends ProviderEvaluatorOptions {
  /** Runs the project's verification command(s); injected, never spawned here. */
  verify: () => Promise<VerificationResult>;
}

/**
 * A evaluator that does not trust the generator's "tests passed" claim: it
 * runs verification first, feeds the result to the independent model, and
 * requires BOTH a zero verification exit code and a model pass. Any failure,
 * throw, or disagreement fails closed.
 */
export function createEvidenceBackedEvaluator(opts: EvidenceBackedEvaluatorOptions): GoalEvaluator {
  const modelEvaluator = createProviderEvaluator(opts);
  return {
    async evaluate(evidence: GoalEvaluationEvidence): Promise<GoalEvaluatorVerdict> {
      let verification: VerificationResult;
      try {
        verification = await opts.verify();
      } catch (err) {
        return {
          verdict: "fail",
          reasons: [`verification error: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
      const output = verification.output.length > 2000 ? `${verification.output.slice(0, 2000)}... [truncated]` : verification.output;
      const modelVerdict = await modelEvaluator.evaluate({
        ...evidence,
        generatorSummary: [
          evidence.generatorSummary ?? "",
          `Verification: ${verification.command} (exit ${verification.exitCode})`,
          `Verification output: ${output || "(empty)"}`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
      });
      if (verification.exitCode !== 0) {
        return {
          verdict: "fail",
          reasons: [
            `verification ${verification.command} exited ${verification.exitCode}`,
            output || "(no verification output)",
            ...modelVerdict.reasons,
          ],
        };
      }
      if (modelVerdict.verdict !== "pass") return modelVerdict;
      return {
        verdict: "pass",
        reasons: [`verification ${verification.command} exited 0`, ...modelVerdict.reasons],
      };
    },
  };
}

/**
 * The /goal evaluator is opt-in through a separate model id: no env means the
 * original same-session gate behaviour, which keeps default spend/behavior
 * byte-identical. The model id is trimmed; blank values count as unset.
 */
export function evaluatorModelFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.HZ_GOAL_EVALUATOR_MODEL;
  if (typeof raw !== "string") return undefined;
  const model = raw.trim();
  return model === "" ? undefined : model;
}

export interface ProviderEvaluatorOptions {
  provider: Provider;
  /** Optional different model for the evaluator call. */
  model?: string;
  signal?: AbortSignal;
}

/** Build an evaluator that runs one toolless provider call per round. */
export function createProviderEvaluator(opts: ProviderEvaluatorOptions): GoalEvaluator {
  return {
    async evaluate(evidence: GoalEvaluationEvidence): Promise<GoalEvaluatorVerdict> {
      const { system, prompt } = renderEvaluatorRequest(evidence);
      let text = "";
      try {
        const request: ProviderRequest = {
          model: opts.model ?? "evaluator",
          system,
          messages: [{ role: "user", content: prompt }],
          tools: [],
          signal: opts.signal ?? new AbortController().signal,
        };
        for await (const event of opts.provider.stream(request)) {
          if (event.type === "text") text += event.text;
        }
      } catch (err) {
        return { verdict: "fail", reasons: [`evaluator provider error: ${err instanceof Error ? err.message : String(err)}`] };
      }
      return parseEvaluatorVerdict(text);
    },
  };
}
