/**
 * Prompt assembly: static sections first, then the environment block.
 * For the main agent the loop passes project instruction files and the
 * per-model block (../instructions.ts) as `memory`, so the order on the wire is
 * static prefix -> project memory -> per-model -> environment -> rails. The
 * volatile environment (date, plan mode, visible tools) sits AFTER the memory
 * so toggling /plan or discovering a deferred tool does not change the bytes
 * in front of the instruction files. A subagent's prompt (`buildChildPrompt`)
 * keeps static -> environment -> memory; its environment is fixed for its life.
 */
import os from "node:os";
import { BASE_PROMPT_SECTIONS, CHILD_PROMPT_SECTIONS, type PromptSection } from "./sections";
import { detectShell, insideGitRepo, renderEnvironment, type EnvironmentInfo } from "./environment";

export { BASE_PROMPT_SECTIONS, CHILD_PROMPT_SECTIONS, renderEnvironment, insideGitRepo, detectShell };
export type { PromptSection, EnvironmentInfo };

export type PromptEnvironmentOverrides = Partial<Omit<EnvironmentInfo, "workspace" | "today">>;

function join(sections: readonly PromptSection[]): string {
  return sections.map((section) => section.text).join("\n\n");
}

/** The static, cache-stable prefix. */
export function staticPrompt(): string {
  return join(BASE_PROMPT_SECTIONS);
}

function environmentFor(workspace: string, today: Date, over: PromptEnvironmentOverrides | undefined): EnvironmentInfo {
  return {
    workspace,
    today,
    os: over?.os ?? `${process.platform} ${os.arch()}`,
    shell: over?.shell ?? detectShell(),
    isGitRepo: over?.isGitRepo ?? insideGitRepo(workspace),
    kernelMode: over?.kernelMode ?? "untrusted",
    planMode: over?.planMode ?? false,
    tools: over?.tools ?? [],
  };
}

export function buildSystemPrompt(
  workspace: string,
  today: Date = new Date(),
  over?: PromptEnvironmentOverrides,
  memory = "",
): string {
  return `${staticPrompt()}${memory}\n\n${renderEnvironment(environmentFor(workspace, today, over))}`;
}

/** The subagent body without the environment (kept as the exported constant). */
export function staticChildPrompt(): string {
  return join(CHILD_PROMPT_SECTIONS);
}

export function buildChildPrompt(workspace: string, today: Date = new Date(), over?: PromptEnvironmentOverrides): string {
  return `${staticChildPrompt()}\n\n${renderEnvironment(environmentFor(workspace, today, over))}`;
}
