/** HorizonCode tool registry: the tools the model may call. */

import type { Tool, ToolContext, ToolExposure, ToolResult, ToolSpec } from "../contracts";
import {
  PermissionCorrectedError,
  PermissionDeclinedError,
  isPermissionCorrectedError,
  isPermissionDeclinedError,
  mapToolErrorKeepingDecline,
  mapToolErrorKeepingDeclineAsync,
  tunnelDecline,
  tunnelPermissionError,
} from "../core/guards/defect-tunnel";
// Dynamic tools (MCP, docs/09 §4.7) live in their own registry; the static list
// is the builtins. One lookup order for the whole loop (getTool/toolSpecs).
import { getMcpTool, mcpToolSpecs } from "../core/mcp/registry";
import { askUserTool } from "./ask-user";
import { agentTool } from "./agent";
import { bestOfNTool } from "./best-of-n";
import { applyPatchTool } from "./apply-patch";
import { astEditTool } from "./ast-edit";
import { astSearchTool } from "./ast-search";
import { codemodeTool } from "./codemode";
import { debugTool } from "./debug";
import { editTool } from "./edit";
import { gitBlameTool, gitDiffTool, gitLogTool, gitStatusTool } from "./git-read";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { interactiveExecTool } from "./interactive-exec";
import { lintTool } from "./lint";
import { lspTool } from "./lsp";
import { handoffCreateTool, handoffResumeTool, handoffSearchTool } from "./handoff";
import { memoryForgetTool, memoryRememberTool } from "./memory-write";
import { memorySearchTool } from "./memory-search";
import { presentTool } from "./present";
import { previewTool } from "./preview";
import { readTool } from "./read";
import { repoMapTool } from "./repo-map";
import { shellBgTool } from "./shell-bg";
import { shellTool } from "./shell";
import { todoTool, todoWriteTool } from "./todo";
import { toolSearchTool } from "./tool-search";
import { undoTool } from "./undo";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";
import { ctxInspectTool } from "./ctx-inspect";
import { historySnipPreviewTool } from "./history-snip-preview";
import { codeModeVmTool } from "./code-mode-vm";
import { diffToolLoadout, type ToolLoadoutDelta } from "../core/tool-loadout-delta";

export const tools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  undoTool,
  grepTool,
  globTool,
  repoMapTool,
  presentTool,
  askUserTool,
  shellTool,
  shellBgTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBlameTool,
  todoTool,
  todoWriteTool,
  agentTool,
  bestOfNTool,
  codemodeTool,
  previewTool,
  applyPatchTool,
  interactiveExecTool,
  lspTool,
  lintTool,
  debugTool,
  memorySearchTool,
  memoryRememberTool,
  memoryForgetTool,
  handoffCreateTool,
  handoffResumeTool,
  handoffSearchTool,
  toolSearchTool,
  astSearchTool,
  astEditTool,
  webFetchTool,
  webSearchTool,
  ctxInspectTool,
  historySnipPreviewTool,
  codeModeVmTool,
];

/** The seven base tools; the delegation tool is deliberately excluded here. */
export const BASE_TOOL_NAMES = ["read", "write", "edit", "grep", "glob", "shell", "todo"] as const;

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name) ?? getMcpTool(name);
}

export {
  PermissionCorrectedError,
  PermissionDeclinedError,
  isPermissionCorrectedError,
  isPermissionDeclinedError,
  mapToolErrorKeepingDecline,
  mapToolErrorKeepingDeclineAsync,
  tunnelDecline,
  tunnelPermissionError,
};

/**
 * Wrap a tool's `execute` method with a permission defect tunnel guard so any
 * `PermissionDeclinedError` (and optionally `PermissionCorrectedError`) thrown
 * during execution is always re-thrown and never swallowed into a generic tool
 * error string by an outer `catch` wrapper.
 */
export function wrapToolWithDefectTunnel(
  tool: Tool,
  onOrdinaryError?: (err: unknown) => ToolResult,
): Tool {
  return {
    ...tool,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      try {
        return await tool.execute(args, ctx);
      } catch (err) {
        tunnelPermissionError(err);
        if (onOrdinaryError !== undefined) return onOrdinaryError(err);
        throw err;
      }
    },
  };
}

/**
 * Execute a tool through the permission defect tunnel. Plain user declines
 * (`PermissionDeclinedError`) and structured steering rejections
 * (`PermissionCorrectedError`) always propagate cleanly to the outer loop
 * boundary; ordinary errors are mapped via `onOrdinaryError` when provided.
 */
