/**
 * Netns CONNECT/TCP denial honesty (docs/33 §5.2 partial).
 *
 * `hz-sandbox-exec` applies userns+netns network-off by default and when
 * `HZ_SANDBOX_CHILD_NET=off`. That denies raw outbound TCP from wrapped children
 * (hermetic tests in `kernel/tests/sandbox_exec.rs`) — but it is **not** routed
 * proxy-only egress and never counts as shell-net `enforced`.
 */

import { egressProxyFromEnv } from "./egress-env";
import { resolveSandboxExecBinary } from "./kernel";
import { sandboxChildNetOffRequested } from "./sandbox-child-net";

export type NetnsDenialHonesty = "partial" | "off";

export interface NetnsConnectDenialPosture {
  honesty: NetnsDenialHonesty;
  /** True when wrapped children are expected to get netns isolation (not HZ_SANDBOX_EXEC=0). */
  netnsIsolationExpected: boolean;
  childNetOff: boolean;
  proxyEnvSet: boolean;
  detail: string;
}

export function netnsConnectDenialPosture(env: Record<string, string | undefined>): NetnsConnectDenialPosture {
  const sandboxOff = env.HZ_SANDBOX_EXEC === "0";
  const childNetOff = sandboxChildNetOffRequested(env);
  const proxyEnvSet = egressProxyFromEnv(env) !== undefined;
  const binPresent = resolveSandboxExecBinary(env) !== undefined;
  const netnsIsolationExpected = !sandboxOff && binPresent;

  if (!netnsIsolationExpected) {
    return {
      honesty: "off",
      netnsIsolationExpected: false,
      childNetOff,
      proxyEnvSet,
      detail: "HZ_SANDBOX_EXEC=0 or hz-sandbox-exec missing — no netns CONNECT denial from the wrapper",
    };
  }

  const proxyNote = proxyEnvSet
    ? "HZ_EGRESS_PROXY sets child proxy env only; bare TCP denied in netns — see doctor egress.netns.route (proxy-routed partial)"
    : "no HZ_EGRESS_PROXY — raw TCP deny via netns/Landlock only (partial, not MITM-enforced shell-net)";

  return {
    honesty: "partial",
    netnsIsolationExpected: true,
    childNetOff,
    proxyEnvSet,
    detail:
      `wrapped children get netns network-off (default or HZ_SANDBOX_CHILD_NET=off); ` +
      `CONNECT/TCP denial is partial — ${proxyNote}; never claim shell-net enforced`,
  };
}
