/**
 * Product-runtime netns default-on when capable (P0-4 residual; ruling **672**).
 *
 * When Linux, trusted Rust kernel, `hz-sandbox-exec` is available, and a
 * userns+netns (+ CREATE-path CAP) probe succeeds, `createRuntime` may set
 * `HZ_SANDBOX_NETNS=1` and child `network-off` when env is unset — mirroring
 * EffectHost `=require` preference (**540**) but only after probes pass.
 *
 * WSL2 / EPERM / missing CAP: leave off; doctor reports gaps honestly.
 * Never claim shell-net **`enforced`**. TLS MITM / proxy product E2E still OPEN.
 */

import type { EnvLike } from "./config";
import { resolveSandboxExecBinary } from "./kernel";
import { hostIsWsl } from "./sandbox-child-net";
import type { DoctorRunFn } from "./sandbox-netns-veth";
import { probeCapNetAdminForVeth } from "./sandbox-netns-veth";

/** Named gap reason for doctor + createRuntime honesty (ruling **715**). */
export type ProductNetnsCapReason =
  | "capable"
  | "non-linux"
  | "wsl"
  | "no-sandbox-exec"
  | "no-userns-netns"
  | "no-cap-net-admin"
  | "injected";

export interface ProductNetnsCapProbe {
  capable: boolean;
  reason: ProductNetnsCapReason;
  wsl: boolean;
  sandboxExec: boolean;
  unshareOk: boolean;
  capNetAdmin: boolean;
  detail: string;
}

let testCapableOverride: boolean | undefined;

/** Test seam — inject capability without host syscalls or CAP_NET_ADMIN. */
export function setProductNetnsCapProbeForTests(capable: boolean | undefined): void {
  testCapableOverride = capable;
}

