/**
 * receipt-shell-terminal.ts — reduced shell effect terminal/capability lines for
 * R172 receipt inspector (ruling **292**). Process exit only — not RC-7 run terminal.
 */

import { EventTypes } from "../contracts";
import type { EffectRecord } from "./effect-host";
import { sessionEventsPath } from "./session-kernel-reconcile";
import { existsSync, readFileSync } from "node:fs";

const SHELL_TOOLS = new Set(["shell", "shell_session", "powershell"]);

export interface ShellEffectTerminalView {
  capabilityId: string;
  executeOk?: boolean;
  exitCode?: number | null;
  /** Coarse process outcome for the shell effect (not the run's RC-7 terminal). */
  processOutcome: "succeeded" | "failed" | "unknown" | "n/a";
  residual: string;
}

function capabilityForTool(tool: string): string | undefined {
  if (SHELL_TOOLS.has(tool)) return "terminal.run";
  return undefined;
}

function readSessionEvents(workspace: string, sessionId: string): Record<string, unknown>[] {
  const file = sessionEventsPath(workspace, sessionId);
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Parse exit from stored tool.result output (codex-shaped or legacy `exit N` tail). */
export function parseShellExitCodeFromToolOutput(output: string): number | null | undefined {
  const exitLine = /(?:^|\n)Exit code: (\d+|null)\s*$/m.exec(output);
  if (exitLine) {
    return exitLine[1] === "null" ? null : Number(exitLine[1]);
  }
  const legacy = /(?:^|\n)exit (\d+|null)(?: \(signal [^)]*\))?$/.exec(output);
  if (legacy) return legacy[1] === "null" ? null : Number(legacy[1]);
  return undefined;
}

function exitFromSessionLog(
  workspace: string | undefined,
  sessionId: string | undefined,
  record: EffectRecord,
): number | null | undefined {
  if (!workspace || !sessionId) return undefined;
  for (const ev of readSessionEvents(workspace, sessionId)) {
    if (ev.type !== EventTypes.toolResult) continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const callId = typeof payload.callId === "string" ? payload.callId : undefined;
    const effectId = typeof payload.effectId === "string" ? payload.effectId : undefined;
    if (callId !== record.callId && effectId !== record.effectId) continue;
    const output = typeof payload.output === "string" ? payload.output : "";
    return parseShellExitCodeFromToolOutput(output);
  }
  return undefined;
}

export function deriveShellEffectTerminalView(
  record: EffectRecord | undefined,
  opts?: { workspace?: string; sessionId?: string },
): ShellEffectTerminalView | undefined {
  if (!record) return undefined;
  const capabilityId = capabilityForTool(record.tool);
  if (!capabilityId) return undefined;

  const execute = [...record.steps].reverse().find((s) => s.phase === "execute");
  const executeOk = execute?.ok;
  const exitCode = exitFromSessionLog(opts?.workspace, opts?.sessionId, record);

  let processOutcome: ShellEffectTerminalView["processOutcome"] = "unknown";
  if (executeOk === undefined) processOutcome = "unknown";
  else if (!executeOk) processOutcome = "failed";
  else if (exitCode === undefined) processOutcome = "unknown";
  else if (exitCode === 0) processOutcome = "succeeded";
  else processOutcome = "failed";

  const residual =
    "RC-7 run terminal + child-process liveness/reap: R172 residual (this pane is process exit only)";

  return { capabilityId, executeOk, exitCode, processOutcome, residual };
}

export function formatShellEffectTerminalLines(view: ShellEffectTerminalView): string[] {
  const lines = [`capability ${view.capabilityId}`, `process outcome ${view.processOutcome}`];
  if (view.executeOk !== undefined) lines.push(`effect execute ok ${view.executeOk}`);
  if (view.exitCode !== undefined) lines.push(`last exit ${view.exitCode === null ? "null" : view.exitCode}`);
  else lines.push("last exit (not in session log — residual)");
  lines.push(view.residual);
  return lines;
}
