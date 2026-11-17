/**
 * swebench-official-harness.ts — J-1: exact argv adapter for the OFFICIAL
 * SWE-bench harness (ruling 519 residual, tractable half).
 *
 * The harness itself is EXTERNAL: neither its source, its dataset nor any
 * credentials ship here. This module only (a) builds the exact argv the
 * official `swebench.harness.run_evaluation` entry point expects, and (b)
 * invokes it through the existing guarded/owned child path with an explicit
 * reason. It NEVER fabricates a submission: the only success result is one
 * where a real subprocess ran and exited 0.
 *
 * Invocation path: `spawnOwned` (the single owned-spawn surface, with a named
 * reason = spawn label + ledger row). A caller can inject `exec` for hermetic
 * tests; the injected function receives the exact argv and the reason.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { kernelStateDir, spawnOwned } from "./owned-spawn";
import {
  SubmitError,
  validatePredsFile,
  type SubmitErrorReason,
  type SubmitResult,
} from "./swebench-submit";

/** The exact module the official harness exposes (`python -m ...`). */
export const OFFICIAL_HARNESS_MODULE = "swebench.harness.run_evaluation";

/** Stable reason carried into the spawn ledger label. */
export const OFFICIAL_HARNESS_REASON = "swebench-official-harness";

/** Default dataset/split — overridable from the CLI; the real dataset is external. */
export const DEFAULT_SWEBENCH_DATASET = "princeton-nlp/SWE-bench_Lite";
export const DEFAULT_SWEBENCH_SPLIT = "test";

export type OfficialHarnessExecResult = {
  status: number | null;
  error?: unknown;
  stdout: string;
  stderr: string;
};

/**
 * The guarded exec seam. `argv` is the EXACT argv after the interpreter
 * (no shell, no globbing); `reason` is the named purpose handed to spawnOwned.
 */
export type OfficialHarnessExec = (
  argv: readonly string[],
  reason: string,
) => Promise<OfficialHarnessExecResult>;

export interface OfficialHarnessArgvOptions {
  predsPath: string;
  dataset: string;
  split: string;
  /** Optional exact instance filter → `--instance_ids <id>...`. */
  instanceIds?: readonly string[];
}

/**
 * Build the exact official-harness argv (everything after the interpreter):
 *   -m swebench.harness.run_evaluation --predictions_path <preds>
 *      --dataset_name <dataset> --split <split> [--instance_ids <id>...]
 * Fail closed on an empty/untrimmed field or a malformed instance id.
 */
export function buildOfficialHarnessArgv(opts: OfficialHarnessArgvOptions): string[] {
  const requireField = (value: string | undefined, field: string): string => {
    if (typeof value !== "string" || value.trim() === "" || value.trim() !== value) {
      throw new SubmitError("invalid-preds", `official harness: ${field} must be a non-empty trimmed string`);
    }
    return value;
  };
  const predsPath = requireField(opts.predsPath, "predictions_path");
  const dataset = requireField(opts.dataset, "dataset_name");
  const split = requireField(opts.split, "split");
  const argv = [
    "-m",
    OFFICIAL_HARNESS_MODULE,
    "--predictions_path",
    predsPath,
    "--dataset_name",
    dataset,
    "--split",
    split,
  ];
  if (opts.instanceIds !== undefined) {
    if (!Array.isArray(opts.instanceIds)) {
      throw new SubmitError("invalid-preds", "official harness: instanceIds must be an array");
    }
    if (opts.instanceIds.length > 0) {
      for (const id of opts.instanceIds) requireField(id, "instance id");
      argv.push("--instance_ids", ...opts.instanceIds);
    }
  }
  return argv;
}

function isPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}

function executableExists(command: string, env: Record<string, string | undefined>): boolean {
  if (isPathLike(command)) return existsSync(command);
  const delimiter = process.platform === "win32" ? ";" : ":";
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(delimiter)) {
    if (dir === "") continue;
    if (existsSync(path.join(dir, command))) return true;
  }
  return false;
}

/**
 * Resolve the Python interpreter for the official harness. Fail closed when
 * nothing is configured or the configured command is not present (a missing
 * harness is a refusal, never a fabricated result). Tests inject an absolute
 * path to a fake interpreter; the default is `python3`.
 */
