/**
 * Opt-in EffectHost mutation precursor (rulings **278**, **280**, **281**, **287**).
 *
 * When `HZ_EFFECT_HOST_KERNEL=1` or `=default`, eligible `write` / `edit` / simple `shell` calls
 * may execute via kernel `effect.execute` (sandboxRoot = workspace) after guard
 * approval in `loop.ts`. One-step Add/exact-Update/Delete/Move,
 * same-file exact multi-hunk Update collapsed into one whole-file write,
 * and structural `ast_edit` one/multiple complete matches may kernel-route.
 * Multi-file/ambiguous/Bun-only-first-hit fuzz remain unsupported. Eligible projections that cannot run may use Bun in non-strict mode;
 * shape-ineligible write/edit/apply_patch/ast_edit are refused by the loop. A Rust refusal or uncertain kernel transport result NEVER falls back to Bun.
 * Kernel still owns the routed write bytes; TS
 * records the change journal after settled write/edit (**281**); kernel owns
 * temp+rename atomic write under sandboxRoot (**283**). Since ruling **349**,
 * explicit Rust refusals and lost effect.execute replies NEVER fall back to Bun,
 * and unsupported multi-operation apply_patch (rename/Bun-first-hit/mixed) refuses
 * BEFORE any write. Ruling **353** collapses same-file exact multi-hunks into
 * one whole-file write; ruling **539** routes multi-file exact Add/Update
 * projections through one reduced kernel `fs.batch` under a single OwnerLog lock.
 * Ruling **646**: same-file multi-hunk + multi-file batch also accept *kernel-unique*
 * fuzzy chunks (trim/relative-indent/unicode-fold/line-patch/dominant/Levenshtein)
 * when `HZ_EFFECT_HOST_EDIT_REPAIR=1` resolves them — Bun first-hit score fuzz stays Bun-only.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex, type KernelRequestMap, type ToolResult } from "../contracts";
import { KernelRefusal, type KernelClient } from "./kernel";
import type { KernelExecutePostimageObserve } from "./receipt-postimage";
import { analyzeShellCompound } from "./shell-split";
import { formatExecOutputForModel } from "../tools/exec-output-format";
import {
  BEFORE_MAX_BYTES,
  bindJournalWorkspace,
  consumeChangeGuarded,
  recordChangeGuarded,
  reloadFromDisk,
  unpersistedEntries,
  type ChangeEntry,
} from "../tools/change-journal";
import { relPath, resolvePath, resolveRealTarget } from "../tools/helpers";
import { parse } from "../tools/apply-patch-parser";
import {
  classifyApplyPatchChunkKernelFuzz,
  resolveKernelApplyPatchChunkEdit,
} from "../tools/apply-patch-kernel-fuzz";
import {
  applyPatchArgsEligibleForKernelRoute,
  applyPatchKernelProjections,
  applyPatchProjectionMissRequireDetail,
  astEditArgsEligibleForKernelRoute,
  astEditKernelProjection,
  astEditKernelAtomicMultiProjection,
  refreshApplyPatchFileCache,
  resolveApplyPatchEditProjectionStep,
  type KernelToolProjection,
} from "./effect-kernel-tool-projection";

function kernelProjectionPath(proj: KernelToolProjection): string {
  if (proj.kind === "rename") return `${proj.from}→${proj.to}`;
  return proj.path;
}

import { kernelFsMutationSuccessOutput } from "./effect-evidence";

const KERNEL_ROUTE_TAG = "[effect-host-kernel]";

/** A thrown kernel error is final. Returning undefined would let the loop treat
 * the attempt as "not routed" and run ambient Bun. KernelRefusal covers an
 * OwnerLog UNKNOWN or a denied policy decision; any other throw (transport
 * down, unexpected failure) is the same class of miss (**958**). */
function refusedKernelRoute(
  error: unknown,
  journalSkipped: boolean,
): KernelMutationRouteOutcome {
  const reason = error instanceof KernelRefusal
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
  const message = `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: kernel mutation refused — ${reason}`;
  return {
    journalSkipped,
    kernelObserve: {},
    result: { ok: false, output: message, error: message },
  };
}

/** Emitted only when kernel write/edit succeeded but change-journal recording failed. */
export const EFFECT_HOST_KERNEL_JOURNAL_FAIL_NOTICE =
  `${KERNEL_ROUTE_TAG} kernel write/edit succeeded but change-journal record failed (undo/rewind may miss this mutation)`;

export type EffectHostKernelMode = "off" | "opt-in" | "default" | "require";

export function effectHostKernelMode(
  env: Record<string, string | undefined> = process.env,
): EffectHostKernelMode {
  const raw = env.HZ_EFFECT_HOST_KERNEL?.trim().toLowerCase();
  if (raw === "require") return "require";
  if (raw === "default") return "default";
  if (raw === "1" || raw === "true" || raw === "yes") return "opt-in";
  return "off";
}

/** Routes eligible mutations like `=1`; `=default` is the documented prototype posture (ruling **299**). */
export function effectHostKernelRoutesLikeOptIn(mode: EffectHostKernelMode): boolean {
  return mode === "opt-in" || mode === "default";
}

export function effectHostKernelMutationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return effectHostKernelMode(env) !== "off";
}

export function effectHostKernelRequireMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return effectHostKernelMode(env) === "require";
}

export function writeArgsEligibleForKernelRoute(args: Record<string, unknown>): boolean {
  return typeof args.path === "string" && args.path !== "" && typeof args.content === "string";
}

export function editArgsEligibleForKernelRoute(args: Record<string, unknown>): boolean {
  if (args.start_anchor !== undefined) return false;
  if (args.all === true) return false;
  return (
    typeof args.path === "string" &&
    args.path !== "" &&
    typeof args.old === "string" &&
    args.old !== "" &&
    typeof args.new === "string"
  );
}

export function shellArgsEligibleForKernelRoute(args: Record<string, unknown>): boolean {
  if (typeof args.command !== "string" || args.command.trim() === "") return false;
  if (args.timeoutMs !== undefined) return false;
  return simpleShellArgvFromCommand(args.command) !== undefined;
}

export type ShellKernelRouteMissReason =
  | "empty"
  | "timeout_arg"
  | "compound"
  | "unparsed"
  | "metachar"
  | "inline_env"
  | "interpreter";

