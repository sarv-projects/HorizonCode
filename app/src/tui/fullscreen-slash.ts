/**
 * fullscreen-slash.ts — run builtin slash handlers on the alt-screen loop (ruling 240).
 */

import { homedir } from "node:os";
import type { Runtime } from "../contracts";
import { defaultConfigPath, loadConfig, persistNotifyConfig } from "../core/config";
import { resolveCommandForMessage } from "../core/commands";
import { formatModelsNotice, isModelsRefreshCommand, runModelsSlashRefresh } from "./models-slash";
import { modelsForProvider } from "../core/catalog/list-models";
import {
  readPermissionMode,
  runConvoCommand,
  runMemoryCommand,
  runModeCommand,
  runPlanCommand,
  runSkillSlashCommand,
  runThemeCommand,
  showTools,
  type PlanCommandState,
  type RuntimeWithExtras,
} from "./interactive";
import { runAutonomyCommand } from "./autonomy-slash";
import { runNotifyCommand } from "./notify";
import { deferredSlashAction, isFullscreenLocalSlash, parseSlashInput } from "./slash-dispatch";
import type { Renderer } from "./render";
import { printSlashHelp } from "./slash-help";
import { formatIdleStatusLine, readGitBranch, type StatusInfo } from "./live";
import { buildUnknownInspectLines, runReconcileCommand, runUnknownCommand } from "./unknown-slash";
import {
  inspectPrincipalPosture,
  readEffectHostMode,
  readEgressPosture,
  readPiiVaultStatus,
} from "./trust-spine-status";
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
  /** Pause fullscreen raw stdin/keypress listeners while an interactive sub-flow owns stdin (e.g. `/changes --review`). */
  withExclusiveStdin?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Toggle quiet `/focus` mode and return the new state. */
  toggleFocusMode?: () => boolean;
  /** Handle `/btw <question>` side-question in fullscreen. */
  sendBtw?: (question: string) => Promise<void>;
  /** D-9: close the alt-screen loop for `/exit` / `/quit`. */
  requestExit?: () => void;
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
  const principal = inspectPrincipalPosture();
  return {
    badge,
    model: ctx.runtime.model,
    provider: rt.providerName ?? "unknown",
    path: shortenPath(ctx.workspace),
    branch: readGitBranch(ctx.workspace),
    unknownCount: unknownCount > 0 ? unknownCount : undefined,
    unknownReceiptId: unknownCount === 1 ? ctx.unknownReceiptId : undefined,
    effectHostMode: readEffectHostMode(),
    egressPosture: readEgressPosture(ctx.runtime),
    piiVault: readPiiVaultStatus(ctx.runtime),
    principalMode: principal.principalMode,
    principalKeyFingerprint: principal.principalKeyFingerprint,
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
  // D-9: a deferred verb is never a prompt. `/exit` closes the loop; the rest
  // have no inline handler and are reported as unavailable here.
  const deferred = deferredSlashAction(name);
  if (deferred !== undefined) {
    if (deferred === "exit") ctx.requestExit?.();
    else ctx.renderer.notice(`/${name} is not available in fullscreen — use the scrollback TUI for it`);
    return true;
  }
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
        runNotifyCommand(arg, renderer, cfg.notify, (prefs) => { void persistNotifyConfig(prefs, home); });
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
        if (name === "changes" && arg.trim() === "--review" && ctx.withExclusiveStdin) {
          await ctx.withExclusiveStdin(() => runPlanCommand(name, arg, runtime, renderer, planState));
        } else {
          await runPlanCommand(name, arg, runtime, renderer, planState);
        }
        return true;
      case "skill":
        await runSkillSlashCommand(arg, runtime, renderer, workspace);
        return true;
      case "focus": {
        const on = ctx.toggleFocusMode ? ctx.toggleFocusMode() : false;
        renderer.notice(
          on
            ? "focus mode ON — collapsing intermediate tool chatter to prompt + diffstat + final response"
            : "focus mode OFF — showing full tool cards and notices",
        );
        return true;
      }
      case "btw": {
        const question = arg.trim();
        if (question === "") {
          renderer.notice("usage: /btw <side-question>");
          return true;
        }
        if (ctx.sendBtw) {
          await ctx.sendBtw(question);
        } else {
          renderer.notice(`[btw] ${sanitizeText(question)}`);
        }
        return true;
      }
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
        if ((ctx.unknownCount ?? 0) > 0) await runUnknownCommand(runtime, renderer);
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
        await runUnknownCommand(runtime, renderer, arg);
        return true;
      }
      case "reconcile":
        await runReconcileCommand(runtime, renderer, arg);
        return true;
      case "worktree":
        runWorktreeSlash(workspace, renderer);
        return true;
      case "snapshot":
        runSnapshotSlash(renderer);
        return true;
      case "models":
        if (isModelsRefreshCommand(arg)) {
          const { notice } = await runModelsSlashRefresh({ env: process.env });
          renderer.notice(notice);
        } else {
          showModels(renderer, runtime);
        }
        return true;
      case "memory":
      case "instructions":
        runMemoryCommand(name, workspace, renderer, { sessionId: runtime.sessionId });
        return true;
      case "rename":
      case "stats":
      case "tokens":
      case "learn":
      case "tasks":
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
