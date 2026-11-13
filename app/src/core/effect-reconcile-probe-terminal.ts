/**
 * effect-reconcile-probe-terminal.ts — docs/06 flow 6.8 read-only `terminal.run`
 * argv allow-list for reconcile probe enrichment (ruling **292**).
 *
 * Fail-closed: only fixed argv shapes run; never used for shell-net enforcement claims.
 */

import { spawnSync } from "node:child_process";

export type ReadOnlyProbeArgv = readonly [program: string, ...args: string[]];

/** Reduced allow-list aligned with docs/06 (observation-only workspace probes). */
export const READ_ONLY_PROBE_ARGV_ALLOWLIST: readonly ReadOnlyProbeArgv[] = [
  ["true"],
  ["pwd"],
  ["git", "rev-parse", "--is-inside-work-tree"],
  ["git", "rev-parse", "--show-toplevel"],
] as const;

export const DEFAULT_WORKSPACE_TERMINAL_PROBES: readonly ReadOnlyProbeArgv[] = READ_ONLY_PROBE_ARGV_ALLOWLIST;

function argvKey(argv: readonly string[]): string {
  return argv.map((p) => p.trim()).join("\0");
}

const ALLOWED = new Set(READ_ONLY_PROBE_ARGV_ALLOWLIST.map((spec) => argvKey(spec)));

/** True when argv exactly matches one allow-listed probe (fail-closed for everything else). */
export function isReadOnlyProbeArgv(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const program = argv[0]?.trim();
  if (!program) return false;
  return ALLOWED.has(argvKey(argv));
}

export function refuseReadOnlyProbeArgv(argv: readonly string[]): string | undefined {
  if (isReadOnlyProbeArgv(argv)) return undefined;
  const preview = argv.slice(0, 8).join(" ");
  return `probe argv not allowlisted (fail-closed): ${preview}${argv.length > 8 ? " …" : ""}`;
}

export type TerminalProbeRunner = (
  argv: readonly string[],
  cwd: string,
) => { ok: boolean; exitCode: number | null; stdout: string; stderr: string };

const defaultRunner: TerminalProbeRunner = (argv, cwd) => {
  const refused = refuseReadOnlyProbeArgv(argv);
  if (refused) {
    return { ok: false, exitCode: null, stdout: "", stderr: refused };
  }
  const [program, ...args] = argv;
  const r = spawnSync(program, [...args], { cwd, encoding: "utf8", timeout: 8_000 });
  return {
    ok: r.status === 0,
    exitCode: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

export interface TerminalProbeRow {
  argv: readonly string[];
  ok: boolean;
  exitCode: number | null;
  stdoutPreview: string;
  refused: boolean;
  error?: string;
}

export interface TerminalProbeSnapshot {
  workspace: string;
  probes: readonly TerminalProbeRow[];
}

export function runReadOnlyProbeArgv(
  argv: readonly string[],
  cwd: string,
  opts?: { run?: TerminalProbeRunner },
): TerminalProbeRow {
  const refused = refuseReadOnlyProbeArgv(argv);
  if (refused) {
    return { argv, ok: false, exitCode: null, stdoutPreview: "", refused: true, error: refused };
  }
  const run = opts?.run ?? defaultRunner;
  const r = run(argv, cwd);
  const mergedErr = (r.stderr ?? "").trim();
  const preview = (r.stdout ?? "").trim().replace(/\s+/g, " ").slice(0, 96);
  return {
    argv,
    ok: r.ok,
    exitCode: r.exitCode,
    stdoutPreview: preview,
    refused: false,
    error: r.ok ? undefined : mergedErr.slice(0, 120) || undefined,
  };
}

/** Workspace terminal probes (allow-listed argv only; no shell string interpolation). */
export function probeWorkspaceTerminalReadOnly(
  workspace: string,
  opts?: { probes?: readonly ReadOnlyProbeArgv[]; run?: TerminalProbeRunner },
): TerminalProbeSnapshot {
  const probes = opts?.probes ?? DEFAULT_WORKSPACE_TERMINAL_PROBES;
  const rows = probes.map((argv) => runReadOnlyProbeArgv(argv, workspace, opts));
  return { workspace, probes: rows };
}

export function formatTerminalProbeLine(row: TerminalProbeRow): string {
  const label = row.argv.join(" ");
  if (row.refused) return `terminal.probe: refused ${label}`;
  const bits = [`exit ${row.exitCode ?? "?"}`];
  if (row.stdoutPreview) bits.push(row.stdoutPreview);
  if (row.error) bits.push(`err ${row.error}`);
  return `terminal.probe: ${label} (${bits.join("; ")})`;
}

export function formatTerminalProbeSummary(snap: TerminalProbeSnapshot): string {
  const ok = snap.probes.filter((p) => p.ok && !p.refused).length;
  const refused = snap.probes.filter((p) => p.refused).length;
  return `terminal read-only probes: ${ok}/${snap.probes.length} ok${refused > 0 ? `; ${refused} refused` : ""} (allow-list only; not shell-net enforcement)`;
}
