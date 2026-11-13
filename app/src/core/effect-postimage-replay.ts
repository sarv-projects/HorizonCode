/**
 * Independent postimage digest replay at session verify (ruling **297**).
 *
 * Opt-in via `HZ_VERIFY_POSTIMAGE_REPLAY=1`: re-read workspace files named on
 * write/edit receipts and compare to stored `postimageDigest` (fail-closed).
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Receipt } from "../contracts";
import { effectHostKernelMode } from "./effect-kernel-mutation-route";
import { observePostimageDigest } from "./receipt-postimage";
import { receiptsPath } from "./session-kernel-reconcile";

const REPLAY_TOOLS = new Set(["write", "edit", "apply_patch", "ast_edit", "multi_edit"]);

export function postimageReplayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_VERIFY_POSTIMAGE_REPLAY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Session verify / evidence gate: explicit opt-in or auto-on under EffectHost require (ruling **301**). */
export function postimageReplayActive(env: Record<string, string | undefined> = process.env): boolean {
  if (postimageReplayEnabled(env)) return true;
  return effectHostKernelMode(env) === "require";
}

export type PostimageReplayDoctorPosture = {
  active: boolean;
  explicit: boolean;
  requireAuto: boolean;
  detail: string;
  hint: string;
};

export function postimageReplayDoctorPosture(
  env: Record<string, string | undefined> = process.env,
): PostimageReplayDoctorPosture {
  const explicit = postimageReplayEnabled(env);
  const requireAuto = !explicit && effectHostKernelMode(env) === "require";
  const active = explicit || requireAuto;
  const base =
    "independent receipt postimage digest replay at `hzcode session verify` / `hzcode effect reconcile` " +
    "(read-only re-read vs stored digest on write/edit/apply_patch/ast_edit/multi_edit receipts; kernel-routed ast_edit incl. unique `$$$` when postimagePath set — not full Rust observe)";
  if (explicit) {
    return {
      active: true,
      explicit: true,
      requireAuto: false,
      detail: `${base}: HZ_VERIFY_POSTIMAGE_REPLAY=1 (on)`,
      hint: "unset HZ_VERIFY_POSTIMAGE_REPLAY to disable unless HZ_EFFECT_HOST_KERNEL=require auto-enables replay",
    };
  }
  if (requireAuto) {
    return {
      active: true,
      explicit: false,
      requireAuto: true,
      detail: `${base}: auto-on because HZ_EFFECT_HOST_KERNEL=require (honesty gate — not full Rust observe)`,
      hint: "explicit opt-in: export HZ_VERIFY_POSTIMAGE_REPLAY=1; run `hzcode doctor --fix effect.postimage.replay`",
    };
  }
  return {
    active: false,
    explicit: false,
    requireAuto: false,
    detail: `${base}: off by default (HZ_VERIFY_POSTIMAGE_REPLAY unset)`,
    hint: "export HZ_VERIFY_POSTIMAGE_REPLAY=1 for independent digest replay at verify; also auto-on when HZ_EFFECT_HOST_KERNEL=require",
  };
}

/** Read-only fix lines for `hzcode doctor --fix effect.postimage.replay` (ruling **301**). */
export function postimageReplayDoctorFixLines(
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (postimageReplayEnabled(env)) {
    return ["HZ_VERIFY_POSTIMAGE_REPLAY=1 already set (independent postimage digest replay at session verify)"];
  }
  return [
    "# Independent postimage digest replay at session verify (diagnose-only — export in your shell)",
    "export HZ_VERIFY_POSTIMAGE_REPLAY=1",
    "# With HZ_EFFECT_HOST_KERNEL=require, replay runs without this export (honesty gate auto-on)",
  ];
}

export interface PostimageReplayFailure {
  receiptId?: string;
  effectId?: string;
  tool: string;
  path: string;
  storedDigest: string;
  replayDigest?: string;
}

export interface PostimageReplayReport {
  workspace: string;
  receiptsScanned: number;
  failures: PostimageReplayFailure[];
}

function readReceiptRows(workspace: string): Receipt[] {
  const file = receiptsPath(workspace);
  if (!existsSync(file)) return [];
  const rows: Receipt[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Receipt);
    } catch {
      /* skip */
    }
  }
  return rows;
}

function sha256Empty(): string {
  return createHash("sha256").update("").digest("hex");
}

/** Read-only replay of receipt postimage digests against current workspace bytes. */
export function probePostimageReplay(workspace: string): PostimageReplayReport {
  const failures: PostimageReplayFailure[] = [];
  const rows = readReceiptRows(workspace);
  for (const row of rows) {
    const tool = typeof row.tool === "string" ? row.tool : "";
    if (!REPLAY_TOOLS.has(tool)) continue;
    const stored = row.postimageDigest;
    const filePath = row.postimagePath;
    if (typeof stored !== "string" || stored === "" || typeof filePath !== "string" || filePath === "") {
      continue;
    }
    if (!existsSync(filePath)) {
      if (stored === sha256Empty()) continue;
      failures.push({
        receiptId: row.id,
        effectId: row.effectId,
        tool,
        path: filePath,
        storedDigest: stored,
      });
      continue;
    }
    const replay = observePostimageDigest(filePath);
    if (replay === undefined || replay !== stored) {
      failures.push({
        receiptId: row.id,
        effectId: row.effectId,
        tool,
        path: filePath,
        storedDigest: stored,
        replayDigest: replay,
      });
    }
  }
  return { workspace, receiptsScanned: rows.length, failures };
}

export function formatPostimageReplaySummary(report: PostimageReplayReport): string {
  if (report.failures.length === 0) {
    return `postimage replay: ${report.receiptsScanned} receipt(s); digests match (HZ_VERIFY_POSTIMAGE_REPLAY)`;
  }
  const bits = report.failures.slice(0, 4).map((f) => `${f.tool} ${f.path.split(/[/\\]/).pop() ?? f.path}`);
  const more = report.failures.length > 4 ? ` (+${report.failures.length - 4} more)` : "";
  return `postimage replay: ${report.failures.length} mismatch(es) — ${bits.join("; ")}${more}`;
}