export function classifyShellKernelRouteMiss(
  command: string,
  opts?: { timeoutMs?: unknown },
): { reason: ShellKernelRouteMissReason; unparsedSubreason?: string } | undefined {
  if (opts?.timeoutMs !== undefined) return { reason: "timeout_arg" };
  const trimmed = command.trim();
  if (trimmed === "") return { reason: "empty" };
  const analysis = analyzeShellCompound(trimmed);
  if (analysis.ok === false) {
    return { reason: "unparsed", unparsedSubreason: analysis.reason };
  }
  if (analysis.compound) return { reason: "compound" };
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return { reason: "inline_env" };
  if (/[|;&<>$`()\\]/.test(trimmed)) return { reason: "metachar" };
  if (simpleShellArgvFromCommand(trimmed) !== undefined) return undefined;
  return { reason: "interpreter" };
}

export function shellKernelRouteMissRequireDetail(
  miss: { reason: ShellKernelRouteMissReason; unparsedSubreason?: string },
): string {
  switch (miss.reason) {
    case "empty":
      return "empty shell command cannot kernel-route";
    case "timeout_arg":
      return "shell timeoutMs is Bun-owned — cannot kernel-route under require";
    case "compound":
      return "compound shell command cannot kernel-route (ambient Bun shell refused under require)";
    case "unparsed":
      return `shell command not safely splittable (${miss.unparsedSubreason ?? "unparsed"}) — ambient Bun shell refused under require`;
    case "metachar":
      return "shell metacharacters imply interpreter — cannot kernel-route under require";
    case "inline_env":
      return "inline VAR= assignment shell prefix — cannot kernel-route under require";
    case "interpreter":
      return "shell interpreter invocation — cannot kernel-route under require";
    default:
      return "shell command cannot kernel-route under require";
  }
}

/** Shape classes named in the no-ambient shell detail (ruling **652** / **957**). */
const SHELL_NO_AMBIENT_MISS = new Set<ShellKernelRouteMissReason>([
  "compound",
  "unparsed",
  "metachar",
  "inline_env",
  "interpreter",
  "timeout_arg",
  "empty",
]);

export const EFFECT_HOST_KERNEL_NO_AMBIENT_SHELL_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL on: refused — compound/interpreter shell cannot ambient Bun-fallback";

/**
 * P0-1 / rulings **652** / **957** / **958**: when EffectHost is `=1` or
 * `=default`, an unrouted shell does not run in ambient Bun. That covers
 * compound/interpreter/metachar, `timeoutMs`, an empty command, and a
 * shape-eligible argv whose kernel route returned no outcome (cwd escape or
 * a throw that was not yet final). `=require` names these through its own
 * refusal, so this helper stays inert there.
 */
export function effectHostNoAmbientCompoundShellRefusal(
  tool: string,
  args: Record<string, unknown>,
  kernelRouted: boolean,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!effectHostKernelMutationEnabled(env)) return undefined;
  if (tool !== "shell" || kernelRouted) return undefined;
  const mode = effectHostKernelMode(env);
  if (mode === "require") return undefined;
  const command = typeof args.command === "string" ? args.command : "";
  const miss = classifyShellKernelRouteMiss(command, { timeoutMs: args.timeoutMs });
  const detail = miss === undefined
    ? "shell kernel route unavailable"
    : SHELL_NO_AMBIENT_MISS.has(miss.reason)
      ? shellKernelRouteMissRequireDetail(miss).replace(/ under require$/, " when EffectHost is on")
      : "shell kernel route unavailable";
  return `${EFFECT_HOST_KERNEL_NO_AMBIENT_SHELL_NOTICE} (${detail})`;
}

export const EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE =
  "[effect-host-kernel] HZ_EFFECT_HOST_KERNEL on: refused — shape-ineligible mutation cannot ambient Bun-fallback";

/**
 * P0-1 / ruling **667**: when EffectHost mutation routing is on (`=1`/`=default`),
 * refuse write/edit/apply_patch/ast_edit that cannot kernel-route at the args
 * shape instead of ambient Bun fallback (require uses **649** preflight/refusal).
 * Eligible shapes that miss kernel transport still Bun-fallback under non-require.
 */
export function effectHostNoAmbientShapeIneligibleMutationRefusal(
  tool: string,
  args: Record<string, unknown>,
  kernelRouted: boolean,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!effectHostKernelMutationEnabled(env)) return undefined;
  if (kernelRouted) return undefined;
  const mode = effectHostKernelMode(env);
  if (mode === "require") return undefined;
  if (tool === "write" && !writeArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE} (write args ineligible for kernel fs.write)`;
  }
  if (tool === "edit" && !editArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE} (edit args ineligible for kernel fs.edit)`;
  }
  if (tool === "apply_patch" && !applyPatchArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE} (${applyPatchProjectionMissRequireDetail("shape_ineligible")})`;
  }
  if (tool === "ast_edit" && !astEditArgsEligibleForKernelRoute(args)) {
    return `${EFFECT_HOST_KERNEL_NO_AMBIENT_SHAPE_MUTATION_NOTICE} (ast_edit args ineligible for kernel fs.edit)`;
  }
  return undefined;
}

export type KernelExecuteObserveSnap = KernelExecutePostimageObserve & {
  exitCode?: number;
  stdoutDigest?: string;
  stderrDigest?: string;
};

export type KernelMutationRouteOutcome = {
  result: ToolResult;
  kernelObserve: KernelExecuteObserveSnap;
  /** True for shell when the kernel path ran (no file journal). */
  journalSkipped: boolean;
  /** True when write/edit journal record could not be attached (notice only). */
  journalRecordFailed?: boolean;
  /** Fresh one-use lease minted for EffectHost transfer (shell admittedByLoop). */
  issuedLease?: { leaseId: string; kind: string; target: string; expiresAt: string };
};

function workspaceRelPath(workspace: string, rawPath: string): string | undefined {
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspace, rawPath);
  const rel = path.relative(workspace, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  if (rel === "" || rel === ".") return ".";
  return rel.split(path.sep).join(path.sep);
}

function specPathInWorkspace(workspace: string, rawPath: string): string | undefined {
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspace, rawPath);
  const rel = path.relative(workspace, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  if (rel === "" || rel === ".") return path.basename(resolved);
  return rel.split(path.sep).join(path.sep);
}

export function kernelExecuteObserveFromResult(
  result: KernelRequestMap["effect.execute"]["result"],
): KernelExecuteObserveSnap {
  return {
    contentDigest: result.contentDigest,
    postimageObservationStable: result.postimageObservationStable,
    postimageConfirmDigest: result.postimageConfirmDigest,
    resultDigest: result.resultDigest,
    resultDigestStable: result.resultDigestStable,
    exitCode: result.exitCode,
    stdoutDigest: result.stdoutDigest,
    stderrDigest: result.stderrDigest,
  };
}

type JournalFlags = {
  journalSkipped: boolean;
  journalRecordFailed?: boolean;
};

