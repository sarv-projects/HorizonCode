/**
 * receipt-child-session-stream.ts — reduced child session event-stream summary for
 * R172 (ruling **322**). Subagent boundaries only — not full nested stream replay.
 */

import { existsSync, readFileSync } from "node:fs";
import { sessionEventsPath } from "./session-kernel-reconcile";

/** Canonical capability for the `agent` delegate tool (docs/_conventions.md registry). */
export const AGENT_SPAWN_CAPABILITY_ID = "agent.spawn";

export interface SubagentBoundaryRow {
  childSessionId: string;
  capabilityId: typeof AGENT_SPAWN_CAPABILITY_ID;
  taskHead?: string;
  status?: string;
  durationMs?: number;
  tools?: number;
  subagentEventCount: number;
}

function readJsonlEvents(file: string): Record<string, unknown>[] {
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

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  let n = 0;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim()) n += 1;
  }
  return n;
}

/** Collect subagent start/end rows from a parent session's kernel event stream. */
export function parentSubagentEventWrapCount(events: readonly Record<string, unknown>[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.type === "subagent.event") n += 1;
  }
  return n;
}

export function subagentBoundariesFromParentEvents(
  events: readonly Record<string, unknown>[],
): SubagentBoundaryRow[] {
  const byAgent = new Map<string, SubagentBoundaryRow>();
  for (const ev of events) {
    const type = ev.type;
    if (type !== "subagent.start" && type !== "subagent.end") continue;
    const agentId = typeof ev.agentId === "string" ? ev.agentId : "";
    if (agentId === "") continue;
    let row = byAgent.get(agentId);
    if (!row) {
      row = {
        childSessionId: agentId,
        capabilityId: AGENT_SPAWN_CAPABILITY_ID,
        subagentEventCount: parentSubagentEventWrapCount(events),
      };
      byAgent.set(agentId, row);
    }
    if (type === "subagent.start") {
      if (typeof ev.task === "string" && ev.task !== "") {
        row.taskHead = ev.task.length > 72 ? `${ev.task.slice(0, 69)}…` : ev.task;
      }
    }
    if (type === "subagent.end") {
      if (typeof ev.status === "string") row.status = ev.status;
      if (typeof ev.durationMs === "number") row.durationMs = ev.durationMs;
      if (typeof ev.tools === "number") row.tools = ev.tools;
    }
  }
  return [...byAgent.values()];
}

export function readParentSessionEvents(workspace: string, parentSessionId: string): Record<string, unknown>[] {
  return readJsonlEvents(sessionEventsPath(workspace, parentSessionId));
}

export function summarizeChildSessionStream(workspace: string, childSessionId: string): {
  eventLines: number;
  streamPath: string;
} {
  const streamPath = sessionEventsPath(workspace, childSessionId);
  return { streamPath, eventLines: countLines(streamPath) };
}

/** Inspector lines for child session streams linked from an `agent` parent receipt. */
export function formatChildSessionStreamLines(
  workspace: string | undefined,
  parentSessionId: string | undefined,
  childEffectCount: number,
): string[] {
  if (!workspace || !parentSessionId) {
    return ["(child session streams need workspace + parent sessionId)"];
  }
  const parentEvents = readParentSessionEvents(workspace, parentSessionId);
  const boundaries = subagentBoundariesFromParentEvents(parentEvents);
  if (boundaries.length === 0) {
    return [
      `capability ${AGENT_SPAWN_CAPABILITY_ID} (no subagent.start in parent stream)`,
      `child effects linked on receipt: ${childEffectCount}`,
      "(per-child session JSONL under kernel state — no boundary row yet)",
    ];
  }
  const lines: string[] = [
    `capability ${AGENT_SPAWN_CAPABILITY_ID}`,
    `child effects linked on receipt: ${childEffectCount}`,
    `parent subagent.event wraps on stream: ${boundaries[0]?.subagentEventCount ?? 0}`,
  ];
  for (const row of boundaries) {
    const bits = [`childSessionId ${row.childSessionId}`];
    if (row.status) bits.push(`status ${row.status}`);
    if (row.durationMs !== undefined) bits.push(`${row.durationMs}ms`);
    if (row.tools !== undefined) bits.push(`${row.tools} tool(s)`);
    if (row.taskHead) bits.push(`task "${row.taskHead}"`);
    lines.push(`  · ${bits.join(" · ")}`);
    const child = summarizeChildSessionStream(workspace, row.childSessionId);
    lines.push(`    stream ${child.eventLines} event line(s) — \`${child.streamPath}\``);
  }
  lines.push("(full nested stream replay / verify: residual — not R174)");
  return lines;
}
