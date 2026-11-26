/**
 * verified-selection.test.ts — Wave 2 / Track 2B verification suite:
 * - Verified Selection Edit Interface (`applyVerifiedSelectionEdits` + `editTool`)
 * - Post-Edit LSP Diagnostics Hook (`HZ_POST_EDIT_LSP`, bounded 10 items, 500ms timeout)
 * - Stateless MCP 2026-07-28 (`Mcp-Method`, `Mcp-Name`, `ttlMs`/`cacheScope`, alphabetical catalog)
 * - `input_examples` JSDoc `@example` emission & sanitization (`codemode-mcp-fs`, `codemode-stubs`)
 * - `LazyResource<T>` / `createLazyBoot` concurrency deduplication, `dispose()`, timeout
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLazyBoot, LazyBootTimeoutError } from "../../src/core/lazy-boot";
import {
  buildStatelessMcpHeaders,
  clearMcpTools,
  MCP_HEADER_METHOD,
  MCP_HEADER_NAME,
  MCP_HEADER_PROTOCOL_VERSION,
  MCP_STATELESS_PROTOCOL_VERSION,
  McpStatelessHttpClient,
  mcpToolSpecs,
  parseMcpCacheMetadata,
  registerMcpTools,
  sortMcpToolCatalog,
} from "../../src/core/mcp";
import { parseToolsList } from "../../src/core/mcp/client";
import { materializeMcpServerTree, type ToolSpecWithExamples } from "../../src/tools/codemode-mcp-fs";
import { buildCodemodeStub } from "../../src/tools/codemode-stubs";
import {
  collectPostEditLspDiagnostics,
  editTool,
  formatPostEditLspDiagnostics,
  POST_EDIT_LSP_ENV,
} from "../../src/tools/edit";
import { applyVerifiedSelectionEdits } from "../../src/tools/verified-selection";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearMcpTools();
  delete process.env[POST_EDIT_LSP_ENV];
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("Verified Selection Edit Interface", () => {
  test("applies exact verified selection edit and preserves trailing newline & CRLF", () => {
    const src = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const res = applyVerifiedSelectionEdits(src, [
      {
        start_line: 2,
        end_line: 2,
        first_line: "const b = 2;",
        last_line: "const b = 2;",
        new_text: "const b = 20;",
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
    expect(res.applied[0]?.shift).toBe(0);

    // CRLF preservation
    const crlfSrc = "line1\r\nline2\r\nline3\r\n";
    const crlfRes = applyVerifiedSelectionEdits(crlfSrc, [
      {
        start_line: 2,
        end_line: 2,
        first_line: "line2",
        last_line: "line2",
        new_text: "line2a\nline2b",
      },
    ]);
    expect(crlfRes.ok).toBe(true);
    if (crlfRes.ok) {
      expect(crlfRes.content).toBe("line1\r\nline2a\r\nline2b\r\nline3\r\n");
    }
  });

  test("absorbs ±3 line shift ONLY when both first_line and last_line agree uniquely", () => {
    const src = [
      "// header 1",
      "// header 2",
      "function greet() {",
      "  return 'hi';",
      "}",
      "// footer",
    ].join("\n") + "\n";

    // Shifted by +2 lines (model thought lines 1..3, actual is lines 3..5)
    const shifted = applyVerifiedSelectionEdits(src, [
      {
        start_line: 1,
        end_line: 3,
        first_line: "function greet() {",
        last_line: "}",
        new_text: "function greet() {\n  return 'hello';\n}",
      },
    ]);
    expect(shifted.ok).toBe(true);
    if (!shifted.ok) return;
    expect(shifted.applied[0]).toMatchObject({
      originalStartLine: 1,
      originalEndLine: 3,
      resolvedStartLine: 3,
      resolvedEndLine: 5,
      shift: 2,
    });
    expect(shifted.content).toContain("return 'hello';");

    // Shift of +4 exceeds ±3 limit -> fail closed
    const tooFar = applyVerifiedSelectionEdits(
      ["//1", "//2", "//3", "//4", "start", "end"].join("\n") + "\n",
      [
        {
          start_line: 1,
          end_line: 2,
          first_line: "start",
          last_line: "end",
          new_text: "replaced",
        },
      ],
    );
    expect(tooFar.ok).toBe(false);

    // Ambiguous shift (identical block at +1 and +3) -> fail closed
    const ambigSrc = [
      "other",
      "dupA",
      "dupB",
      "dupA",
      "dupB",
    ].join("\n") + "\n";
    const ambig = applyVerifiedSelectionEdits(ambigSrc, [
      {
        start_line: 1,
        end_line: 2,
        first_line: "dupA",
        last_line: "dupB",
        new_text: "fixed",
      },
    ]);
    expect(ambig.ok).toBe(false);
    if (!ambig.ok) {
      expect(ambig.error).toMatch(/ambiguous/i);
    }
  });

  test("fails closed on boundary quote mismatch and writes nothing via editTool", async () => {
    const ws = makeWorkspace({ "a.ts": "alpha\nbeta\ngamma\n" });
    const ctx = mockToolContext({ cwd: ws });
    const res = await editTool.execute(
      {
        path: "a.ts",
        edits: [
          {
            start_line: 1,
            end_line: 2,
            first_line: "alpha",
            last_line: "WRONG_LAST_LINE",
            new_text: "mutated",
          },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boundary mismatch/i);
    expect(readFixture(ws, "a.ts")).toBe("alpha\nbeta\ngamma\n");
  });

  test("expands @@refA-B@@ copy markers from pre-edit snapshot and rejects out-of-range refs", () => {
    const src = ["line1", "line2", "line3", "line4", "line5"].join("\n") + "\n";
    const res = applyVerifiedSelectionEdits(src, [
      {
        start_line: 4,
        end_line: 5,
        first_line: "line4",
        last_line: "line5",
        new_text: "// copied:\n@@ref1-2@@\n// end",
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.applied[0]?.refExpansions).toBe(1);
    expect(res.content).toBe(["line1", "line2", "line3", "// copied:", "line1", "line2", "// end"].join("\n") + "\n");

    // Out-of-range ref fails closed
    const badRef = applyVerifiedSelectionEdits(src, [
      {
        start_line: 1,
        end_line: 1,
        first_line: "line1",
        last_line: "line1",
        new_text: "@@ref1-99@@",
      },
    ]);
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) {
      expect(badRef.error).toMatch(/out-of-range/i);
    }

    // Inverted ref fails closed
    const invertedRef = applyVerifiedSelectionEdits(src, [
      {
        start_line: 1,
        end_line: 1,
        first_line: "line1",
        last_line: "line1",
        new_text: "@@ref4-2@@",
      },
    ]);
    expect(invertedRef.ok).toBe(false);
  });

  test("applies multiple non-overlapping edits bottom-up and rejects overlapping ranges", async () => {
    const src = ["one", "two", "three", "four", "five", "six"].join("\n") + "\n";
    // First edit expands lines 1..2 into 4 lines; second edit replaces lines 5..6.
    // Bottom-up application ensures line 5..6 isn't displaced by lines 1..2 growing.
    const multi = applyVerifiedSelectionEdits(src, [
      {
        start_line: 1,
        end_line: 2,
        first_line: "one",
        last_line: "two",
        new_text: "ONE_A\nONE_B\nTWO_A\nTWO_B",
      },
      {
        start_line: 5,
        end_line: 6,
        first_line: "five",
        last_line: "six",
        new_text: "FIVE_SIX\n@@ref1-1@@",
      },
    ]);
    expect(multi.ok).toBe(true);
    if (!multi.ok) return;
    expect(multi.content).toBe(
      ["ONE_A", "ONE_B", "TWO_A", "TWO_B", "three", "four", "FIVE_SIX", "one"].join("\n") + "\n",
    );

    // Overlapping ranges fail closed
    const overlap = applyVerifiedSelectionEdits(src, [
      {
        start_line: 2,
        end_line: 4,
        first_line: "two",
        last_line: "four",
        new_text: "x",
      },
      {
        start_line: 4,
        end_line: 5,
        first_line: "four",
        last_line: "five",
        new_text: "y",
      },
    ]);
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) {
      expect(overlap.error).toMatch(/overlapping/i);
    }

    // End-to-end through editTool.execute
    const ws = makeWorkspace({ "multi.ts": src });
    const ctx = mockToolContext({ cwd: ws });
    const toolRes = await editTool.execute(
      {
        path: "multi.ts",
        edits: [
          { start_line: 1, end_line: 1, first_line: "one", last_line: "one", new_text: "FIRST" },
          { start_line: 6, end_line: 6, first_line: "six", last_line: "six", new_text: "LAST" },
        ],
      },
      ctx,
    );
    expect(toolRes.ok).toBe(true);
    expect(toolRes.output).toContain("Applied 2 verified-selection edit(s)");
    expect(readFixture(ws, "multi.ts")).toBe(["FIRST", "two", "three", "four", "five", "LAST"].join("\n") + "\n");
  });
});

describe("Post-Edit LSP Diagnostics Hook", () => {
  test("appends bounded diagnostics (max 10) after successful edit and respects HZ_POST_EDIT_LSP=0", async () => {
    const ws = makeWorkspace({ "app.ts": "const x: number = 1;\n" });
    const ctx = mockToolContext({ cwd: ws });
    const diags = Array.from({ length: 13 }, (_, i) => ({
      file: "app.ts",
      line: i + 1,
      col: 3,
      severity: i % 2 === 0 ? "error" : "warning",
      message: `problem ${i + 1}`,
    }));
    (ctx as unknown as { lsp: { diagnostics: () => Promise<typeof diags> } }).lsp = {
      diagnostics: async () => diags,
    };

    const res = await editTool.execute(
      { path: "app.ts", old: "const x: number = 1;", new: "const x: number = 'bad';" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("<lsp-diagnostics>");
    expect(res.output).toContain("app.ts:1:3 [error] problem 1");
    expect(res.output).toContain("app.ts:10:3 [warning] problem 10");
    expect(res.output).not.toContain("problem 11");
    expect(res.output).toContain("... (+3 more)");

    // Opt-out via HZ_POST_EDIT_LSP=0
    process.env[POST_EDIT_LSP_ENV] = "0";
    const disabledRes = await editTool.execute(
      { path: "app.ts", old: "'bad'", new: "42" },
      ctx,
    );
    expect(disabledRes.ok).toBe(true);
    expect(disabledRes.output).not.toContain("<lsp-diagnostics>");
  });

  test("degrades silently on timeout, provider error, or missing LSP", async () => {
    const ws = makeWorkspace({ "slow.ts": "const a = 1;\n" });
    const ctx = mockToolContext({ cwd: ws });

    // No LSP attached -> silent no-op
    expect(await collectPostEditLspDiagnostics(ctx, path.join(ws, "slow.ts"), "slow.ts")).toBe("");

    // Slow LSP exceeding timeout -> silent no-op
    (ctx as unknown as { lsp: { diagnostics: () => Promise<unknown[]> } }).lsp = {
      diagnostics: () => new Promise((resolve) => setTimeout(() => resolve([{ line: 1, message: "late" }]), 200)),
    };
    const timedOut = await collectPostEditLspDiagnostics(ctx, path.join(ws, "slow.ts"), "slow.ts", {
      timeoutMs: 20,
    });
    expect(timedOut).toBe("");

    // Throwing LSP -> silent no-op
    (ctx as unknown as { lsp: { diagnostics: () => Promise<never> } }).lsp = {
      diagnostics: async () => {
        throw new Error("lsp crashed");
      },
    };
    expect(await collectPostEditLspDiagnostics(ctx, path.join(ws, "slow.ts"), "slow.ts")).toBe("");

    // Formatting sanity check for numeric severity
    const formatted = formatPostEditLspDiagnostics([{ line: 4, column: 9, severity: 1, message: "syntax error" }], "x.ts");
    expect(formatted).toContain("x.ts:4:9 [error] syntax error");
  });
});

describe("Stateless MCP 2026-07-28 & Deterministic Catalog Sorting", () => {
  test("builds Mcp-Method, Mcp-Name, and MCP-Protocol-Version headers and parses ttlMs/cacheScope", async () => {
    const headers = buildStatelessMcpHeaders({ method: "tools/call", name: "list_issues" });
    expect(headers[MCP_HEADER_PROTOCOL_VERSION]).toBe(MCP_STATELESS_PROTOCOL_VERSION);
    expect(headers[MCP_HEADER_METHOD]).toBe("tools/call");
    expect(headers[MCP_HEADER_NAME]).toBe("list_issues");

    // Metadata parsing from payload and headers
    expect(parseMcpCacheMetadata({ _meta: { ttlMs: 15000, cacheScope: "workspace" } })).toEqual({
      ttlMs: 15000,
      cacheScope: "workspace",
    });
    expect(
      parseMcpCacheMetadata(
        {},
        new Headers({ "Cache-Control": "public, max-age=60", "X-Mcp-Cache-Scope": "global" }),
      ),
    ).toEqual({
      ttlMs: 60000,
      cacheScope: "global",
    });

    // End-to-end stateless HTTP client with mocked fetch
    const seenHeaders: Array<Record<string, string>> = [];
    const mockFetch: typeof fetch = (async (_url, init) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              _meta: { ttlMs: 30000, cacheScope: "session" },
              tools: [
                { name: "z_tool", description: "Z", inputSchema: { type: "object", properties: {} } },
                { name: "a_tool", description: "A", inputSchema: { type: "object", properties: {} } },
                { name: "m_tool", description: "M", inputSchema: { type: "object", properties: {} } },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "ok-stateless" }],
            isError: false,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Mcp-Ttl-Ms": "5000",
            "X-Mcp-Cache-Scope": "workspace",
          },
        },
      );
    }) as typeof fetch;

    const client = new McpStatelessHttpClient({
      serverId: "remote",
      endpointUrl: "https://mcp.example.test/rpc",
      fetchImpl: mockFetch,
    });
    const listRes = await client.listTools();
    expect(listRes.tools.map((t) => t.name)).toEqual(["a_tool", "m_tool", "z_tool"]);
    expect(listRes.cacheMeta).toEqual({ ttlMs: 30000, cacheScope: "session" });
    expect(seenHeaders[0]?.[MCP_HEADER_METHOD]).toBe("tools/list");
    expect(seenHeaders[0]?.[MCP_HEADER_PROTOCOL_VERSION]).toBe("2026-07-28");

    const callRes = await client.callTool("a_tool", { q: "test" });
    expect(callRes.text).toBe("ok-stateless");
    expect(callRes.cacheMeta).toEqual({ ttlMs: 5000, cacheScope: "workspace" });
    expect(seenHeaders[1]?.[MCP_HEADER_METHOD]).toBe("tools/call");
    expect(seenHeaders[1]?.[MCP_HEADER_NAME]).toBe("a_tool");
  });

  test("parses input_examples/ttlMs/cacheScope and sorts catalogs deterministically via sortMcpToolCatalog & mcpToolSpecs", () => {
    const parsed = parseToolsList(
      {
        tools: [
          { name: "zebra", description: "z" },
          { name: "alpha", description: "a", input_examples: [{ q: "hi" }], ttlMs: 1000, cacheScope: "session" },
          { name: "middle", description: "m" },
        ],
      },
      "srv",
    );
    const sorted = sortMcpToolCatalog(parsed);
    expect(sorted.map((t) => t.name)).toEqual(["alpha", "middle", "zebra"]);
    expect(sorted[0]?.input_examples).toEqual([{ q: "hi" }]);
    expect(sorted[0]?.ttlMs).toBe(1000);
    expect(sorted[0]?.cacheScope).toBe("session");

    registerMcpTools("srv-b", [{ name: "z_op" }, { name: "a_op" }]);
    registerMcpTools("srv-a", [{ name: "b_op" }]);
    expect(mcpToolSpecs({ sorted: true }).map((s) => s.name)).toEqual([
      "mcp__srv-a__b_op",
      "mcp__srv-b__a_op",
      "mcp__srv-b__z_op",
    ]);
  });
});

describe("Code Mode input_examples JSDoc Emission & Sanitization", () => {
  test("emits sanitized @example blocks in servers/<server>/<tool>.ts and codemode-stubs", () => {
    const root = makeTempDir("hz-examples-");
    const tag = "\u{E0001}\u{E0041}\u{E007F}";
    const bidi = "\u202E";
    const specs: ToolSpecWithExamples[] = [
      {
        name: "mcp__github__search_code",
        description: "Search code in repos",
        parameters: {
          type: "object",
          required: ["query"],
          properties: { query: { type: "string" }, limit: { type: "number" } },
        },
        input_examples: [
          { query: `auth */ injected ${tag}${bidi} token`, limit: 5 },
        ],
      },
      {
        name: "mcp__jira__get_issue",
        description: "Fetch a Jira issue",
        parameters: {
          type: "object",
          required: ["issueKey", "includeComments"],
          properties: {
            issueKey: { type: "string" },
            includeComments: { type: "boolean" },
          },
        },
      },
    ];

    const tree = materializeMcpServerTree(root, specs);
    const ghStub = readFileSync(path.join(tree.serversDir, "github", "search_code.ts"), "utf8");
    expect(ghStub).toContain("* @example");
    expect(ghStub).toContain("await search_code(");
    expect(ghStub).toContain("*\\/");
    expect(ghStub).not.toContain("\u{E0001}");
    expect(ghStub).not.toContain("\u202E");

    // Synthesized minimal example from required fields when input_examples is absent
    const jiraStub = readFileSync(path.join(tree.serversDir, "jira", "get_issue.ts"), "utf8");
    expect(jiraStub).toContain("* @example");
    expect(jiraStub).toContain('await get_issue({"issueKey":"<issueKey>","includeComments":false});');

    // codemode-stubs buildCodemodeStub also emits sanitized @example
    const dtsStub = buildCodemodeStub(specs[0]!);
    expect(dtsStub.dts).toContain("* @example");
    expect(dtsStub.dts).toContain("*\\/");
    expect(dtsStub.dts).not.toContain("\u{E0001}");
  });
});

describe("LazyResource / createLazyBoot", () => {
  test("pays zero boot overhead until first get() and deduplicates concurrent get() calls", async () => {
    let initCalls = 0;
    let disposedValues: string[] = [];
    const resource = createLazyBoot({
      name: "mcp-sandbox",
      init: async () => {
        initCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return `instance-${initCalls}`;
      },
      dispose: async (val) => {
        disposedValues.push(val);
      },
    });

    expect(initCalls).toBe(0);
    expect(resource.isInitialized()).toBe(false);
    expect(resource.peek()).toBeUndefined();

    // 5 concurrent callers must trigger init() exactly once
    const results = await Promise.all([
      resource.get(),
      resource.get(),
      resource.get(),
      resource.get(),
      resource.get(),
    ]);
    expect(initCalls).toBe(1);
    expect(results).toEqual(["instance-1", "instance-1", "instance-1", "instance-1", "instance-1"]);
    expect(resource.isInitialized()).toBe(true);
    expect(resource.peek()).toBe("instance-1");

    await resource.dispose();
    expect(resource.isInitialized()).toBe(false);
    expect(resource.peek()).toBeUndefined();
    expect(disposedValues).toEqual(["instance-1"]);

    // Subsequent get() re-initializes cleanly
    expect(await resource.get()).toBe("instance-2");
    expect(initCalls).toBe(2);
  });

  test("enforces optional timeout and recovers cleanly after failure", async () => {
    let attempts = 0;
    const flaky = createLazyBoot({
      name: "slow-boot",
      timeoutMs: 25,
      init: async () => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise((r) => setTimeout(r, 120));
          return "too-late";
        }
        return "ready";
      },
    });

    await expect(flaky.get()).rejects.toBeInstanceOf(LazyBootTimeoutError);
    expect(flaky.isInitialized()).toBe(false);
    expect(await flaky.get()).toBe("ready");
    expect(flaky.isInitialized()).toBe(true);
  });
});