function outcomeFromExecuteResult(
  result: KernelRequestMap["effect.execute"]["result"],
  okOutput: string,
  failOutput: string,
  journal: JournalFlags,
): KernelMutationRouteOutcome {
  const kernelObserve = kernelExecuteObserveFromResult(result);
  if (result.verdict !== "settled") {
    return {
      journalSkipped: journal.journalSkipped,
      journalRecordFailed: journal.journalRecordFailed,
      kernelObserve,
      result: {
        ok: false,
        output: failOutput,
        error: failOutput,
      },
    };
  }
  return {
    journalSkipped: journal.journalSkipped,
    journalRecordFailed: journal.journalRecordFailed,
    kernelObserve,
    result: { ok: true, output: okOutput },
  };
}

async function readUtf8Preimage(
  resolved: string,
): Promise<{ before: string | null; beforeUnreadable?: boolean }> {
  if (!existsSync(resolved)) return { before: null };
  try {
    const buf = await readFile(resolved);
    if (buf.includes(0)) return { before: null, beforeUnreadable: true };
    return { before: buf.toString("utf8") };
  } catch {
    return { before: null, beforeUnreadable: true };
  }
}

async function afterSha256ForKernelMutation(
  resolved: string,
  contentDigest: string | undefined,
): Promise<string | undefined> {
  if (typeof contentDigest === "string" && contentDigest !== "") return contentDigest;
  try {
    const text = (await readFile(resolved)).toString("utf8");
    return sha256Hex(text);
  } catch {
    return undefined;
  }
}

async function recordKernelFsJournal(
  sessionId: string,
  workspace: string,
  resolved: string,
  rel: string,
  tool: "write" | "edit",
  preimage: { before: string | null; beforeUnreadable?: boolean },
  afterSha256: string | undefined,
): Promise<boolean> {
  if (afterSha256 === undefined) return false;
  bindJournalWorkspace(sessionId, workspace);
  try {
    await recordChangeGuarded(sessionId, {
      path: resolved,
      rel,
      before: preimage.before,
      ...(preimage.beforeUnreadable ? { beforeUnreadable: true } : {}),
      afterSha256,
      at: Date.now(),
      tool,
    });
    return true;
  } catch {
    return false;
  }
}

export async function tryKernelWriteRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  args: Record<string, unknown>,
  opts?: { skipJournal?: boolean },
): Promise<KernelMutationRouteOutcome | undefined> {
  const rel = specPathInWorkspace(workspace, String(args.path));
  if (rel === undefined) return undefined;
  const resolved = path.isAbsolute(String(args.path))
    ? path.resolve(String(args.path))
    : path.resolve(workspace, String(args.path));
  try {
    const preimage = await readUtf8Preimage(resolved);
    // Multi-hunk projection may carry an *earlier* file digest. Never pin
    // only the second pre-read: a change between projection and dispatch
    // would otherwise turn a stale plan into an authorized overwrite.
    const plannedDigest = args.expectedPreimageDigest;
    if (plannedDigest !== undefined &&
      (typeof plannedDigest !== "string" || !/^[a-f0-9]{64}$/.test(plannedDigest) ||
        preimage.before === null || sha256Hex(preimage.before) !== plannedDigest)) {
      const message = `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: stale or unreadable expected preimage; write refused before kernel execution`;
      return {
        journalSkipped: false,
        kernelObserve: {},
        result: { ok: false, output: message, error: message },
      };
    }
    const result = await kernel.executeEffect({
      effectId,
      sandboxRoot: workspace,
      dispatch: {
        kind: "fs.write",
        spec: {
          path: rel,
          text: String(args.content),
          // Kernel checks the caller's pre-read bytes independently under
          // the OwnerLog lock; null asserts this is a new (missing) file.
          ...(typeof plannedDigest === "string"
            ? { expectedPreimageDigest: plannedDigest }
            : preimage.before !== null
              ? { expectedPreimageDigest: sha256Hex(preimage.before) }
              : !existsSync(resolved)
                ? { expectedPreimageDigest: null }
                : {}),
        },
      },
    });
    let journalRecordFailed: boolean | undefined;
    const journalSkipped = opts?.skipJournal === true;
    if (result.verdict === "settled" && !journalSkipped) {
      const afterSha256 = await afterSha256ForKernelMutation(resolved, result.contentDigest);
      const recorded = await recordKernelFsJournal(
        sessionId,
        workspace,
        resolved,
        rel,
        "write",
        preimage,
        afterSha256,
      );
      if (!recorded) journalRecordFailed = true;
    }
    return outcomeFromExecuteResult(
      result,
      kernelFsMutationSuccessOutput("write", rel, result.contentDigest),
      `${KERNEL_ROUTE_TAG} kernel fs.write ${result.verdict}${
        result.postimageObservationStable === false ? " (postimage observation unstable)" : ""
      }`,
      { journalSkipped, journalRecordFailed },
    );
  } catch (error) {
    return refusedKernelRoute(error, false);
  }
}

export async function tryKernelEditRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  args: Record<string, unknown>,
): Promise<KernelMutationRouteOutcome | undefined> {
  const rel = specPathInWorkspace(workspace, String(args.path));
  if (rel === undefined) return undefined;
  const resolved = path.isAbsolute(String(args.path))
    ? path.resolve(String(args.path))
    : path.resolve(workspace, String(args.path));
  try {
    const preimage = await readUtf8Preimage(resolved);
    if (preimage.before === null && !preimage.beforeUnreadable) {
      const msg = `${KERNEL_ROUTE_TAG} kernel fs.edit refused: file missing (${rel})`;
      return {
        journalSkipped: false,
        kernelObserve: {},
        result: { ok: false, output: msg, error: msg },
      };
    }
    const result = await kernel.executeEffect({
      effectId,
      sandboxRoot: workspace,
      dispatch: {
        kind: "fs.edit",
        spec: {
          path: rel,
          oldString: String(args.old),
          newString: String(args.new),
          ...(preimage.before !== null
            ? { expectedPreimageDigest: sha256Hex(preimage.before) }
            : {}),
        },
      },
    });
    let journalRecordFailed: boolean | undefined;
    if (result.verdict === "settled") {
      const afterSha256 = await afterSha256ForKernelMutation(resolved, result.contentDigest);
      const recorded = await recordKernelFsJournal(
        sessionId,
        workspace,
        resolved,
        rel,
        "edit",
        preimage,
        afterSha256,
      );
      if (!recorded) journalRecordFailed = true;
    }
    return outcomeFromExecuteResult(
      result,
      kernelFsMutationSuccessOutput("edit", rel, result.contentDigest),
      `${KERNEL_ROUTE_TAG} kernel fs.edit ${result.verdict}${
        result.postimageObservationStable === false ? " (postimage observation unstable)" : ""
      }`,
      { journalSkipped: false, journalRecordFailed },
    );
  } catch (error) {
    return refusedKernelRoute(error, false);
  }
}

