/**
 * HorizonCode — entry point.
 *
 * Chat first: with no arguments this opens a conversation. Flags are optional
 * conveniences; anything they can do, the human can also just ask for in words.
 *
 *   stdin is a TTY   -> the chat bar (tui/interactive.ts)
 *   stdin is a pipe  -> plain streamed text, one message per stdin line
 *
 * The runtime comes from ./core (app/src/core), which is built against
 * ./contracts.ts and may expose optional extras; every extra is feature-detected.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunBudget, Runtime, RuntimeOptions } from "./contracts";
import * as core from "./core";
import type { PermissionMode } from "./core/permission-mode";
import { describeMode, parsePermissionMode, permissionModeError } from "./core/permission-mode";
import {
  doctorExitCode,
  doctorFixSuggestion,
  realDoctorEnv,
  renderDoctor,
  renderDoctorJson,
  runDoctor,
} from "./core/doctor";
import { createServer } from "./core/server";
import { liveStdin } from "./core/stdin-live";
import {
  PRINT_FORMATS,
  createApprovalUi,
  installApprovalHandler,
  runFullscreenExperimentalChat,
  runHeadless,
  runInteractive,
  runPrint,
} from "./tui";
import { checkKeymapOverrides, defaultKeymap } from "./tui/keymap";
import { consumeTuiHandoff } from "./tui/handoff";
import { isFullscreenChatMode, resolveTuiScreenMode, type TuiScreenMode } from "./tui/screen-mode";
import type { PrintFormat } from "./tui";
import { errorMessage } from "./tui/style";
import { loadCatalog } from "./core/catalog/catalog";
import {
  allCatalogModelIds,
  filterModelIds,
  formatDidYouMean,
  isKnownModel,
  modelIdsForProvider,
  suggestModelIds,
} from "./core/catalog/model-suggest";
import {
  augmentConfigWithTrustedWorkspace,
  checkConfigFile,
  defaultConfigPath,
  loadConfig,
  renderConfigCheck,
} from "./core/config";
import { buildShowPromptsRequest, renderShowPrompts } from "./core/show-prompts";
import { buildShowRepoMap } from "./core/show-repo-map";
import { appendAttributionToMessage, parseCommitAttributeArgs } from "./core/commit-attribution";
import { cleanCommitMessage, commitCommand, commitPrompt, stagedDiff, withReceiptTrailer } from "./core/commit";
import { resolveCommandForMessage } from "./core/commands";
import { cleanSuggestedCommand, suggestPrompt } from "./core/suggest";
import { validateWorktreeName } from "./core/worktree";
import { resolveWorktreeAcquire, worktreePoolMaxFromEnv } from "./core/worktree-pool";
import {
  catalogCachePath,
  CATALOG_PATH,
  DEFAULT_CATALOG_SOURCE,
  fetchLiveCatalog,
  readCatalogCache,
  summarizeCatalogDiff,
  writeCatalogCache,
} from "./core/catalog/catalog";
import { KernelClient } from "./core/kernel";
import { effectReconcileExitCode, renderEffectReconcile } from "./core/effect-cli";
import { renderReceiptShow } from "./core/receipt-cli";
import { exportSessionCli, forkSessionCli, renderSessionList } from "./core/session-cli";
import {
  buildSessionVerifyReport,
  renderSessionVerify,
  sessionVerifyExitCode,
} from "./core/session-verify-cli";

const VERSION = "0.1.0";

const HELP = [
  "hzcode \u2014 chat with a coding assistant in your terminal",
  "",
  "  hzcode [message]     start chatting (optionally with an opening message)",
  "  hzcode serve         run the single-attach server (NDJSON JSON-RPC on stdio)",
  "  hzcode config check  report unknown and rejected keys in the config file",
  "  hzcode keybind check  validate optional keybind overrides JSON (docs/33 §5.19)",
  "  hzcode commit        write a commit message for the staged diff and commit it through the guard (--preview, --receipt)",
  "  hzcode suggest       print one shell command for a task (never executes it)",
  "  hzcode doctor        diagnose this install (OK/WARN/FAIL + a fix per problem; --json, --fix <check>, --workspace <path>)",
  "  hzcode session list  list sessions in a workspace",
  "  hzcode session fork <id> [--at n]  fork a session transcript (no chat)",
  "  hzcode session export <id> [-o path]  portable .hzs archive (export only; no import)",
  "  hzcode session verify <id>  receipt chain + reconcile probe (read-only; exit 3 on failure)",
  "  hzcode effect reconcile [--session <id>] [--probe]  observe-only reconcile report (no writes)",
  "  hzcode receipt show <id>            read-only receipt inspector + local chain verify (R172 reduced)",
  "  --worktree <name>    create a git worktree beside the repo and start there (not OS sandbox)",
  "  --workspace <path>   folder to work in (default: the current folder)",
  "  --model <name>       model to use           --continue   resume the last session",
  "  --list-models [sub]  list known model ids (optional substring filter)",
  "  --show-prompts       dump the rendered provider request and exit (no API)",
  "  --show-repo-map      dump the repo_map render and exit (no API)",
  "  --mock               offline demo, no key   --version    print the version",
  "  -p, --print [text]   one non-interactive turn, print the answer (prompt from stdin if no text)",
  "  --output-format <f>  with -p: text (default) | json | stream-json",
  "  --permission-mode <m>  default | plan | accept-edits | read-only (no bypass mode; /mode in chat)",
  "  --max-steps <n>      cap model steps per turn (0 = unlimited)",
  "  --max-tokens <n>     cap tokens per turn    --max-wall-ms <n>  cap wall clock per turn",
  "  --fullscreen         reduced alt-screen chat (docs/33 §5.17; residuals remain)",
  "  --tui-mode <m>       scrollback (default) | fullscreen | fullscreen-experimental",
].join("\n");

interface CliOptions {
  workspace: string;
  model?: string;
  continueSession: boolean;
  mock: boolean;
  help: boolean;
  version: boolean;
  initialMessage?: string;
  /** -p / --print: one non-interactive turn */
  print: boolean;
  printText?: string;
  outputFormat?: PrintFormat;
  budget?: RunBudget;
  permissionMode?: PermissionMode;
  worktree?: string;
  tuiScreenMode?: TuiScreenMode;
  listModels: boolean;
  listModelsFilter?: string;
  showPrompts: boolean;
  showRepoMap: boolean;
  errors: string[];
}

