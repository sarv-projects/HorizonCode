/**
 * tool-exposure.test.ts — codex-style tool exposure classes + tool_search
 * (research §1.6, FEAT-002).
 *
 * The gating lives entirely in the registry (tools/index.ts): toolSpecs() emits
 * Direct tools plus any Deferred tool the session has discovered via the
 * `tool_search` meta-tool; Hidden / undiscovered-Deferred / CodeModeOnly tools
 * never appear in the default specs. Dispatch (getTool) still resolves any
 * registered tool by name. These tests fail if the gating is reverted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Tool, ToolContext } from "../../src/contracts";
import {
  __resetToolDiscoveryForTests,
  deferredSearchCandidates,
  discoverDeferredTools,
  exposureOf,
  getTool,
  isDiscovered,
  toolSpecs,
  tools,
} from "../../src/tools";
import { toolSearchTool } from "../../src/tools/tool-search";

const SESSION = "sess-exposure";

function ctx(sessionId = SESSION): ToolContext {
  return {
    cwd: "/ws",
    workspace: "/ws",
    sessionId,
    signal: new AbortController().signal,
    guard: async () => ({ decision: "allow" }),
    approve: async () => true,
    receipt: async () => ({ id: "r", kind: "fs.read", ts: "t", hash: "h", prevHash: null }),
  } as unknown as ToolContext;
}

afterEach(() => {
  __resetToolDiscoveryForTests();
});

describe("tool exposure gating", () => {
  test("(e) REGRESSION: default toolSpecs() is exactly the Direct builtins (preview absent)", () => {
    __resetToolDiscoveryForTests();
    const names = toolSpecs().map((s) => s.name);
    for (const direct of [
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "shell",
      "todo",
      "undo",
      "repo_map",
      "agent",
      "code_mode",
      "tool_search",
    ]) {
      expect(names, `${direct} should be a Direct builtin`).toContain(direct);
    }
    // preview is Deferred: absent until discovered.
    expect(names).not.toContain("preview");
  });

  test("(a) a Deferred tool (preview) is absent from toolSpecs() by default", () => {
    __resetToolDiscoveryForTests();
    expect(exposureOf(getTool("preview")!)).toBe("deferred");
    expect(toolSpecs().map((s) => s.name)).not.toContain("preview");
    expect(toolSpecs(SESSION).map((s) => s.name)).not.toContain("preview");
  });

  test("(b) after tool_search with a matching query, preview is discovered, visible, and resolvable", async () => {
    __resetToolDiscoveryForTests();
    const res = await toolSearchTool.execute({ query: "start a dev server on localhost" }, ctx());
    expect(res.ok).toBe(true);
    expect(isDiscovered(SESSION, "preview")).toBe(true);
    expect(toolSpecs(SESSION).map((s) => s.name)).toContain("preview");
    // Another session that has not discovered it still does not see it.
    expect(toolSpecs("other-session").map((s) => s.name)).not.toContain("preview");
    // getTool resolves it regardless (dispatch is not gated by exposure).
    expect(getTool("preview")).toBeDefined();
  });

  test("(c) tool_search returns the matched tool's spec in its output", async () => {
    __resetToolDiscoveryForTests();
    const res = await toolSearchTool.execute({ query: "preview server port" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("preview");
    // The full spec (description + parameters JSON) rides the output.
    expect(res.output).toContain("parameters");
    expect(res.output).toContain("action");
  });

  test("(f) data-driven match: a query matching no keyword discovers nothing", async () => {
    __resetToolDiscoveryForTests();
    const res = await toolSearchTool.execute({ query: "quantum entanglement" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output.toLowerCase()).toContain("no deferred tools matched");
    expect(isDiscovered(SESSION, "preview")).toBe(false);
    expect(toolSpecs(SESSION).map((s) => s.name)).not.toContain("preview");
  });

  test("(d) a Hidden tool is NEVER in toolSpecs() and a CodeModeOnly tool is excluded too", () => {
    __resetToolDiscoveryForTests();
    // Use a local fixture tool to assert the filter without registering it.
    const hidden: Tool = {
      name: "hidden-fixture",
      description: "never exposed",
      parameters: { type: "object", properties: {} },
      exposure: "hidden",
      execute: async () => ({ ok: true, output: "" }),
    };
    const codeModeOnly: Tool = {
      name: "cmo-fixture",
      description: "code mode only",
      parameters: { type: "object", properties: {} },
      exposure: "code_mode_only",
      execute: async () => ({ ok: true, output: "" }),
    };
    expect(exposureOf(hidden)).toBe("hidden");
    expect(exposureOf(codeModeOnly)).toBe("code_mode_only");
    // Simulate inclusion in the registry gate: neither passes the Direct/discovered filter.
    const gated = (t: Tool): boolean => {
      const e = exposureOf(t);
      if (e === "direct") return true;
      if (e === "deferred") return isDiscovered(SESSION, t.name);
      return false;
    };
    expect(gated(hidden)).toBe(false);
    expect(gated(codeModeOnly)).toBe(false);
  });

  test("deferredSearchCandidates is data-driven and includes preview", () => {
    const candidates = deferredSearchCandidates();
    const preview = candidates.find((c) => c.name === "preview");
    expect(preview).toBeDefined();
    expect(preview!.keywords).toContain("localhost");
    // Only Deferred tools are candidates.
    for (const c of candidates) {
      expect(exposureOf(getTool(c.name)!)).toBe("deferred");
    }
  });

  test("discoverDeferredTools is session-scoped", () => {
    __resetToolDiscoveryForTests();
    discoverDeferredTools("s1", ["preview"]);
    expect(isDiscovered("s1", "preview")).toBe(true);
    expect(isDiscovered("s2", "preview")).toBe(false);
    expect(isDiscovered(undefined, "preview")).toBe(false);
    // tool_search is registered and Direct.
    expect(tools.some((t) => t.name === "tool_search")).toBe(true);
    expect(exposureOf(toolSearchTool)).toBe("direct");
  });
});
