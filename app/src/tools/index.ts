/** HorizonCode tool registry: the tools the model may call. */

import type { Tool, ToolExposure, ToolSpec } from "../contracts";
// Dynamic tools (MCP, docs/09 §4.7) live in their own registry; the static list
// is the builtins. One lookup order for the whole loop (getTool/toolSpecs).
import { getMcpTool, mcpToolSpecs } from "../core/mcp/registry";
import { agentTool } from "./agent";
import { applyPatchTool } from "./apply-patch";
import { astEditTool } from "./ast-edit";
import { astSearchTool } from "./ast-search";
import { codemodeTool } from "./codemode";
import { debugTool } from "./debug";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { interactiveExecTool } from "./interactive-exec";
import { lspTool } from "./lsp";
import { memorySearchTool } from "./memory-search";
import { previewTool } from "./preview";
import { readTool } from "./read";
import { repoMapTool } from "./repo-map";
import { shellTool } from "./shell";
import { todoTool } from "./todo";
import { toolSearchTool } from "./tool-search";
import { undoTool } from "./undo";
import { writeTool } from "./write";

export const tools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  undoTool,
  grepTool,
  globTool,
  repoMapTool,
  shellTool,
  todoTool,
  agentTool,
  codemodeTool,
  previewTool,
  applyPatchTool,
  interactiveExecTool,
  lspTool,
  debugTool,
  memorySearchTool,
  toolSearchTool,
  astSearchTool,
  astEditTool,
];

/** The seven base tools; the delegation tool is deliberately excluded here. */
export const BASE_TOOL_NAMES = ["read", "write", "edit", "grep", "glob", "shell", "todo"] as const;

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name) ?? getMcpTool(name);
}

/**
 * A tool's exposure class (research §1.6). Absent === "direct", mirroring the
 * `concurrencyClass` default. The spec builder gates on this; dispatch does not.
 */
export function exposureOf(tool: Tool): ToolExposure {
  return tool.exposure ?? "direct";
}

/* ----------------------- per-session tool discovery ----------------------- */
// Deferred tools are absent from the default specs until a session discovers
// them via `tool_search`. The registry is an in-process Map keyed by sessionId,
// mirroring the in-memory session maps used elsewhere (e.g. change-journal).

const discoveredBySession = new Map<string, Set<string>>();

/** Record that `names` (deferred tool names) are unlocked for `sessionId`. */
export function discoverDeferredTools(sessionId: string, names: string[]): void {
  let set = discoveredBySession.get(sessionId);
  if (set === undefined) {
    set = new Set<string>();
    discoveredBySession.set(sessionId, set);
  }
  for (const name of names) set.add(name);
}

/** Has `sessionId` discovered the deferred tool `name`? */
export function isDiscovered(sessionId: string | undefined, name: string): boolean {
  if (sessionId === undefined) return false;
  return discoveredBySession.get(sessionId)?.has(name) ?? false;
}

/** Drop a session's discovery state when the session ends (long-lived `serve`). */
export function clearDiscoveredTools(sessionId: string): void {
  discoveredBySession.delete(sessionId);
}

/** Test-only: clear the per-session discovery registry between cases. */
export function __resetToolDiscoveryForTests(): void {
  discoveredBySession.clear();
}

/**
 * The deferred tools' discovery surface for `tool_search` to match over.
 * Data-driven: no per-tool-id logic — any Deferred tool with a searchInfo is a
 * candidate. `description` comes from the tool itself; keywords from searchInfo.
 */
export function deferredSearchCandidates(): { name: string; description: string; keywords: string[] }[] {
  return tools
    .filter((t) => exposureOf(t) === "deferred")
    .map((t) => ({ name: t.name, description: t.description, keywords: t.searchInfo?.keywords ?? [] }));
}

/**
 * Specs the model sees. By default this is every Direct tool (absent exposure
 * === Direct, so all shipped-Direct tools are unchanged) plus MCP specs. A
 * Deferred tool joins the list only once the given session has discovered it
 * via `tool_search`. Hidden, undiscovered-Deferred, and CodeModeOnly tools are
 * never in the default specs.
 */
export function toolSpecs(sessionId?: string): ToolSpec[] {
  return [
    ...tools
      .filter((t) => {
        const exposure = exposureOf(t);
        if (exposure === "direct") return true;
        if (exposure === "deferred") return isDiscovered(sessionId, t.name);
        return false; // hidden, code_mode_only
      })
      .map(({ name, description, parameters }) => ({ name, description, parameters })),
    ...mcpToolSpecs(),
  ];
}