function skipShellWord(command: string, start: number): number | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        if (i + 1 >= command.length) return null;
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) return null;
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") return i;
  }
  return inSingle || inDouble ? null : command.length;
}

function unquoteShellWord(word: string): string {
  if (word.length >= 2 && word.startsWith("'") && word.endsWith("'")) {
    return word.slice(1, -1);
  }
  if (word.length >= 2 && word.startsWith('"') && word.endsWith('"')) {
    return word
      .slice(1, -1)
      .replace(/\\(.)/g, "$1");
  }
  return word;
}

/**
 * Hermetic argv for kernel `shell.exec` — refuses compound shell strings and
 * metacharacters that imply a shell interpreter (ruling **280**).
 */
export function simpleShellArgvFromCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (trimmed === "") return undefined;
  const analysis = analyzeShellCompound(trimmed);
  if (!analysis.ok || analysis.compound) return undefined;
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return undefined;
  if (/[|;&<>$`()\\]/.test(trimmed)) return undefined;
  const argv: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    while (trimmed[i] === " " || trimmed[i] === "\t") i++;
    if (i >= trimmed.length) break;
    const end = skipShellWord(trimmed, i);
    if (end === null) return undefined;
    const word = unquoteShellWord(trimmed.slice(i, end));
    if (word === "" || /[\0\n\r]/.test(word)) return undefined;
    argv.push(word);
    i = end;
  }
  if (argv.length === 0) return undefined;
  const program = argv[0]!.toLowerCase();
  const shellInterpreters = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"]);
  if (shellInterpreters.has(program) || argv.includes("-c")) return undefined;
  return argv;
}

export async function tryKernelRenameRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  args: Record<string, unknown>,
): Promise<KernelMutationRouteOutcome | undefined> {
  const fromRel = specPathInWorkspace(workspace, String(args.from));
  const toRel = specPathInWorkspace(workspace, String(args.to));
  if (fromRel === undefined || toRel === undefined) return undefined;
  const fromResolved = path.isAbsolute(String(args.from))
    ? path.resolve(String(args.from))
    : path.resolve(workspace, String(args.from));
  const toResolved = path.isAbsolute(String(args.to))
    ? path.resolve(String(args.to))
    : path.resolve(workspace, String(args.to));
  try {
    const sourcePre = await readUtf8Preimage(fromResolved);
    const destPre = await readUtf8Preimage(toResolved);
    if (sourcePre.before === null && !sourcePre.beforeUnreadable) {
      const msg = `${KERNEL_ROUTE_TAG} kernel fs.rename refused: source missing (${fromRel})`;
      return {
        journalSkipped: false,
        kernelObserve: {},
        result: { ok: false, output: msg, error: msg },
      };
    }
    const result = await kernel.executeEffect({
      effectId,
      sandboxRoot: workspace,
      dispatch: {
        kind: "fs.rename",
        spec: {
          from: fromRel, to: toRel,
          ...(sourcePre.before !== null
            ? { expectedPreimageDigest: sha256Hex(sourcePre.before) }
            : {}),
        },
      },
    });
    let journalRecordFailed: boolean | undefined;
    if (result.verdict === "settled") {
      const afterSha256 = await afterSha256ForKernelMutation(toResolved, result.contentDigest);
      const destRecorded = await recordKernelFsJournal(
        sessionId,
        workspace,
        toResolved,
        toRel,
        "write",
        destPre,
        afterSha256,
      );
      const srcRecorded = await recordKernelFsJournal(
        sessionId,
        workspace,
        fromResolved,
        fromRel,
        "write",
        sourcePre,
        sha256Hex(""),
      );
      if (!destRecorded || !srcRecorded) journalRecordFailed = true;
    }
    return outcomeFromExecuteResult(
      result,
      kernelFsMutationSuccessOutput("rename", toRel, result.contentDigest, fromRel),
      `${KERNEL_ROUTE_TAG} kernel fs.rename ${result.verdict}${
        result.postimageObservationStable === false ? " (postimage observation unstable)" : ""
      }`,
      { journalSkipped: false, journalRecordFailed },
    );
  } catch (error) {
    return refusedKernelRoute(error, false);
  }
}

export async function tryKernelDeleteRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  args: Record<string, unknown>,
  opts?: { skipJournal?: boolean },
): Promise<KernelMutationRouteOutcome | undefined> {
  const rel = specPathInWorkspace(workspace, String(args.path));
  if (rel === undefined) return undefined;
  const resolved = path.isAbsolute(String(args.path))
    ? path.resolve(String(args.path))
    : path.resolve(workspace, String(args.path));
  try {
    const preimage = await readUtf8Preimage(resolved);
    if (preimage.before === null && !preimage.beforeUnreadable) {
      const msg = `${KERNEL_ROUTE_TAG} kernel fs.delete refused: file missing (${rel})`;
      return {
        journalSkipped: false,
        kernelObserve: {},
        result: { ok: false, output: msg, error: msg },
      };
    }
    const result = await kernel.executeEffect({
      effectId,
      sandboxRoot: workspace,
      dispatch: {
        kind: "fs.delete",
        spec: {
          path: rel,
          ...(preimage.before !== null
            ? { expectedPreimageDigest: sha256Hex(preimage.before) }
            : {}),
        },
      },
    });
    const afterSha256 = sha256Hex("");
    let journalRecordFailed: boolean | undefined;
    const journalSkipped = opts?.skipJournal === true;
    if (result.verdict === "settled" && !journalSkipped) {
      const recorded = await recordKernelFsJournal(
        sessionId,
        workspace,
        resolved,
        rel,
        "write",
        preimage,
        afterSha256,
      );
      if (!recorded) journalRecordFailed = true;
    }
    return outcomeFromExecuteResult(
      result,
      kernelFsMutationSuccessOutput("delete", rel, result.contentDigest),
      `${KERNEL_ROUTE_TAG} kernel fs.delete ${result.verdict}${
        result.postimageObservationStable === false ? " (postimage observation unstable)" : ""
      }`,
      { journalSkipped, journalRecordFailed },
    );
  } catch (error) {
    return refusedKernelRoute(error, false);
  }
}

function newestChangeEntry(candidates: ChangeEntry[]): ChangeEntry | undefined {
  if (candidates.length === 0) return undefined;
  let best = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (candidate.at >= best.at) best = candidate;
  }
  return best;
}

/**
 * P0-1 / ruling **650**: route `undo` through kernel `fs.write` / `fs.delete`
 * (skip re-journal; consume the live undo entry on settle). Returns undefined
 * only when EffectHost mutation routing is off for the caller to skip.
 */
export async function tryKernelUndoRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  args: Record<string, unknown>,
): Promise<KernelMutationRouteOutcome | undefined> {
  const softFail = (message: string): KernelMutationRouteOutcome => ({
    journalSkipped: true,
    kernelObserve: {},
    result: { ok: false, output: message, error: message },
  });

  try {
    const scope =
      typeof args.path === "string" && args.path !== "" ? resolvePath(workspace, args.path) : undefined;
    bindJournalWorkspace(sessionId, workspace);
    const load = reloadFromDisk(workspace);
    const candidates = [...load.entries, ...unpersistedEntries(sessionId)];
    const entry =
      scope !== undefined
        ? newestChangeEntry(candidates.filter((e) => e.path === scope))
        : newestChangeEntry(candidates);
    if (entry === undefined) {
      return softFail(
        scope !== undefined
          ? `nothing to undo for ${relPath(workspace, scope)}: this workspace's change journal holds no live change to it`
          : "nothing to undo: this workspace's change journal holds no live change",
      );
    }
    const rel = entry.rel;
    if (entry.beforeUnreadable === true) {
      return softFail(
        `cannot undo the last change to ${rel}: its previous bytes were not restorable text ` +
          `(binary or non-UTF-8), so the journal cannot put them back; the file is untouched`,
      );
    }
    if (entry.nonRestorable === true) {
      return softFail(
        `cannot undo the last change to ${rel}: its previous content was larger than the journal keeps ` +
          `(nonRestorable: over the ${BEFORE_MAX_BYTES / 1024} KB per-entry cap), so it cannot be put back`,
      );
    }

    const target = resolveRealTarget(workspace, entry.path, workspace);
    const real = target.real;
    let current: string;
    try {
      current = (await readFile(real)).toString("utf8");
    } catch {
      return softFail(
        `HZ_PRECONDITION_FAILED: undo refused: ${rel} is gone or unreadable; ` +
          `the recorded change expected sha256 ${entry.afterSha256} -- refusing to touch the path`,
      );
    }
    const actual = sha256Hex(current);
    if (actual !== entry.afterSha256) {
      return softFail(
        `HZ_PRECONDITION_FAILED: undo refused: ${rel} changed since the recorded change wrote it ` +
          `(expected sha256 ${entry.afterSha256}; actual sha256 ${actual}); refusing to overwrite a concurrent edit`,
      );
    }

    let outcome: KernelMutationRouteOutcome | undefined;
    if (entry.before === null) {
      outcome = await tryKernelDeleteRoute(
        kernel,
        workspace,
        sessionId,
        effectId,
        { path: real },
        { skipJournal: true },
      );
    } else {
      outcome = await tryKernelWriteRoute(
        kernel,
        workspace,
        sessionId,
        effectId,
        { path: real, content: entry.before, expectedPreimageDigest: entry.afterSha256 },
        { skipJournal: true },
      );
    }
    if (outcome === undefined) {
      return softFail(`${KERNEL_ROUTE_TAG} kernel undo route unavailable for ${rel}`);
    }
    if (outcome.result.ok) {
      await consumeChangeGuarded(sessionId, entry);
      const restored =
        entry.before === null
          ? `Removed ${rel} (kernel undo; existed only because of the last recorded ${entry.tool})`
          : `Restored ${rel} to its content before the last recorded ${entry.tool} (kernel undo)`;
      return {
        ...outcome,
        journalSkipped: true,
        result: { ok: true, output: restored },
      };
    }
    return outcome;
  } catch (error) {
    return refusedKernelRoute(error, true);
  }
}

