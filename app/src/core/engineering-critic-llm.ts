/**
 * Engineering Brain — fresh-context cross-model adversarial critic (ruling 705).
 *
 * Default-off: `HZ_ENG_CRITIC_MODEL=1` (weak-model chain) or an explicit model id.
 * One bounded provider call after the local harness `runAdversarialCritic`; on
 * error/timeout/empty/unparseable output, fail-closed to harness-only. Prompt
 * carries goal, paths, verification, evidence, and symbol-impact only — not the
 * main model's prior turn transcript (fresh-context posture).
 *
 * Hermetic tests inject `Provider`; product wiring uses the session provider.
 * Does not claim AST call-graph review. Never shell-net enforced.
 */

import type { Provider, ProviderRequest } from "../contracts";
import { commitMessageModels, resolveCommitWeakModelFor } from "./commit";
import type { CriticFinding, CriticInput, CriticReport } from "./engineering-critic";
import { mergeCriticReports, runAdversarialCritic } from "./engineering-critic";

export const ENG_CRITIC_MODEL_ENV = "HZ_ENG_CRITIC_MODEL";

export const ENG_CRITIC_LLM_TIMEOUT_MS = 20_000;

export const ENG_CRITIC_LLM_MAX_OUTPUT_TOKENS = 320;

export const ENG_CRITIC_LLM_MAX_EVIDENCE_CHARS = 24_000;

const OPT_IN_ALIASES = new Set(["1", "true", "yes", "on"]);

/** True when cross-model critic should run (explicit model id or opt-in alias). */
export function engCriticLlmOptIn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[ENG_CRITIC_MODEL_ENV];
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  if (v === "") return false;
  const lower = v.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  return true;
}

/** Models to try for the critic pass (weak chain when env is `1`/`true`). */
export function engCriticLlmModels(
  mainModel: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const raw = env[ENG_CRITIC_MODEL_ENV]?.trim() ?? "";
  if (raw === "") return [];
  if (OPT_IN_ALIASES.has(raw.toLowerCase())) {
    const weak = resolveCommitWeakModelFor(mainModel, env);
    return commitMessageModels(mainModel, weak);
  }
  return [raw];
}

function clipText(text: string | undefined, maxChars: number): string {
  if (text === undefined) return "";
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n…(truncated)";
}

export function buildEngCriticLlmPrompt(input: CriticInput): string {
  const paths = input.changedPaths.map((p) => p.replace(/\\/g, "/"));
  const blocks = [
    "You are an adversarial engineering critic reviewing a coding turn.",
    "You see ONLY the materials below — not the implementer's prior reasoning.",
    "Flag concrete risks. Do not invent files or commands not shown.",
    "Never approve claiming shell-net egress is `enforced` when evidence suggests it.",
    "",
    "Reply with 1–8 lines using ONLY this format (no markdown fences):",
    "VERDICT: PASS | PASS_WITH_NOTES | FAIL",
    "P0: <one-line evidence>   (only for blocking issues — security, policy, dishonest egress claims)",
    "P1: <one-line evidence>   (notes — scope, missing verification, blast radius)",
    "Omit P0/P1 lines when none. Do not use tools.",
    "",
    `Goal: ${clipText(input.goal, 4_000)}`,
    `Changed paths (${paths.length}): ${paths.slice(0, 40).join(", ")}${paths.length > 40 ? " …" : ""}`,
    `Verification command this turn: ${input.verifiedCommand ?? "(none)"}`,
  ];
  if (input.symbolImpactSummary?.trim()) {
    blocks.push(
      "",
      "Lexical + structural call-site impact (not tree-sitter AST call-graph):",
      clipText(input.symbolImpactSummary, 2_000),
    );
  }
  const evidence = clipText(input.evidenceText, ENG_CRITIC_LLM_MAX_EVIDENCE_CHARS);
  if (evidence !== "") {
    blocks.push("", "Evidence excerpts:", evidence);
  }
  return blocks.join("\n");
}

/**
 * Parse LLM critic lines into findings. Unrecognized output yields [] (fail-closed:
 * harness verdict stands).
 */
export function parseEngCriticLlmFindings(text: string): CriticFinding[] {
  const findings: CriticFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const p0 = trimmed.match(/^P0\s*:\s*(.+)$/i);
    if (p0?.[1]) {
      findings.push({
        code: "llm_adversarial_finding",
        severity: "P0",
        evidence: p0[1].trim().slice(0, 500),
      });
      continue;
    }
    const p1 = trimmed.match(/^P1\s*:\s*(.+)$/i);
    if (p1?.[1]) {
      findings.push({
        code: "llm_adversarial_finding",
        severity: "P1",
        evidence: p1[1].trim().slice(0, 500),
      });
    }
  }
  return findings;
}

export async function streamEngCriticLlmFindings(args: {
  provider: Provider;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CriticFinding[] | undefined> {
  const timeoutMs = args.timeoutMs ?? ENG_CRITIC_LLM_TIMEOUT_MS;
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
      "Adversarial post-mutation critic. Output only VERDICT/P0/P1 lines as instructed. No tools.",
    messages: [{ role: "user", content: args.prompt }],
    tools: [],
    maxTokens: ENG_CRITIC_LLM_MAX_OUTPUT_TOKENS,
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
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const findings = parseEngCriticLlmFindings(trimmed);
  return findings.length > 0 ? findings : undefined;
}

async function tryEngCriticLlm(args: {
  provider: Provider;
  mainModel: string;
  input: CriticInput;
  signal?: AbortSignal;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<CriticFinding[] | undefined> {
  const models = engCriticLlmModels(args.mainModel, args.env);
  if (models.length === 0) return undefined;
  const prompt = buildEngCriticLlmPrompt(args.input);
  for (const model of models) {
    const findings = await streamEngCriticLlmFindings({
      provider: args.provider,
      model,
      prompt,
      signal: args.signal,
    });
    if (findings !== undefined) return findings;
  }
  return undefined;
}

export type ResolveAdversarialCriticInput = {
  input: CriticInput;
  provider: Provider;
  mainModel: string;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Local harness critic always runs; when `HZ_ENG_CRITIC_MODEL` opts in, merge a
 * fresh-context cross-model pass or fall back to harness-only on any LLM failure.
 */
export async function resolveAdversarialCritic(args: ResolveAdversarialCriticInput): Promise<CriticReport> {
  const env = args.env ?? process.env;
  const local = runAdversarialCritic(args.input);
  if (!engCriticLlmOptIn(env)) return local;

  const llmFindings = await tryEngCriticLlm({
    provider: args.provider,
    mainModel: args.mainModel,
    input: args.input,
    signal: args.signal,
    env,
  });
  if (llmFindings === undefined) return local;
  return mergeCriticReports(local, llmFindings);
}