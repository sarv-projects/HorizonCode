/**
 * convo.ts - conversation management verbs (forgecode take T-12).
 *
 * Pure helpers behind /rename, /retry, /stats, /export and /copy: the last
 * user and assistant text, a stats summary, and the JSON / HTML exports. The
 * HTML export carries the receipt chain status, so a shared transcript says
 * whether the audit chain verified when it was written. Nothing here touches
 * the guard: exports are written under the state root by the caller.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg } from "../contracts";
import { estimateTokens } from "./output-budget";

export interface ChainStatus {
  ok: boolean;
  count: number;
  brokenAt?: number;
  /** Hash of the newest receipt, when there is one. */
  head?: string;
}

export interface ExportMeta {
  sessionId: string;
  title: string;
  model: string;
  exportedAt: string;
  chain?: ChainStatus;
}

export interface ConvoStats {
  messages: number;
  byRole: Record<string, number>;
  toolCalls: number;
  estimatedTokens: number;
}

/** The newest non-empty message of a role. */
export function lastOfRole(history: readonly ChatMsg[], role: ChatMsg["role"]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m?.role === role && (m.content ?? "").trim() !== "") return m.content;
  }
  return undefined;
}

export function convoStats(history: readonly ChatMsg[]): ConvoStats {
  const byRole: Record<string, number> = {};
  let toolCalls = 0;
  let text = "";
  for (const m of history) {
    byRole[m.role] = (byRole[m.role] ?? 0) + 1;
    toolCalls += m.toolCalls?.length ?? 0;
    text += (m.content ?? "") + "\n";
  }
  return { messages: history.length, byRole, toolCalls, estimatedTokens: estimateTokens(text) };
}

export function renderStats(stats: ConvoStats): string {
  const roles = Object.entries(stats.byRole)
    .map(([role, n]) => `${role} ${n}`)
    .join(", ");
  return `${stats.messages} message(s) (${roles || "none"}), ${stats.toolCalls} tool call(s), ~${stats.estimatedTokens} tokens (local estimate)`;
}

export function chainLine(chain: ChainStatus | undefined): string {
  if (!chain) return "receipt chain: not checked";
  if (chain.ok) return `receipt chain verified: ${chain.count} receipt(s)`;
  return `receipt chain BROKEN at receipt ${chain.brokenAt ?? "?"} (${chain.count} verified before it)`;
}

export function renderExportJson(history: readonly ChatMsg[], meta: ExportMeta): string {
  return JSON.stringify({ ...meta, messages: history }, null, 2) + "\n";
}

function esc(text: string): string {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderExportHtml(history: readonly ChatMsg[], meta: ExportMeta): string {
  const rows = history
    .map((m) => {
      const calls = (m.toolCalls ?? []).map((c) => `<div class="call">tool call: ${esc(c.name)}</div>`).join("");
      const who = m.role === "tool" ? `tool${m.toolName ? " " + esc(m.toolName) : ""}` : esc(m.role);
      return `<section class="${esc(m.role)}"><h3>${who}</h3><pre>${esc(m.content ?? "")}</pre>${calls}</section>`;
    })
    .join("\n");
  const chain = meta.chain;
  const head = chain?.head ? ` Head: <code>${esc(chain.head)}</code>.` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(meta.title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}
section{border-left:4px solid #888;padding:.2rem .8rem;margin:.8rem 0}.user{border-color:#27c}.assistant{border-color:#2a5}
.chain{padding:.5rem;border:1px solid #888}.bad{color:#b00}pre{white-space:pre-wrap;word-break:break-word}h3{margin:.2rem 0}</style></head>
<body><h1>${esc(meta.title)}</h1>
<p>Session <code>${esc(meta.sessionId)}</code>, model ${esc(meta.model)}, exported ${esc(meta.exportedAt)}.</p>
<p class="chain${chain && !chain.ok ? " bad" : ""}">${esc(chainLine(chain))}.${head}</p>
${rows}
</body></html>
`;
}

/** Hash of the newest receipt in `<kernel state dir>/receipts.jsonl`, if any. */
export function receiptHead(kernelStateDir: string): string | undefined {
  try {
    const lines = readFileSync(path.join(kernelStateDir, "receipts.jsonl"), "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim() === "") continue;
      const hash = (JSON.parse(lines[i]) as { hash?: unknown }).hash;
      return typeof hash === "string" ? hash : undefined;
    }
  } catch {
    /* no receipts yet */
  }
  return undefined;
}

/** OSC 52 sequence asking the terminal to put `text` on the clipboard. */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}
