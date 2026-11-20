/**
 * I-4 residual — opt-in local-only analytics NDJSON log (ADAPT aider
 * `--analytics-log`). Never opens a network socket. Off by default.
 *
 * Enable with `HZ_ANALYTICS_LOG=1` (default path under workspace state) or
 * `HZ_ANALYTICS_LOG=<abs-or-rel-path>`, or CLI `--analytics-log [path]`.
 * Rows must not carry code, chat text, API keys, or secret paths.
 */

import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { nowIso } from "../contracts";
import { LOCAL_ANALYTICS_EVENTS, LOCAL_ANALYTICS_FIELDS, type LocalAnalyticsField } from "./event-catalogue";
import { appendJsonlSync } from "./jsonl-append";
import { workspaceStateDir } from "./paths";

/** Default filename under `<workspaceStateDir>/`. */
export const ANALYTICS_LOG_FILE = "analytics.ndjson";

/** I-4: event names come from the local catalogue, not from a free-form string. */
export type AnalyticsEventName = (typeof LOCAL_ANALYTICS_EVENTS)[number];

/**
 * One NDJSON row. The base envelope (`v`/`ts`/`event`) is always present; every
 * other field is OPTIONAL and drawn from the allowlist in
 * `LOCAL_ANALYTICS_FIELDS`. Nothing here can carry chat text, code, keys or
 * secret paths — `analyticsRowFields` drops any field outside the allowlist.
 */
export interface AnalyticsEventV1 {
  v: 1;
  ts: string;
  event: AnalyticsEventName;
  sessionId?: string;
  provider?: string;
  model?: string;
  kernelMode?: string;
  /** Observability one-shot flag name (e.g. show-repo-map), never argv secrets. */
  flag?: string;
  /** RC-7 terminal token when the observation has one (never the run's answer). */
  terminal?: string;
  /** Stable machine error code when the observation failed (never the message). */
  errorCode?: string;
  /** Wall-clock for the observation, milliseconds (finite, non-negative). */
  durationMs?: number;
  /** Counts only — never tool names, arguments or file paths. */
  toolCount?: number;
  stepCount?: number;
  batchSize?: number;
  batchDone?: number;
  batchFailed?: number;
  /** Harness micro-USD estimate (integer); never a billing invoice. */
  costMicroUsd?: number;
}

/** The catalogue is fixed data; expose a copy for `/settings` and tooling. */
export function analyticsEventCatalogue(): readonly AnalyticsEventName[] {
  return [...LOCAL_ANALYTICS_EVENTS];
}

/** The field allowlist and each field's primitive shape (I-4). */
export function analyticsFieldCatalogue(): Readonly<typeof LOCAL_ANALYTICS_FIELDS> {
  return LOCAL_ANALYTICS_FIELDS;
}

/**
 * Copy ONLY allowlisted, correctly-shaped fields from a caller's options into
 * an analytics row. A field outside `LOCAL_ANALYTICS_FIELDS` (e.g. `content`,
 * `task`, `apiKey`, `path`) is never read — this is the privacy boundary that
 * keeps the local log free of code, chat text, keys and secret paths. Badly
 * typed values are dropped too, so a row can never claim a number it does not
 * have.
 */
export function analyticsRowFields(
  source: Record<string, unknown>,
): Partial<Pick<AnalyticsEventV1, LocalAnalyticsField>> {
  const out: Record<string, string | number> = {};
  for (const [field, shape] of Object.entries(LOCAL_ANALYTICS_FIELDS) as [LocalAnalyticsField, "string" | "number"][]) {
    const value = source[field];
    if (shape === "string") {
      if (typeof value === "string" && value.trim() !== "") out[field] = value;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[field] = field === "costMicroUsd" ? Math.round(value) : value;
    }
  }
  return out as Partial<Pick<AnalyticsEventV1, LocalAnalyticsField>>;
}

export type AnalyticsEnv = Record<string, string | undefined>;

