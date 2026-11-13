/**
 * receipt-run-terminal.ts — RC-7 run-level `terminal.run` capability snapshot
 * (docs/28 ruling **298** reduced). Session `run.complete` + receipt inspector
 * pane; NOT per-shell-effect process exit (**292**).
 */

import type { RunExit, TerminalState } from "../contracts";
import { activeShellSessionCount } from "../tools/interactive-exec";

export const RUN_COMPLETE_EVENT = "run.complete";

export interface TerminalRunCapabilitySnapshot {
  capabilityId: "terminal.run";
  cols: number;
  rows: number;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** Open `shell_session` entries at capture time (bounded registry; not full PTY state). */
  shellSessionOpen: number;
  residual: string;
}

export interface RunCompletePayload {
  exit: RunExit;
  terminalRunCapability: TerminalRunCapabilitySnapshot;
}

const RC7: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "unknown",
  "budget_exhausted",
  "timeout",
  "interrupted",
]);

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** Best-effort host TTY geometry + `terminal.run` capability id (read-only). */
export function captureTerminalRunCapabilitySnapshot(opts?: {
  cols?: number;
  rows?: number;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  shellSessionOpen?: number;
}): TerminalRunCapabilitySnapshot {
  const cols = positiveInt(opts?.cols ?? process.stdout.columns, 80);
  const rows = positiveInt(opts?.rows ?? process.stdout.rows, 24);
  const stdinIsTTY = opts?.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY = opts?.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  const shellSessionOpen = opts?.shellSessionOpen ?? activeShellSessionCount();
  return {
    capabilityId: "terminal.run",
    cols,
    rows,
    stdinIsTTY,
    stdoutIsTTY,
    shellSessionOpen,
    residual:
      "PTY scrollback/session liveness/reap beyond open count: R172 residual (snapshot is host geometry + session registry only)",
  };
}

export function buildRunCompletePayload(exit: RunExit, snap?: TerminalRunCapabilitySnapshot): RunCompletePayload {
  return {
    exit,
    terminalRunCapability: snap ?? captureTerminalRunCapabilitySnapshot(),
  };
}

function parseRunExit(raw: unknown): RunExit | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const terminal = row.terminal;
  if (typeof terminal !== "string" || !RC7.has(terminal)) return undefined;
  const detail = typeof row.detail === "string" ? row.detail : undefined;
  return { terminal: terminal as TerminalState, detail: detail as RunExit["detail"] };
}

function parseCapabilitySnapshot(raw: unknown): TerminalRunCapabilitySnapshot | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (row.capabilityId !== "terminal.run") return undefined;
  return {
    capabilityId: "terminal.run",
    cols: positiveInt(row.cols, 0),
    rows: positiveInt(row.rows, 0),
    stdinIsTTY: row.stdinIsTTY === true,
    stdoutIsTTY: row.stdoutIsTTY === true,
    shellSessionOpen: typeof row.shellSessionOpen === "number" ? Math.max(0, Math.floor(row.shellSessionOpen)) : 0,
    residual:
      typeof row.residual === "string" && row.residual !== ""
        ? row.residual
        : "PTY session status beyond open count: residual",
  };
}

/** Latest `run.complete` in session event order (newest wins). */
export function latestRunCompleteFromEvents(
  events: readonly Record<string, unknown>[],
): RunCompletePayload | undefined {
  let found: RunCompletePayload | undefined;
  for (const ev of events) {
    if (ev.type !== RUN_COMPLETE_EVENT) continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const exit = parseRunExit(payload.exit);
    const terminalRunCapability = parseCapabilitySnapshot(payload.terminalRunCapability);
    if (!exit || !terminalRunCapability) continue;
    found = { exit, terminalRunCapability };
  }
  return found;
}

export function formatRunTerminalCapabilityLines(
  snap: TerminalRunCapabilitySnapshot,
  exit?: RunExit,
): string[] {
  const lines = [
    `capability ${snap.capabilityId}`,
    `geometry ${snap.cols}x${snap.rows}`,
    `tty stdin ${snap.stdinIsTTY} stdout ${snap.stdoutIsTTY}`,
    `shell_session open ${snap.shellSessionOpen}`,
  ];
  if (exit) {
    lines.push(`RC-7 terminal ${exit.terminal}${exit.detail ? ` (${exit.detail})` : ""}`);
  } else {
    lines.push("RC-7 terminal (no run.complete in session log — residual)");
  }
  lines.push(snap.residual);
  return lines;
}

export function formatTerminalRunCapabilityDoctorLine(snap: TerminalRunCapabilitySnapshot): string {
  return (
    `terminal.run capability snapshot: ${snap.cols}x${snap.rows}; ` +
    `tty in=${snap.stdinIsTTY} out=${snap.stdoutIsTTY}; ` +
    `shell_session open=${snap.shellSessionOpen} (host geometry only; not shell-net enforcement)`
  );
}
