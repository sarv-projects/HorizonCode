/**
 * `/settings` and observability (docs/30 I-4, ADAPT aider): effective runtime
 * settings with secrets masked — no API call, no writes.
 */

import type { HzConfig } from "./config";
import { renderConfigCheck, checkConfigFile, defaultConfigPath } from "./config";
import { maskSecrets } from "./compaction";

export interface SettingsReportOptions {
  workspace: string;
  home: string;
  config: HzConfig;
}

function line(label: string, value: string): string {
  return `  ${label}: ${maskSecrets(value)}`;
}

/** Human-readable settings snapshot for TUI `/settings`. */
export function renderSettingsReport(opts: SettingsReportOptions): string {
  const { workspace, home, config } = opts;
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
  lines.push("", `user config file: ${userFile}`);
  lines.push(renderConfigCheck(checkConfigFile(userFile)));
  lines.push("", "Residual: local-only analytics log (not built).");
  return lines.join("\n");
}