/**
 * Truthy enable tokens → default path; `0`/`false`/`off` → disabled; any other
 * non-empty string is treated as an explicit log path.
 */
export function resolveAnalyticsLogPath(
  workspace: string,
  env: AnalyticsEnv = process.env,
  cliPath?: string | boolean,
): string | undefined {
  if (cliPath === false) return undefined;
  if (cliPath === true) return defaultAnalyticsLogPath(workspace);
  if (typeof cliPath === "string" && cliPath.trim() !== "") {
    return path.resolve(cliPath.trim());
  }

  const raw = env.HZ_ANALYTICS_LOG;
  if (raw === undefined || raw === "") return undefined;
  const key = raw.trim().toLowerCase();
  if (key === "0" || key === "false" || key === "off" || key === "no") return undefined;
  if (key === "1" || key === "true" || key === "yes" || key === "on") {
    return defaultAnalyticsLogPath(workspace);
  }
  return path.isAbsolute(raw.trim()) ? path.resolve(raw.trim()) : path.resolve(workspace, raw.trim());
}

export function analyticsLogEnabled(
  workspace: string,
  env: AnalyticsEnv = process.env,
  cliPath?: string | boolean,
): boolean {
  return resolveAnalyticsLogPath(workspace, env, cliPath) !== undefined;
}

export function defaultAnalyticsLogPath(workspace: string): string {
  return path.join(workspaceStateDir(workspace), ANALYTICS_LOG_FILE);
}

export interface AppendAnalyticsOptions extends Partial<Pick<AnalyticsEventV1, LocalAnalyticsField>> {
  workspace: string;
  event: AnalyticsEventName;
  env?: AnalyticsEnv;
  /** CLI override: true = default path; string = explicit path; omit = env only. */
  cliPath?: string | boolean;
  /** Injected clock for tests. */
  now?: () => string;
}

export async function admitAnalyticsLogWrite(
  file: string,
  workspace: string,
): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("./preds-writer");
  const refused = await admitPredsOutWrite(file, workspace);
  if (refused === undefined) return undefined;
  // Enabling HZ_ANALYTICS_LOG / --analytics-log is the operator consent for this
  // observability file. Ask cannot be resolved on this non-interactive path;
  // deny still refuses (ruling 600).
  if (/requires approval/i.test(refused)) return undefined;
  return refused
    .replace(/^preds write refused:/, "analytics-log refused:")
    .replace(/^preds write denied/, "analytics-log denied")
    .replace(/^preds fs\.write requires approval/, "analytics-log fs.write requires approval");
}

/**
 * Append one NDJSON row when enabled. Best-effort: failures and Guard deny are
 * swallowed so observability never blocks the session (ruling 600 under-admission).
 * Returns the path written, or undefined.
 */
export async function appendAnalyticsEvent(opts: AppendAnalyticsOptions): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const file = resolveAnalyticsLogPath(opts.workspace, env, opts.cliPath);
  if (file === undefined) return undefined;

  const refused = await admitAnalyticsLogWrite(file, opts.workspace);
  if (refused !== undefined) return undefined;

  const row: AnalyticsEventV1 = {
    v: 1,
    ts: (opts.now ?? nowIso)(),
    event: opts.event,
    ...analyticsRowFields(opts as unknown as Record<string, unknown>),
  };

  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendJsonlSync(file, `${JSON.stringify(row)}\n`, env as NodeJS.ProcessEnv);
    return file;
  } catch {
    return undefined;
  }
}

/** Apply CLI `--analytics-log` onto `HZ_ANALYTICS_LOG` before createRuntime. */
export function applyAnalyticsLogCliFlag(
  env: AnalyticsEnv,
  cliPath: string | boolean | undefined,
): void {
  if (cliPath === undefined || cliPath === false) return;
  if (cliPath === true) env.HZ_ANALYTICS_LOG = "1";
  else env.HZ_ANALYTICS_LOG = cliPath;
}