function defaultDoctorRun(cmd: string, args: string[], timeoutMs: number) {
  try {
    const proc = Bun.spawnSync({ cmd: [cmd, ...args], timeout: timeoutMs, stderr: "pipe", stdout: "pipe" });
    return {
      ok: proc.exitCode === 0,
      status: proc.exitCode ?? 1,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  } catch {
    return { ok: false, status: 1, stdout: "", stderr: "" };
  }
}

/**
 * Host userns+netns (+ veth CREATE CAP) probe for product default-on.
 * Injectable via `setProductNetnsCapProbeForTests` (no real CAP_NET_ADMIN in CI).
 */
export function assessProductNetnsCapability(input: {
  env?: Record<string, string | undefined>;
  wsl?: boolean;
  run?: DoctorRunFn;
} = {}): ProductNetnsCapProbe {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const wsl = input.wsl ?? hostIsWsl();
  const run = input.run ?? defaultDoctorRun;
  const sandboxExec = resolveSandboxExecBinary(env) !== undefined;

  if (testCapableOverride !== undefined) {
    const capable = testCapableOverride;
    return {
      capable,
      reason: "injected",
      wsl,
      sandboxExec,
      unshareOk: capable,
      capNetAdmin: capable,
      detail: capable
        ? "injected probe: userns+netns+CAP ok — product default-on eligible (never shell-net enforced)"
        : wsl
          ? "injected probe: WSL/not capable — product netns stays off"
          : "injected probe: not capable — product netns stays off",
    };
  }

  if (process.platform !== "linux") {
    return {
      capable: false,
      reason: "non-linux",
      wsl: false,
      sandboxExec,
      unshareOk: false,
      capNetAdmin: false,
      detail: "non-Linux — product netns default-on not applicable",
    };
  }
  if (!sandboxExec) {
    return {
      capable: false,
      reason: "no-sandbox-exec",
      wsl,
      sandboxExec: false,
      unshareOk: false,
      capNetAdmin: false,
      detail: "hz-sandbox-exec not resolved — product netns default-off",
    };
  }

  const unshareOk = run("unshare", ["--user", "--map-root-user", "--net", "true"], 5_000).ok;
  if (wsl && !unshareOk) {
    return {
      capable: false,
      reason: "wsl",
      wsl: true,
      sandboxExec: true,
      unshareOk: false,
      capNetAdmin: false,
      detail:
        "WSL host: user+net unshare(CLONE_NEWNET) EPERM — product netns default-off; shell-net egress NOT confined; never claim enforced",
    };
  }
  const capNetAdmin = unshareOk ? probeCapNetAdminForVeth(run) : false;

  if (!unshareOk) {
    return {
      capable: false,
      reason: "no-userns-netns",
      wsl: false,
      sandboxExec: true,
      unshareOk: false,
      capNetAdmin: false,
      detail:
        "user+net unshare unavailable (EPERM/ENOSYS) — product netns default-off; never claim shell-net enforced",
    };
  }
  if (!capNetAdmin) {
    return {
      capable: false,
      reason: "no-cap-net-admin",
      wsl,
      sandboxExec: true,
      unshareOk: true,
      capNetAdmin: false,
      detail:
        "CAP_NET_ADMIN missing for in-wrapper CREATE path — product netns default-off; never claim enforced",
    };
  }

  return {
    capable: true,
    reason: "capable",
    wsl,
    sandboxExec: true,
    unshareOk: true,
    capNetAdmin: true,
    detail:
      "userns+netns probe ok + CAP_NET_ADMIN for CREATE path — createRuntime may default HZ_SANDBOX_NETNS=1; TLS MITM/proxy E2E still OPEN; never shell-net enforced",
  };
}

/** True when caller has not pinned netns honesty flags (explicit off disables default-on). */
export function productNetnsHonestyEnvUnset(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_SANDBOX_NETNS?.trim();
  if (raw === undefined || raw === "") return true;
  const lower = raw.toLowerCase();
  if (lower === "0" || lower === "false" || lower === "off" || lower === "no") return false;
  return false;
}

export type ApplyProductNetnsResult = {
  applied?: "capable-default";
  notice?: string;
  capability?: ProductNetnsCapProbe;
};

/**
 * Apply product netns env when probes succeed (ruling **672**).
 * Explicit `HZ_SANDBOX_NETNS` / `HZ_SANDBOX_CHILD_NET` always win.
 */
export function applyProductNetnsCapableDefault(
  env: EnvLike,
  opts: {
    kernelTrusted: boolean;
    capability?: ProductNetnsCapProbe;
    wsl?: boolean;
    run?: DoctorRunFn;
  },
): ApplyProductNetnsResult {
  const rec = env as Record<string, string | undefined>;
  if (process.platform !== "linux") return {};
  if (!opts.kernelTrusted) return {};
  if (!productNetnsHonestyEnvUnset(rec)) return {};

  const capability =
    opts.capability ??
    assessProductNetnsCapability({ env: rec, wsl: opts.wsl, run: opts.run });
  if (!capability.capable) {
    const gapNotice =
      productNetnsHonestyEnvUnset(rec) && opts.kernelTrusted
        ? `[egress.netns.capability] product netns default-off (reason=${capability.reason}): ${capability.detail}`
        : undefined;
    return { capability, notice: gapNotice };
  }

  rec.HZ_SANDBOX_NETNS = "1";
  const childRaw = rec.HZ_SANDBOX_CHILD_NET?.trim();
  if (childRaw === undefined || childRaw === "") {
    rec.HZ_SANDBOX_CHILD_NET = "off";
  }

  return {
    applied: "capable-default",
    capability,
    notice:
      "[egress.netns] HZ_SANDBOX_NETNS=1 (runtime: Linux + trusted Rust kernel + userns/netns/CAP probe ok — " +
      "product CREATE spawn path advisory per **341**/**656**; TLS MITM/proxy E2E still OPEN; never shell-net enforced)",
  };
}

/** Doctor-only: project netns env when probe ok and env unset (trusted kernel not probed). */
export function projectProductNetnsDoctorEnv(
  env: Record<string, string | undefined>,
  capability: ProductNetnsCapProbe,
): Record<string, string | undefined> {
  if (!capability.capable || !productNetnsHonestyEnvUnset(env)) return env;
  const next: Record<string, string | undefined> = { ...env, HZ_SANDBOX_NETNS: "1" };
  const childRaw = env.HZ_SANDBOX_CHILD_NET?.trim();
  if (childRaw === undefined || childRaw === "") {
    next.HZ_SANDBOX_CHILD_NET = "off";
  }
  return next;
}

export const PRODUCT_NETNS_TLS_MITM_RESIDUAL =
  "TLS MITM / routed proxy product E2E still OPEN — never claim shell-net enforced";

const SHELL_NET_ENFORCED_NEGATION =
  /never\s+(claim\s+)?(shell-net\s+)?enforced|not\s+enforced|advisory only/gi;

/**
 * True when copy would advertise shell-net egress as enforced (fail-closed).
 * Negated honesty lines (`never claim enforced`) are not violations.
 */
export function textClaimsBareShellNetEnforced(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("enforced")) return false;
  let stripped = text;
  let prev = "";
  while (stripped !== prev) {
    prev = stripped;
    stripped = stripped.replace(SHELL_NET_ENFORCED_NEGATION, "");
  }
  return stripped.toLowerCase().includes("enforced");
}

/** Doctor detail for `egress.netns.capability` (ruling **715**). */
export function formatProductNetnsCapabilityDoctorDetail(cap: ProductNetnsCapProbe): string {
  const probeBits = [
    cap.wsl ? "wsl-host" : "wsl=false",
    cap.sandboxExec ? "hz-sandbox-exec=ok" : "hz-sandbox-exec=missing",
    cap.unshareOk ? "userns+netns=ok" : "userns+netns=gap",
    cap.capNetAdmin ? "CAP_NET_ADMIN=ok" : "CAP_NET_ADMIN=gap",
  ].join("; ");
  if (cap.capable) {
    return (
      `capable=true reason=${cap.reason} — ${probeBits}; createRuntime default-on-when-capable (**672**/**715**); ` +
      `${cap.detail}; ${PRODUCT_NETNS_TLS_MITM_RESIDUAL}`
    );
  }
  return (
    `capable=false reason=${cap.reason} — ${probeBits}; ${cap.detail}; ` +
    "product netns default-off (**715**) — never claim shell-net enforced"
  );
}