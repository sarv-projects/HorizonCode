/**
 * Honest vision / multimodal posture for the active provider+model (ruling **731**).
 * Pure heuristics + `HZ_VISION` override — no live API probe.
 */

import type { ChatMsg } from "../contracts";
import { chatContentHasImage } from "./chat-content";

export type EnvLike = Record<string, string | undefined>;

export type VisionSupport = true | false | "unknown";

export type VisionPosture = {
  support: VisionSupport;
  provider: string;
  model: string;
  summary: string;
  envOverride?: "force-on" | "force-off";
};

function visionEnvOverride(env: EnvLike): "force-on" | "force-off" | undefined {
  const raw = env.HZ_VISION;
  if (typeof raw !== "string" || raw === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "force") return "force-on";
  if (v === "0" || v === "false" || v === "off") return "force-off";
  return undefined;
}

/** Heuristic vision capability for provider+model (no network). */
export function inferVisionSupport(provider: string, model: string): VisionSupport {
  const p = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  if (m === "") return "unknown";

  if (p === "mock") return true;

  if (p === "ollama") {
    return /llava|vision|moondream|bakllava|minicpm-v|gemma.*vision|llama.*vision/i.test(m) ? true : false;
  }

  if (p === "anthropic" || p.includes("anthropic")) {
    if (/claude-(3|4)/i.test(m) || /claude-(sonnet|opus|haiku)-[34]/i.test(m)) return true;
    if (/claude-2|claude-instant/i.test(m)) return false;
    return "unknown";
  }

  if (p === "google" || p.includes("gemini")) {
    return /gemini/i.test(m) ? true : "unknown";
  }

  if (p === "openai" || p.includes("openai") || p === "groq" || p === "openrouter") {
    if (/gpt-3\.5|text-davinci|codex(?!-)/i.test(m) && !/vision|4o|gpt-4/i.test(m)) return false;
    if (/gpt-4|4o|vision|o1(?!-mini)|o3|gpt-5/i.test(m)) return true;
    return "unknown";
  }

  return "unknown";
}

export function assessVisionPosture(provider: string, model: string, env: EnvLike): VisionPosture {
  const override = visionEnvOverride(env);
  const inferred = inferVisionSupport(provider, model);
  const support: VisionSupport =
    override === "force-on" ? true : override === "force-off" ? false : inferred;
  const parts = [`provider=${provider}`, `model=${model}`, `vision=${support}`];
  if (override) parts.push(`HZ_VISION=${override === "force-on" ? "on" : "off"}`);
  else if (inferred === "unknown") parts.push("heuristic inconclusive");
  return {
    support,
    provider,
    model,
    summary: parts.join("; "),
    ...(override ? { envOverride: override } : {}),
  };
}

export function historyHasImages(messages: readonly ChatMsg[]): boolean {
  for (const msg of messages) {
    if (chatContentHasImage(msg.content)) return true;
  }
  return false;
}

/** Notice when images are stripped or posture is uncertain (loop + doctor). */
export function visionHonestyNotice(posture: VisionPosture, context: "dispatch" | "doctor"): string {
  if (posture.support === false) {
    return context === "doctor"
      ? `multimodal: this model is treated as text-only (${posture.summary}); image parts in history will be dropped on wire`
      : `multimodal: images stripped for this dispatch — ${posture.summary}`;
  }
  if (posture.support === "unknown") {
    return `multimodal: vision support is unknown for ${posture.provider}/${posture.model}; image parts are wired when present — set HZ_VISION=0 to force text-only`;
  }
  return `multimodal: vision treated as supported (${posture.summary})`;
}