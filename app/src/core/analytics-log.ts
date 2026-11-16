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
import { appendJsonlSync } from "./jsonl-append";
import { workspaceStateDir } from "./paths";

/** Default filename under `<workspaceStateDir>/`. */
export const ANALYTICS_LOG_FILE = "analytics.ndjson";

export type AnalyticsEventName = "session.start" | "session.end" | "cli.flag";

export interface AnalyticsEventV1 {
  v: 1;
  ts: string;
  event: AnalyticsEventName;
  /** Session id when known — never transcript content. */
  sessionId?: string;
  provider?: string;
  model?: string;
  kernelMode?: string;
  /** Observability one-shot flag name (e.g. show-repo-map), never argv secrets. */
  flag?: string;
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

export interface AppendAnalyticsOptions {
  workspace: string;
  event: AnalyticsEventName;
  sessionId?: string;
  provider?: string;
  model?: string;
  kernelMode?: string;
  flag?: string;
  env?: AnalyticsEnv;
  /** CLI override: true = default path; string = explicit path; omit = env only. */
  cliPath?: string | boolean;
  /** Injected clock for tests. */
  now?: () => string;
}

/**
 * Append one NDJSON row when enabled. Best-effort: failures are swallowed so
 * observability never blocks the session. Returns the path written, or undefined.
 */
export function appendAnalyticsEvent(opts: AppendAnalyticsOptions): string | undefined {
  const env = opts.env ?? process.env;
  const file = resolveAnalyticsLogPath(opts.workspace, env, opts.cliPath);
  if (file === undefined) return undefined;

  const row: AnalyticsEventV1 = {
    v: 1,
    ts: (opts.now ?? nowIso)(),
    event: opts.event,
  };
  if (opts.sessionId !== undefined && opts.sessionId !== "") row.sessionId = opts.sessionId;
  if (opts.provider !== undefined && opts.provider !== "") row.provider = opts.provider;
  if (opts.model !== undefined && opts.model !== "") row.model = opts.model;
  if (opts.kernelMode !== undefined && opts.kernelMode !== "") row.kernelMode = opts.kernelMode;
  if (opts.flag !== undefined && opts.flag !== "") row.flag = opts.flag;

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