function cliConfig(workspace: string, opts: CliOptions): ReturnType<typeof loadConfig> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.mock) env.HZ_PROVIDER = "mock";
  if (opts.model !== undefined) env.HZ_MODEL = opts.model;
  const home = typeof env.HOME === "string" && env.HOME !== "" ? env.HOME : os.homedir();
  return augmentConfigWithTrustedWorkspace(loadConfig(env, defaultConfigPath(home), workspace), workspace, env, home, () => {});
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    workspace: process.cwd(),
    continueSession: false,
    mock: false,
    help: false,
    version: false,
    print: false,
    listModels: false,
    showPrompts: false,
    showRepoMap: false,
    errors: [],
  };
  const rest: string[] = [];
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (positionalOnly) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg === "") continue;

    let name = arg;
    let inline: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      const at = arg.indexOf("=");
      name = arg.slice(0, at);
      inline = arg.slice(at + 1);
    }
    const nextValue = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith("--")) return undefined;
      i += 1;
      return String(next);
    };

    switch (name) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--version":
      case "-v":
        opts.version = true;
        break;
      case "--continue":
      case "--resume":
        opts.continueSession = true;
        break;
      case "--print":
      case "-p": {
        opts.print = true;
        // the text is optional: `-p` alone reads the prompt from stdin
        if (inline !== undefined) opts.printText = inline;
        else {
          const next = argv[i + 1];
          if (next !== undefined && !String(next).startsWith("-")) {
            i += 1;
            opts.printText = String(next);
          }
        }
        break;
      }
      case "--output-format": {
        const value = nextValue();
        if (value !== undefined && (PRINT_FORMATS as readonly string[]).includes(value)) opts.outputFormat = value as PrintFormat;
        else opts.errors.push("--output-format needs text, json or stream-json");
        break;
      }
      case "--permission-mode": {
        const value = nextValue();
        const mode = parsePermissionMode(value);
        if (mode !== undefined) opts.permissionMode = mode;
        else opts.errors.push(`--permission-mode: ${permissionModeError(value)}`);
        break;
      }
      case "--mock":
        opts.mock = true;
        break;
      case "--show-prompts":
        opts.showPrompts = true;
        break;
      case "--show-repo-map":
        opts.showRepoMap = true;
        break;
      case "--list-models": {
        opts.listModels = true;
        if (inline !== undefined) opts.listModelsFilter = inline;
        else {
          const next = argv[i + 1];
          if (next !== undefined && !String(next).startsWith("-")) {
            i += 1;
            opts.listModelsFilter = String(next);
          }
        }
        break;
      }
      case "--fullscreen":
        opts.tuiScreenMode = "fullscreen";
        break;
      case "--tui-mode": {
        const value = nextValue();
        if (value === undefined || value.trim() === "") {
          opts.errors.push("--tui-mode needs scrollback or fullscreen");
          break;
        }
        const key = value.trim().toLowerCase();
        if (key === "scrollback" || key === "default" || key === "minimal") opts.tuiScreenMode = "scrollback";
        else if (key === "fullscreen" || key === "full" || key === "alt") opts.tuiScreenMode = "fullscreen";
        else opts.errors.push("--tui-mode needs scrollback or fullscreen");
        break;
      }
      case "--worktree": {
        const value = nextValue();
        if (value === undefined || value === "") opts.errors.push("--worktree needs a name");
        else opts.worktree = value;
        break;
      }
      case "--workspace": {
        const value = nextValue();
        if (value === undefined || value === "") opts.errors.push("--workspace needs a folder");
        else opts.workspace = value;
        break;
      }
      case "--model": {
        const value = nextValue();
        if (value === undefined || value === "") opts.errors.push("--model needs a name");
        else opts.model = value;
        break;
      }
      // NF-073: run budgets; 0 = unlimited, the one convention everywhere.
      case "--max-steps":
      case "--max-tokens":
      case "--max-wall-ms": {
        const value = nextValue();
        const n = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
        if (!Number.isFinite(n) || n < 0) {
          opts.errors.push(`${name} needs a number (0 = unlimited)`);
          break;
        }
        const amount = Math.floor(n);
        opts.budget = opts.budget ?? {};
        if (name === "--max-steps") opts.budget.maxSteps = amount;
        else if (name === "--max-tokens") opts.budget.maxTokens = amount;
        else opts.budget.maxWallMs = amount;
        break;
      }
      default:
        if (name.startsWith("-") && name !== "-") opts.errors.push(`unknown option ${name}`);
        else rest.push(arg);
        break;
    }
  }

  if (rest.length > 0) opts.initialMessage = rest.join(" ");
  return opts;
}

type CoreModule = {
  createRuntime?: (opts: RuntimeOptions) => Promise<Runtime>;
  default?: { createRuntime?: (opts: RuntimeOptions) => Promise<Runtime> };
};

/**
 * `hzcode serve` — the single-attach server (docs/14 §3.2, reduced v1). It
 * speaks NDJSON JSON-RPC over stdio: every stdin line is one request, every
 * response is one stdout line, and `session.event` notifications stream a
 * turn's RuntimeEvents. stdout carries ONLY protocol lines (S15: diagnostics go
 * to stderr). SIGTERM stops gracefully — every live runtime is closed through
 * runtime.close() — and exits 143 like the chat stop path. This is parsed
 * before the chat-first arg handling, so no existing flag behaviour changes.
 */
