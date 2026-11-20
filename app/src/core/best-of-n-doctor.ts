/**
 * Doctor surface for Best-of-N worktree racing — posture only (no delegate races).
 */

import type { EnvLike } from "./config";
import {
  bestOfNCountFromEnv,
  bestOfNParallelFromEnv,
  bestOfNRacingEnabledFromEnv,
  hermeticBestOfNSelfCheck,
} from "./best-of-n";

export type BestOfNDoctorPosture = {
  racingEnabled: boolean;
  parallel: boolean;
  n: number;
  selfCheckOk: boolean;
  selfCheckSummary: string;
};

export function assessBestOfNDoctor(env: EnvLike): BestOfNDoctorPosture {
  const racingEnabled = bestOfNRacingEnabledFromEnv(env as Record<string, string | undefined>);
  const parallel = bestOfNParallelFromEnv(env as Record<string, string | undefined>);
  const n = bestOfNCountFromEnv(env as Record<string, string | undefined>);
  const self = hermeticBestOfNSelfCheck();
  return {
    racingEnabled,
    parallel,
    n,
    selfCheckOk: self.ok,
    selfCheckSummary: self.summary,
  };
}

export function formatBestOfNDoctorDetail(posture: BestOfNDoctorPosture): string {
  const parts: string[] = [posture.selfCheckSummary];
  if (!posture.racingEnabled) {
    parts.push("racing off (set HZ_BEST_OF_N=2..4 to opt in; tool/agent fail closed)");
    return parts.join("; ");
  }
  parts.push(`HZ_BEST_OF_N=${posture.n}`);
  parts.push(
    posture.parallel
      ? "parallel worktree race on (HZ_BEST_OF_N_PARALLEL=1)"
      : "sequential first-success (HZ_BEST_OF_N_PARALLEL unset)",
  );
  parts.push("does not run delegate races from doctor");
  return parts.join("; ");
}