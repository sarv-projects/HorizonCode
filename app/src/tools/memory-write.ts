/**
 * `memory_remember` / `memory_forget` — mnemopi-style FTS bank writes (docs/30 §8 #4 ADAPT).
 */

import * as path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { PROJECT_BANK, parseMemoryBankId, type MemoryBankId } from "../core/memory/banks";
import {
  MEMORY_FILE,
  appendRememberedFactToMemoryIndex,
} from "../core/memory/manifest";
import { stateRoot } from "../core/paths";
import { MEMORY_FACT_MAX_CHARS, memoryDbPathForBank } from "../core/memory/store";
import { forgetMemoryFacts, rememberMemoryFact } from "../core/memory/store";

function fail(message: string): ToolResult {
  return { ok: false, output: message, error: message };
}

/** Guard `fs.write` on the bank DB before SQLite mutation (ruling 554). */
async function admitMemoryBankDbWrite(
  ctx: ToolContext,
  bank: MemoryBankId,
  title: string,
): Promise<string | undefined> {
  const target = memoryDbPathForBank(ctx.workspace, bank);
  const action: GuardAction = { kind: "fs.write", target };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const approved = await ctx.approve({ title, detail: target, kind: "fs.write" }, action);
    if (!approved) return "declined by user";
  }
  return undefined;
}

function parseBankArg(raw: unknown): MemoryBankId | undefined {
  if (raw === undefined || raw === null) return PROJECT_BANK;
  if (typeof raw !== "string") return undefined;
  const bank = parseMemoryBankId(raw.trim());
  return bank;
}

export const memoryRememberTool: Tool = {
  name: "memory_remember",
  description:
    `Store a fact in a memory bank (FTS index). Default bank is project (.hz/state/memory.db). user and shared banks live in the user config dir. With HZ_MEMORY_SYNC_MEMORY_MD=1, project remembers also append a capped bullet to MEMORY.md. Max ${MEMORY_FACT_MAX_CHARS} chars.`,
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Fact text to retain for later recall." },
      bank: { type: "string", enum: ["project", "user", "shared"], description: "Target bank (default project)." },
    },
    required: ["content"],
  },
  concurrencyClass: "exclusive",
  exposure: "deferred",
  searchInfo: { keywords: ["memory", "remember", "recall", "fact", "bank", "mnemopi"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const content = typeof args.content === "string" ? args.content : "";
    const bank = parseBankArg(args.bank);
    if (bank === undefined) return fail("invalid bank");
    if (content.trim() === "") return fail("content is required");
    if (content.length > MEMORY_FACT_MAX_CHARS) {
      return fail(`content exceeds ${MEMORY_FACT_MAX_CHARS} chars`);
    }
    // Admit bank DB (+ optional MEMORY.md) before any mutation (ruling 554).
    const deniedDb = await admitMemoryBankDbWrite(ctx, bank, "Remember memory fact");
    if (deniedDb) return fail(deniedDb);
    const syncMemoryMd = bank === PROJECT_BANK && process.env.HZ_MEMORY_SYNC_MEMORY_MD === "1";
    if (syncMemoryMd) {
      const target = path.join(stateRoot(ctx.workspace), MEMORY_FILE);
      const action: GuardAction = { kind: "fs.write", target };
      const decision = await ctx.guard(action);
      if (decision.decision === "deny") {
        return fail(`denied by policy${decision.reason ? `: ${decision.reason}` : ""}`);
      }
      if (decision.decision === "ask") {
        const approved = await ctx.approve(
          { title: "Update MEMORY.md index", detail: target, kind: "fs.write" },
          action,
        );
        if (!approved) return fail("declined by user");
      }
    }
    const result = rememberMemoryFact(ctx.workspace, content, bank);
    if (result.ok === false) {
      if (result.reason === "empty") return fail("content is required");
      if (result.reason === "too_long") return fail(`content exceeds ${MEMORY_FACT_MAX_CHARS} chars`);
      return { ok: true, output: `no change (duplicate fact in bank ${bank})` };
    }
    const memoryIndex = syncMemoryMd
      ? appendRememberedFactToMemoryIndex(ctx.workspace, content)
      : "skipped";
    const indexNote =
      memoryIndex === "appended"
        ? " (MEMORY.md index updated)"
        : memoryIndex === "duplicate"
          ? " (MEMORY.md already listed)"
          : "";
    return { ok: true, output: `remembered in bank ${result.bank}${indexNote}` };
  },
};

export const memoryForgetTool: Tool = {
  name: "memory_forget",
  description:
    "Remove facts from a memory bank. Provide exact content and/or a BM25 query (same token rules as memory_search). At least one of content or query is required.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Exact fact text to delete." },
      query: { type: "string", description: "Search terms; deletes up to limit matching facts." },
      bank: { type: "string", enum: ["project", "user", "shared"] },
      limit: { type: "number", description: "Max rows removed when using query (default 8)." },
    },
  },
  concurrencyClass: "exclusive",
  exposure: "deferred",
  searchInfo: { keywords: ["memory", "forget", "delete", "recall", "bank"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const bank = parseBankArg(args.bank) ?? PROJECT_BANK;
    if (args.bank !== undefined && parseBankArg(args.bank) === undefined) return fail("invalid bank");
    const content = typeof args.content === "string" ? args.content : undefined;
    const query = typeof args.query === "string" ? args.query : undefined;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
    if ((content === undefined || content.trim() === "") && (query === undefined || query.trim() === "")) {
      return fail("content or query is required");
    }
    const deniedDb = await admitMemoryBankDbWrite(ctx, bank, "Forget memory facts");
    if (deniedDb) return fail(deniedDb);
    const { deleted, removed } = forgetMemoryFacts(ctx.workspace, { bank, content, query, limit });
    if (deleted === 0) return { ok: true, output: `no matching facts in bank ${bank}` };
    const preview = removed.map((r) => `- ${r.slice(0, 120)}${r.length > 120 ? "…" : ""}`).join("\n");
    return { ok: true, output: `forgot ${deleted} fact(s) in bank ${bank}:\n${preview}` };
  },
};
