/** HorizonCode tool registry: the tools the model may call. */

import type { Tool, ToolSpec } from "../contracts";
// Dynamic tools (MCP, docs/09 §4.7) live in their own registry; the static list
// is the builtins. One lookup order for the whole loop (getTool/toolSpecs).
import { getMcpTool, mcpToolSpecs } from "../core/mcp/registry";
import { agentTool } from "./agent";
import { astEditTool } from "./ast-edit";
import { astSearchTool } from "./ast-search";
import { codemodeTool } from "./codemode";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { previewTool } from "./preview";
import { readTool } from "./read";
import { repoMapTool } from "./repo-map";
import { shellTool } from "./shell";
import { todoTool } from "./todo";
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
  astSearchTool,
  astEditTool,
];

/** The seven base tools; the delegation tool is deliberately excluded here. */
export const BASE_TOOL_NAMES = ["read", "write", "edit", "grep", "glob", "shell", "todo"] as const;

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name) ?? getMcpTool(name);
}

export function toolSpecs(): ToolSpec[] {
  return [
    ...tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ...mcpToolSpecs(),
  ];
}
