/**
 * swebench-submit.ts — J-1: SWE-bench submission wiring with ZERO runtime
 * dependency on the benchmark harness.
 *
 * `preds-writer.ts` emits a standard `preds.json`. This module does two more
 * things, both honest:
 *   1. It VALIDATES the preds file before anything is submitted (fail closed on
 *      malformed / empty / wrong-shaped records — an empty preds file is never
 *      "a successful submission of zero predictions").
 *   2. It OPTIONALLY invokes an EXTERNAL harness, named by `HZ_SWEBENCH_HARNESS`
 *      or `--submit-cmd`. There is no built-in submitter and no network client.
 *      The harness is a real subprocess; the only "submitted" result this module
 *      can produce is one where that subprocess actually ran and exited 0.
 *
 * FAIL CLOSED when no command is configured: a `--submit` request with no
 * harness is a usage error, never a pretend submission. The harness is spawned
 * with `node:child_process` `spawnSync` (same explicit exclusion as kernel.ts /
 * supervisor.ts in the spawn lint: it would recurse through spawnOwned); the
 * preds path is appended to the harness argv (or substituted for a `{preds}`
 * placeholder), which is what makes a fake harness able to record argv in a
 * hermetic test.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { PredsFileV1 } from "./preds-writer";

export type SubmitErrorReason =
  | "missing-command"
  | "missing-preds"
  | "invalid-preds"
  | "spawn-failed"
  | "harness-failed";

export class SubmitError extends Error {
  readonly reason: SubmitErrorReason;
  readonly exitCode?: number;

  constructor(reason: SubmitErrorReason, detail: string, exitCode?: number) {
    super(`${reason}: ${detail}`);
    this.name = "SubmitError";
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

/** Resolve the external harness command from CLI or environment. */
export function resolveSubmitCommand(opts: { submitCmd?: string; env?: Record<string, string | undefined> }): string | undefined {
  const cli = opts.submitCmd?.trim() ?? "";
  if (cli !== "") return cli;
  const env = opts.env ?? process.env;
  const fromEnv = (env.HZ_SWEBENCH_HARNESS ?? "").trim();
  return fromEnv === "" ? undefined : fromEnv;
}

/** Validate a preds.json file's shape without importing the benchmark harness. */
export function validatePredsFile(file: string): { valid: true; count: number; preds: PredsFileV1 } | { valid: false; error: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { valid: false, error: `cannot read preds file ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { valid: false, error: `${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, error: `${file}: preds.json must be a JSON object keyed by instance_id` };
  }
  const preds = parsed as Record<string, unknown>;
  const keys = Object.keys(preds);
  if (keys.length === 0) return { valid: false, error: `${file}: preds.json is empty — refusing to submit zero predictions` };
  for (const key of keys) {
    const row = preds[key] as Partial<{ instance_id: string; model_name_or_path: string; model_patch: string }> | null;
    if (row === null || typeof row !== "object") {
      return { valid: false, error: `${file}: preds[${JSON.stringify(key)}] is not an object` };
    }
    if (typeof row.instance_id !== "string" || row.instance_id.trim() === "") {
      return { valid: false, error: `${file}: preds[${JSON.stringify(key)}] has no instance_id` };
    }
    if (typeof row.model_name_or_path !== "string" || row.model_name_or_path.trim() === "") {
      return { valid: false, error: `${file}: preds[${JSON.stringify(key)}] has no model_name_or_path` };
    }
    if (typeof row.model_patch !== "string") {
      return { valid: false, error: `${file}: preds[${JSON.stringify(key)}] has no model_patch string` };
    }
  }
  return { valid: true, count: keys.length, preds: preds as unknown as PredsFileV1 };
}

export interface SubmitOptions {
  /** Path to the validated preds.json. */
  predsFile: string;
  /** Resolved harness command; when absent the call fails closed. */
  command?: string;
  env?: Record<string, string | undefined>;
  /** Injectable for hermetic tests; defaults to `node:child_process` spawnSync. */
  run?: (exe: string, args: string[], env: Record<string, string | undefined>) => {
    status: number | null;
    error?: unknown;
    stdout?: string;
    stderr?: string;
  };
}

export interface SubmitResult {
  submitted: true;
  command: string;
  predsFile: string;
  predictionCount: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Split a command into argv tokens (no shell interpretation). */
export function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((token) => token !== "");
}

/**
 * Validate the preds file, then invoke the external harness. This NEVER returns
 * a fake "submitted" result: either the subprocess ran and exited 0, or a typed
 * `SubmitError` is thrown. Missing command / preds path fail closed.
 */
export function submitPredictions(opts: SubmitOptions): SubmitResult {
  const command = opts.command?.trim() ?? "";
  if (command === "") {
    throw new SubmitError("missing-command", "no SWE-bench harness configured — set HZ_SWEBENCH_HARNESS or pass --submit-cmd (refusing to fake a submission)");
  }
  if (opts.predsFile.trim() === "") {
    throw new SubmitError("missing-preds", "a preds.json path is required for --submit (pass --preds-out)");
  }
  const validation = validatePredsFile(opts.predsFile);
  if (validation.valid === false) throw new SubmitError("invalid-preds", validation.error);

  const tokens = tokenizeCommand(command);
  const exe = tokens[0]!;
  const args = tokens.slice(1);
  if (args.some((arg) => arg === "{preds}")) {
    for (let i = 0; i < args.length; i += 1) if (args[i] === "{preds}") args[i] = opts.predsFile;
  } else {
    args.push(opts.predsFile);
  }

  const env = opts.env ?? process.env;
  const run = opts.run ?? ((e, a, en) => {
    const result = spawnSync(e, a, { encoding: "utf8", env: en as Record<string, string> });
    return {
      status: result.status,
      error: result.error,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
  const outcome = run(exe, args, env);
  if (outcome.error !== undefined) {
    throw new SubmitError("spawn-failed", `could not start harness ${JSON.stringify(exe)}: ${String(outcome.error)}`);
  }
  if (outcome.status !== 0) {
    throw new SubmitError(
      "harness-failed",
      `harness ${JSON.stringify(exe)} exited ${outcome.status}: ${(outcome.stderr ?? "").trim().slice(0, 400)}`,
      outcome.status ?? undefined,
    );
  }
  return {
    submitted: true,
    command,
    predsFile: opts.predsFile,
    predictionCount: validation.count,
    exitCode: outcome.status ?? 0,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
  };
}
