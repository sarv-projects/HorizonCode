/**
 * receipt-child-session-stream.ts — reduced child session event-stream summary for
 * R172 (ruling **322**). Subagent boundaries only — not full nested stream replay.
 */

import { existsSync, readFileSync } from "node:fs";
import { sessionEventsPath } from "./session-kernel-reconcile";
import { verifySessionEventAnchorSync, type ChainAnchorVerdict } from "./chain-anchor-verify";

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
    // A real kernel EventEnvelope carries details in payload. The historical
    // reduced stream test used flat rows; support both without inventing facts.
    const payload = ev.payload && typeof ev.payload === "object" && !Array.isArray(ev.payload)
      ? ev.payload as Record<string, unknown> : ev;
    const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
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
      if (typeof payload.task === "string" && payload.task !== "") {
        row.taskHead = payload.task.length > 72 ? `${payload.task.slice(0, 69)}…` : payload.task;
      }
    }
    if (type === "subagent.end") {
      if (typeof payload.status === "string") row.status = payload.status;
      if (typeof payload.durationMs === "number") row.durationMs = payload.durationMs;
      if (typeof payload.tools === "number") row.tools = payload.tools;
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

/** Chain integrity is required for an asserted nested-stream observation.
 * Legacy streams without anchors have a verified hash walk but are visibly
 * marked unanchored, and a missing chain is NEVER silently considered clean. */
export function formatNestedStreamIntegrity(verdict: ChainAnchorVerdict): string {
  if (verdict.skipped) return "MISSING (no child stream evidence)";
  if (!verdict.ok) {
    return verdict.refusal ? `UNVERIFIED: ${verdict.refusal}`
      : `INVALID chain at seq ${verdict.brokenAt ?? "unknown"}`;
  }
  if (verdict.anchorAbsent) return `hash-walk OK (${verdict.count}), anchor absent (legacy/unanchored)`;
  return `VERIFIED hash chain + head (${verdict.count})`;
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
  const parentIntegrity = verifySessionEventAnchorSync(workspace, parentSessionId);
  if (!parentIntegrity.ok) {
    return [
      `capability ${AGENT_SPAWN_CAPABILITY_ID}`,
      `child effects linked on receipt: ${childEffectCount}`,
      `parent stream ${formatNestedStreamIntegrity(parentIntegrity)}`,
      "(untrusted parent stream: refusing child names and claimed outcomes)",
    ];
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
    const integrity = verifySessionEventAnchorSync(workspace, row.childSessionId);
    lines.push(`    stream ${child.eventLines} event line(s) — \`${child.streamPath}\``);
    lines.push(`    integrity ${formatNestedStreamIntegrity(integrity)}`);
  }
  lines.push("(full nested stream replay / verify: residual — not R174)");
  return lines;
}
