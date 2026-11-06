/** HorizonCode tool registry: the tools the model may call. */

import type { Tool, ToolSpec } from "../contracts";
import { agentTool } from "./agent";
import { codemodeTool } from "./codemode";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { previewTool } from "./preview";
import { readTool } from "./read";
import { shellTool } from "./shell";
import { todoTool } from "./todo";
import { writeTool } from "./write";

export const tools: Tool[] = [readTool, writeTool, editTool, grepTool, globTool, shellTool, todoTool, agentTool, codemodeTool, previewTool];

/** The seven base tools; the delegation tool is deliberately excluded here. */
export const BASE_TOOL_NAMES = ["read", "write", "edit", "grep", "glob", "shell", "todo"] as const;

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

export function toolSpecs(): ToolSpec[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
