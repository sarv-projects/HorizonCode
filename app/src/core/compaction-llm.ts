/**
 * Opt-in LLM semantic compaction for elided history (extends ruling 668).
 *
 * Default-off: `HZ_LLM_COMPACTION=1` or `LoopDeps.llmCompaction`. One weak-or-main
 * provider call per compaction when enabled; on error/timeout/empty output, the
 * loop falls back to deterministic `summariseElided`.
 */

import type { ChatMsg, Provider, ProviderRequest } from "../contracts";
import { commitMessageModels, resolveCommitWeakModelFor } from "./commit";
import {
  elidedPrefixForCompaction,
  MAX_SUMMARY_CHARS,
  SUMMARY_HEADING,
  summariseElided,
  tokensIn,
} from "./compaction";
import type { CompactionBreaker } from "./compaction-breaker";
import type { CompactionHoldBuffer } from "./compaction-hold";
import type { ElidedSummariser } from "./compaction-hold";
import { textFromChatContent } from "./chat-content";
import { estimateTokens } from "./output-budget";

export const LLM_COMPACTION_ENV = "HZ_LLM_COMPACTION";

/** Default wall for the compaction summariser (separate from turn budgets). */
export const LLM_COMPACTION_TIMEOUT_MS = 15_000;

/** Cap on excerpt characters fed to the summariser prompt. */
export const LLM_COMPACTION_MAX_INPUT_CHARS = 12_000;

/** Output budget for the compaction call (provider `maxTokens`). */
export const LLM_COMPACTION_MAX_OUTPUT_TOKENS = 400;

export type LlmCompactionLoopSlice = {
  llmCompaction?: boolean;
  provider: Provider;
  model: string;
  signal: AbortSignal;
};

export function llmCompactionEnabled(
  deps: { llmCompaction?: boolean },
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  if (deps.llmCompaction === true) return true;
  return env[LLM_COMPACTION_ENV] === "1";
}

export function compactionSummaryModels(
  mainModel: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const weak = resolveCommitWeakModelFor(mainModel, env);
  return commitMessageModels(mainModel, weak);
}

