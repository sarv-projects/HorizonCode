/**
 * post-edit-diagnostics.ts — the POST-EDIT-ONLY LSP diagnostic notice.
 *
 * This module never rejects, edits, or blocks anything: it is called after a
 * successful `apply_patch` has already written to disk, and its only product is
 * a compact `<lsp-diagnostics>` block appended to the tool result. A query
 * failure degrades to "no notice" and the edit stands. No server is started
 * when there is no LSP config (the writethrough no-ops on an empty config).
 *
 * Fresh-only de-charging is the existing `DiagnosticsLedger.reduce` inside
 * `workspaceDiagnostics`: an unchanged diagnostic already seen for a path is
 * not reported again, so re-applying the same content produces no notice.
 */

import { readFile } from "node:fs/promises";
import type { PostEditDiagnosticsNotice } from "../contracts";
import { DiagnosticsLedger } from "./diagnostics-ledger";
import { loadConfig, type LspConfig } from "./config";
import { workspaceDiagnostics, type FileDiagnosticsResult, type LspGuardHooks } from "./lsp";
import { relPath } from "../tools/helpers";

/** One mutated path's fresh diagnostics, after ledger reduction. */
export interface PostEditDiagnosticEntry {
  rel: string;
  server: string;
  summary: string;
  messages: string[];
}

/** Format the notice block. Pure: no config, no disk, no LSP. */
export function formatPostEditDiagnosticsNotice(entries: readonly PostEditDiagnosticEntry[]): string {
  const filled = entries.filter((e) => e.messages.length > 0);
  if (filled.length === 0) return "";
  const body = filled
    .map((e) => `${e.rel} (${e.server}): ${e.summary}\n${e.messages.join("\n")}`)
    .join("\n");
  return `<lsp-diagnostics>\n${body}\n</lsp-diagnostics>`;
}

/** One DiagnosticsLedger per session so fresh-only state spans successive edits. */
const ledgers = new Map<string, DiagnosticsLedger>();
function ledgerFor(sessionId: string): DiagnosticsLedger {
  let ledger = ledgers.get(sessionId);
  if (ledger === undefined) {
    ledger = new DiagnosticsLedger();
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}
/** @internal test hook — resets fresh-only state between cases. */
export function clearPostEditLedgers(): void {
  ledgers.clear();
}

export interface CreatePostEditDiagnosticsNoticeInput {
  sessionId: string;
  workspace: string;
  cwd: string;
  hooks: LspGuardHooks;
  signal?: AbortSignal;
  /** Config source override for hermetic tests; defaults to `loadConfig().lsp`. */
  configLoader?: () => LspConfig | undefined;
}

/**
 * Build the bound hook installed on `ToolContext.postEditDiagnosticsNotice`.
 * The returned function reads each mutated path's post-edit bytes and runs the
 * existing writethrough; every per-path failure is swallowed into "no notice".
 */
export function createPostEditDiagnosticsNotice(
  input: CreatePostEditDiagnosticsNoticeInput,
): PostEditDiagnosticsNotice {
  const configOf = input.configLoader ?? (() => loadConfig().lsp);
  return async (absPaths: readonly string[]): Promise<string> => {
    const config = configOf();
    if (config === undefined) return ""; // never spawn a server without config
    const ledger = ledgerFor(input.sessionId);
    const entries: PostEditDiagnosticEntry[] = [];

    for (const absPath of absPaths) {
      let content: string;
      try {
        content = (await readFile(absPath)).toString("utf8");
      } catch {
        continue; // deleted between the edit and the notice — nothing to query
      }
      let result: FileDiagnosticsResult | undefined;
      try {
        result = await workspaceDiagnostics({
          absPath,
          content,
          config,
          ledger,
          workspace: input.workspace,
          cwd: input.cwd,
          hooks: input.hooks,
          signal: input.signal,
        });
      } catch {
        continue; // a failed query is NOT an edit failure
      }
      if (result === undefined || result.messages.length === 0) continue;
      entries.push({
        rel: relPath(input.cwd, absPath),
        server: result.server,
        summary: result.summary,
        messages: result.messages,
      });
    }

    return formatPostEditDiagnosticsNotice(entries);
  };
}
