/**
 * `ast_edit` — structural replace in one file (Tier-3).
 *
 * This mirrors edit.ts's write discipline EXACTLY, because a structural rewrite
 * is strictly more dangerous than an exact-string edit: it RECONSTRUCTS the
 * regions it changes from a pattern the model may never have inspected. So:
 *
 *   1. GuardAction {kind:'fs.write', target:resolved} via ctx.guard; deny fails.
 *   2. Read the preimage (reject binary; file-not-found -> fail), sha256 it.
 *   3. Require wasRead(ctx, resolved) before trusting the rewrite — the same
 *      read-before-write gate edit.ts puts on its fuzzy rungs (audit finding 2).
 *   4. Compute the rewrite with ast-match.rewriteMatches; count 0 -> fail, no write.
 *   5. On decision 'ask', ctx.approve({kind:'fs.write'}); declined -> fail.
 *   6. Re-read immediately before writing and compare the sha256 to the preimage;
 *      any drift -> HZ_PRECONDITION_FAILED and nothing is written.
 *   7. writeAtomic (atomic-write.ts) -> verify on-disk bytes -> recordChange +
 *      noteRead.
 *
 * The receipt is issued by the loop (core/loop.ts) per tool call, NOT here.
 */

import { readFile } from "node:fs/promises";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { sha256Hex } from "../core/canon";
import { rewriteMatches } from "./ast-match";
import { isRefused, writeAtomic } from "./atomic-write";
import { recordChange } from "./change-journal";
import { isBinary, relPath, resolvePath } from "./helpers";
import { noteRead, wasRead } from "./read-ledger";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const astEditTool: Tool = {
  name: "ast_edit",
  description:
    "Structural replace in one file: match a pattern with metavariables ($NAME / $$$NAME) and substitute them into a replacement template. " +
    "Every occurrence is replaced. Goes through the write guard and the preimage safety check, like edit.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit (a single file)." },
      pat: { type: "string", description: "Structural pattern to match, e.g. 'foo($A)'." },
      out: { type: "string", description: "Replacement template; $NAME / $$$NAME expand to captured text." },
      lang: { type: "string", description: "Optional language hint (reserved; the built-in matcher is language-agnostic)." },
    },
    required: ["path", "pat", "out"],
  },

  // NF-072: a mutating tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.path !== "string" || args.path === "") return fail("path is required");
      if (typeof args.pat !== "string" || args.pat === "") return fail("pat is required");
      if (typeof args.out !== "string") return fail("out is required");

      const pat = args.pat;
      const out = args.out;
      const resolved = resolvePath(ctx.cwd, args.path);
      const rel = relPath(ctx.cwd, resolved);

      const action: GuardAction = { kind: "fs.write", target: resolved };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }

      let before: string;
      let preimageSha256: string;
      try {
        const buf = await readFile(resolved);
        if (isBinary(buf)) return fail(`binary file (contains a NUL byte): ${rel}`);
        before = buf.toString("utf8");
        preimageSha256 = sha256Hex(before); // the preimage this call read
      } catch {
        return fail(`file not found: ${rel}`);
      }

      // Read-before-write (audit finding 2), as in edit.ts: a structural rewrite
      // reconstructs regions the model may not have inspected, so the session
      // must have READ the file before it can be trusted to rewrite it.
      if (!wasRead(ctx, resolved)) {
        return fail(
          `HZ_PRECONDITION_FAILED: ast_edit refused: this session has not read ${rel} — ` +
            `a structural rewrite reconstructs regions the model may not have inspected; read ${rel} and edit again`,
        );
      }

      const rewrite = rewriteMatches(before, pat, out);
      if (rewrite.count === 0) {
        return fail(`no structural match for the pattern in ${rel} (nothing written)`);
      }
      const after = rewrite.text;

      if (decision.decision === "ask") {
        const approved = await ctx.approve(
          {
            title: `AST edit ${rel}`,
            detail: `${rewrite.count} replacement(s)`,
            kind: "fs.write",
          },
          action,
        );
        if (!approved) return fail("declined by user");
      }

      // Preimage check immediately before the write: a file changed during the
      // guard/approval window is a conflict, and nothing is written (docs/09 §8.2).
      let actualSha256: string;
      try {
        actualSha256 = sha256Hex((await readFile(resolved)).toString("utf8"));
      } catch {
        actualSha256 = "unreadable";
      }
      if (actualSha256 !== preimageSha256) {
        return fail(
          `HZ_PRECONDITION_FAILED: ast_edit refused: preimage changed: ${rel} ` +
            `(expected sha256 ${preimageSha256}; actual sha256 ${actualSha256}; changedBy unknown)`,
        );
      }

      const outcome = await writeAtomic(resolved, after, ctx);
      if (isRefused(outcome)) return fail(outcome.refusal);
      const verified = (await readFile(resolved)).toString("utf8") === after;
      if (!verified) return fail(`verification failed: ${rel} does not match the intended content`);

      recordChange(ctx.sessionId, {
        path: resolved,
        rel,
        before,
        afterSha256: sha256Hex(after),
        at: Date.now(),
        tool: "edit",
      });
      noteRead(ctx, resolved);

      return { ok: true, output: `Replaced ${rewrite.count} structural match(es) in ${rel}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