/** One-file, multiple hunks can be one *atomic file* mutation.
 * Compute the entire postimage WITHOUT writing. Every hunk must resolve to a
 * unique kernel window (exact, or unique repair under `HZ_EFFECT_HOST_EDIT_REPAIR`)
 * in the evolving in-memory copy. Excludes Bun-first-hit / tied / cross-file / move.
 * The original SHA-256 is pinned through to Rust's independent OwnerLog CAS.
 */
async function projectSingleFileAtomicPatch(
  workspace: string,
  args: Record<string, unknown>,
  projections: KernelToolProjection[],
): Promise<{ path: string; content: string; expectedPreimageDigest: string } | undefined> {
  if (projections.length < 2 || !projections.every((p) => p.kind === "edit")) return undefined;
  const patchText = typeof args.input === "string" && args.input !== ""
    ? args.input
    : typeof args.patch === "string" && args.patch !== "" ? args.patch : undefined;
  if (!patchText) return undefined;
  const parsed = parse(patchText);
  if (!parsed.ok || parsed.patch.ops.length !== 1) return undefined;
  const op = parsed.patch.ops[0]!;
  if (op.kind !== "update" || op.movePath !== undefined || op.chunks.length !== projections.length) {
    return undefined;
  }
  const rel = specPathInWorkspace(workspace, op.path);
  if (!rel || rel === ".") return undefined;
  if (projections.some((p) =>
    p.kind !== "edit" || specPathInWorkspace(workspace, p.path) !== rel)) return undefined;
  const absolute = path.resolve(workspace, rel);
  let beforeBuffer: Buffer;
  try {
    beforeBuffer = await readFile(absolute);
  } catch {
    return undefined;
  }
  // Encoding loss in a planned rewrite is never an acceptable fuzzy edit.
  if (beforeBuffer.includes(0)) return undefined;
  const original = beforeBuffer.toString("utf8");
  if (!Buffer.from(original, "utf8").equals(beforeBuffer)) return undefined;

  let current = original;
  for (const chunk of op.chunks) {
    if (chunk.oldLines.length === 0) return undefined;
    if (classifyApplyPatchChunkKernelFuzz(current, chunk) === "bun_fuzz_only") return undefined;
    const resolved = resolveKernelApplyPatchChunkEdit(current, chunk, process.env);
    if (!resolved || resolved.old.length === 0) return undefined;
    const position = current.indexOf(resolved.old);
    if (position < 0 || current.indexOf(resolved.old, position + 1) !== -1) return undefined;
    current = current.slice(0, position) + resolved.new + current.slice(position + resolved.old.length);
  }
  if (current === original) return undefined;
  return { path: rel, content: current, expectedPreimageDigest: sha256Hex(original) };
}

type ExactBatchWrite = {
  path: string;
  content: string;
  expectedPreimageDigest: string | null;
  tool: "write" | "edit";
  before: string | null;
  /**
   * Exact Update hunks → ordered kernel `fs.edit` ops in the same batch
   * (rulings 552/553). Empty/undefined keeps full-file `fs.write`.
   */
  edits?: Array<{ oldString: string; newString: string }>;
};

