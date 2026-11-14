/**
 * Opt-in EffectHost mutation precursor (rulings **278**, **280**, **281**, **287**).
 *
 * When `HZ_EFFECT_HOST_KERNEL=1` or `=default`, eligible `write` / `edit` / simple `shell` calls
 * may execute via kernel `effect.execute` (sandboxRoot = workspace) after guard
 * approval in `loop.ts`. One-step Add/exact-Update/Delete/Move,
 * same-file exact multi-hunk Update collapsed into one whole-file write,
 * and structural `ast_edit` one/multiple complete matches may kernel-route.
 * Multi-file/fuzzy/ambiguous operations remain unsupported. Ineligible or disabled routes may use Bun in non-strict mode; a
 * Rust refusal or uncertain kernel transport result NEVER falls back to Bun.
 * Kernel still owns the routed write bytes; TS
 * records the change journal after settled write/edit (**281**); kernel owns
 * temp+rename atomic write under sandboxRoot (**283**). Since ruling **349**,
 * explicit Rust refusals and lost effect.execute replies NEVER fall back to Bun,
 * and unsupported multi-operation apply_patch refuses BEFORE any write
 * without atomic fs.batch ownership. Rule 353 adds a safe subset: whole-file
 * atomic writes for same-file exact multi-hunks and complete multi-site AST
 * rewrites with Rust-verified original preimage digests.
 * Full edit.ts repair ladder stays on Bun; kernel path has optional reduced
 * repair via `HZ_EFFECT_HOST_EDIT_REPAIR`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex, type KernelRequestMap, type ToolResult } from "../contracts";
import { KernelRefusal, type KernelClient } from "./kernel";
import type { KernelExecutePostimageObserve } from "./receipt-postimage";
import { analyzeShellCompound } from "./shell-split";
import { bindJournalWorkspace, recordChange } from "../tools/change-journal";
import { parse } from "../tools/apply-patch-parser";
import {
  classifyApplyPatchChunkKernelFuzz,
  resolveKernelApplyPatchChunkEdit,
} from "../tools/apply-patch-kernel-fuzz";
import {
  applyPatchKernelProjections,
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

/** A kernel refusal is final: it may represent an OwnerLog UNKNOWN or a
 * denied policy decision. Treating it as an unavailable route and running Bun
 * instead would make the kernel's authority advisory. Transport UNKNOWN is
 * surfaced as KernelRefusal by KernelClient.rpc for the same reason. */
function refusedKernelRoute(
  error: unknown,
  journalSkipped: boolean,
): KernelMutationRouteOutcome | undefined {
  if (!(error instanceof KernelRefusal)) return undefined;
  const message = `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: kernel mutation refused — ${error.message}`;
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
    recordChange(sessionId, {
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
    if (result.verdict === "settled") {
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
      { journalSkipped: false, journalRecordFailed },
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
    if (result.verdict === "settled") {
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
      { journalSkipped: false, journalRecordFailed },
    );
  } catch (error) {
    return refusedKernelRoute(error, false);
  }
}

/** One-file, multiple exact hunks can be one *atomic file* mutation.
 * Compute the entire postimage WITHOUT writing. Every hunk must resolve to a
 * unique exact line window in the evolving in-memory copy. This deliberately
 * excludes fuzzy/tied/cross-file/move operations, not claiming fs.batch parity.
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
    if (chunk.oldLines.length === 0 ||
      classifyApplyPatchChunkKernelFuzz(current, chunk) !== "exact") return undefined;
    const exact = resolveKernelApplyPatchChunkEdit(current, chunk);
    if (!exact || exact.old.length === 0) return undefined;
    const position = current.indexOf(exact.old);
    if (position < 0 || current.indexOf(exact.old, position + 1) !== -1) return undefined;
    current = current.slice(0, position) + exact.new + current.slice(position + exact.old.length);
  }
  if (current === original) return undefined;
  return { path: rel, content: current, expectedPreimageDigest: sha256Hex(original) };
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
  // An exact same-file multi-hunk Update is reducible to ONE kernel-owned
  // atomic fs.write: validate every hunk on a private in-memory copy, then
  // pin the original bytes' SHA-256 all the way through Rust OwnerLog.
  // This is not general fs.batch: all cross-file/rename/fuzzy multi-op plans
  // still refuse BEFORE the first mutation (no partial patch).
  if (projections.length > 1) {
    const atomic = await projectSingleFileAtomicPatch(workspace, args, projections);
    if (atomic) {
      const outcome = await tryKernelWriteRoute(kernel, workspace, sessionId, effectId, atomic);
      if (outcome?.result.ok) {
        return {
          ...outcome,
          result: {
            ok: true,
            output: `${KERNEL_ROUTE_TAG} apply_patch ${projections.length} exact hunks committed via one atomic kernel fs.write (${atomic.path})`,
          },
        };
      }
      return outcome;
    }
    const message =
      `${KERNEL_ROUTE_TAG} HZ_PRECONDITION_FAILED: multi-operation apply_patch requires an atomic kernel batch; ` +
      "unsupported, stale, fuzzy or ambiguous plan refused before executing any operation";
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

  // The preflight rejects >1 projections. A single settled operation is
  // the only honest kernel apply_patch result until fs.batch is implemented.
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
    if (approval?.admittedByLoop && kernel.mode === "trusted") {
      const permit = await kernel.makeLease("shell.exec", argv.join(" "), 60_000, approval.sessionId);
      approvedLeaseId = permit.leaseId;
    }
    const result = await kernel.executeEffect({
      effectId,
      sandboxRoot: workspace,
      ...(approval ? { sessionId: approval.sessionId } : {}),
      ...(approvedLeaseId ? { leaseId: approvedLeaseId } : {}),
      dispatch: { kind: "shell.exec", spec },
    });
    const exit = result.exitCode ?? -1;
    return outcomeFromExecuteResult(
      result,
      `${KERNEL_ROUTE_TAG} exit ${exit} (kernel shell.exec argv; stdout digest ${result.stdoutDigest ?? "?"})`,
      `${KERNEL_ROUTE_TAG} kernel shell.exec ${result.verdict}`,
      { journalSkipped: true },
    );
  } catch (error) {
    return refusedKernelRoute(error, true);
  }
}
