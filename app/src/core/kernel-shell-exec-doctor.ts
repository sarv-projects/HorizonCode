/**
 * Kernel-routed `shell.exec` hz-sandbox-exec wrap honesty (ruling **732**).
 * Reports helper presence and require-wrap posture — never shell-net `enforced`.
 */

import { resolveSandboxExecBinary } from "./kernel";
import { resolveSandboxChildNet } from "./sandbox-child-net";

export type KernelShellExecDoctorPosture = {
  wrapDisabled: boolean;
  requireWrap: boolean;
  binary?: string;
  childNet: string;
  wslDefaultChildNet: boolean;
  detail: string;
  hint?: string;
  status: "ok" | "warn" | "fail";
};

function requireWrapFromEnv(env: Record<string, string | undefined>): boolean {
  return env.HZ_SANDBOX_REQUIRE === "1" || env.HZ_SHELL_EXEC_REQUIRE_WRAP === "1";
}

export function assessKernelShellExecDoctorPosture(
  env: Record<string, string | undefined> = process.env,
): KernelShellExecDoctorPosture {
  const wrapDisabled = env.HZ_SANDBOX_EXEC === "0";
  const requireWrap = requireWrapFromEnv(env);
  const binary = wrapDisabled ? undefined : resolveSandboxExecBinary(env);
  const childNet = resolveSandboxChildNet({ env });
  const wslDefaultChildNet = childNet.wslDefaultChildNet;
  const netHonesty =
    childNet.mode === "on" || wslDefaultChildNet
      ? "child_net=on — network egress NOT confined"
      : "child_net=off does not imply product egress enforced";

  if (wrapDisabled) {
    const detail = requireWrap
      ? "HZ_SANDBOX_EXEC=0 with require-wrap env — kernel shell.exec refuses bare argv (**732**); never shell-net enforced"
      : "HZ_SANDBOX_EXEC=0 — kernel shell.exec runs bare argv (no hz-sandbox-exec wrap); never shell-net enforced";
    return {
      wrapDisabled: true,
      requireWrap,
      childNet: childNet.mode,
      wslDefaultChildNet,
      detail: `${detail}; ${netHonesty}`,
      status: requireWrap ? "fail" : "warn",
      hint: requireWrap
        ? "unset HZ_SANDBOX_REQUIRE / HZ_SHELL_EXEC_REQUIRE_WRAP or build hz-sandbox-exec and unset HZ_SANDBOX_EXEC=0"
        : "build hz-sandbox-exec for FS/process confinement on kernel shell.exec",
    };
  }

  if (binary === undefined) {
    const detail = requireWrap
      ? "hz-sandbox-exec missing with HZ_SANDBOX_REQUIRE=1 (or HZ_SHELL_EXEC_REQUIRE_WRAP=1) — kernel shell.exec refuses bare argv (**732**)"
      : "hz-sandbox-exec missing — kernel shell.exec falls back to bare argv (honest sandboxExecWrapped=false)";
    return {
      wrapDisabled: false,
      requireWrap,
      childNet: childNet.mode,
      wslDefaultChildNet,
      detail: `${detail}; ${netHonesty}; never shell-net enforced`,
      status: requireWrap ? "fail" : "warn",
      hint: "build `hz-sandbox-exec` from kernel/ or set HZ_SANDBOX_EXEC_BIN",
    };
  }

  return {
    wrapDisabled: false,
    requireWrap,
    binary,
    childNet: childNet.mode,
    wslDefaultChildNet,
    detail: `kernel shell.exec wraps via ${binary} when routed (**675**); ${netHonesty}; never shell-net enforced`,
    status: "ok",
  };
}