type ExactBatchRename = {
  kind: "rename";
  from: string;
  to: string;
  expectedPreimageDigest: string | null;
  before: string | null;
};

type ExactBatchDelete = {
  kind: "delete";
  path: string;
  expectedPreimageDigest: string;
  before: string;
};

type ExactBatchPlan = {
  writes: ExactBatchWrite[];
  renames: ExactBatchRename[];
  deletes: ExactBatchDelete[];
};

/** Multi-file Add/Update/Move/Delete → one reduced kernel `fs.batch`
 * (write/edit/rename/delete). Kernel-unique repair hunks allowed under
 * `HZ_EFFECT_HOST_EDIT_REPAIR` (**646**); Bun-first-hit / ambiguous → undefined.
 */
async function projectMultiFileExactBatchPlan(
  workspace: string,
  args: Record<string, unknown>,
): Promise<ExactBatchPlan | undefined> {
  const patchText =
    typeof args.input === "string" && args.input !== ""
      ? args.input
      : typeof args.patch === "string" && args.patch !== ""
        ? args.patch
        : undefined;
  if (!patchText) return undefined;
  const parsed = parse(patchText);
  if (!parsed.ok || parsed.patch.ops.length === 0) return undefined;
  // Single Update+Move (edit then rename) is a multi-op kernel batch even when
  // the patch has one FileOp; otherwise require ≥2 FileOps.
  if (parsed.patch.ops.length < 2) {
    const only = parsed.patch.ops[0];
    if (!(only?.kind === "update" && only.movePath !== undefined)) return undefined;
  }

  const writes: ExactBatchWrite[] = [];
  const renames: ExactBatchRename[] = [];
  const deletes: ExactBatchDelete[] = [];
  for (const op of parsed.patch.ops) {
    if (op.kind === "delete") {
      const rel = specPathInWorkspace(workspace, op.path);
      if (!rel || rel === ".") return undefined;
      const absolute = path.resolve(workspace, rel);
      let beforeBuffer: Buffer;
      try {
        beforeBuffer = await readFile(absolute);
      } catch {
        return undefined;
      }
      if (beforeBuffer.includes(0)) return undefined;
      const original = beforeBuffer.toString("utf8");
      if (!Buffer.from(original, "utf8").equals(beforeBuffer)) return undefined;
      deletes.push({
        kind: "delete",
        path: rel,
        expectedPreimageDigest: sha256Hex(original),
        before: original,
      });
      continue;
    }
    if (op.kind === "add") {
      const rel = specPathInWorkspace(workspace, op.path);
      if (!rel || rel === ".") return undefined;
      const content = op.addBody.join("\n") + (op.addBody.length > 0 ? "\n" : "");
      writes.push({
        path: rel,
        content,
        expectedPreimageDigest: null,
        tool: "write",
        before: null,
      });
      continue;
    }
    if (op.kind === "update") {
      const rel = specPathInWorkspace(workspace, op.path);
      if (!rel || rel === ".") return undefined;
      const absolute = path.resolve(workspace, rel);
      let beforeBuffer: Buffer;
      try {
        beforeBuffer = await readFile(absolute);
      } catch {
        return undefined;
      }
      if (beforeBuffer.includes(0)) return undefined;
      const original = beforeBuffer.toString("utf8");
      if (!Buffer.from(original, "utf8").equals(beforeBuffer)) return undefined;
      let current = original;
      const edits: Array<{ oldString: string; newString: string }> = [];
      for (const chunk of op.chunks) {
        const bytesOld = chunk.oldLines.join("\n");
        const bytesNew = chunk.newLines.join("\n");
        if (bytesOld === bytesNew) continue;
        if (chunk.oldLines.length === 0) return undefined;
        if (classifyApplyPatchChunkKernelFuzz(current, chunk) === "bun_fuzz_only") {
          return undefined;
        }
        const resolved = resolveKernelApplyPatchChunkEdit(current, chunk, process.env);
        if (!resolved || resolved.old.length === 0) return undefined;
        const position = current.indexOf(resolved.old);
        if (position < 0 || current.indexOf(resolved.old, position + 1) !== -1) return undefined;
        current = current.slice(0, position) + resolved.new + current.slice(position + resolved.old.length);
        edits.push({ oldString: resolved.old, newString: resolved.new });
      }
      if (op.movePath !== undefined) {
        const relTo = specPathInWorkspace(workspace, op.movePath);
        if (!relTo || relTo === "." || relTo === rel) return undefined;
        if (edits.length > 0) {
          writes.push({
            path: rel,
            content: current,
            expectedPreimageDigest: sha256Hex(original),
            tool: "edit",
            before: original,
            edits,
          });
        }
        renames.push({
          kind: "rename",
          from: rel,
          to: relTo,
          expectedPreimageDigest: edits.length > 0 ? null : sha256Hex(original),
          before: edits.length > 0 ? null : original,
        });
        continue;
      }
      if (edits.length === 0 || current === original) return undefined;
      writes.push({
        path: rel,
        content: current,
        expectedPreimageDigest: sha256Hex(original),
        tool: "edit",
        before: original,
        // Exact hunks → ordered fs.edit ops (kernel applies same-path edits sequentially).
        edits,
      });
      continue;
    }
    // unknown — not exact write/rename/delete batch
    return undefined;
  }
  if (writes.length + renames.length + deletes.length < 2) return undefined;
  return { writes, renames, deletes };
}

async function tryKernelFsBatchWriteRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  plan: ExactBatchPlan,
): Promise<KernelMutationRouteOutcome> {
  const { writes, renames, deletes } = plan;
  try {
    // Local stale check before RPC so Bun/LocalKernel never mutates a drifted plan.
    for (const w of writes) {
      const resolved = path.resolve(workspace, w.path);
      if (w.expectedPreimageDigest === null) {
        if (existsSync(resolved)) {
          const message = `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: stale or unreadable expected preimage; write refused before kernel execution`;
          return {
            journalSkipped: false,
            kernelObserve: {},
            result: { ok: false, output: message, error: message },
          };
        }
      } else {
        const preimage = await readUtf8Preimage(resolved);
        if (
          preimage.before === null ||
          sha256Hex(preimage.before) !== w.expectedPreimageDigest
        ) {
          const message = `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: stale or unreadable expected preimage; write refused before kernel execution`;
          return {
            journalSkipped: false,
            kernelObserve: {},
            result: { ok: false, output: message, error: message },
          };
        }
      }
    }
    for (const ren of renames) {
      if (ren.expectedPreimageDigest === null) continue;
      const resolved = path.resolve(workspace, ren.from);
      const preimage = await readUtf8Preimage(resolved);
      if (
        preimage.before === null ||
        sha256Hex(preimage.before) !== ren.expectedPreimageDigest
      ) {
        const message = `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: stale or unreadable expected preimage; rename refused before kernel execution`;
        return {
          journalSkipped: false,
          kernelObserve: {},
          result: { ok: false, output: message, error: message },
        };
      }
    }
    for (const del of deletes) {
      const resolved = path.resolve(workspace, del.path);
      const preimage = await readUtf8Preimage(resolved);
      if (
        preimage.before === null ||
        sha256Hex(preimage.before) !== del.expectedPreimageDigest
      ) {
        const message = `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: stale or unreadable expected preimage; delete refused before kernel execution`;
        return {
          journalSkipped: false,
          kernelObserve: {},
          result: { ok: false, output: message, error: message },
        };
      }
    }
    const batchOps: Array<Record<string, unknown>> = [];
    for (const w of writes) {
      if (w.edits && w.edits.length > 0) {
        for (const e of w.edits) {
          batchOps.push({
            kind: "fs.edit",
            path: w.path,
            oldString: e.oldString,
            newString: e.newString,
            expectedPreimageDigest: w.expectedPreimageDigest,
          });
        }
      } else {
        batchOps.push({
          kind: "fs.write",
          path: w.path,
          text: w.content,
          expectedPreimageDigest: w.expectedPreimageDigest,
        });
      }
    }
    for (const ren of renames) {
      batchOps.push({
        kind: "fs.rename",
        from: ren.from,
        to: ren.to,
        ...(ren.expectedPreimageDigest !== null
          ? { expectedPreimageDigest: ren.expectedPreimageDigest }
          : {}),
      });
    }
    for (const del of deletes) {
      batchOps.push({
        kind: "fs.delete",
        path: del.path,
        expectedPreimageDigest: del.expectedPreimageDigest,
      });
    }
    const result = await kernel.executeEffect({
      effectId,
      sandboxRoot: workspace,
      dispatch: {
        kind: "fs.batch",
        spec: { ops: batchOps },
      },
    });
    let journalRecordFailed: boolean | undefined;
    if (result.verdict === "settled") {
      for (let i = 0; i < writes.length; i += 1) {
        const w = writes[i]!;
        const renamedTo = renames.find((r) => r.from === w.path)?.to;
        const journalRel = renamedTo ?? w.path;
        const resolved = path.resolve(workspace, journalRel);
        const digest =
          Array.isArray(result.contentDigests) && typeof result.contentDigests[i] === "string"
            ? (result.contentDigests[i] as string)
            : result.contentDigest;
        const afterSha256 = await afterSha256ForKernelMutation(resolved, digest);
        const recorded = await recordKernelFsJournal(
          sessionId,
          workspace,
          resolved,
          journalRel,
          w.tool,
          { before: w.before },
          afterSha256,
        );
        if (!recorded) journalRecordFailed = true;
      }
      for (const ren of renames) {
        if (writes.some((w) => w.path === ren.from)) continue;
        const resolved = path.resolve(workspace, ren.to);
        const afterSha256 = await afterSha256ForKernelMutation(resolved, result.contentDigest);
        const recorded = await recordKernelFsJournal(
          sessionId,
          workspace,
          resolved,
          ren.to,
          "write",
          { before: ren.before },
          afterSha256,
        );
        if (!recorded) journalRecordFailed = true;
      }
      for (const del of deletes) {
        const resolved = path.resolve(workspace, del.path);
        const recorded = await recordKernelFsJournal(
          sessionId,
          workspace,
          resolved,
          del.path,
          "write",
          { before: del.before },
          sha256Hex(""),
        );
        if (!recorded) journalRecordFailed = true;
      }
    }
    const pathsJoined = [
      ...writes.map((w) => w.path),
      ...renames.map((r) => `${r.from}→${r.to}`),
      ...deletes.map((d) => `delete:${d.path}`),
    ].join(", ");
    const opCount = writes.length + renames.length + deletes.length;
    const okOutput = `${KERNEL_ROUTE_TAG} apply_patch ${opCount} op(s) via kernel fs.batch (${pathsJoined})`;
    return outcomeFromExecuteResult(
      result,
      okOutput,
      `${KERNEL_ROUTE_TAG} kernel fs.batch ${result.verdict}${
        result.postimageObservationStable === false ? " (postimage observation unstable)" : ""
      }`,
      { journalSkipped: false, journalRecordFailed },
    );
  } catch (error) {
    return refusedKernelRoute(error, false);
  }
}

