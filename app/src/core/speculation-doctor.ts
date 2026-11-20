/**
 * Doctor surface for speculative execution — posture and hermetic self-check only.
 */

import type { EnvLike } from "./config";
import { speculativeExecutionEnabled, type LoopDeps } from "./loop";
import {
  DEFAULT_MAX_IN_FLIGHT,
  SpeculationError,
  normalizeSpeculationEffect,
  speculationEffectForToolCall,
} from "./speculation";

/** Sync checks: closed effect union + coordinator constants (no live tool runs). */
export function hermeticSpeculationDoctorSelfCheck(): { ok: boolean; summary: string } {
  try {
    normalizeSpeculationEffect({ kind: "shell.exec", target: "echo" });
    return { ok: false, summary: "normalizeSpeculationEffect did not reject non-speculable effect" };
  } catch (err) {
    if (!(err instanceof SpeculationError) || err.reason !== "unspeculable-effect") {
      return { ok: false, summary: "normalizeSpeculationEffect threw unexpected error" };
    }
  }
  if (DEFAULT_MAX_IN_FLIGHT !== 2) {
    return { ok: false, summary: `DEFAULT_MAX_IN_FLIGHT expected 2 (got ${DEFAULT_MAX_IN_FLIGHT})` };
  }
  if (speculationEffectForToolCall("write", { path: "x" }, "/tmp") !== undefined) {
    return { ok: false, summary: "write must not be speculable" };
  }
  return { ok: true, summary: "closed effect union + max-in-flight=2 self-check ok" };
}

export type SpeculationDoctorPosture = {
  enabled: boolean;
  selfCheckOk: boolean;
  selfCheckSummary: string;
};

export function assessSpeculationDoctor(env: EnvLike): SpeculationDoctorPosture {
  const deps = {} as LoopDeps;
  const self = hermeticSpeculationDoctorSelfCheck();
  return {
    enabled: speculativeExecutionEnabled(deps, env as Record<string, string | undefined>),
    selfCheckOk: self.ok,
    selfCheckSummary: self.summary,
  };
}

export function formatSpeculationDoctorDetail(posture: SpeculationDoctorPosture): string {
  const parts: string[] = [posture.selfCheckSummary];
  if (!posture.enabled) {
    parts.push(
      "default-off (coordinator unwired on the live path); opt-in via HZ_SPECULATIVE_EXECUTION=1 or LoopDeps.speculativeExecution",
    );
    return parts.join("; ");
  }
  parts.push("opt-in WIRED (**670**): read/grep/glob/repo_map may prep mid-stream");
  parts.push("fingerprint mismatch on commit discards prep (hooks skipped; ask declined during prep)");
  parts.push("batchSegments ordering + full hook parity still OPEN");
  parts.push("never shell-net enforced");
  return parts.join("; ");
}

export const SPECULATION_DOCTOR_FIX_LINES = [
  "# Opt in to speculative read overlap (default remains off):",
  "export HZ_SPECULATIVE_EXECUTION=1",
  "# Or pass speculativeExecution: true on LoopDeps / runtime",
] as const;