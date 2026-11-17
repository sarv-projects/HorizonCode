/**
 * `/settings` and observability (docs/30 I-4, ADAPT aider): effective runtime
 * settings with secrets masked — no API call, no writes.
 */

import type { HzConfig } from "./config";
import { renderConfigCheck, checkConfigFile, defaultConfigPath } from "./config";
import { maskSecrets } from "./compaction";
import { defaultAnalyticsLogPath, resolveAnalyticsLogPath } from "./analytics-log";
import { metricContract } from "./metrics";

export interface SettingsReportOptions {
  workspace: string;
  home: string;
  config: HzConfig;
  env?: Record<string, string | undefined>;
}

function line(label: string, value: string): string {
  return `  ${label}: ${maskSecrets(value)}`;
}

/**
 * H-7: contracted machine-readable facts for the numbers `/settings` reports.
 * The human report stays byte-identical; a consumer that needs a number uses
 * this parallel surface, where each value carries Metric/Anchor/Population/
 * Excludes. Config paths and keys never appear — only counts and budget limits.
 */
export function settingsReportPublication(opts: SettingsReportOptions): string[] {
  const { config, workspace } = opts;
  const anchor = "none — first settings snapshot (no comparison baseline)";
  const population = `effective settings for workspace ${workspace}`;
  const excludes = "none — every configured server/provider is counted; no secrets or paths are published";
  const blocks = [
    metricContract({ metric: "settings mcp servers", anchor, population, excludes, value: config.mcp?.servers.length ?? 0 }),
    metricContract({ metric: "settings lsp servers", anchor, population, excludes, value: config.lsp?.servers.length ?? 0 }),
    metricContract({ metric: "settings registered providers", anchor, population, excludes, value: config.providers?.providers.length ?? 0 }),
    metricContract({ metric: "settings trusted workspace hooks", anchor, population, excludes, value: config.trustedWorkspaceHooks?.length ?? 0 }),
  ];
  if (config.budget) {
    for (const [key, value] of [
      ["maxSteps", config.budget.maxSteps],
      ["maxTokens", config.budget.maxTokens],
      ["maxWallMs", config.budget.maxWallMs],
    ] as const) {
      if (value !== undefined) {
        blocks.push(metricContract({ metric: `settings budget ${key}`, anchor, population, excludes, value }));
      }
    }
  }
  return blocks;
}

/** Human-readable settings snapshot for TUI `/settings`. */
export function renderSettingsReport(opts: SettingsReportOptions): string {
  const { workspace, home, config } = opts;
  const env = opts.env ?? process.env;
  const userFile = defaultConfigPath(home);
  const lines: string[] = [
    "settings (effective for this chat)",
    line("workspace", workspace),
    line("provider", String(config.provider)),
    line("model", config.model),
    `  sources: provider=${config.sources.provider} model=${config.sources.model} baseUrl=${config.sources.baseUrl} apiKey=${config.sources.apiKey}`,
  ];
  if (config.baseUrl) lines.push(line("baseUrl", config.baseUrl));
  if (config.toolFormat) lines.push(line("toolFormat", config.toolFormat));
  if (config.permissionMode) lines.push(line("permissionMode", config.permissionMode));
  if (config.autonomy) lines.push(line("autonomy", config.autonomy));
  if (config.theme) lines.push(line("theme", config.theme));
  if (config.budget) {
    const parts: string[] = [];
    if (config.budget.maxSteps !== undefined) parts.push(`maxSteps=${config.budget.maxSteps}`);
    if (config.budget.maxTokens !== undefined) parts.push(`maxTokens=${config.budget.maxTokens}`);
    if (config.budget.maxWallMs !== undefined) parts.push(`maxWallMs=${config.budget.maxWallMs}`);
    if (parts.length > 0) lines.push(`  budget: ${parts.join(", ")}`);
  }
  const mcpCount = config.mcp?.servers.length ?? 0;
  const lspCount = config.lsp?.servers.length ?? 0;
  const regCount = config.providers?.providers.length ?? 0;
  lines.push(`  mcp.servers: ${mcpCount}  lsp.servers: ${lspCount}  registered providers: ${regCount}`);
  if ((config.trustedWorkspaceHooks?.length ?? 0) > 0) {
    lines.push(`  trustedWorkspaceHooks: ${config.trustedWorkspaceHooks!.length} path(s)`);
  }
  const analyticsPath = resolveAnalyticsLogPath(workspace, env);
  if (analyticsPath !== undefined) {
    lines.push(line("analyticsLog", analyticsPath));
  } else {
    lines.push(
      `  analyticsLog: off (set HZ_ANALYTICS_LOG=1 or --analytics-log; default ${defaultAnalyticsLogPath(workspace)})`,
    );
  }
  lines.push("", `user config file: ${userFile}`);
  lines.push(renderConfigCheck(checkConfigFile(userFile)));
  return lines.join("\n");
}