export async function tryKernelApplyPatchRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  args: Record<string, unknown>,
): Promise<KernelMutationRouteOutcome | undefined> {
  const projections = applyPatchKernelProjections(args);
  if (!projections || projections.length === 0) return undefined;
  // Same-file multi-hunk Update → ONE kernel-owned atomic fs.write (exact or
  // kernel-unique repair under HZ_EFFECT_HOST_EDIT_REPAIR — ruling **646**).
  // Multi-file Add/Update/Move/Delete → reduced kernel fs.batch (539/630/631/646).
  // Bun-first-hit / ambiguous still refuse BEFORE mutation.
  if (projections.length > 1) {
    const atomic = await projectSingleFileAtomicPatch(workspace, args, projections);
    if (atomic) {
      const outcome = await tryKernelWriteRoute(kernel, workspace, sessionId, effectId, atomic);
      if (outcome?.result.ok) {
        return {
          ...outcome,
          result: {
            ok: true,
            output: `${KERNEL_ROUTE_TAG} apply_patch ${projections.length} hunks committed via one atomic kernel fs.write (${atomic.path})`,
          },
        };
      }
      return outcome;
    }
    const batch = await projectMultiFileExactBatchPlan(workspace, args);
    if (batch) {
      return tryKernelFsBatchWriteRoute(kernel, workspace, sessionId, effectId, batch);
    }
    const message =
      `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: multi-operation apply_patch requires an atomic kernel batch; ` +
      "unsupported, stale, Bun-first-hit fuzzy or ambiguous plan refused before executing any operation";
    return {
      journalSkipped: false,
      kernelObserve: {},
      result: { ok: false, output: message, error: message },
    };
  }
  const input =
    typeof args.input === "string" && args.input !== ""
      ? args.input
      : typeof args.patch === "string" && args.patch !== ""
        ? args.patch
        : undefined;
  if (!input) return undefined;
  const parsed = parse(input);
  if (!parsed.ok) return undefined;

  let lastOutcome: KernelMutationRouteOutcome | undefined;
  let journalRecordFailed: boolean | undefined;
  const patchWalk = { opIndex: 0, editChunkInOp: 0, fileCache: new Map<string, string>() };

  let step = 0;
  for (const structProj of projections) {
    step += 1;
    let proj = structProj;
    if (structProj.kind === "edit") {
      proj = await resolveApplyPatchEditProjectionStep(workspace, structProj, parsed.patch.ops, patchWalk);
    }
    const outcome =
      proj.kind === "write"
        ? await tryKernelWriteRoute(kernel, workspace, sessionId, effectId, {
            path: proj.path,
            content: proj.content,
          })
        : proj.kind === "edit"
          ? await tryKernelEditRoute(kernel, workspace, sessionId, effectId, {
              path: proj.path,
              old: proj.old,
              new: proj.new,
            })
          : proj.kind === "rename"
            ? await tryKernelRenameRoute(kernel, workspace, sessionId, effectId, {
                from: proj.from,
                to: proj.to,
              })
            : await tryKernelDeleteRoute(kernel, workspace, sessionId, effectId, { path: proj.path });
    if (outcome === undefined) {
      const msg = `${KERNEL_ROUTE_TAG} apply_patch kernel route unavailable for ${kernelProjectionPath(proj)} (fail-closed after ${step}/${projections.length} op(s))`;
      return {
        journalSkipped: lastOutcome?.journalSkipped ?? false,
        journalRecordFailed,
        kernelObserve: lastOutcome?.kernelObserve ?? {},
        result: { ok: false, output: msg, error: msg },
      };
    }
    lastOutcome = outcome;
    if (outcome.journalRecordFailed) journalRecordFailed = true;
    if (!outcome.result.ok) return { ...outcome, journalRecordFailed };
    if (proj.kind === "edit" || proj.kind === "write") {
      const rel = proj.kind === "edit" ? proj.path : proj.path;
      await refreshApplyPatchFileCache(workspace, rel, patchWalk.fileCache);
    } else if (proj.kind === "rename") {
      await refreshApplyPatchFileCache(workspace, proj.to, patchWalk.fileCache);
      patchWalk.fileCache.delete(
        path.resolve(workspace, proj.from),
      );
    }
  }

  // Single-projection path: one settled kernel op (multi-file uses fs.batch above).
  return lastOutcome ? { ...lastOutcome, journalRecordFailed } : undefined;
}

export async function tryKernelAstEditRoute(
  kernel: KernelClient,
  workspace: string,
  sessionId: string,
  effectId: string,
  args: Record<string, unknown>,
): Promise<KernelMutationRouteOutcome | undefined> {
  const proj = await astEditKernelProjection(workspace, args);
  if (proj?.kind === "edit") {
    return tryKernelEditRoute(kernel, workspace, sessionId, effectId, {
      path: proj.path,
      old: proj.old,
      new: proj.new,
    });
  }
  // A single-file many-site structural rewrite is one atomic fs.write, not
  // N independent fs.edit effects. Rust verifies the SHA-256 of the original
  // complete source before durable OwnerLog prepare and immediately before
  // write; a stale or truncated structural plan never partially executes.
  const multi = await astEditKernelAtomicMultiProjection(workspace, args);
  if (!multi) return undefined;
  const outcome = await tryKernelWriteRoute(kernel, workspace, sessionId, effectId, {
    path: multi.path,
    content: multi.after,
    expectedPreimageDigest: sha256Hex(multi.before),
  });
  if (!outcome?.result.ok) return outcome;
  return {
    ...outcome,
    result: {
      ok: true,
      output: `${KERNEL_ROUTE_TAG} ast_edit ${multi.count} structural matches committed via one atomic kernel fs.write (${multi.path})`,
    },
  };
}

export async function tryKernelShellRoute(
  kernel: KernelClient,
  workspace: string,
  effectId: string,
  args: Record<string, unknown>,
  approval?: { sessionId: string; admittedByLoop: true },
): Promise<KernelMutationRouteOutcome | undefined> {
  const argv = simpleShellArgvFromCommand(String(args.command));
  if (!argv) return undefined;
  const cwdRel =
    typeof args.cwd === "string" && args.cwd !== "" ? workspaceRelPath(workspace, args.cwd) : undefined;
  if (typeof args.cwd === "string" && args.cwd !== "" && cwdRel === undefined) return undefined;
  const spec: Record<string, unknown> = { argv };
  if (cwdRel !== undefined && cwdRel !== ".") spec.cwd = cwdRel;
  try {
    // The loop has already completed Guard/check/approval/hooks. The Rust
    // EffectHost now independently checks Guard *inside* OwnerLog. Transfer
    // that permission using a fresh, exact-command one-use kernel lease,
    // bound to this session; do not mint when this helper is invoked directly.
    // Raw callers remain subject to the kernel's own ASK/deny policy.
    let approvedLeaseId: string | undefined;
    let issuedLease: KernelMutationRouteOutcome["issuedLease"];
    if (approval?.admittedByLoop && kernel.mode === "trusted") {
      const permit = await kernel.makeLease("shell.exec", argv.join(" "), 60_000, approval.sessionId);
      approvedLeaseId = permit.leaseId;
      issuedLease = {
        leaseId: permit.leaseId,
        kind: "shell.exec",
        target: argv.join(" "),
        expiresAt: permit.expiry,
      };
    }
    const startedAt = Date.now();
    const result = await kernel.executeEffect({
      effectId,
      sandboxRoot: workspace,
      ...(approval ? { sessionId: approval.sessionId } : {}),
      ...(approvedLeaseId ? { leaseId: approvedLeaseId } : {}),
      dispatch: { kind: "shell.exec", spec },
    });
    const exit = result.exitCode ?? -1;
    const elapsed = Date.now() - startedAt;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const body = [stdout.replace(/\n+$/, ""), stderr.replace(/\n+$/, "")].filter((part) => part !== "").join("\n");
    const okOutput =
      stdout !== "" || stderr !== ""
        ? formatExecOutputForModel({
            exitCode: result.exitCode ?? null,
            wallMs: elapsed,
            body,
            outputTruncated: result.stdoutTruncated === true || result.stderrTruncated === true,
          })
        : // A silent command still gets evidence: nothing was printed, and the
          // digest proves the kernel observed the empty stream.
          `${KERNEL_ROUTE_TAG} exit ${exit} (kernel shell.exec argv; stdout digest ${result.stdoutDigest ?? "?"})`;
    return {
      ...outcomeFromExecuteResult(
        result,
        okOutput,
        `${KERNEL_ROUTE_TAG} kernel shell.exec ${result.verdict}`,
        { journalSkipped: true },
      ),
      ...(issuedLease !== undefined ? { issuedLease } : {}),
    };
  } catch (error) {
    return refusedKernelRoute(error, true);
  }
}
