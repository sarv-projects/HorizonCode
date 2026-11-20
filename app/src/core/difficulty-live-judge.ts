/**
 * C-11 opt-in live difficulty judge (ruling 694): one weak-model provider call
 * per turn when `HZ_THINKING_LIVE_JUDGE=1`, else unchanged local routing.
 *
 * Fail-closed: provider error, timeout, empty output, or unparseable tier falls
 * back to the same local path as `resolveThinkingEffort` (calibrated when
 * `HZ_THINKING_CALIBRATED=1`, else cheap heuristic). Never reaches `xhigh`
 * without explicit ultrathink. Hermetic tests inject `Provider`; product wiring
 * uses the session provider — not shell-net enforced.
 */

import type { Provider, ProviderRequest } from "../contracts";
import {
  commitMessageModels,
  resolveCommitWeakModelFor,
} from "./commit";
import type { CalibrationFeatures } from "./decision-helper";
import {
  capAtAutoThinkingCeiling,
  parseThinkingRung,
  resolveThinkingEffort,
  type ResolveThinkingEffortInput,
  type ResolvedThinkingEffort,
  type ThinkingRung,
} from "./thinking-effort";

export const LIVE_DIFFICULTY_JUDGE_ENV = "HZ_THINKING_LIVE_JUDGE";

/** Wall clock for the judge call (separate from turn budgets). */
export const LIVE_DIFFICULTY_JUDGE_TIMEOUT_MS = 8_000;

export const LIVE_DIFFICULTY_JUDGE_MAX_OUTPUT_TOKENS = 24;

const JUDGE_RUNG_WORDS = ["minimal", "low", "medium", "high"] as const;

/** True for `1` / `true` / `yes` (case-insensitive). */
export function liveDifficultyJudgeOptIn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[LIVE_DIFFICULTY_JUDGE_ENV];
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function difficultyJudgeModels(
  mainModel: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const weak = resolveCommitWeakModelFor(mainModel, env);
  return commitMessageModels(mainModel, weak);
}

function clipUserText(text: string, maxChars = 2_000): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n…(truncated)";
}

export function buildDifficultyJudgePrompt(
  userText: string,
  features?: Omit<CalibrationFeatures, "userText">,
): string {
  const toolCount = features?.toolCount ?? 0;
  const outcomes = features?.priorStepOutcomes ?? [];
  const failures = outcomes.filter((o) => o === "failure").length;
  return [
    "You classify coding-task difficulty for thinking-effort routing.",
    "Reply with exactly ONE word from this list (lowercase, no punctuation):",
    JUDGE_RUNG_WORDS.join(", "),
    "Do not explain. Do not use tools.",
    "",
    `Tool surface this turn: ${toolCount}`,
    `Prior tool failures in session: ${failures}`,
    "",
    "User task:",
    clipUserText(userText),
  ].join("\n");
}

/**
 * Parse a judge reply into a thinking rung. Rejects `xhigh` and unknown tokens
 * (fail-closed).
 */
export function parseDifficultyJudgeTier(text: string): ThinkingRung | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "") return undefined;
  const firstToken = trimmed.split(/\s+/)[0]?.replace(/[^a-z]/g, "") ?? "";
  if (firstToken === "xhigh" || firstToken === "ultrathink") return undefined;
  const direct = parseThinkingRung(firstToken);
  if (direct !== undefined && direct !== "xhigh") return direct;
  for (const word of JUDGE_RUNG_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(trimmed)) return word;
  }
  return undefined;
}

export async function streamDifficultyJudgeTier(args: {
  provider: Provider;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ThinkingRung | undefined> {
  const timeoutMs = args.timeoutMs ?? LIVE_DIFFICULTY_JUDGE_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort();
  };
  args.signal?.addEventListener("abort", onParentAbort, { once: true });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : undefined;

  const request: ProviderRequest = {
    model: args.model,
    system:
      "You are a terse classifier. Output exactly one difficulty word: minimal, low, medium, or high.",
    messages: [{ role: "user", content: args.prompt }],
    tools: [],
    maxTokens: LIVE_DIFFICULTY_JUDGE_MAX_OUTPUT_TOKENS,
    signal: controller.signal,
  };

  let text = "";
  try {
    for await (const event of args.provider.stream(request)) {
      if (event.type === "text") text += event.text;
      else if (event.type === "error") return undefined;
      else if (event.type === "done") break;
    }
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    args.signal?.removeEventListener("abort", onParentAbort);
  }
  const tier = parseDifficultyJudgeTier(text);
  return tier;
}

async function tryLiveDifficultyJudge(args: {
  provider: Provider;
  mainModel: string;
  userText: string;
  calibrationFeatures?: Omit<CalibrationFeatures, "userText">;
  signal?: AbortSignal;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<ThinkingRung | undefined> {
  const models = difficultyJudgeModels(args.mainModel, args.env);
  if (models.length === 0) return undefined;
  const prompt = buildDifficultyJudgePrompt(args.userText, args.calibrationFeatures);
  for (const model of models) {
    const tier = await streamDifficultyJudgeTier({
      provider: args.provider,
      model,
      prompt,
      signal: args.signal,
    });
    if (tier !== undefined) return tier;
  }
  return undefined;
}

export type ResolveThinkingEffortWithLiveJudgeInput = ResolveThinkingEffortInput & {
  provider: Provider;
  mainModel: string;
  signal: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * When live judge is opt-in and the sync path would run auto routing, try the
 * weak-model judge first; on any failure, fall back to local calibrated/heuristic
 * via `resolveThinkingEffort`.
 */
export async function resolveThinkingEffortWithLiveJudge(
  input: ResolveThinkingEffortWithLiveJudgeInput,
): Promise<ResolvedThinkingEffort> {
  const env = input.env ?? process.env;
  const sync = resolveThinkingEffort(input);
  if (!liveDifficultyJudgeOptIn(env) || input.autoDifficulty === false) {
    return sync;
  }
  if (sync.source !== "auto" && sync.source !== "auto-calibrated") {
    return sync;
  }

  const tier = await tryLiveDifficultyJudge({
    provider: input.provider,
    mainModel: input.mainModel,
    userText: input.userText,
    calibrationFeatures: input.calibrationFeatures,
    signal: input.signal,
    env,
  });
  if (tier !== undefined) {
    return { effort: capAtAutoThinkingCeiling(tier), source: "auto-live-judge" };
  }
  return resolveThinkingEffort(input);
}