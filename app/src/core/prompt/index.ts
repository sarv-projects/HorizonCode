/**
 * Prompt assembly: static sections first, then the environment block.
 * Project instruction files and per-model blocks (../instructions.ts) are
 * appended after this by the loop, so the order on the wire is
 * static prefix -> environment -> project memory -> per-model -> rails.
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

export function buildSystemPrompt(workspace: string, today: Date = new Date(), over?: PromptEnvironmentOverrides): string {
  return `${staticPrompt()}\n\n${renderEnvironment(environmentFor(workspace, today, over))}`;
}

/** The subagent body without the environment (kept as the exported constant). */
export function staticChildPrompt(): string {
  return join(CHILD_PROMPT_SECTIONS);
}

export function buildChildPrompt(workspace: string, today: Date = new Date(), over?: PromptEnvironmentOverrides): string {
  return `${staticChildPrompt()}\n\n${renderEnvironment(environmentFor(workspace, today, over))}`;
}
