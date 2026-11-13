/**
 * Durable opt-in R170 reconcile latch state. The append-only transition file
 * survives a runtime restart; this is NOT a kernel-signed OwnerLog or a
 * cross-process admission lock. Readers take the latest session transition.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { appendJsonlSync } from "./jsonl-append";
import { kernelStateDir } from "./paths";

export const RECONCILE_LATCHES_FILE = "reconcile-latches.jsonl";

export type PersistedReconcileLatch = {
  reason: string;
  latchedAt: number;
  blockedPaths: string[];
};

type LatchTransition = {
  v: 1;
  sessionId: string;
  state: "latched" | "released";
  at: string;
  reason?: string;
  latchedAt?: number;
  blockedPaths?: string[];
};

export function reconcileLatchFile(workspace: string): string {
  return path.join(kernelStateDir(workspace), RECONCILE_LATCHES_FILE);
}

function invalidLatch(): PersistedReconcileLatch {
  // Indeterminate journal data is NOT proof of a clean, released latch.
  return { reason: "reconcile latch journal unreadable or malformed; inspection required", latchedAt: 0, blockedPaths: [] };
}

export function loadReconcileLatch(
  workspace: string,
  sessionId: string,
): { present: boolean; latch?: PersistedReconcileLatch } {
  const file = reconcileLatchFile(workspace);
  if (!existsSync(file)) return { present: false };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { present: true, latch: invalidLatch() };
  }
  let latest: PersistedReconcileLatch | null | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return { present: true, latch: invalidLatch() };
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { present: true, latch: invalidLatch() };
    }
    const item = row as Partial<LatchTransition>;
    if (item.v !== 1 || typeof item.sessionId !== "string" ||
        (item.state !== "latched" && item.state !== "released")) {
      return { present: true, latch: invalidLatch() };
    }
    if (item.sessionId !== sessionId) continue;
    if (item.state === "released") {
      latest = null;
      continue;
    }
    if (typeof item.reason !== "string" || typeof item.latchedAt !== "number" ||
        !Number.isFinite(item.latchedAt) || !Array.isArray(item.blockedPaths) ||
        !item.blockedPaths.every((p) => typeof p === "string" && path.isAbsolute(p))) {
      return { present: true, latch: invalidLatch() };
    }
    latest = {
      reason: item.reason,
      latchedAt: item.latchedAt,
      blockedPaths: [...item.blockedPaths],
    };
  }
  if (latest === undefined) return { present: false };
  return latest === null ? { present: true } : { present: true, latch: latest };
}

/** Persist the transition first; callers must not update their in-memory view
 * on write failure. There is no automatic "clean" release transition. */
export function appendReconcileLatch(
  workspace: string,
  sessionId: string,
  latch: PersistedReconcileLatch | null,
): void {
  const file = reconcileLatchFile(workspace);
  mkdirSync(path.dirname(file), { recursive: true });
  const row: LatchTransition = {
    v: 1,
    sessionId,
    state: latch ? "latched" : "released",
    at: new Date().toISOString(),
    ...(latch
      ? {
          reason: latch.reason,
          latchedAt: latch.latchedAt,
          blockedPaths: latch.blockedPaths,
        }
      : {}),
  };
  appendJsonlSync(file, JSON.stringify(row) + "\n");
}
