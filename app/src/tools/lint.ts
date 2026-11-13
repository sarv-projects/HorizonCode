/**
 * `lint` — compiler-grade errors via the LSP path (docs/30 F-1 reduced).
 *
 * Delegates to the same writethrough as `lsp`, then keeps only severity `error`
 * lines. Tree-sitter excerpts and a user-supplied per-language command table are
 * out of scope.
 */

import { readFile } from "node:fs/promises";
import type { GuardAction, ReceiptInput, Tool, ToolContext, ToolResult } from "../contracts";
import { canonicalJson, sha256Hex } from "../core/canon";
import { DiagnosticsLedger } from "../core/diagnostics-ledger";
import { workspaceDiagnostics } from "../core/lsp";
import { isBinary, relPath, resolvePath } from "./helpers";
import { defaultConfigPath, loadConfig, type LspConfig } from "../core/config";
import {
  formatLintFindings,
  parseLintOutputLines,
  resolveLintCommand,
  runUserLintCommand,
  substituteLintFile,
} from "../core/lint-commands";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ledgers = new Map<string, DiagnosticsLedger>();

function ledgerFor(sessionId: string): DiagnosticsLedger {
  let ledger = ledgers.get(sessionId);
  if (ledger === undefined) {
    ledger = new DiagnosticsLedger();
    ledgers.set(sessionId, ledger);
  }
  return ledger;
}

/** @internal test hook — shares override with `lsp` when both are exercised. */
export function clearLintLedgers(): void {
  ledgers.clear();
}

function resolveLspConfig(): LspConfig | undefined {
  return loadConfig().lsp;
}

const ERROR_LINE = /:\d+:\d+ error /;

function compilerErrorsOnly(messages: readonly string[]): string[] {
  return messages.filter((line) => ERROR_LINE.test(line));
}

/**
 * A user-configured lint command is a full shell program, not a pure LSP read.
 * The outer lint admission guards fs.read; this second guard is mandatory
 * before /bin/sh -c runs anything, even if a config claims it is a linter.
 */
export async function admitUserLintCommand(command: string, ctx: ToolContext): Promise<boolean> {
  const action: GuardAction = { kind: "shell.exec", target: command };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") return false;
  if (decision.decision === "ask") {
    return ctx.approve({ title: "Run lint command", detail: command, kind: "shell.exec" }, action);
  }
  return true;
}

export const lintTool: Tool = {
  name: "lint",
  description:
    "Compiler-grade diagnostics for a file: runs the language-server path and returns only severity error lines (warnings omitted).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to lint." },
    },
    required: ["path"],
  },
  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
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

      const hz = loadConfig(process.env, defaultConfigPath(process.env.HOME));
      const userLint = resolveLintCommand(resolved, hz.lint);
      if (userLint !== undefined) {
        const cmd = substituteLintFile(userLint.command, resolved);
        if (!(await admitUserLintCommand(cmd, ctx))) {
          return fail("HZ_PRECONDITION_FAILED: user lint shell command was denied or declined");
        }
        const ran = await runUserLintCommand(cmd, ctx.cwd, ctx.signal);
        const parsed = parseLintOutputLines(ran.stdout);
        const errors = parsed.filter((row) => /error/i.test(row.message) || ran.exitCode !== 0);
        const output = formatLintFindings(rel, errors.length > 0 ? errors : parsed);
        const receipt: ReceiptInput = {
          action: "lint.check",
          tool: "lint",
          argsDigest: sha256Hex(canonicalJson({ path: rel, userLint: true })),
          resultDigest: sha256Hex(output),
        };
        try {
          await ctx.receipt(receipt);
        } catch {
          /* best-effort */
        }
        return { ok: true, output };
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

      if (result === undefined) {
        return { ok: true, output: `no language server configured for ${rel} — lint unavailable` };
      }

      const errors = compilerErrorsOnly(result.messages);
      const output =
        errors.length === 0
          ? `${rel}: no compiler errors`
          : `${rel} (${result.server}): ${errors.length} compiler error(s)\n${errors.join("\n")}`;

      const receipt: ReceiptInput = {
        action: "lint.check",
        tool: "lint",
        argsDigest: sha256Hex(canonicalJson({ path: rel })),
        resultDigest: sha256Hex(output),
      };
      try {
        await ctx.receipt(receipt);
      } catch {
        /* receipt failure must not sink a read-only lint result */
      }

      return { ok: true, output };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
