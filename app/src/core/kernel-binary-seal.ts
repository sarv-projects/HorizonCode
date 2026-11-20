/**
 * H-30 / CB-6 / ruling **710** — detach release-binary seal honesty.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import { kernelBinarySealPath, readKernelBinarySeal } from "./kernel-socket";
import { hashKernelBinary } from "./kernel-pin";

export function assertSupervisorBinarySeal(
  stateDir: string,
  clientSha: string | undefined,
  pingSha: string | undefined,
): void {
  const disk = readKernelBinarySeal(stateDir);
  if (disk === undefined && pingSha === undefined) return;
  if (clientSha === undefined) {
    throw new Error(
      "HZ_PRECONDITION_FAILED: supervisor.binary mismatch (client digest unavailable — cannot reattach after binary upgrade)",
    );
  }
  if (disk !== undefined && clientSha !== disk) {
    throw new Error(
      `HZ_PRECONDITION_FAILED: supervisor.binary mismatch (disk=${disk} client=${clientSha})`,
    );
  }
  if (pingSha !== undefined && disk !== undefined && pingSha !== disk) {
    throw new Error(
      `HZ_PRECONDITION_FAILED: supervisor.binary mismatch (disk=${disk} ping=${pingSha})`,
    );
  }
  if (pingSha !== undefined && clientSha !== pingSha) {
    throw new Error(
      `HZ_PRECONDITION_FAILED: supervisor.binary mismatch (client=${clientSha} ping=${pingSha})`,
    );
  }
}

export type KernelBinarySealDoctorPosture =
  | { status: "ok"; detail: string }
  | { status: "warn"; detail: string; hint: string }
  | { status: "fail"; detail: string; hint: string };

/** Pure posture for doctor — no DoctorCheck import (avoids cycles). */
export function assessKernelSupervisorBinary(opts: {
  detachRequested: boolean;
  stateDir: string;
  kernelBinary: string | undefined;
}): KernelBinarySealDoctorPosture {
  if (!opts.detachRequested) {
    return {
      status: "ok",
      detail: "detach/socket env unset — hzk.binary seal not required",
    };
  }
  const sealPath = kernelBinarySealPath(opts.stateDir);
  if (!existsSync(sealPath)) {
    return {
      status: "warn",
      detail: `no ${sealPath} yet (orphan not listening or pre-710 kernel)`,
      hint: "start a detach kernel once to record hzk.binary; reattach refuses binary upgrade mismatch",
    };
  }
  const seal = readKernelBinarySeal(opts.stateDir);
  if (seal === undefined) {
    return {
      status: "warn",
      detail: `${sealPath} present but not a 64-char hex digest`,
      hint: "remove or rewrite hzk.binary; reattach will refuse ambiguous seals",
    };
  }
  const binary = opts.kernelBinary;
  if (binary === undefined) {
    return {
      status: "warn",
      detail: `sealed digest ${seal.slice(0, 12)}… (kernel binary path unknown)`,
      hint: "set HZ_KERNEL_BIN or build kernel/target/release/hz-kernel",
    };
  }
  const digest = hashKernelBinary(binary);
  if (digest === undefined) {
    return {
      status: "warn",
      detail: `sealed ${seal.slice(0, 12)}… vs unreadable ${binary}`,
      hint: "fix permissions on the configured kernel binary",
    };
  }
  if (digest !== seal) {
    return {
      status: "fail",
      detail: `hzk.binary=${seal.slice(0, 12)}… does not match ${binary} (${digest.slice(0, 12)}…)`,
      hint: "rebuild to match the orphan, or stop the detach kernel and start fresh; does not hot-swap authority across binaries",
    };
  }
  return {
    status: "ok",
    detail: `${path.basename(binary)} matches hzk.binary ${seal.slice(0, 12)}…`,
  };
}