export async function executeToolWithDefectTunnel(
  tool: Pick<Tool, "execute">,
  args: Record<string, unknown>,
  ctx: ToolContext,
  onOrdinaryError?: (err: unknown) => ToolResult,
): Promise<ToolResult> {
  try {
    return await tool.execute(args, ctx);
  } catch (err) {
    tunnelPermissionError(err);
    if (onOrdinaryError !== undefined) return onOrdinaryError(err);
    throw err;
  }
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

const MAX_DISCOVERY_SESSIONS = 256;
const discoveredBySession = new Map<string, Set<string>>();
const frozenSpecsBySession = new Map<string, readonly ToolSpec[]>();

/**
 * Record that `names` (deferred tool names) are unlocked for `sessionId`.
 * ADDITIVE (Group B): returns the toolsAdded/toolsRemoved delta so callers can
 * emit a prefix-safe system delta; callers ignoring the return are unaffected.
 */
export function discoverDeferredTools(sessionId: string, names: string[]): ToolLoadoutDelta {
  let set = discoveredBySession.get(sessionId);
  if (set === undefined) {
    if (discoveredBySession.size >= MAX_DISCOVERY_SESSIONS) {
      const oldest = discoveredBySession.keys().next().value;
      if (oldest !== undefined) {
        discoveredBySession.delete(oldest);
        frozenSpecsBySession.delete(oldest);
      }
    }
    set = new Set<string>();
    discoveredBySession.set(sessionId, set);
  }
  const before = [...set];
  for (const name of names) set.add(name);
  return diffToolLoadout(before, [...set]);
}

/** Has `sessionId` discovered the deferred tool `name`? */
export function isDiscovered(sessionId: string | undefined, name: string): boolean {
  if (sessionId === undefined) return false;
  return discoveredBySession.get(sessionId)?.has(name) ?? false;
}

/** Drop a session's discovery state when the session ends (long-lived `serve`). */
export function clearDiscoveredTools(sessionId: string): void {
  discoveredBySession.delete(sessionId);
  frozenSpecsBySession.delete(sessionId);
}

/** Test-only: clear the per-session discovery registry between cases. */
export function __resetToolDiscoveryForTests(): void {
  discoveredBySession.clear();
  frozenSpecsBySession.clear();
}

/** Threshold above which MCP tools are automatically deferred unless HZ_MCP_DEFER_TOOLS=0. */
export const MCP_DEFER_THRESHOLD = 10;

/**
 * True when undiscovered MCP tools should be omitted from the initial turn's
 * `tools[]` array (preserving prompt-cache prefix stability on large MCP catalogs).
 * - `HZ_MCP_DEFER_TOOLS=0` forces eager inclusion (all MCP tools in `tools[]`).
 * - `HZ_MCP_DEFER_TOOLS=1` forces deferred discovery via `tool_search`.
 * - Otherwise auto-defers when `mcpSpecs.length > 10`, keeping small MCP suites
 *   100% backwards compatible.
 */
export function shouldDeferMcpTools(
  mcpSpecs: readonly ToolSpec[] = mcpToolSpecs(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.HZ_MCP_DEFER_TOOLS?.trim();
  if (flag === "0") return false;
  if (flag === "1") return true;
  return mcpSpecs.length > MCP_DEFER_THRESHOLD;
}

/**
 * The deferred tools' discovery surface for `tool_search` to match over.
 * Data-driven: includes every Deferred builtin plus every registered MCP tool
 * (`mcpToolSpecs()`) so `tool_search` can discover MCP tools on demand.
 */
export function deferredSearchCandidates(): { name: string; description: string; keywords: string[] }[] {
  const builtinDeferred = tools
    .filter((t) => exposureOf(t) === "deferred")
    .map((t) => ({ name: t.name, description: t.description, keywords: t.searchInfo?.keywords ?? [] }));
  const mcpCandidates = mcpToolSpecs().map((spec) => {
    const rest = spec.name.startsWith("mcp__") ? spec.name.slice("mcp__".length) : spec.name;
    const sep = rest.indexOf("__");
    const serverId = sep > 0 ? rest.slice(0, sep) : "";
    const toolName = sep > 0 ? rest.slice(sep + 2) : rest;
    const keywords = ["mcp", ...(serverId ? [serverId] : []), ...(toolName ? [toolName] : [])];
    return { name: spec.name, description: spec.description, keywords };
  });
  return [...builtinDeferred, ...mcpCandidates];
}

function sortToolSpecs(specs: readonly ToolSpec[]): ToolSpec[] {
  return [...specs].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Exact prompt-cache prefix freeze: returns a deterministic static `tools[]`
 * prefix (Direct builtins in registry order + sorted static MCP specs) frozen
 * at session start so mid-session `tool_search` discoveries never mutate
 * `tools[]` and bust provider KV cache.
 */
export function frozenToolSpecs(sessionId?: string): ToolSpec[] {
  if (sessionId !== undefined) {
    const cached = frozenSpecsBySession.get(sessionId);
    if (cached !== undefined) return [...cached];
  }
  const direct = tools
    .filter((t) => exposureOf(t) === "direct")
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  const mcp = mcpToolSpecs();
  const staticMcp = shouldDeferMcpTools(mcp) ? [] : sortToolSpecs(mcp);
  const frozen: ToolSpec[] = [...direct, ...staticMcp];
  if (sessionId !== undefined) {
    if (frozenSpecsBySession.size >= MAX_DISCOVERY_SESSIONS) {
      const oldest = frozenSpecsBySession.keys().next().value;
      if (oldest !== undefined) frozenSpecsBySession.delete(oldest);
    }
    frozenSpecsBySession.set(sessionId, frozen);
  }
  return [...frozen];
}

/**
 * Specs the model sees. By default this is every Direct tool (in deterministic
 * registry order) plus MCP specs. When `HZ_FREEZE_TOOL_PREFIX=1`, the initial
 * static prefix is frozen per session and deferred/MCP schemas are delivered
 * via `tool_search` output / tail deltas instead of mutating `tools[]` mid-session.
 */
export function toolSpecs(sessionId?: string): ToolSpec[] {
  if (process.env.HZ_FREEZE_TOOL_PREFIX === "1") {
    return frozenToolSpecs(sessionId);
  }
  const mcp = mcpToolSpecs();
  const deferMcp = shouldDeferMcpTools(mcp);
  const direct = tools
    .filter((t) => exposureOf(t) === "direct")
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  const eagerMcp = deferMcp ? [] : sortToolSpecs(mcp);
  const discoveredBuiltin = tools
    .filter((t) => exposureOf(t) === "deferred" && isDiscovered(sessionId, t.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  const discoveredMcp = deferMcp
    ? sortToolSpecs(mcp.filter((s) => isDiscovered(sessionId, s.name)))
    : [];
  return [...direct, ...eagerMcp, ...discoveredBuiltin, ...discoveredMcp];
}
