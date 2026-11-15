/**
 * `memory_search` — BM25 recall over workspace memory facts (docs/33 §5.4 partial).
 */

import type { Tool, ToolContext, ToolResult } from "../contracts";
import { parseMemoryBankId, PROJECT_BANK, type MemoryBankId } from "../core/memory/banks";
import { memorySearchHits, sharedMemorySearch } from "../core/memory/store";

function fail(message: string): ToolResult {
  return { ok: false, output: message, error: message };
}

function parseBanksArg(raw: unknown): MemoryBankId[] | "shared_recall" | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "shared" || trimmed === "shared_recall" || trimmed === "all") return "shared_recall";
    const one = parseMemoryBankId(trimmed);
    return one === undefined ? undefined : [one];
  }
  if (Array.isArray(raw)) {
    const out: MemoryBankId[] = [];
    for (const item of raw) {
      if (typeof item !== "string") return undefined;
      const bank = parseMemoryBankId(item);
      if (bank === undefined) return undefined;
      if (!out.includes(bank)) out.push(bank);
    }
    return out.length === 0 ? undefined : out;
  }
  return undefined;
}

export const memorySearchTool: Tool = {
  name: "memory_search",
  description:
    "Search user-curated memory (FTS BM25). Default bank is project (MEMORY.md under .hz/). Use scope shared_recall to search project, user, and shared banks with bank labels on hits.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Terms to search for in remembered facts." },
      scope: {
        type: "string",
        description:
          "Search scope: project (default), user, shared, or shared_recall / all (cross-bank recall with bank id on each hit).",
        enum: ["project", "user", "shared", "shared_recall", "all"],
      },
      banks: {
        type: "array",
        items: { type: "string", enum: ["project", "user", "shared"] },
        description: "Optional explicit bank list (overrides scope when set).",
      },
      limit: {
        type: "integer",
        description: "Max hits (default 8; shared_recall enables BM25 MMR-lite diversify by default).",
        minimum: 1,
        maximum: 32,
      },
      diversify: {
        type: "boolean",
        description: "When true, rerank BM25 hits with lexical MMR-lite (default true for shared_recall / all).",
      },
    },
    required: ["query"],
  },
  concurrencyClass: "shared",
  exposure: "deferred",
  searchInfo: { keywords: ["memory", "recall", "remember", "MEMORY.md", "facts", "banks", "shared"] },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") return fail("query is required");

    const banksArg = parseBanksArg(args.banks);
    const scopeRaw = typeof args.scope === "string" ? args.scope.trim().toLowerCase() : "";
    const limitRaw = args.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw)
        ? Math.min(32, Math.max(1, Math.floor(limitRaw)))
        : undefined;
    const diversifyArg = args.diversify;
    const diversifyExplicit = typeof diversifyArg === "boolean" ? diversifyArg : undefined;

    const sharedScope = banksArg === "shared_recall" || scopeRaw === "shared_recall" || scopeRaw === "all";

    let hits;
    if (sharedScope) {
      hits = sharedMemorySearch(ctx.workspace, query, limit ?? 8);
    } else if (Array.isArray(banksArg)) {
      const diversify =
        diversifyExplicit ?? (banksArg.length > 1 ? true : false);
      hits = memorySearchHits(ctx.workspace, query, {
        banks: banksArg,
        limit,
        diversify,
      });
    } else if (scopeRaw === "user" || scopeRaw === "shared") {
      const bank = parseMemoryBankId(scopeRaw);
      if (bank === undefined) return fail(`invalid scope: ${scopeRaw}`);
      hits = memorySearchHits(ctx.workspace, query, {
        banks: [bank],
        limit,
        diversify: diversifyExplicit,
      });
    } else {
      hits = memorySearchHits(ctx.workspace, query, {
        banks: [PROJECT_BANK],
        limit,
        diversify: diversifyExplicit,
      });
    }

    if (hits.length === 0) return { ok: true, output: "no memory hits" };
    const crossBank =
      banksArg === "shared_recall" ||
      scopeRaw === "shared_recall" ||
      scopeRaw === "all" ||
      (Array.isArray(banksArg) && banksArg.length > 1);
    const body = hits
      .map((h, i) => {
        const prefix = crossBank || hits.some((x) => x.bank !== h.bank) ? `[${h.bank}] ` : "";
        return `${i + 1}. ${prefix}${h.content}`;
      })
      .join("\n");
    return { ok: true, output: body };
  },
};
