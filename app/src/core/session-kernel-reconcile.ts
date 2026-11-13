/**
 * session-kernel-reconcile.ts — correlate session tool.call events with receipt
 * chain rows (honesty P0 session↔kernel bridge, reduced form).
 *
 * Not EffectHost: does not settle effects. It scans a session event stream and
 * the receipts JSONL and reports unpaired tool calls / receipts for doctor and
 * tests. When effectId is present on tool.call / tool.result / receipt.issued,
 * pairing prefers that key before callId or tool name.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { EventTypes } from "../contracts";
import { kernelStateDir } from "./paths";

export interface SessionToolCallRef {
  callId: string;
  tool: string;
  seq: number;
  effectId?: string;
}

export interface ReceiptRef {
  id: string;
  seq: number;
  tool: string;
  callId?: string;
  effectId?: string;
}

export interface ReconcileReport {
  sessionStream: string;
  toolCalls: number;
  receipts: number;
  paired: number;
  effectIdPaired: number;
  unpairedCalls: SessionToolCallRef[];
  unpairedReceipts: ReceiptRef[];
}

function readJsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* torn/corrupt line — skip like other readers */
    }
  }
  return rows;
}

function sanitizeStream(stream: string): string {
  return stream.replace(/[^a-zA-Z0-9._-]+/g, "__");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function sessionEventsPath(workspace: string, sessionId: string): string {
  const stream = `session:${sessionId}`;
  return path.join(kernelStateDir(workspace), "events", sanitizeStream(stream) + ".jsonl");
}

export function receiptsPath(workspace: string): string {
  return path.join(kernelStateDir(workspace), "receipts.jsonl");
}

function effectIdFromEvents(events: Record<string, unknown>[], callId: string): string | undefined {
  for (const ev of events) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const id = asString(payload.callId) ?? asString(payload.id);
    if (id !== callId) continue;
    const effectId = asString(payload.effectId);
    if (effectId) return effectId;
    if (ev.type === EventTypes.toolResult || ev.type === EventTypes.receiptIssued) {
      const e2 = asString(payload.effectId);
      if (e2) return e2;
    }
  }
  return undefined;
}

/** Best-effort pairing: effectId, receipt payload callId, else tool name + order. */
export function reconcileSessionKernel(workspace: string, sessionId: string): ReconcileReport {
  const events = readJsonl(sessionEventsPath(workspace, sessionId));
  const receipts = readJsonl(receiptsPath(workspace));

  const calls: SessionToolCallRef[] = [];
  for (const ev of events) {
    if (ev.type !== EventTypes.toolCall) continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const callId = asString(payload.id) ?? asString(payload.callId) ?? "";
    const tool = asString(payload.name) ?? asString(payload.tool) ?? "unknown";
    const effectId = asString(payload.effectId) ?? effectIdFromEvents(events, callId);
    calls.push({ callId, tool, seq: typeof ev.seq === "number" ? ev.seq : 0, effectId });
  }

  const receiptRefs: ReceiptRef[] = receipts.map((r) => ({
    id: typeof r.id === "string" ? r.id : "",
    seq: typeof r.seq === "number" ? r.seq : 0,
    tool: typeof r.tool === "string" ? r.tool : "unknown",
    callId: typeof r.callId === "string" ? r.callId : undefined,
    effectId: typeof r.effectId === "string" ? r.effectId : undefined,
  }));

  const unpairedCalls: SessionToolCallRef[] = [];
  const usedReceipts = new Set<number>();
  let paired = 0;
  let effectIdPaired = 0;

  for (const call of calls) {
    let matchIdx = -1;
    let matchedByEffectId = false;
    if (call.effectId) {
      matchIdx = receiptRefs.findIndex((r, i) => !usedReceipts.has(i) && r.effectId === call.effectId);
      if (matchIdx >= 0) matchedByEffectId = true;
    }
    if (matchIdx < 0 && call.callId) {
      matchIdx = receiptRefs.findIndex((r, i) => !usedReceipts.has(i) && r.callId === call.callId);
    }
    if (matchIdx < 0) {
      matchIdx = receiptRefs.findIndex((r, i) => !usedReceipts.has(i) && r.tool === call.tool);
    }
    if (matchIdx >= 0) {
      usedReceipts.add(matchIdx);
      paired += 1;
      if (matchedByEffectId) effectIdPaired += 1;
    } else {
      unpairedCalls.push(call);
    }
  }

  const unpairedReceipts = receiptRefs.filter((_, i) => !usedReceipts.has(i));

  return {
    sessionStream: `session:${sessionId}`,
    toolCalls: calls.length,
    receipts: receiptRefs.length,
    paired,
    effectIdPaired,
    unpairedCalls,
    unpairedReceipts,
  };
}

/** Stable digest of a reconcile report for tests / notices. */
export function reconcileReportDigest(report: ReconcileReport): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify({
      toolCalls: report.toolCalls,
      receipts: report.receipts,
      paired: report.paired,
      effectIdPaired: report.effectIdPaired,
      unpairedCalls: report.unpairedCalls.length,
      unpairedReceipts: report.unpairedReceipts.length,
    }),
  );
  return h.digest("hex");
}

/** Human notice when session tool.call rows and receipts do not pair (ruling 235). */
export function formatUnpairedSessionKernelNotice(report: ReconcileReport): string {
  const uCalls = report.unpairedCalls.length;
  const uRcpt = report.unpairedReceipts.length;
  if (uCalls === 0 && uRcpt === 0) return "";
  const bits: string[] = ["session↔kernel reconcile: unpaired tool ledger"];
  if (uCalls > 0) {
    const sample = report.unpairedCalls
      .slice(0, 3)
      .map((c) => `${c.tool}${c.effectId ? ` (${c.effectId.slice(0, 8)})` : ""}`)
      .join(", ");
    bits.push(`${uCalls} call(s) without receipt${uCalls > 3 ? "…" : ""}: ${sample}`);
  }
  if (uRcpt > 0) {
    const sample = report.unpairedReceipts
      .slice(0, 3)
      .map((r) => `${r.tool}#${r.seq}`)
      .join(", ");
    bits.push(`${uRcpt} receipt(s) without tool.call${uRcpt > 3 ? "…" : ""}: ${sample}`);
  }
  return bits.join(" · ");
}

/**
 * Best-effort reconcile scan for live turns. Returns a notice string when
 * unpaired, otherwise undefined. Never throws.
 */
export function sessionKernelReconcileNotice(workspace: string, sessionId: string): string | undefined {
  try {
    const report = reconcileSessionKernel(workspace, sessionId);
    const msg = formatUnpairedSessionKernelNotice(report);
    return msg === "" ? undefined : msg;
  } catch {
    return undefined;
  }
}
