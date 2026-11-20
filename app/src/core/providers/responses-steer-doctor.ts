/**
 * Doctor surface for C-9 Responses WebSocket `response.steer` — availability +
 * hermetic status only.
 *
 * Does not open `wss://api.openai.com` from `hzcode doctor`. Product steering
 * stays behind `HZ_RESPONSES_STEER=1`, GPT-6-class models, and real credentials
 * (see `responses-steer-wire.test.ts` / `responses-steer-product.test.ts`).
 */

import { loadConfig, type EnvLike } from "../config";
import {
  hermeticResponsesSteerWireSelfCheck,
  RESPONSES_STEER_MODELS,
  type HermeticResponsesSteerSelfCheck,
} from "./responses-steer-wire";
import { productResponsesSteerEnabled } from "./responses-steer-product";

export interface ResponsesSteerDoctorPosture {
  selfCheck: HermeticResponsesSteerSelfCheck;
  productRequested: boolean;
  provider: string;
  openAiKeyMissing: boolean;
}

export function assessResponsesSteerDoctor(env: EnvLike): ResponsesSteerDoctorPosture {
  const selfCheck = hermeticResponsesSteerWireSelfCheck();
  const productRequested = productResponsesSteerEnabled(env as Record<string, string | undefined>);
  const config = loadConfig(env);
  const key = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  const openAiKeyMissing = key === "";
  return {
    selfCheck,
    productRequested,
    provider: config.provider,
    openAiKeyMissing,
  };
}

export function formatResponsesSteerDoctorDetail(posture: ResponsesSteerDoctorPosture): string {
  const models = RESPONSES_STEER_MODELS.join(",");
  const parts: string[] = [
    "wire available (responses-steer-wire.ts)",
    posture.selfCheck.summary,
    `GPT-6 steer models: ${models}`,
  ];
  if (posture.productRequested) {
    parts.push(
      posture.openAiKeyMissing
        ? "HZ_RESPONSES_STEER=1 but OPENAI_API_KEY unset — live GPT-6 steer not claimed"
        : `HZ_RESPONSES_STEER=1 on (provider=${posture.provider}) — doctor does not open Responses WS; chat-completions may lack response.created id until Responses stream path`,
    );
  } else {
    parts.push("product steer off (HZ_RESPONSES_STEER=1 opt-in)");
  }
  return parts.join("; ");
}