/**
 * fullscreen-slash.ts — run builtin slash handlers on the alt-screen loop (ruling 240).
 */

import { homedir } from "node:os";
import type { Runtime } from "../contracts";
import { defaultConfigPath, loadConfig, persistNotifyConfig } from "../core/config";
import { resolveCommandForMessage } from "../core/commands";
import { formatModelsNotice } from "./models-slash";
import { modelsForProvider } from "../core/catalog/list-models";
import {
  readPermissionMode,
  runConvoCommand,
  runMemoryCommand,
  runModeCommand,
  runPlanCommand,
  runThemeCommand,
  showTools,
  type PlanCommandState,
  type RuntimeWithExtras,
} from "./interactive";
import { runAutonomyCommand } from "./autonomy-slash";
import { runNotifyCommand } from "./notify";
import { isFullscreenLocalSlash, parseSlashInput } from "./slash-dispatch";
import type { Renderer } from "./render";
import { printSlashHelp } from "./slash-help";
import { formatIdleStatusLine, readGitBranch, type StatusInfo } from "./live";
import { buildUnknownInspectLines, runUnknownCommand } from "./unknown-slash";
import { parseUnknownSlashArgs } from "./unknown-slash-parse";
import { dim, errorMessage, sanitizeText, strip, terminalWidth } from "./style";
import { modeBadge } from "../core/permission-mode";
import { shortenPath } from "./banner";
import { runWorktreeSlash } from "./worktree-slash";
import { runSnapshotSlash } from "./snapshot-slash";

export interface FullscreenSlashContext {
  runtime: Runtime;
  renderer: Renderer;
  workspace: string;
  write: (text: string) => void;
  planState: PlanCommandState;
  unknownCount?: number;
  unknownReceiptId?: string;
  /** When set, `/unknown inspect` paints a fullscreen inspector overlay instead of transcript lines. */
  showReceiptInspector?: (lines: readonly string[]) => Promise<void>;
}

function showContext(renderer: Renderer, runtime: Runtime): void {
  const usage = (runtime as RuntimeWithExtras).contextUsage?.();
  if (!usage) {
    renderer.notice("no context snapshot yet — send a message first, then ask again");
    return;
  }
  const percent = usage.window > 0 ? Math.round((usage.estimatedInput / usage.window) * 100) : 0;
  renderer.notice(
    `context · model ${usage.model} · window ${usage.window} tok · estimated input ${usage.estimatedInput} tok (${percent}%) · output cap ${usage.maxOutput} tok · ${usage.messages}/${usage.historyLimit} messages in view`,
  );
}

function slashStatusInfo(ctx: FullscreenSlashContext): StatusInfo {
  const rt = ctx.runtime as RuntimeWithExtras;
  const badge = ctx.planState.on ? "PLAN" : modeBadge(readPermissionMode(ctx.runtime));
  const unknownCount = ctx.unknownCount ?? 0;
  return {
    badge,
    model: ctx.runtime.model,
    provider: rt.providerName ?? "unknown",
    path: shortenPath(ctx.workspace),
    branch: readGitBranch(ctx.workspace),
    unknownCount: unknownCount > 0 ? unknownCount : undefined,
    unknownReceiptId: unknownCount === 1 ? ctx.unknownReceiptId : undefined,
  };
}

function showStatus(renderer: Renderer, ctx: FullscreenSlashContext): void {
  const line = strip(formatIdleStatusLine(slashStatusInfo(ctx), terminalWidth() - 1, { plain: true }));
  renderer.notice(line);
}

function showModels(renderer: Renderer, runtime: Runtime): void {
  const rt = runtime as RuntimeWithExtras;
  const provider = rt.providerName ?? "unknown";
  const list = modelsForProvider(provider, rt.config ?? {});
  renderer.notice(formatModelsNotice(provider, list));
}

/**
 * Try to handle a slash line locally. Returns true when consumed (no model turn).
 * Custom `.hz/commands` templates return false so the caller can expand/send.
 */
export async function tryRunFullscreenLocalSlash(
  text: string,
  ctx: FullscreenSlashContext,
): Promise<boolean> {
  const parsed = parseSlashInput(text);
  if (parsed === null) return false;
  const { name, arg } = parsed;
  if (name === "") return false;
  if (!isFullscreenLocalSlash(name)) return false;
  if (resolveCommandForMessage(ctx.workspace, parsed.raw)) return false;

  const { runtime, renderer, workspace, write, planState } = ctx;

  try {
    switch (name) {
      case "help":
      case "?":
        printSlashHelp(renderer, workspace);
        return true;
      case "theme":
        runThemeCommand(arg, renderer);
        return true;
      case "notify": {
        const home = process.env.HOME?.trim() || homedir();
        const cfg = loadConfig(process.env, defaultConfigPath(home), workspace);
        runNotifyCommand(arg, renderer, cfg.notify, (prefs) => persistNotifyConfig(prefs, home));
        return true;
      }
      case "mode":
        runModeCommand(arg, runtime, renderer);
        planState.on = readPlanModeFromRuntime(runtime);
        return true;
      case "autonomy":
        runAutonomyCommand(arg, runtime, renderer, () => readPermissionMode(runtime));
        planState.on = readPlanModeFromRuntime(runtime);
        return true;
      case "plan":
      case "changes":
      case "apply":
      case "discard":
        await runPlanCommand(name, arg, runtime, renderer, planState);
        return true;
      case "think": {
        const textThinking = renderer.lastThinking?.() ?? "";
        if (textThinking.trim() === "") {
          renderer.notice("no reasoning block yet, only models that stream their thinking have one");
          return true;
        }
        for (const l of sanitizeText(textThinking).trimEnd().split("\n")) renderer.line(dim("\u2503 " + l));
        return true;
      }
      case "files":
        showTools(renderer, runtime);
        return true;
      case "context":
        showContext(renderer, runtime);
        return true;
      case "status":
        showStatus(renderer, ctx);
        if ((ctx.unknownCount ?? 0) > 0) runUnknownCommand(runtime, renderer);
        return true;
      case "unknown": {
        const sub = parseUnknownSlashArgs(arg);
        if (sub.kind === "inspect" && typeof ctx.showReceiptInspector === "function") {
          const lines = buildUnknownInspectLines(runtime, sub.target);
          if (lines) {
            await ctx.showReceiptInspector(lines);
            return true;
          }
        }
        runUnknownCommand(runtime, renderer, arg);
        return true;
      }
      case "worktree":
        runWorktreeSlash(workspace, renderer);
        return true;
      case "snapshot":
        runSnapshotSlash(renderer);
        return true;
      case "models":
        showModels(renderer, runtime);
        return true;
      case "memory":
      case "instructions":
        runMemoryCommand(name, workspace, renderer, { sessionId: runtime.sessionId });
        return true;
      case "rename":
      case "stats":
      case "tokens":
      case "learn":
      case "trust":
      case "settings":
      case "graph":
      case "copy":
      case "export":
        await runConvoCommand(name, arg, runtime, renderer, workspace, write);
        return true;
      default:
        return false;
    }
  } catch (err) {
    renderer.notice(`/${name} failed: ${errorMessage(err)}`);
    return true;
  }
}

function readPlanModeFromRuntime(runtime: Runtime): boolean {
  const read = (runtime as RuntimeWithExtras).planMode;
  if (typeof read !== "function") return false;
  try {
    return Boolean(read.call(runtime));
  } catch {
    return false;
  }
}