async function runServe(opts: CliOptions, workspace: string): Promise<number> {
  const server = createServer({
    workspace,
    // Live worker-backed reader: Bun batches pipe stdin until EOF (stdin-live.ts).
    input: liveStdin(),
    // One protocol line per frame to stdout; nothing else is ever written here.
    output: (line: string) => process.stdout.write(line),
    mock: opts.mock,
    model: opts.model,
  });

  let terminated = false;
  const onSigterm = (): void => {
    terminated = true;
    void Promise.resolve(server.stop()).catch(() => {
      /* closing on the way out */
    });
    const timer = setTimeout(() => process.exit(143), 300);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  };
  process.once("SIGTERM", onSigterm);

  process.stderr.write(`hzcode serve: NDJSON JSON-RPC on stdio (workspace ${workspace})\n`);
  try {
    await server.start();
  } catch (err) {
    process.stderr.write(`hzcode serve: ${errorMessage(err)}\n`);
    await server.stop().catch(() => undefined);
    return 1;
  } finally {
    process.removeListener("SIGTERM", onSigterm);
  }
  await server.stop().catch(() => undefined);
  return terminated ? 143 : 0;
}

/** `hzcode doctor [--json] [--workspace <path>]`: diagnose only, exit 1 on any FAIL. */
function runDoctorCommand(args: string[]): number {
  let json = false;
  let fixCheck: string | undefined;
  let workspace = process.cwd();
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] ?? "");
    if (arg === "--json") json = true;
    else if (arg === "--fix" || arg.startsWith("--fix=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      if (value === undefined || value === "" || (!arg.includes("=") && String(value).startsWith("--"))) {
        process.stderr.write("hzcode: --fix needs a check id (e.g. effect.host)\n");
        return 2;
      }
      if (!arg.includes("=")) i += 1;
      fixCheck = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "hzcode doctor [--json] [--fix <check>] [--workspace <path>]\n  check bun, the kernel, config, provider, workspace, git and terminal; prints OK/WARN/FAIL with a fix per problem; --fix prints read-only export hints for one check id; exits 1 on FAIL; changes nothing\n",
      );
      return 0;
    } else if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      if (value === undefined || value === "" || (!arg.includes("=") && String(value).startsWith("--"))) {
        process.stderr.write("hzcode: --workspace needs a folder\n");
        return 2;
      }
      if (!arg.includes("=")) i += 1;
      workspace = value;
    } else {
      process.stderr.write(`hzcode: doctor: unknown argument ${arg}\ntry 'hzcode doctor --help'\n`);
      return 2;
    }
  }
  const env = realDoctorEnv(path.resolve(workspace));
  const checks = runDoctor(env);
  if (fixCheck !== undefined) {
    const lines = doctorFixSuggestion(fixCheck, env.env as Record<string, string | undefined>);
    if (lines === undefined) {
      process.stderr.write(`hzcode doctor --fix: no suggestions for check id ${fixCheck}\n`);
      return 2;
    }
    process.stdout.write(`doctor --fix ${fixCheck} (read-only suggestions; nothing changed)\n`);
    for (const line of lines) process.stdout.write(`${line}\n`);
    return 0;
  }
  process.stdout.write((json ? renderDoctorJson(checks) : renderDoctor(checks)) + "\n");
  return doctorExitCode(checks);
}

function runEffectCommand(args: string[]): number {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(
      "usage: hzcode effect reconcile [--workspace <path>] [--session <id>] [--probe]\n  observe-only reconcile simulation; --probe adds read-only fs/vcs probes (docs/06); no ledger writes\n",
    );
    return args.length === 0 ? 2 : 0;
  }
  if (args[0] !== "reconcile") {
    process.stderr.write(
      "usage: hzcode effect reconcile [--workspace <path>] [--session <id>] [--probe]\n",
    );
    return 2;
  }
  let workspace = process.cwd();
  let sessionId: string | undefined;
  let probe = false;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--probe") probe = true;
    else if (arg === "--session") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        process.stderr.write("hzcode effect reconcile: --session needs an id\n");
        return 2;
      }
      sessionId = value;
      i += 1;
    } else if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      if (value === undefined || value === "") {
        process.stderr.write("hzcode: --workspace needs a folder\n");
        return 2;
      }
      if (!arg.includes("=")) i += 1;
      workspace = value;
    } else {
      process.stderr.write(`hzcode effect reconcile: unknown argument ${arg}\n`);
      return 2;
    }
  }
  workspace = path.resolve(workspace);
  try {
    process.stdout.write(`${renderEffectReconcile(workspace, { sessionId, probe })}\n`);
    return effectReconcileExitCode(workspace, { sessionId, probe });
  } catch (err) {
    process.stderr.write(`hzcode effect reconcile: ${errorMessage(err)}\n`);
    return 1;
  }
}

