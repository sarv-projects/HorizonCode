/**
 * DeepSeek-harness `systemPromptUpdate: 'in-history'` reduced (docs/30 §5.7).
 *
 * KV-cache discipline: keep the **stable** assembler prefix on `req.system` and
 * append volatile tail (environment, rails, hooks) as a trailing user envelope
 * tagged `[harness-system-update]`, so the cached message prefix is not rewritten
 * when those sections change. Anthropic/OpenAI wires call `wireSystemPromptInHistory`
 * when `HZ_SYSTEM_PROMPT_IN_HISTORY=1`.
 *
 * Residual: per-model catalog flag; live cache-hit measurement (B-4).
 */

import type { ChatMsg, ProviderRequest } from "../contracts";
import { staticPrompt } from "./prompt";

export const SYSTEM_UPDATE_TAG = "[harness-system-update]";
export const SYSTEM_PROMPT_UPDATE_ENV = "HZ_SYSTEM_PROMPT_IN_HISTORY";

export function systemPromptUpdateInHistory(env: Record<string, string | undefined> = process.env): boolean {
  return env[SYSTEM_PROMPT_UPDATE_ENV] === "1";
}

/**
 * Split stable prefix from volatile tail at the Environment block (the first
 * place the cache-stable sections end in our assembler).
 */
export function splitStableSystem(system: string): { stable: string; volatile: string } {
  const marker = "\n\nEnvironment:";
  const at = system.indexOf(marker);
  if (at === -1) return { stable: system, volatile: "" };
  return { stable: system.slice(0, at), volatile: system.slice(at) };
}

/**
 * Append-only system delta for in-history mode (never rewrite leading system).
 * Call when a mid-session system section changes outside the provider wire path.
 */
export function appendSystemPromptUpdate(messages: ChatMsg[], volatileTail: string): ChatMsg[] {
  const tail = volatileTail.trim();
  if (tail === "") return messages;
  const envelope = `${SYSTEM_UPDATE_TAG}\n${tail}`;
  return [...messages, { role: "user", content: envelope }];
}

export function wireSystemPromptInHistory(req: ProviderRequest): ProviderRequest {
  const full = typeof req.system === "string" ? req.system : "";
  if (full.trim() === "") return req;
  const { stable, volatile } = splitStableSystem(full);
  const tail = volatile.trim() !== "" ? volatile : full !== stable ? full.slice(stable.length) : "";
  const stablePrefix = stable.trim() !== "" ? stable : staticPrompt();
  const messages: ChatMsg[] = [...(req.messages ?? [])];
  const envelope =
    `${SYSTEM_UPDATE_TAG}\n` +
    (tail.trim() !== "" ? tail : full.slice(stablePrefix.length).trim() || "(system rail)");
  messages.push({ role: "user", content: envelope });
  return { ...req, system: stablePrefix, messages };
}
