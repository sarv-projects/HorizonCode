/**
 * mcp-list-pagination.test.ts — MCP `tools/list` cursor passthrough.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  McpClient,
  McpProtocolError,
  parseToolsList,
} from "../../src/core/mcp/client";
import {
  listAllMcpResources,
  listAllMcpTools,
  mcpListRequestParams,
  parseMcpListNextCursor,
  MCP_LIST_MAX_PAGES,
} from "../../src/core/mcp/registry";
import { parseResourcesList } from "../../src/core/mcp/client";
import { clearMcpTools, getMcpTool, mcpToolSpecs, registerMcpTools } from "../../src/core/mcp/registry";
import { kernelStateDir } from "../../src/core/owned-spawn";
import { cleanupTemps, tempDir } from "./helpers";

const BUN = process.execPath || "bun";
const PAGED_FIXTURE = path.resolve(import.meta.dir, "../fixtures/mcp-paged-server.ts");
const PAGED_RESOURCES_FIXTURE = path.resolve(import.meta.dir, "../fixtures/mcp-paged-resources-server.ts");

beforeEach(() => {
  clearMcpTools();
});

afterAll(() => {
  cleanupTemps();
});

describe("mcp list pagination helpers", () => {
  test("mcpListRequestParams passes cursor only when non-empty", () => {
    expect(mcpListRequestParams()).toEqual({});
    expect(mcpListRequestParams("")).toEqual({});
    expect(mcpListRequestParams("  ")).toEqual({});
    expect(mcpListRequestParams("tok-1")).toEqual({ cursor: "tok-1" });
    expect(mcpListRequestParams("  tok-2  ")).toEqual({ cursor: "tok-2" });
  });

  test("parseMcpListNextCursor reads nextCursor from a list object", () => {
    expect(parseMcpListNextCursor({ tools: [], nextCursor: "a" })).toBe("a");
    expect(parseMcpListNextCursor({ resources: [], nextCursor: "b" })).toBe("b");
    expect(parseMcpListNextCursor({ tools: [] })).toBeUndefined();
    expect(parseMcpListNextCursor(null)).toBeUndefined();
    expect(parseMcpListNextCursor({ nextCursor: 1 })).toBeUndefined();
    expect(parseMcpListNextCursor({ nextCursor: "  " })).toBeUndefined();
  });

  test("listAllMcpTools merges pages until nextCursor is absent", async () => {
    const pages = [
      { tools: [{ name: "one", inputSchema: { type: "object" } }], nextCursor: "p1" },
      { tools: [{ name: "two", inputSchema: { type: "object" } }], nextCursor: "p2" },
      { tools: [{ name: "three", inputSchema: { type: "object" } }] },
    ];
    const seen: Array<string | undefined> = [];
    const tools = await listAllMcpTools(async (cursor) => {
      seen.push(cursor);
      const index = cursor === undefined ? 0 : cursor === "p1" ? 1 : 2;
      return pages[index];
    }, "fake");
    expect(seen).toEqual([undefined, "p1", "p2"]);
    expect(tools.map((t) => t.name)).toEqual(["one", "two", "three"]);
  });

  test("listAllMcpResources merges pages until nextCursor is absent", async () => {
    const pages = [
      { resources: [{ uri: "u1", name: "one" }], nextCursor: "p1" },
      { resources: [{ uri: "u2", name: "two" }], nextCursor: "p2" },
      { resources: [{ uri: "u3", name: "three" }] },
    ];
    const seen: Array<string | undefined> = [];
    const resources = await listAllMcpResources(async (cursor) => {
      seen.push(cursor);
      const index = cursor === undefined ? 0 : cursor === "p1" ? 1 : 2;
      return pages[index];
    }, "fake");
    expect(seen).toEqual([undefined, "p1", "p2"]);
    expect(resources.map((r) => r.uri)).toEqual(["u1", "u2", "u3"]);
  });

  test("listAllMcpTools fails closed when max pages exceeded", async () => {
    const caught = await listAllMcpTools(
      async () => ({ tools: [{ name: "loop", inputSchema: { type: "object" } }], nextCursor: "again" }),
      "fake",
      { maxPages: 2 },
    ).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(McpProtocolError);
    expect((caught as Error).message).toContain("exceeded 2 page");
  });

  test("MCP_LIST_MAX_PAGES default is pinned", () => {
    expect(MCP_LIST_MAX_PAGES).toBe(64);
  });

  test("parseResourcesList validates a single page", () => {
    const resources = parseResourcesList(
      { resources: [{ uri: "file:///x", name: "doc", mimeType: "text/plain" }] },
      "srv",
    );
    expect(resources[0]?.uri).toBe("file:///x");
    expect(resources[0]?.name).toBe("doc");
  });

  test("parseToolsList still validates a single page", () => {
    const tools = parseToolsList(
      { tools: [{ name: "x", annotations: { readOnlyHint: true } }] },
      "srv",
    );
    expect(tools[0]?.name).toBe("x");
    expect(tools[0]?.readOnlyHint).toBe(true);
  });
});

describe("mcp client resources/list pagination (stdio)", () => {
  test("listResources follows nextCursor across pages", async () => {
    const workspace = tempDir("hz-mcp-res-paged-");
    const stateDir = kernelStateDir(workspace);
    const client = new McpClient({
      serverId: "res-paged",
      command: BUN,
      args: ["run", PAGED_RESOURCES_FIXTURE],
      stateDir,
    });
    try {
      await client.connect();
      const resources = await client.listResources();
      expect(resources.map((r) => r.name)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
    } finally {
      await client.stop();
    }
  });
});

describe("mcp client tools/list pagination (stdio)", () => {
  test("handshake follows nextCursor across pages", async () => {
    const workspace = tempDir("hz-mcp-paged-");
    const stateDir = kernelStateDir(workspace);
    const client = new McpClient({
      serverId: "paged",
      command: BUN,
      args: ["run", PAGED_FIXTURE],
      stateDir,
      onTools: (id, tools) => registerMcpTools(id, tools, client),
    });
    try {
      const tools = await client.connect();
      expect(tools.map((t) => t.name)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
      expect(mcpToolSpecs().map((s) => s.name)).toEqual([
        "mcp__paged__alpha",
        "mcp__paged__beta",
        "mcp__paged__gamma",
        "mcp__paged__delta",
        "mcp__paged__epsilon",
      ]);
      const alpha = getMcpTool("mcp__paged__alpha");
      expect(alpha).toBeDefined();
    } finally {
      await client.stop();
    }
  });
});
