/**
 * sandbox-container-deny.ts — J-3 default-deny proof against a REAL container.
 *
 * The WSL2 host in CI cannot `unshare(CLONE_NEWNET)` (EPERM) and has no docker
 * daemon, so the netns modules in this repo are honestly ADVISORY. This module
 * adds a *proof harness* for a host that does have a container runtime: it
 * launches a container with `--network none` and runs a command that must fail
 * to reach the network. The result is a measured proof, not a claim.
 *
 * Fail-closed contract:
 *  - no runtime / no daemon / non-zero setup -> `available: false`, never
 *    "enforced";
 *  - `--network none` is required in the argv (asserted by tests);
 *  - the probe command must produce the expected denial marker;
 *  - a host that reaches the network is a FAILED proof.
 *
 * No dependency: `spawnSync` from node:child_process and injectable command
 * runner. The live test is opt-in (`HZ_LIVE_CONTAINER=1`).
 */

import { spawnSync } from "node:child_process";

export interface ContainerDenyOptions {
  image?: string;
  runtime?: "docker" | "podman";
  /** Injectable for hermetic tests; default uses spawnSync. */
  run?: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };
}

export interface ContainerDenyResult {
  available: boolean;
  enforced: boolean;
  runtime: "docker" | "podman" | undefined;
  detail: string;
  argv?: string[];
}

const DEFAULT_IMAGE = "alpine:3.20";
/** The container command: any successful egress is a proof failure. */
export const DENY_PROBE_SCRIPT =
  "set -e; if (command -v wget >/dev/null 2>&1 && wget -q -T 3 -O /dev/null https://example.com); then echo REACHABLE; exit 0; fi; echo DENIED";

function defaultRun(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function available(cmd: string, run: NonNullable<ContainerDenyOptions["run"]>): boolean {
  try {
    return run("sh", ["-c", `command -v ${cmd} >/dev/null 2>&1`]).status === 0;
  } catch {
    return false;
  }
}

/**
 * Run the real default-deny proof. `enforced: true` is only returned when a
 * real container runtime launched `--network none` and the in-container probe
 * printed DENIED. Every other path is a refusal.
 */
export function proveContainerDefaultDeny(opts: ContainerDenyOptions = {}): ContainerDenyResult {
  const run = opts.run ?? defaultRun;
  const candidates: Array<"docker" | "podman"> = opts.runtime ? [opts.runtime] : ["docker", "podman"];
  const runtime = candidates.find((candidate) => available(candidate, run));
  if (runtime === undefined) {
    return {
      available: false,
      enforced: false,
      runtime: undefined,
      detail: "no docker/podman runtime available — shell-net stays unenforced (never claim default-deny)",
    };
  }
  const image = opts.image ?? DEFAULT_IMAGE;
  const argv = ["run", "--rm", "--network", "none", image, "sh", "-c", DENY_PROBE_SCRIPT];
  let result: ReturnType<NonNullable<ContainerDenyOptions["run"]>>;
  try {
    result = run(runtime, argv);
  } catch (err) {
    return {
      available: true,
      enforced: false,
      runtime,
      argv,
      detail: `container probe failed to launch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    return { available: true, enforced: false, runtime, argv, detail: `container setup failed (${result.status}): ${output.trim()}` };
  }
  if (output.includes("REACHABLE")) {
    return { available: true, enforced: false, runtime, argv, detail: "in-container egress SUCCEEDED — default-deny proof FAILED" };
  }
  if (!output.includes("DENIED")) {
    return { available: true, enforced: false, runtime, argv, detail: `inconclusive probe output: ${output.trim()}` };
  }
  return { available: true, enforced: true, runtime, argv, detail: "real container launched with --network none; egress denied" };
}
