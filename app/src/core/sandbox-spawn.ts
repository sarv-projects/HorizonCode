/**
 * sandbox-spawn.ts — verified `hz-sandbox-exec` routing for owned children.
 *
 * Truthfulness rule: a kernel report is a CLAIM, not evidence. This module
 * therefore runs a live canary — `hz-sandbox-exec -- /bin/true` with the exact
 * child policy (FS root/mode, RO paths, child net) — and only treats the
 * sandbox as applied when that canary actually exits 0. The result is cached
 * per environment, so the cost is one short-lived process per posture.
 *
 * Auto wrap (`spawnOwned` shell/code labels) is best-effort unless
 * `HZ_SANDBOX_REQUIRE=1` (or `sandboxWrap: true` / `"required"`), which fail
 * closed with `SandboxUnavailableError` when the canary cannot confine.
 *
 * WSL: `unshare(CLONE_NEWNET)` is not permitted, so sandboxed children default
 * to `HZ_SANDBOX_CHILD_NET=on` there (visible notice, network dimension never
 * reported enforced). Under `HZ_SANDBOX_REQUIRE=1` that default is refused
 * rather than silently weakening the requested posture.
 */

import * as path from "node:path";
import type { EnforcementOutcome, SandboxMode, SandboxSpawnKernel } from "../contracts";
import { resolveSandboxExecBinary } from "./kernel";
import {
  WSL_CHILD_NET_NOTICE,
  hostIsWsl,
  resolveSandboxChildNet,
  type SandboxChildNetMode,
} from "./sandbox-child-net";

export type SandboxFsMode = "read-only" | "workspace-write";

/** A typed fail-closed refusal: confinement was required but cannot be proven. */
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export function enforcementHasAppliedDimension(outcome: EnforcementOutcome): boolean {
  if (outcome.status !== "report") return false;
  return outcome.dimensions.some((d) => d.guarantee === "enforced");
}

/**
 * Map a SandboxMode to the Landlock FS mode env for hz-sandbox-exec.
 * `danger-full-access` returns undefined (no FS fence).
 */
export function sandboxFsModeFor(mode: SandboxMode): "read-only" | "workspace-write" | undefined {
  if (mode === "read-only") return "read-only";
  if (mode === "workspace-write") return "workspace-write";
  return undefined;
}

/** The exact sandbox env a wrapped child receives. */
export interface SandboxChildPolicy {
  fsRoot: string;
  fsMode: SandboxFsMode;
  /** `:`-separated read-only carve-outs under `fsRoot` (may be empty). */
  roPaths: string;
  childNet: SandboxChildNetMode;
  childNetSource: "explicit" | "wsl-default" | "default";
  wsl: boolean;
  /** True only when the WSL default (not an explicit value) chose `on`. */
  wslDefaultChildNet: boolean;
  notices: string[];
}

/** Resolve the child policy once; both the canary and the real child use it. */
export function resolveSandboxChildPolicy(input: {
  fsRoot?: string;
  fsMode?: SandboxFsMode;
  roPaths?: string;
  childNet?: SandboxChildNetMode;
  env?: Record<string, string | undefined>;
  /** Test seam: host WSL posture (defaults to the cached live probe). */
  wsl?: boolean;
}): SandboxChildPolicy {
  const env = input.env ?? process.env;
  const wsl = input.wsl ?? hostIsWsl();
  const net =
    input.childNet !== undefined
      ? {
          mode: input.childNet,
          source: "explicit" as const,
          wsl,
          wslDefaultChildNet: false,
          notices: [] as string[],
        }
      : resolveSandboxChildNet({ env, wsl });
  return {
    fsRoot: path.resolve(input.fsRoot ?? process.cwd()),
    fsMode: input.fsMode ?? "workspace-write",
    roPaths: input.roPaths ?? "",
    childNet: net.mode,
    childNetSource: net.source,
    wsl: net.wsl,
    wslDefaultChildNet: net.wslDefaultChildNet,
    notices: net.notices,
  };
}