export function resolveOfficialPython(opts: {
  python?: string;
  env?: Record<string, string | undefined>;
}): string {
  const env = opts.env ?? process.env;
  const configured = (opts.python ?? env.HZ_SWEBENCH_PYTHON ?? "python3").trim();
  if (configured === "") {
    throw new SubmitError(
      "missing-harness",
      "no official SWE-bench harness interpreter configured — set HZ_SWEBENCH_PYTHON (the harness itself is external)",
    );
  }
  if (!executableExists(configured, env)) {
    throw new SubmitError(
      "missing-harness",
      `official harness interpreter ${JSON.stringify(configured)} is not present — refusing to fake a submission`,
    );
  }
  return configured;
}

/**
 * Default guarded runner: one owned, ledgered child via `spawnOwned` with the
 * reason as its label. stdio is drained before the exit code is read so a fake
 * harness recording its argv cannot lose the write on process exit.
 */
export const spawnOwnedOfficialHarnessExec: OfficialHarnessExec = async (argv, reason) => {
  if (argv.length === 0) throw new SubmitError("missing-harness", "official harness: empty argv");
  const exe = argv[0]!;
  const { proc } = await spawnOwned([exe, ...argv.slice(1)], {
    stateDir: kernelStateDir(process.cwd()),
    label: reason,
    longLived: false,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
};

export interface SubmitOfficialOptions {
  predsFile: string;
  dataset?: string;
  split?: string;
  instanceIds?: readonly string[];
  /** Overrides HZ_SWEBENCH_PYTHON; an absolute path to a fake is fine in tests. */
  python?: string;
  env?: Record<string, string | undefined>;
  stateDir?: string;
  /** Injectable guarded exec (hermetic tests); defaults to the spawnOwned runner. */
  exec?: OfficialHarnessExec;
}

export interface SubmitOfficialResult extends SubmitResult {
  /** The exact argv handed to the harness (after the interpreter). */
  argv: string[];
  python: string;
}

/**
 * Validate preds, build the exact official argv, and invoke the harness through
 * the guarded path. Any failure is a typed `SubmitError` — a missing interpreter,
 * an absent harness module (nonzero exit) or a spawn failure NEVER becomes a
 * "submitted: true" result.
 */
export async function submitWithOfficialHarness(opts: SubmitOfficialOptions): Promise<SubmitOfficialResult> {
  if (opts.predsFile.trim() === "") {
    throw new SubmitError("missing-preds", "--harness swebench-official requires --preds-out <preds.json>");
  }
  const validation = validatePredsFile(opts.predsFile);
  if (validation.valid === false) throw new SubmitError("invalid-preds", validation.error);

  const env = opts.env ?? process.env;
  const python = resolveOfficialPython({ ...(opts.python !== undefined ? { python: opts.python } : {}), env });
  const argv = buildOfficialHarnessArgv({
    predsPath: opts.predsFile,
    dataset: opts.dataset ?? env.HZ_SWEBENCH_DATASET ?? DEFAULT_SWEBENCH_DATASET,
    split: opts.split ?? env.HZ_SWEBENCH_SPLIT ?? DEFAULT_SWEBENCH_SPLIT,
    ...(opts.instanceIds !== undefined ? { instanceIds: opts.instanceIds } : {}),
  });
  const exec = opts.exec ?? spawnOwnedOfficialHarnessExec;
  let outcome: OfficialHarnessExecResult;
  try {
    outcome = await exec(argv, OFFICIAL_HARNESS_REASON);
  } catch (err) {
    throw new SubmitError("missing-harness", `could not start official harness: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (outcome.error !== undefined) {
    const reason: SubmitErrorReason =
      (outcome.error as { code?: unknown } | null)?.code === "ENOENT" ? "missing-harness" : "spawn-failed";
    throw new SubmitError(reason, `could not start official harness ${JSON.stringify(python)}: ${String(outcome.error)}`);
  }
  if (outcome.status !== 0) {
    throw new SubmitError(
      "harness-failed",
      `official harness ${JSON.stringify(python)} exited ${outcome.status}: ${(outcome.stderr ?? "").trim().slice(0, 400)} (the harness/dataset/credentials are external)`,
      outcome.status ?? undefined,
    );
  }
  return {
    submitted: true,
    command: [python, ...argv].join(" "),
    predsFile: opts.predsFile,
    predictionCount: validation.count,
    exitCode: outcome.status ?? 0,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    argv,
    python,
  };
}
