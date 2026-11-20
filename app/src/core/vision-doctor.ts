/**
 * Doctor surface for multimodal / vision posture (extends **676**, ruling **731**).
 */

import type { EnvLike } from "./config";
import { assessVisionPosture, visionHonestyNotice, type VisionPosture } from "./vision-posture";

export function assessVisionDoctor(provider: string, model: string, env: EnvLike): VisionPosture {
  return assessVisionPosture(provider, model, env);
}

export function formatVisionDoctorDetail(posture: VisionPosture): string {
  return `${visionHonestyNotice(posture, "doctor")}; never shell-net enforced`;
}

export const VISION_DOCTOR_FIX_LINES = [
  "# Force vision on (wire image parts even when heuristic is text-only):",
  "export HZ_VISION=1",
  "# Force text-only (strip image parts on provider wire):",
  "export HZ_VISION=0",
  "# Use a vision-capable model id (examples):",
  "#   anthropic: claude-sonnet-4-5",
  "#   openai: gpt-4o",
  "#   google: gemini-2.5-flash",
] as const;