function formatRoles(elided: readonly ChatMsg[]): string {
  const counts: Record<string, number> = {};
  for (const message of elided) {
    const role = message?.role ?? "unknown";
    counts[role] = (counts[role] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([role, count]) => `${role}:${count}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** Build a clipped plain-text transcript of elided turns for the summariser. */
export function transcriptExcerptForCompaction(elided: readonly ChatMsg[], maxChars = LLM_COMPACTION_MAX_INPUT_CHARS): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; i < elided.length; i += 1) {
    const message = elided[i];
    const role = message?.role ?? "unknown";
    let text = textFromChatContent(message?.content ?? "").trim();
    if (text === "" && (message?.toolCalls?.length ?? 0) > 0) {
      const names = (message?.toolCalls ?? []).map((c) => c?.name ?? "tool").join(", ");
      text = `[tool calls: ${names}]`;
    }
    const line = `${i + 1}. (${role}) ${text}`;
    if (size + line.length + 1 > maxChars) {
      lines.push(`… (${elided.length - i} further message(s) omitted from excerpt)`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

export function buildLlmCompactionPrompt(elided: readonly ChatMsg[], total: number, limit: number): string {
  const excerpt = transcriptExcerptForCompaction(elided);
  return [
    "Summarize the elided conversation turns below in 8-12 short bullet lines.",
    "Capture: the user's goals, constraints, decisions, files or paths touched, commands run, and open work.",
    "Do not invent facts not present in the excerpt. No preamble — bullets only.",
    "",
    `Context: ${elided.length} of ${total} messages left a ${limit}-message provider window.`,
    "",
    "---",
    excerpt,
    "---",
  ].join("\n");
}

export function formatLlmCompactionSummary(llmBody: string, elided: readonly ChatMsg[], total: number, limit: number): string {
  const body = llmBody.trim();
  const headMeta = [
    SUMMARY_HEADING,
    "",
    `${elided.length} of ${total} messages left the ${limit}-message window (~${tokensIn(elided)} tokens).`,
    `- roles elided: ${formatRoles(elided)}`,
    "- summary source: semantic (one provider call; see bullets below)",
    "",
  ];
  const footer = "- the full transcript is unchanged in the session store; this block is a view, not a deletion.";
  const cutNote = `- (further summary lines omitted at the ${MAX_SUMMARY_CHARS}-char cap)`;

  if (body === "") {
    return [...headMeta, "(semantic summary empty)", footer].join("\n");
  }

  const bodyLines = body.split("\n");
  const capped: string[] = [...headMeta];
  let bodySize = headMeta.join("\n").length + 1 + footer.length;
  for (let i = 0; i < bodyLines.length; i += 1) {
    const line = bodyLines[i] as string;
    const reserve = i < bodyLines.length - 1 ? 1 + cutNote.length : 0;
    if (bodySize + 1 + line.length + reserve > MAX_SUMMARY_CHARS) {
      capped.push(cutNote);
      break;
    }
    capped.push(line);
    bodySize += 1 + line.length;
  }
  capped.push(footer);
  return capped.join("\n");
}

export async function streamCompactionSummary(args: {
  provider: Provider;
  model: string;
  prompt: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const timeoutMs = args.timeoutMs ?? LLM_COMPACTION_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort();
  };
  args.signal.addEventListener("abort", onParentAbort, { once: true });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : undefined;

  const request: ProviderRequest = {
    model: args.model,
    system:
      "You compress conversation history for a coding agent. Output only concise markdown bullets; no tools; no code fences unless quoting a path.",
    messages: [{ role: "user", content: args.prompt }],
    tools: [],
    maxTokens: LLM_COMPACTION_MAX_OUTPUT_TOKENS,
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
    args.signal.removeEventListener("abort", onParentAbort);
  }
  const trimmed = text.trim();
  return trimmed !== "" ? trimmed : undefined;
}

export async function tryLlmSemanticCompaction(
  deps: LlmCompactionLoopSlice,
  elided: readonly ChatMsg[],
  total: number,
  limit: number,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  breaker?: CompactionBreaker,
): Promise<string | undefined> {
  const models = compactionSummaryModels(deps.model, env);
  if (models.length === 0) return undefined;
  const prompt = buildLlmCompactionPrompt(elided, total, limit);
  if (estimateTokens(prompt) > 100_000) return undefined;
  // ADDITIVE: a per-run breaker refuses further attempts after repeated
  // compaction failures, so a failing summariser cannot burn provider calls.
  if (breaker !== undefined && !breaker.allowAttempt().allowed) return undefined;

  for (const model of models) {
    const raw = await streamCompactionSummary({
      provider: deps.provider,
      model,
      prompt,
      signal: deps.signal,
    });
    if (raw !== undefined) {
      breaker?.recordSuccess();
      return formatLlmCompactionSummary(raw, elided, total, limit);
    }
    breaker?.recordFailure(`compaction summary model ${model} returned no output`);
  }
  return undefined;
}

/**
 * When LLM compaction is enabled and hold-then-swap will not apply, attempt one
 * semantic summary; returns a constant summariser or undefined (deterministic default).
 */
export async function resolveLlmCompactionSummariser(
  deps: LlmCompactionLoopSlice,
  rawHistory: ChatMsg[],
  historyLimit: number,
  hold?: CompactionHoldBuffer,
  breaker?: CompactionBreaker,
): Promise<ElidedSummariser | undefined> {
  if (!llmCompactionEnabled(deps)) return undefined;
  const elided = elidedPrefixForCompaction(rawHistory, historyLimit);
  if (!elided) return undefined;
  if (hold?.wouldSwap(elided)) return undefined;
  const llm = await tryLlmSemanticCompaction(deps, elided, rawHistory.length, historyLimit, process.env, breaker);
  if (llm === undefined) return undefined;
  return () => llm;
}

/** Fail-closed merge: LLM summary when present, else deterministic `summariseElided`. */
export function summariseElidedOrLlm(
  elided: readonly ChatMsg[],
  total: number,
  limit: number,
  llmSummary?: string,
): string {
  if (llmSummary !== undefined && llmSummary.trim() !== "") return llmSummary;
  return summariseElided(elided, total, limit);
}