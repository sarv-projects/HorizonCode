/**
 * Doctor surface for B-4 live cache-hit probe — availability + hermetic status only.
 *
 * Does not call provider APIs from `hzcode doctor`. Live measurement stays behind
 * `HZ_LIVE_CACHE=1` and real credentials (see `cache-hit-probe.test.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, missingKey, type EnvLike } from "../config";
import {
  hermeticCacheHitProbeSelfCheck,
  liveCacheProbeRequested,
  type HermeticCacheHitProbeSelfCheck,
} from "./cache-hit-probe";

export interface CacheHitProbeDoctorPosture {
  selfCheck: HermeticCacheHitProbeSelfCheck;
  liveRequested: boolean;
  provider: string;
  providerKeyMissing: boolean;
  /** When a prior opt-in live run persisted a snapshot (never required for CI). */
  lastLiveNote?: string;
}

function readOptionalLastLiveNote(home: string): string | undefined {
  const path = join(home, ".config", "horizon", "cache-hit-probe-last.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { note?: unknown; at?: unknown };
    if (typeof raw.note !== "string" || raw.note.trim() === "") return undefined;
    const at = typeof raw.at === "string" ? raw.at : undefined;
    return at ? `${raw.note} (recorded ${at})` : raw.note;
  } catch {
    return undefined;
  }
}

export function assessCacheHitProbeDoctor(
  env: EnvLike,
  home: string = homedir(),
): CacheHitProbeDoctorPosture {
  const selfCheck = hermeticCacheHitProbeSelfCheck();
  const liveRequested = liveCacheProbeRequested(env as Record<string, string | undefined>);
  const config = loadConfig(env);
  const providerKeyMissing = missingKey(config) !== null && config.provider !== "mock" && config.provider !== "ollama";
  const lastLiveNote = readOptionalLastLiveNote(home);
  return {
    selfCheck,
    liveRequested,
    provider: config.provider,
    providerKeyMissing,
    lastLiveNote,
  };
}

export function formatCacheHitProbeDoctorDetail(posture: CacheHitProbeDoctorPosture): string {
  const parts: string[] = [
    "probe available (cache-hit-probe.ts)",
    posture.selfCheck.summary,
  ];
  if (posture.liveRequested) {
    parts.push(
      posture.providerKeyMissing
        ? `HZ_LIVE_CACHE=1 but no provider key — live hit not claimed (provider=${posture.provider})`
        : `HZ_LIVE_CACHE=1 enabled — doctor does not call the API; run providers/cache-hit-probe live test`,
    );
  } else {
    parts.push("live measure off (HZ_LIVE_CACHE=1 opt-in)");
  }
  if (posture.lastLiveNote) {
    parts.push(`last live note: ${posture.lastLiveNote}`);
  }
  return parts.join("; ");
}