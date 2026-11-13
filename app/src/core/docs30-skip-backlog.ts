/**
 * Mirror of docs/30 Wave F / goal-SKIP backlog (ruling 252). Documentation is
 * authoritative; this list exists only for `hzcode doctor` honesty.
 */

export const DOCS_30_SKIP_BACKLOG_LABELS = [
  "D-4 scheduler (no cron runner — at-most-once scheduling)",
  "H-6 full KDL compat cascade (partial host map **244** only)",
  "provider-hosted tools (local tool set only, docs/09)",
  "external agent subagents (in-process children only)",
  "§8 #17 foreign session import (until memory spine #1–#4)",
  "§8 #18 collab-web / desktop session-ui",
  "Rust TUI rewrite",
  "Effect-TS rewrite",
  "vendored memory MCP servers as core",
  "Kitty graphics",
  "forge hosted search / spoofed OAuth clients",
] as const;

export function docs30SkipBacklogCount(): number {
  return DOCS_30_SKIP_BACKLOG_LABELS.length;
}