function runReceiptCommand(args: string[]): number {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("usage: hzcode receipt show <receiptId> [--workspace <path>]\n");
    return args.length === 0 ? 2 : 0;
  }
  let workspace = process.cwd();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      if (value === undefined || value === "") {
        process.stderr.write("hzcode: --workspace needs a folder\n");
        return 2;
      }
      if (!arg.includes("=")) i += 1;
      workspace = value;
    } else {
      rest.push(arg);
    }
  }
  workspace = path.resolve(workspace);
  if (rest[0] !== "show") {
    process.stderr.write("usage: hzcode receipt show <receiptId> [--workspace <path>]\n");
    return 2;
  }
  const receiptId = rest[1];
  if (receiptId === undefined || receiptId.startsWith("--")) {
    process.stderr.write("hzcode receipt show: missing receipt id\n");
    return 2;
  }
  try {
    process.stdout.write(`${renderReceiptShow(workspace, receiptId)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`hzcode receipt show: ${errorMessage(err)}\n`);
    return 1;
  }
}

function runSessionCommand(args: string[]): number {
  if (args.length === 0) {
    process.stderr.write(
      "usage: hzcode session list [--workspace <path>] | hzcode session fork <id> [--at n] | hzcode session export <id> [-o path] | hzcode session verify <id> [--workspace <path>]\n",
    );
    return 2;
  }
  let workspace = process.cwd();
  const verb = args[0];
  const rest: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      if (value === undefined || value === "") {
        process.stderr.write("hzcode: --workspace needs a folder\n");
        return 2;
      }
      if (!arg.includes("=")) i += 1;
      workspace = value;
    } else {
      rest.push(arg);
    }
  }
  workspace = path.resolve(workspace);
  try {
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      process.stderr.write(`hzcode: not a folder: ${workspace}\n`);
      return 2;
    }
  } catch (err) {
    process.stderr.write(`hzcode: cannot use ${workspace}: ${errorMessage(err)}\n`);
    return 2;
  }
  if (verb === "list") {
    process.stdout.write(`${renderSessionList(workspace)}\n`);
    return 0;
  }
  if (verb === "export") {
    const sessionId = rest[0];
    if (sessionId === undefined || sessionId.startsWith("--")) {
      process.stderr.write("usage: hzcode session export <sessionId> [-o <path>]\n");
      return 2;
    }
    let out: string | undefined;
    for (let j = 1; j < rest.length; j += 1) {
      if (rest[j] === "-o" || rest[j] === "--output") {
        const p = rest[j + 1];
        if (p === undefined || p.startsWith("-")) {
          process.stderr.write("hzcode session export: -o needs a file path\n");
          return 2;
        }
        out = p;
        j += 1;
      } else {
        process.stderr.write(`hzcode session export: unknown argument ${rest[j]}\n`);
        return 2;
      }
    }
    try {
      const result = exportSessionCli(workspace, sessionId, { out });
      process.stdout.write(
        `exported ${result.messageCount} message(s), ${result.checkpointCount} checkpoint(s)` +
          (result.eventCount > 0 ? `, ${result.eventCount} event(s)` : "") +
          ` → ${result.path}\n`,
      );
      return 0;
    } catch (err) {
      process.stderr.write(`hzcode session export: ${errorMessage(err)}\n`);
      return 1;
    }
  }
  if (verb === "verify") {
    const sessionId = rest[0];
    if (sessionId === undefined || sessionId.startsWith("--")) {
      process.stderr.write("usage: hzcode session verify <sessionId> [--workspace <path>]\n");
      return 2;
    }
    for (let j = 1; j < rest.length; j += 1) {
      process.stderr.write(`hzcode session verify: unknown argument ${rest[j]}\n`);
      return 2;
    }
    try {
      const report = buildSessionVerifyReport(workspace, sessionId);
      process.stdout.write(`${renderSessionVerify(report)}\n`);
      return sessionVerifyExitCode(report);
    } catch (err) {
      process.stderr.write(`hzcode session verify: ${errorMessage(err)}\n`);
      return 1;
    }
  }
  if (verb === "fork") {
    const parentId = rest[0];
    if (parentId === undefined || parentId.startsWith("--")) {
      process.stderr.write("usage: hzcode session fork <parentSessionId> [--at n]\n");
      return 2;
    }
    let at: number | undefined;
    for (let j = 1; j < rest.length; j += 1) {
      if (rest[j] === "--at") {
        const n = Number(rest[j + 1]);
        if (!Number.isInteger(n) || n < 0) {
          process.stderr.write("hzcode: --at must be a non-negative integer\n");
          return 2;
        }
        at = n;
        j += 1;
      } else {
        process.stderr.write(`hzcode session fork: unknown argument ${rest[j]}\n`);
        return 2;
      }
    }
    try {
      const child = forkSessionCli(workspace, parentId, { at });
      process.stdout.write(`forked ${parentId} → ${child.childId} (${child.title}) at message ${child.messageIndex}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`hzcode session fork: ${errorMessage(err)}\n`);
      return 1;
    }
  }
  process.stderr.write(`hzcode session: unknown verb ${verb}\n`);
  return 2;
}

function runConfigCommand(args: string[]): number {
  if (args[0] !== "check" || args.length > 2) {
    process.stderr.write("usage: hzcode config check [file]\n");
    return 2;
  }
  const check = args[1] !== undefined ? checkConfigFile(path.resolve(args[1])) : checkConfigFile();
  process.stdout.write(renderConfigCheck(check) + "\n");
  return check.unknown.length > 0 || check.rejected.length > 0 ? 1 : 0;
}

/** Re-run this entry with `--workspace` after creating a worktree. */
function reexecInWorkspace(dest: string, argvTail: string[]): number {
  const script = process.argv[1] ?? "";
  const filtered: string[] = [];
  for (let i = 0; i < argvTail.length; i += 1) {
    const arg = argvTail[i] ?? "";
    if (arg === "--worktree") {
      const next = argvTail[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) i += 1;
      continue;
    }
    if (arg.startsWith("--worktree=")) continue;
    filtered.push(arg);
  }
  const args = [script, "--workspace", dest, ...filtered];
  const res = spawnSync(process.execPath, args, { stdio: "inherit", cwd: dest });
  const code = res.status;
  return typeof code === "number" ? code : 1;
}

function gitWorktreePorcelain(cwd: string): string | undefined {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return r.stdout ?? "";
}