/** The env overlay for a wrapped child — the only confinement-relevant vars. */
export function sandboxExecEnvOverlay(policy: SandboxChildPolicy): Record<string, string> {
  return {
    HZ_SANDBOX_FS_ROOT: policy.fsRoot,
    HZ_SANDBOX_FS_MODE: policy.fsMode,
    HZ_SANDBOX_FS_RO_PATHS: policy.roPaths,
    HZ_SANDBOX_CHILD_NET: policy.childNet,
  };
}

/* ------------------------------- canary probe ------------------------------ */

export interface SandboxExecProbe {
  ok: boolean;
  /** False when the canary could not even be attempted (missing helper, disabled). */
  probed: boolean;
  binary: string | null;
  fsRoot: string;
  fsMode: SandboxFsMode;
  childNet: SandboxChildNetMode;
  wslDefaultChildNet: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Captured stderr (bounded) for diagnosis; empty on success. */
  stderr: string;
  /** Why the canary is not a valid proof, when `ok` is false. */
  reason?: string;
  notes: string[];
}

export interface ProbeSandboxExecInput {
  policy: SandboxChildPolicy;
  env?: Record<string, string | undefined>;
  /** Override helper resolution (tests / explicit callers). */
  binary?: string;
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_STDERR_CAP = 2_000;
/** Only these ambient vars reach the canary; the confinement vars are exact. */
const PROBE_ENV_PASSTHROUGH = ["PATH", "HOME", "TMPDIR", "TMP", "LANG", "LC_ALL", "USER"] as const;

const probeCache = new Map<string, Promise<SandboxExecProbe>>();

/** Forget cached canaries (tests and explicit host re-probes). */
export function resetSandboxExecProbeCache(): void {
  probeCache.clear();
}

function probeKey(binary: string | undefined, policy: SandboxChildPolicy, env: Record<string, string | undefined>): string {
  return JSON.stringify([
    process.platform,
    binary ?? "",
    env.HZ_SANDBOX_EXEC ?? "",
    policy.fsRoot,
    policy.fsMode,
    policy.roPaths,
    policy.childNet,
  ]);
}

function probeFailed(
  policy: SandboxChildPolicy,
  binary: string | null,
  reason: string,
  opts: { probed?: boolean; exitCode?: number | null; timedOut?: boolean; stderr?: string } = {},
): SandboxExecProbe {
  return {
    ok: false,
    probed: opts.probed ?? false,
    binary,
    fsRoot: policy.fsRoot,
    fsMode: policy.fsMode,
    childNet: policy.childNet,
    wslDefaultChildNet: policy.wslDefaultChildNet,
    exitCode: opts.exitCode ?? null,
    timedOut: opts.timedOut ?? false,
    stderr: opts.stderr ?? "",
    reason,
    notes: [...policy.notices],
  };
}

function probeChildEnv(policy: SandboxChildPolicy, base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROBE_ENV_PASSTHROUGH) {
    const value = base[key];
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...sandboxExecEnvOverlay(policy) };
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return (line ?? text.trim()).slice(0, 400);
}

async function runProbe(
  binary: string,
  policy: SandboxChildPolicy,
  baseEnv: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<SandboxExecProbe> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: [binary, "--", "/bin/true"],
      cwd: policy.fsRoot,
      env: probeChildEnv(policy, baseEnv),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return probeFailed(policy, binary, `cannot start hz-sandbox-exec: ${message}`, { probed: false });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  let stderr = "";
  try {
    const stream = proc.stderr as unknown as ReadableStream<Uint8Array>;
    stderr = (await new Response(stream).text()).slice(-PROBE_STDERR_CAP);
  } catch {
    stderr = "";
  }

  if (timedOut) {
    return probeFailed(policy, binary, `hz-sandbox-exec canary timed out after ${timeoutMs}ms`, {
      probed: true,
      exitCode,
      timedOut: true,
      stderr,
    });
  }
  if (exitCode !== 0) {
    const detail = firstLine(stderr);
    const reason = `hz-sandbox-exec -- /bin/true failed (exit ${exitCode})${detail !== "" ? `: ${detail}` : ""}`;
    return probeFailed(policy, binary, reason, { probed: true, exitCode, stderr });
  }
  return {
    ok: true,
    probed: true,
    binary,
    fsRoot: policy.fsRoot,
    fsMode: policy.fsMode,
    childNet: policy.childNet,
    wslDefaultChildNet: policy.wslDefaultChildNet,
    exitCode,
    timedOut: false,
    stderr,
    notes: [...policy.notices],
  };
}

