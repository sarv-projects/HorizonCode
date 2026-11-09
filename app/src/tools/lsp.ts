/**
 * `lsp` — language-server diagnostics for one file (docs/09 §4.7, reduced v1).
 *
 * v1 op set is a single read-only op: `op: 'diagnostics'` (`path` required). The
 * tool resolves the path, reads the file, and runs the LSP writethrough
 * (core/lsp/workspace-diagnostics) with a per-session DiagnosticsLedger so only
 * FRESH diagnostics are surfaced — a second pass over unchanged content returns
 * nothing new. Starting a language server is admitted as a `spawn` GuardAction
 * (core/lsp lspSpawnAction) via the ctx.guard/ctx.approve hooks BEFORE any
 * process exists; the first diagnostics call that needs a server triggers it.
 *
 * GRACEFUL NO-OP: with no server configured for the file's extension the tool
 * returns ok:true with a clear message and never crashes; a server that fails
 * to start/handshake degrades to the same no-op (the writethrough never throws).
 *
 * Diagnostics are surfaced INSIDE the ToolResult.output string, so no contract
 * change and no edits to edit.ts/write.ts/loop.ts are needed.
 *
 * concurrencyClass is the default `shared`: diagnostics are read-only (apply:
 * false) per docs/09 — navigation/diagnostics are `allow`/read-only.
 */

import { readFile } from "node:fs/promises";
import type { ReceiptInput, Tool, ToolContext, ToolResult } from "../contracts";
import { canonicalJson, sha256Hex } from "../core/canon";
import { loadConfig, type LspConfig } from "../core/config";
import { DiagnosticsLedger } from "../core/diagnostics-ledger";
import { workspaceDiagnostics } from "../core/lsp";
import { isBinary, relPath, resolvePath } from "./helpers";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One DiagnosticsLedger per session, so fresh-only de-charging is scoped to the
 * session (like edit.ts's reflections Map). Process-global, keyed by sessionId.
 */
const ledgers = new Map<string, DiagnosticsLedger>();

function ledgerFor(sessionId: string): DiagnosticsLedger {
  let ledger = ledgers.get(sessionId);
  if (ledger === undefined) {
    ledger = new DiagnosticsLedger();
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}

/**
 * Config override for tests: when set, the tool uses this LspConfig instead of
 * reading the user config file (the sandbox has no servers, so a test points
 * the config at the fake-server fixture). Absent in production.
 */
let configOverride: LspConfig | undefined | null = null;

/** Set (or clear with `null`) the test config override. */
export function setLspConfigOverride(config: LspConfig | undefined | null): void {
  configOverride = config;
}

/** Clear every session ledger; tests use this to reset fresh-only state. */
export function clearLspLedgers(): void {
  ledgers.clear();
}

function resolveLspConfig(): LspConfig | undefined {
  if (configOverride !== null) return configOverride;
  return loadConfig().lsp;
}

export const lspTool: Tool = {
  name: "lsp",
  description:
    "Language-server diagnostics for a file. op:'diagnostics' (path required) syncs the file to any configured " +
    "language server and reports only fresh diagnostics; a no-op when no server is configured for the file type.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["diagnostics"], description: "The operation (v1: 'diagnostics')." },
      path: { type: "string", description: "File path to diagnose." },
    },
    required: ["op", "path"],
  },

  // Read-only (apply:false): navigation/diagnostics are shared (docs/09 §10).
  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const op = typeof args.op === "string" ? args.op : "diagnostics";
      if (op !== "diagnostics") return fail(`unsupported op: ${op} (v1 supports 'diagnostics')`);
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");

      const resolved = resolvePath(ctx.cwd, args.path);
      const rel = relPath(ctx.cwd, resolved);

      let content: string;
      try {
        const buf = await readFile(resolved);
        if (isBinary(buf)) return fail(`binary file (contains a NUL byte): ${rel}`);
        content = buf.toString("utf8");
      } catch {
        return fail(`file not found: ${rel}`);
      }

      const config = resolveLspConfig();
      const result = await workspaceDiagnostics({
        absPath: resolved,
        content,
        config,
        ledger: ledgerFor(ctx.sessionId),
        workspace: ctx.workspace,
        cwd: ctx.cwd,
        hooks: {
          guard: (action) => ctx.guard(action),
          approve: (req, action) => ctx.approve(req, action),
        },
        signal: ctx.signal,
      });

      // Graceful no-op: no language server configured for this file type.
      const output =
        result === undefined
          ? `no language server configured for ${extOf(rel)} (${rel})`
          : result.messages.length === 0
            ? `${rel}: no issues`
            : `${rel} (${result.server}): ${result.summary}\n${result.messages.join("\n")}`;

      // The op's own receipt (distinct action from the loop's tool.execute),
      // digesting the canonical args and the output surfaced to the model.
      const receipt: ReceiptInput = {
        action: "lsp.diagnostics",
        tool: "lsp",
        argsDigest: sha256Hex(canonicalJson({ op: "diagnostics", path: rel })),
        resultDigest: sha256Hex(output),
      };
      try {
        await ctx.receipt(receipt);
      } catch {
        /* a receipt failure must not sink a read-only diagnostics result */
      }

      return { ok: true, output };
    } catch (e) {
      return fail(msg(e));
    }
  },
};

/** The dotless extension of a display path, for the no-server message. */
function extOf(rel: string): string {
  const dot = rel.lastIndexOf(".");
  const slash = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
  if (dot <= slash + 1) return "this file type";
  return `.${rel.slice(dot + 1)} files`;
}
