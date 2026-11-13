/**
 * `--show-prompts` (docs/30 I-1; doc 14 prompt inspection): build the same
 * ProviderRequest the loop would send on the next dispatch, with a synthetic
 * user turn, and print it — no provider call.
 */

import type { ChatMsg, ProviderRequest, ToolSpec } from "../contracts";
import { toolSpecs } from "../tools";
import { loadCatalog, catalogWindow } from "./catalog/catalog";
import { loadConfig, type HzConfig } from "./config";
import { instructionPrompt, loadInstructionBlocks, resolveModelInstructions } from "./instructions";
import { memoryPromptSection } from "./memory/manifest";
import { estimatePromptTokens, fitMaxOutputTokens, windowForModel } from "./output-budget";
import { systemPrompt } from "./loop";
import { resolveToolRoutingConfig } from "../tools/model-tool-routing";

const SHOW_PROMPTS_USER = "Hello!";

export interface ShowPromptsOptions {
  workspace: string;
  config?: HzConfig;
  model?: string;
  mock?: boolean;
  kernelMode?: "trusted" | "untrusted";
  planMode?: boolean;
}

function projectInstructionRail(workspace: string, model: string, provider: string): string {
  const loaded = loadInstructionBlocks(workspace);
  const projectBlocks = instructionPrompt(loaded.blocks, loaded.report);
  const perModel = resolveModelInstructions({
    model,
    provider,
    warn: () => {},
  });
  const mem = memoryPromptSection(workspace, SHOW_PROMPTS_USER);
  let base = perModel === "" ? projectBlocks : `${projectBlocks}\n\n${perModel}\n`;
  if (mem !== undefined) base = `${base}\n\n${mem}\n`;
  return base;
}

/**
 * Assemble the provider request for preview. Tool list follows routing for
 * `config`'s resolved provider + model (same as `runTurn` after routing merge).
 */
export function buildShowPromptsRequest(opts: ShowPromptsOptions): ProviderRequest {
  const workspace = opts.workspace;
  const config = opts.config ?? loadConfig();
  const model = opts.model?.trim() !== "" ? opts.model!.trim() : config.model;
  const providerName = config.resolved?.name ?? config.provider ?? "mock";
  const routing = resolveToolRoutingConfig({ model, provider: providerName });
  const toolFilter = routing.toToolFilter(undefined);
  const specs: ToolSpec[] = toolSpecs(undefined)
    .filter((spec) => toolFilter === undefined || toolFilter(spec.name))
    .map((spec) => spec);

  const instructions = projectInstructionRail(workspace, model, providerName);
  const kernelMode = opts.kernelMode ?? "untrusted";
  const basePrompt = systemPrompt(
    workspace,
    new Date(),
    {
      tools: specs.map((s) => s.name),
      kernelMode,
      planMode: opts.planMode === true,
    },
    instructions,
  );

  const history: ChatMsg[] = [{ role: "user", content: SHOW_PROMPTS_USER }];
  const catalog = loadCatalog();
  const contextWindow = catalogWindow(providerName, model, catalog) ?? windowForModel(model);
  const inputEstimate = estimatePromptTokens(basePrompt, history, JSON.stringify(specs));
  const maxTokens = fitMaxOutputTokens(inputEstimate, contextWindow);

  return {
    model,
    system: basePrompt,
    maxTokens,
    messages: history,
    tools: specs,
    signal: new AbortController().signal,
  };
}

/** Pretty-printed JSON for stdout (`--show-prompts`). */
export function renderShowPrompts(request: ProviderRequest): string {
  const payload = {
    model: request.model,
    maxTokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