/**
 * Actually spawn `hz-sandbox-exec -- /bin/true` with the policy's exact env.
 * Cached per environment; concurrent callers share one probe.
 */
export async function probeSandboxExec(input: ProbeSandboxExecInput): Promise<SandboxExecProbe> {
  const env = input.env ?? process.env;
  const policy = input.policy;
  // A child-env pin wins; otherwise the parent's helper resolution applies.
  const binary = input.binary ?? resolveSandboxExecBinary({ ...process.env, ...env });
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;

  if (process.platform !== "linux") {
    return probeFailed(policy, binary ?? null, `the hz-sandbox-exec canary is Linux-only (this host is ${process.platform})`);
  }
  if (env.HZ_SANDBOX_EXEC === "0") {
    return probeFailed(policy, binary ?? null, "HZ_SANDBOX_EXEC=0 disables sandbox wrapping");
  }
  if (binary === undefined) {
    return probeFailed(
      policy,
      null,
      "hz-sandbox-exec was not found (build the kernel helper or set HZ_SANDBOX_EXEC_BIN)",
    );
  }

  const key = probeKey(binary, policy, env);
  const cached = probeCache.get(key);
  if (cached !== undefined) return await cached;
  const pending = runProbe(binary, policy, env, timeoutMs);
  probeCache.set(key, pending);
  return await pending;
}

/* ----------------------------- enforcement posture ------------------------- */

export interface SandboxEnforcementOptions {
  fsRoot?: string;
  fsMode?: SandboxFsMode;
  roPaths?: string;
  /** Force the child-net mode (e.g. code_mode requires `off`). */
  childNet?: SandboxChildNetMode;
  env?: Record<string, string | undefined>;
  /** Test seam: host WSL posture. */
  wsl?: boolean;
  /**
   * Refuse unless the kernel is trusted even when `HZ_SANDBOX_EXEC=1` forces
   * wrapping. code_mode sets this: model-authored JS never runs on an
   * untrusted kernel's say-so.
   */
  requireTrusted?: boolean;
}

export interface SandboxEnforcementPosture {
  enforced: boolean;
  kernelTrusted: boolean;
  canary: SandboxExecProbe | null;
  report?: EnforcementOutcome;
  reason?: string;
}

function postureFailure(
  kernelTrusted: boolean,
  canary: SandboxExecProbe | null,
  reason: string,
  report?: EnforcementOutcome,
): SandboxEnforcementPosture {
  return { enforced: false, kernelTrusted, canary, report, reason };
}

/**
 * The single verified-sandbox decision: trusted kernel (unless explicitly
 * forced) + a kernel report naming the process dimension enforced + a live
 * canary that actually exits 0. A report alone is never sufficient.
 */