async function runWorktreeBootstrap(opts: CliOptions, workspace: string): Promise<number> {
  const name = opts.worktree ?? "";
  const porcelain = gitWorktreePorcelain(workspace);
  const decision = resolveWorktreeAcquire(workspace, name, {
    max: worktreePoolMaxFromEnv(process.env),
    porcelain: porcelain ?? "",
  });
  if (decision.kind === "refuse") {
    process.stderr.write(`hzcode: ${decision.reason}\n`);
    return decision.reason.startsWith("invalid worktree") || decision.reason.includes("required") ? 2 : 1;
  }
  const dest = decision.dest;
  if (decision.kind === "reuse") {
    process.stderr.write(`hzcode: worktree: reusing idle pool tree ${dest} (branch ${decision.branch})\n`);
    return reexecInWorkspace(dest, process.argv.slice(2));
  }
  const mod = core as unknown as CoreModule;
  const createRuntime = typeof mod.createRuntime === "function" ? mod.createRuntime : mod?.default?.createRuntime;
  if (typeof createRuntime !== "function") {
    process.stderr.write("hzcode: the runtime is missing from this build (app/src/core)\n");
    return 1;
  }
  let runtime: Runtime;
  try {
    runtime = await createRuntime({ workspace, mock: opts.mock, permissionMode: "default" });
  } catch (err) {
    process.stderr.write(`hzcode: worktree: ${errorMessage(err)}\n`);
    return 1;
  }
  const extras = runtime as Runtime & { runGuardedShell?: (command: string) => Promise<{ ok: boolean; output: string }> };
  try {
    const ui = createApprovalUi(Boolean(process.stdin.isTTY));
    ui.runtime = runtime;
    installApprovalHandler(ui);
    if (typeof extras.runGuardedShell !== "function") {
      process.stderr.write("hzcode: worktree: this build cannot run a guarded command\n");
      return 1;
    }
    const out = await extras.runGuardedShell(decision.command);
    if (!out.ok) {
      process.stderr.write(`hzcode: worktree: ${out.output.trim() || "git worktree add failed"}\n`);
      return 1;
    }
    process.stderr.write(`hzcode: worktree ${dest} (branch ${decision.branch})\n`);
  } finally {
    try {
      await runtime.close();
    } catch {
      /* closing */
    }
  }
  return reexecInWorkspace(dest, process.argv.slice(2));
}

/** `hzcode login|logout <provider>` — OAuth PKCE when the registry entry has `oauth` (docs/33 §5.6). */
async function runLoginCommand(args: string[]): Promise<number> {
  const verb = args[0];
  const device = args.includes("--device");
  const provider = args.find((a, i) => i > 0 && !a.startsWith("-"))?.trim();
  if (!provider) {
    process.stderr.write(`usage: hzcode ${verb} <provider> [--device]\n`);
    return 2;
  }
  const { loadConfig } = await import("./core/config");
  const { providerHasOAuth, runOAuthLogout, runPkceLogin } = await import("./core/auth/login");
  const { providerHasDeviceOAuth, runDeviceCodeLogin } = await import("./core/auth/device");
  const config = loadConfig();
  const entry = config.providers?.providers.find((p) => p.id === provider.toLowerCase());
  if (verb === "logout") {
    try {
      runOAuthLogout(provider.toLowerCase());
      return 0;
    } catch (e) {
      process.stderr.write(`hzcode logout: ${errorMessage(e)}\n`);
      return 1;
    }
  }
  if (entry === undefined) {
    process.stderr.write(`hzcode login: unknown provider id ${JSON.stringify(provider)} in user config providers[]\n`);
    return 1;
  }
  if (device) {
    if (!providerHasDeviceOAuth(entry)) {
      process.stderr.write(
        `hzcode login: provider ${entry.id} needs oauth.deviceAuthorizationUrl, tokenUrl and clientId for --device\n`,
      );
      return 1;
    }
    try {
      await runDeviceCodeLogin(entry);
      return 0;
    } catch (e) {
      process.stderr.write(`hzcode login: ${errorMessage(e)}\n`);
      return 1;
    }
  }
  if (!providerHasOAuth(entry)) {
    process.stderr.write(
      `hzcode login: provider ${entry.id} has no oauth block (authorizeUrl, tokenUrl, clientId); use HZ_API_KEY or apiKey until configured\n`,
    );
    return 1;
  }
  try {
    await runPkceLogin(entry);
    return 0;
  } catch (e) {
    process.stderr.write(`hzcode login: ${errorMessage(e)}\n`);
    return 1;
  }
}

/** `hzcode tui relaunch` — consume one-shot handoff (docs/13 D2 reduced). */
function runTuiCommand(args: string[]): number {
  if (args[0] !== "relaunch") {
    process.stderr.write("usage: hzcode tui relaunch  (consumes <state>/tui-handoff.json)\n");
    return 2;
  }
  const workspace = process.cwd();
  const handoff = consumeTuiHandoff(workspace);
  if (handoff === undefined) {
    process.stderr.write("hzcode tui relaunch: no handoff file (nothing to restore)\n");
    return 1;
  }
  process.stdout.write(
    `relaunch handoff consumed: session ${handoff.sessionId}, mode ${handoff.mode}, draft ${handoff.draft.length} bytes\n`,
  );
  return 0;
}

/** `hzcode keybind check [file]` — validate keybind override JSON (docs/33 §5.19). */
function runKeybindCommand(args: string[]): number {
  if (args[0] !== "check") {
    process.stderr.write("usage: hzcode keybind check [overrides.json]\n");
    return 2;
  }
  const file = args[1];
  let overrides: Record<string, string> = {};
  if (file !== undefined) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        process.stderr.write(`hzcode keybind check: ${file} must be a JSON object of actionId → chord\n`);
        return 1;
      }
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v !== "string") {
          process.stderr.write(`hzcode keybind check: ${file}: ${k} must be a string chord\n`);
          return 1;
        }
        overrides[k] = v;
      }
    } catch (e) {
      process.stderr.write(`hzcode keybind check: ${errorMessage(e)}\n`);
      return 1;
    }
  }
  const errors = checkKeymapOverrides(overrides, defaultKeymap());
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(`hzcode keybind check: ${err}\n`);
    return 1;
  }
  const n = Object.keys(overrides).length;
  process.stdout.write(
    n === 0
      ? `keybind check ok (defaults, ${defaultKeymap().actions.length} actions)\n`
      : `keybind check ok (${n} override(s))\n`,
  );
  return 0;
}

