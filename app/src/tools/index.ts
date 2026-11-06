/** HorizonCode tool registry: the tools the model may call. */

import type { Tool, ToolSpec } from "../contracts";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { shellTool } from "./shell";
import { todoTool } from "./todo";
import { writeTool } from "./write";

export const tools: Tool[] = [readTool, writeTool, editTool, grepTool, globTool, shellTool, todoTool];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}

export function toolSpecs(): ToolSpec[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