export async function sandboxEnforcementPosture(
  kernel: SandboxSpawnKernel | undefined,
  opts: SandboxEnforcementOptions = {},
): Promise<SandboxEnforcementPosture> {
  const env = opts.env ?? process.env;
  const kernelTrusted = kernel?.mode === "trusted";
  if (env.HZ_SANDBOX_EXEC === "0") {
    return postureFailure(kernelTrusted, null, "HZ_SANDBOX_EXEC=0 disables sandbox wrapping");
  }
  const forced = env.HZ_SANDBOX_EXEC === "1";
  if (opts.requireTrusted === true && !kernelTrusted) {
    return postureFailure(false, null, "the kernel is not trusted; refusing to rely on its sandbox report");
  }
  if (!kernelTrusted && !forced) {
    return postureFailure(false, null, "the kernel is not trusted; refusing to rely on its sandbox report");
  }

  let report: EnforcementOutcome | undefined;
  if (!forced) {
    if (kernel === undefined) {
      return postureFailure(false, null, "no kernel is available to report its sandbox posture");
    }
    try {
      report = await kernel.sandboxReport("workspace-write", { allowPartial: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return postureFailure(kernelTrusted, null, `kernel sandbox report failed: ${message}`);
    }
    if (report.status !== "report") {
      return postureFailure(
        kernelTrusted,
        null,
        `the kernel reports SANDBOX_UNAVAILABLE: ${report.reason}`,
        report,
      );
    }
    const processEnforced = report.dimensions.some(
      (d) => d.dimension === "process" && d.guarantee === "enforced",
    );
    if (!processEnforced) {
      return postureFailure(
        kernelTrusted,
        null,
        "the kernel reports no enforced process sandbox dimension",
        report,
      );
    }
  }

  const policy = resolveSandboxChildPolicy({
    fsRoot: opts.fsRoot,
    fsMode: opts.fsMode ?? "workspace-write",
    roPaths: opts.roPaths,
    childNet: opts.childNet,
    env,
    wsl: opts.wsl,
  });
  const wslRefusal = sandboxRequireWslRefusal(policy, sandboxWrapRequired());
  if (wslRefusal !== undefined) {
    return postureFailure(kernelTrusted, null, wslRefusal, report);
  }

  const canary = await probeSandboxExec({ policy, env });
  if (!canary.ok) {
    return postureFailure(kernelTrusted, canary, canary.reason ?? "the sandbox canary failed", report);
  }
  return { enforced: true, kernelTrusted, canary, report };
}

/**
 * True when the kernel reports a process boundary AND a live canary proves the
 * helper can actually confine a child under this host's policy.
 */
export async function kernelEnforcesProcessSandbox(
  kernel: SandboxSpawnKernel,
  opts: SandboxEnforcementOptions = {},
): Promise<boolean> {
  return (await sandboxEnforcementPosture(kernel, opts)).enforced;
}

export const SANDBOX_AUTO_LABELS = new Set(["shell", "shell_session", "code_mode"]);

/** True when callers asked for fail-closed confinement (`HZ_SANDBOX_REQUIRE=1`). */
export function sandboxWrapRequired(): boolean {
  return process.env.HZ_SANDBOX_REQUIRE === "1";
}

/**
 * Under `HZ_SANDBOX_REQUIRE=1`, a WSL-defaulted `child_net=on` is a silent
 * weakening of the requested posture: refuse with a typed reason instead.
 */
export function sandboxRequireWslRefusal(
  policy: Pick<SandboxChildPolicy, "wslDefaultChildNet">,
  requireClosed: boolean,
): string | undefined {
  if (!requireClosed || !policy.wslDefaultChildNet) return undefined;
  return (
    "HZ_SANDBOX_REQUIRE=1 cannot be satisfied on this WSL host: unshare(CLONE_NEWNET) " +
    "is not permitted, so the only working child-net default is `on` and network egress " +
    "would be unconfined. Set HZ_SANDBOX_CHILD_NET=off to fail closed explicitly, or " +
    "unset HZ_SANDBOX_REQUIRE=1 to accept FS/process confinement without a network fence."
  );
}

/** The once-per-process visible notice text for a WSL child-net default. */
export function wslChildNetNotice(policy: Pick<SandboxChildPolicy, "wslDefaultChildNet">): string | undefined {
  return policy.wslDefaultChildNet ? WSL_CHILD_NET_NOTICE : undefined;
}

const emittedNotices = new Set<string>();

/** Emit one visible notice per distinct message (never silent). */
export function emitSandboxNoticeOnce(message: string): void {
  if (emittedNotices.has(message)) return;
  emittedNotices.add(message);
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* no stderr: the spawn decision is still the honest one */
  }
}

/** Test seam: clear the notices already emitted. */
export function resetSandboxNotices(): void {
  emittedNotices.clear();
}