/** `hzcode models refresh` — conditional fetch + user cache (docs/33 §5.8). */
async function runModelsCommand(args: string[]): Promise<number> {
  if (args[0] !== "refresh") {
    process.stderr.write("usage: hzcode models refresh\n");
    return 2;
  }
  const workspace = process.cwd();
  const kernel = new KernelClient({ workspace });
  await kernel.start();
  const catalogUrl = DEFAULT_CATALOG_SOURCE.replace(/\/+$/, "") + CATALOG_PATH;
  const guard = await kernel.checkGuard({ kind: "net.fetch", target: catalogUrl });
  if (guard.decision === "deny") {
    process.stderr.write(`hzcode models refresh: egress denied — ${guard.reason ?? "net.fetch"}\n`);
    return 1;
  }
  if (guard.decision === "ask") {
    process.stderr.write(
      "hzcode models refresh: net.fetch requires approval (not available in this command); adjust egress policy or run from a session\n",
    );
    return 1;
  }
  const prev = readCatalogCache();
  try {
    const fetched = await fetchLiveCatalog(DEFAULT_CATALOG_SOURCE, {
      etag: prev?.meta.etag,
      assertNetFetch: (url) => {
        if (url !== catalogUrl) throw new Error("unexpected catalog URL");
      },
    });
    if (fetched.notModified) {
      process.stdout.write(`models cache unchanged (304) at ${catalogCachePath()}\n`);
      return 0;
    }
    const file = writeCatalogCache(fetched.catalog, {
      fetchedAt: new Date().toISOString(),
      source: DEFAULT_CATALOG_SOURCE,
      etag: fetched.etag,
    });
    const n = Object.keys(fetched.catalog.providers).length;
    const diffLine = prev !== undefined ? summarizeCatalogDiff(prev.catalog, fetched.catalog) : undefined;
    process.stdout.write(
      `models cache updated: ${n} providers → ${file}${diffLine !== undefined ? `\ncatalog diff: ${diffLine}` : ""}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`hzcode models refresh: ${errorMessage(err)}\n`);
    return 1;
  }
}

/** `hzcode suggest [task...]` — one model turn, print a command, never run it (T-16). */
async function runSuggestCommand(args: string[]): Promise<number> {
  let workspace = process.cwd();
  let mock = false;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mock") mock = true;
    else if (arg === "--workspace" && args[i + 1] !== undefined) workspace = args[(i += 1)];
    else if (arg.startsWith("--")) {
      process.stderr.write(`hzcode: suggest: unknown option ${arg}\nusage: hzcode suggest [--workspace <path>] [task...]\n`);
      return 2;
    } else parts.push(arg);
  }
  workspace = path.resolve(workspace);
  if (parts.join(" ").trim() === "" && !process.stdin.isTTY) {
    try {
      parts.push((await Bun.stdin.text()).trim());
    } catch {
      /* no stdin */
    }
  }
  const request = parts.join(" ").trim();
  if (request === "") {
    process.stderr.write("hzcode: suggest: give a task on the command line or stdin\n");
    return 2;
  }
  const mod = core as unknown as CoreModule;
  const createRuntime = typeof mod.createRuntime === "function" ? mod.createRuntime : mod?.default?.createRuntime;
  if (typeof createRuntime !== "function") {
    process.stderr.write("hzcode: the runtime is missing from this build (app/src/core)\n");
    return 1;
  }
  let runtime: Runtime;
  try {
    runtime = await createRuntime({ workspace, mock, permissionMode: "default" });
  } catch (err) {
    process.stderr.write(`hzcode: suggest: ${errorMessage(err)}\n`);
    return 1;
  }
  try {
    const ui = createApprovalUi(false);
    ui.runtime = runtime;
    installApprovalHandler(ui);
    const res = await runtime.send(suggestPrompt(request), { onEvent: () => {} });
    const line = cleanSuggestedCommand(res.text);
    if (res.aborted || line === "") {
      process.stderr.write("hzcode: suggest: no command was produced\n");
      return 1;
    }
    process.stdout.write(line + "\n");
    return 0;
  } finally {
    try {
      await runtime.close();
    } catch {
      /* closing */
    }
  }
}

/** `hzcode commit [--preview] [--receipt] [--attribute-*] [--workspace <path>] [context...]` (T-16). */
async function runCommitCommand(rawArgs: string[]): Promise<number> {
  let attribution;
  let args: string[];
  try {
    ({ attribution, rest: args } = parseCommitAttributeArgs(rawArgs));
  } catch (err) {
    process.stderr.write(`hzcode: commit: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  let preview = false;
  let receipt = false;
  let workspace = process.cwd();
  let mock = false;
  const context: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--preview") preview = true;
    else if (arg === "--receipt") receipt = true;
    else if (arg === "--mock") mock = true;
    else if (arg === "--workspace" && args[i + 1] !== undefined) workspace = args[(i += 1)];
    else if (arg.startsWith("--")) {
      process.stderr.write(
        `hzcode: commit: unknown option ${arg}\nusage: hzcode commit [--preview] [--receipt] [--attribute-coauthor <email>] [context...]\n`,
      );
      return 2;
    } else context.push(arg);
  }
  workspace = path.resolve(workspace);
  const staged = stagedDiff(workspace);
  if ("error" in staged) {
    process.stderr.write(`hzcode: commit: ${staged.error}\n`);
    return 1;
  }
  if (staged.diff.trim() === "") {
    process.stderr.write("hzcode: commit: nothing is staged (git add something first)\n");
    return 1;
  }
  const mod = core as unknown as CoreModule;
  const createRuntime = typeof mod.createRuntime === "function" ? mod.createRuntime : mod?.default?.createRuntime;
  if (typeof createRuntime !== "function") {
    process.stderr.write("hzcode: the runtime is missing from this build (app/src/core)\n");
    return 1;
  }
  let runtime: Runtime;
  try {
    runtime = await createRuntime({ workspace, mock, permissionMode: "default" });
  } catch (err) {
    process.stderr.write(`\u26a0 could not start a session: ${errorMessage(err)}\n`);
    return 1;
  }
  const extras = runtime as Runtime & {
    runGuardedShell?: (command: string) => Promise<{ ok: boolean; output: string }>;
    receiptHead?: () => string | undefined;
  };
  try {
    const ui = createApprovalUi(Boolean(process.stdin.isTTY));
    ui.runtime = runtime;
    installApprovalHandler(ui);
    const res = await runtime.send(commitPrompt(staged.diff, staged.truncated, context.join(" ")), { onEvent: () => {} });
    let message = cleanCommitMessage(res.text);
    if (res.aborted || message === "") {
      process.stderr.write("hzcode: commit: no message was produced\n");
      return 1;
    }
    message = appendAttributionToMessage(message, attribution);
    // The head named in the trailer is the chain as it stands when the commit
    // is made; the commit's own receipt comes after it.
    const head = receipt ? extras.receiptHead?.() : undefined;
    const finalMessage = withReceiptTrailer(message, head);
    if (receipt && head === undefined) process.stderr.write("hzcode: commit: no receipt chain head yet; no trailer added\n");
    if (preview) {
      process.stdout.write(finalMessage + "\n");
      return 0;
    }
    if (typeof extras.runGuardedShell !== "function") {
      process.stderr.write("hzcode: commit: this build cannot run a guarded command\n");
      return 1;
    }
    const out = await extras.runGuardedShell(commitCommand(finalMessage));
    process.stdout.write(out.output.trim() + "\n");
    return out.ok ? 0 : 1;
  } finally {
    try {
      await runtime.close();
    } catch {
      /* already closed */
    }
  }
}

async function main(): Promise<number> {
  // Subcommand dispatch happens before the chat-first arg parse so no existing
  // flag behaviour changes: `serve` is additive, everything else is unchanged.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "commit") return runCommitCommand(rawArgs.slice(1));
  if (rawArgs[0] === "suggest") return runSuggestCommand(rawArgs.slice(1));
  if (rawArgs[0] === "models") return runModelsCommand(rawArgs.slice(1));
  if (rawArgs[0] === "login" || rawArgs[0] === "logout") return runLoginCommand(rawArgs);
  if (rawArgs[0] === "config") return runConfigCommand(rawArgs.slice(1));
  if (rawArgs[0] === "keybind") return runKeybindCommand(rawArgs.slice(1));
  if (rawArgs[0] === "tui") return runTuiCommand(rawArgs.slice(1));
  if (rawArgs[0] === "doctor") return runDoctorCommand(rawArgs.slice(1));
  if (rawArgs[0] === "receipt") return runReceiptCommand(rawArgs.slice(1));
  if (rawArgs[0] === "effect") return runEffectCommand(rawArgs.slice(1));
  if (rawArgs[0] === "session") return runSessionCommand(rawArgs.slice(1));
  if (rawArgs[0] === "serve") {
    const serveOpts = parseArgs(rawArgs.slice(1));
    if (serveOpts.errors.length > 0) {
      for (const message of serveOpts.errors) process.stderr.write(`hzcode: ${message}\n`);
      process.stderr.write("try 'hzcode --help'\n");
      return 2;
    }
    const serveWorkspace = path.resolve(serveOpts.workspace);
    try {
      if (!fs.existsSync(serveWorkspace) || !fs.statSync(serveWorkspace).isDirectory()) {
        process.stderr.write(`hzcode: not a folder: ${serveWorkspace}\n`);
        return 2;
      }
    } catch (err) {
      process.stderr.write(`hzcode: cannot use ${serveWorkspace}: ${errorMessage(err)}\n`);
      return 2;
    }
    return runServe(serveOpts, serveWorkspace);
  }

  const opts = parseArgs(process.argv.slice(2));

  if (opts.errors.length > 0) {
    for (const message of opts.errors) process.stderr.write(`hzcode: ${message}\n`);
    process.stderr.write("try 'hzcode --help'\n");
    return 2;
  }
  if (opts.outputFormat !== undefined && !opts.print) {
    process.stderr.write("hzcode: --output-format needs -p\n");
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`hzcode ${VERSION}\n`);
    return 0;
  }

  const workspace = path.resolve(opts.workspace);
  // `hzcode run <name> [args]` runs a .hz/commands file as a print-mode turn.
  // It only applies when such a command exists, so "run the tests" stays chat.
  const runMatch = !opts.print ? /^run\s+(\S+)(?:\s+([\s\S]*))?$/.exec(opts.initialMessage ?? "") : null;
  if (runMatch && resolveCommandForMessage(workspace, "/" + runMatch[1])) {
    opts.print = true;
    opts.printText = `/${runMatch[1]} ${runMatch[2] ?? ""}`.trim();
    opts.initialMessage = undefined;
  }
  try {
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
      process.stderr.write(`hzcode: not a folder: ${workspace}\n`);
      return 2;
    }
  } catch (err) {
    process.stderr.write(`hzcode: cannot use ${workspace}: ${errorMessage(err)}\n`);
    return 2;
  }

  if (opts.worktree !== undefined) {
    return runWorktreeBootstrap(opts, workspace);
  }

  if (opts.showPrompts) {
    const config = cliConfig(workspace, opts);
    const request = buildShowPromptsRequest({ workspace, config, model: config.model });
    process.stdout.write(renderShowPrompts(request));
    return 0;
  }

  if (opts.showRepoMap) {
    process.stdout.write(buildShowRepoMap({ workspace }));
    return 0;
  }

  if (opts.listModels) {
    const config = cliConfig(workspace, opts);
    const catalog = loadCatalog(process.env);
    const provider = String(config.resolved?.name ?? config.provider);
    const ids = filterModelIds(modelIdsForProvider(provider, config, catalog), opts.listModelsFilter);
    if (ids.length === 0) {
      const hint = opts.listModelsFilter !== undefined && opts.listModelsFilter !== "" ? ` matching ${opts.listModelsFilter}` : "";
      process.stdout.write(`(no models for provider ${provider}${hint})\n`);
    } else {
      for (const id of ids) process.stdout.write(`${id}\n`);
    }
    return 0;
  }

  const config = cliConfig(workspace, opts);
  const catalog = loadCatalog(process.env);
  const provider = String(config.resolved?.name ?? config.provider);
  if (!isKnownModel(provider, config.model, config, catalog)) {
    const pool = modelIdsForProvider(provider, config, catalog);
    const suggestions = suggestModelIds(
      config.model,
      pool.length > 0 ? pool : allCatalogModelIds(config, catalog),
    );
    process.stderr.write(`hzcode: ${formatDidYouMean(config.model, suggestions)}\n`);
    return 2;
  }

  // A human is attached when they typed into a terminal; a pipe is a script.
  // -p is always a script: never a chat bar, never an approval prompt.
  const interactive = !opts.print && Boolean(process.stdin.isTTY);

  const screenMode = resolveTuiScreenMode(process.env as Record<string, string | undefined>, opts.tuiScreenMode);
  let printPrompt = "";
  if (opts.print) {
    printPrompt = [opts.printText, opts.initialMessage].filter((x) => x !== undefined && x !== "").join(" ");
    if (printPrompt.trim() === "" && !process.stdin.isTTY) {
      try {
        printPrompt = await Bun.stdin.text();
      } catch {
        printPrompt = "";
      }
    }
    if (printPrompt.trim() === "") {
      process.stderr.write("hzcode: -p needs a prompt (as text or on stdin)\n");
      return 2;
    }
  }

  const mod = core as unknown as CoreModule;
  const createRuntime = typeof mod.createRuntime === "function" ? mod.createRuntime : mod?.default?.createRuntime;
  if (typeof createRuntime !== "function") {
    process.stderr.write("hzcode: the runtime is missing from this build (app/src/core)\n");
    return 1;
  }

  let runtime: Runtime;
  try {
    runtime = await createRuntime({
      workspace,
      model: opts.model,
      continueSession: opts.continueSession,
      mock: opts.mock,
      budget: opts.budget,
      permissionMode: opts.permissionMode,
    });
  } catch (err) {
    process.stderr.write(`\u26a0 could not start a session: ${errorMessage(err)}\n`);
    process.stderr.write("  (the runtime lives in app/src/core \u2014 nothing else is needed to start chatting)\n");
    return 1;
  }

  // A non-default mode is never silent: -p and pipes get one stderr line (the
  // chat shows a badge and its own notice).
  const startMode = (runtime as { permissionMode?: () => PermissionMode }).permissionMode?.call(runtime);
  if (!interactive && startMode !== undefined && startMode !== "default") {
    process.stderr.write(`hzcode: permission mode ${describeMode(startMode)}\n`);
  }

  // Approvals: the guard asks, the chat surface answers (deny when nobody can).
  const ui = createApprovalUi(interactive);
  ui.runtime = runtime;
  if (!installApprovalHandler(ui)) {
    process.stderr.write("hzcode: this build has no approval hook \u2014 actions that need a yes will be refused\n");
  }

  // SIGTERM -> graceful shutdown: stop the current turn, close the session, and
  // exit 143 (docs/14 §3.2) — a supervisor that stopped the run must be able to
  // tell it did, so this is not 0.
  const stop = (): void => {
    try {
      runtime.abort();
    } catch {
      /* nothing in flight */
    }
    void Promise.resolve(runtime.close()).catch(() => {
      /* closing on the way out */
    });
    const timer = setTimeout(() => process.exit(143), 300);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  };
  process.once("SIGTERM", stop);

  const handoff = interactive ? consumeTuiHandoff(workspace) : undefined;
  if (handoff !== undefined && handoff.sessionId !== runtime.sessionId) {
    process.stderr.write(
      `hzcode: relaunch handoff targets session ${handoff.sessionId}; current is ${runtime.sessionId} (draft discarded)\n`,
    );
  }

  try {
    if (interactive) {
      const interactiveOpts = {
        runtime,
        workspace,
        version: VERSION,
        ui,
        initialMessage: opts.initialMessage,
        resumedDraft:
          handoff !== undefined && handoff.sessionId === runtime.sessionId ? handoff.draft : undefined,
        skipResumePickerOnStart:
          opts.continueSession || (opts.initialMessage !== undefined && opts.initialMessage.trim() !== ""),
      };
      if (isFullscreenChatMode(screenMode)) {
        return await runFullscreenExperimentalChat(interactiveOpts);
      }
      return await runInteractive(interactiveOpts);
    }
    if (opts.print) {
      // `-p "/name args"` expands a custom command file; anything else is untouched.
      const custom = resolveCommandForMessage(workspace, printPrompt.trim());
      return await runPrint({ runtime, prompt: custom ? custom.prompt : printPrompt.trim(), format: opts.outputFormat ?? "text" });
    }
    return await runHeadless({ runtime, initialMessage: opts.initialMessage });
  } finally {
    try {
      await runtime.close();
    } catch {
      /* already closed */
    }
  }
}

// A closed pipe (`hzcode | head`) is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err && err.code === "EPIPE") process.exit(0);
});

void main().then(
  (code) => {
    process.exitCode = code;
    // Safety net: if some stray handle keeps the loop alive, still leave cleanly.
    const timer = setTimeout(() => process.exit(code), 1000);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  },
  (err) => {
    process.stderr.write(`hzcode: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  },
);
