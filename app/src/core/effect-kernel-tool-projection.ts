/**
 * Project `apply_patch` / `ast_edit` into kernel fs.write / fs.edit (rulings **287**, **293**).
 */

import * as path from "node:path";
import { parse, type FileOp, type PatchChunk } from "../tools/apply-patch-parser";
import {
  classifyApplyPatchChunkKernelFuzz,
  resolveKernelApplyPatchChunkEdit,
} from "../tools/apply-patch-kernel-fuzz";
import { langFromPath, rewriteMatches } from "../tools/ast-match";

export type KernelToolProjection =
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; old: string; new: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; from: string; to: string };

function chunkExactBytes(chunk: PatchChunk): { old: string; new: string } | undefined {
  if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) return undefined;
  return { old: chunk.oldLines.join("\n"), new: chunk.newLines.join("\n") };
}

function patchInputString(args: Record<string, unknown>): string | undefined {
  if (typeof args.input === "string" && args.input !== "") return args.input;
  if (typeof args.patch === "string" && args.patch !== "") return args.patch;
  return undefined;
}

function fileOpKernelProjections(op: FileOp): KernelToolProjection[] | undefined {
  if (op.kind === "add") {
    const content = op.addBody.join("\n") + (op.addBody.length > 0 ? "\n" : "");
    return [{ kind: "write", path: op.path, content }];
  }
  if (op.kind === "update") {
    if (op.movePath !== undefined) {
      if (op.chunks.length !== 1) return undefined;
      const bytes = chunkExactBytes(op.chunks[0]!);
      if (!bytes) return undefined;
      if (bytes.old === bytes.new) {
        return [{ kind: "rename", from: op.path, to: op.movePath }];
      }
      return [
        { kind: "edit", path: op.path, old: bytes.old, new: bytes.new },
        { kind: "rename", from: op.path, to: op.movePath },
      ];
    }
    const edits: KernelToolProjection[] = [];
    for (const chunk of op.chunks) {
      const bytes = chunkExactBytes(chunk);
      if (!bytes) return undefined;
      if (bytes.old === bytes.new) continue;
      edits.push({ kind: "edit", path: op.path, old: bytes.old, new: bytes.new });
    }
    if (edits.length === 0) return undefined;
    return edits;
  }
  if (op.kind === "delete") {
    return [{ kind: "delete", path: op.path }];
  }
  return undefined;
}

function fileOpKernelProjection(op: FileOp): KernelToolProjection | undefined {
  const projs = fileOpKernelProjections(op);
  if (!projs || projs.length !== 1) return undefined;
  return projs[0];
}

/**
 * Ordered kernel projections for sequential single-file Add / exact-chunk Update ops.
 * Refuses cross-file fuzzy or non-exact move/edit (delete + exact move allowed). EOF-anchored
 * single-file updates project when on-disk bytes resolve to a unique exact match (**300** reduced).
 * Same-file multi-chunk Update with exact chunks projects to ordered `fs.edit` (**299**).
 */
export function applyPatchKernelProjections(args: Record<string, unknown>): KernelToolProjection[] | undefined {
  const input = patchInputString(args);
  if (!input) return undefined;
  const parsed = parse(input);
  if (!parsed.ok) return undefined;
  const { ops } = parsed.patch;
  if (ops.length === 0) return undefined;
  const projections: KernelToolProjection[] = [];
  for (const op of ops) {
    const projs = fileOpKernelProjections(op);
    if (!projs) return undefined;
    projections.push(...projs);
  }
  return projections;
}

/** First projection when exactly one op; undefined for ineligible or multi-op input. */
export function applyPatchKernelProjection(args: Record<string, unknown>): KernelToolProjection | undefined {
  const projections = applyPatchKernelProjections(args);
  if (!projections || projections.length !== 1) return undefined;
  return projections[0];
}

export function applyPatchArgsEligibleForKernelRoute(args: Record<string, unknown>): boolean {
  return applyPatchKernelProjections(args) !== undefined;
}

function resolvePathInWorkspace(workspace: string, rawPath: string): string | undefined {
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspace, rawPath);
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

/**
 * Resolve edit projections against on-disk bytes; fail-closed when a chunk needs Bun-only fuzz.
 * Structural eligibility (`applyPatchArgsEligibleForKernelRoute`) can still be true while this
 * returns undefined (doctor documents the gap).
 */
export async function resolveApplyPatchKernelProjections(
  workspace: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Promise<KernelToolProjection[] | undefined> {
  const input = patchInputString(args);
  if (!input) return undefined;
  const parsed = parse(input);
  if (!parsed.ok) return undefined;
  const structural = applyPatchKernelProjections(args);
  if (!structural) return undefined;

  const { readFile } = await import("node:fs/promises");
  const fileCache = new Map<string, string>();
  const resolved: KernelToolProjection[] = [];

  for (let opIdx = 0; opIdx < parsed.patch.ops.length; opIdx += 1) {
    const op = parsed.patch.ops[opIdx]!;
    const projs = fileOpKernelProjections(op);
    if (!projs) return undefined;
    let editChunkCursor = 0;
    const editableChunks =
      op.kind === "update"
        ? op.chunks.filter((c) => {
            const bytes = chunkExactBytes(c);
            return bytes && bytes.old !== bytes.new;
          })
        : [];
    for (const proj of projs) {
      if (proj.kind !== "edit") {
        resolved.push(proj);
        continue;
      }
      if (op.kind !== "update") return undefined;
      const chunk = editableChunks[editChunkCursor];
      editChunkCursor += 1;
      if (!chunk) return undefined;

      const abs = resolvePathInWorkspace(workspace, proj.path);
      if (!abs) return undefined;
      let before = fileCache.get(abs);
      if (before === undefined) {
        try {
          before = (await readFile(abs)).toString("utf8");
          fileCache.set(abs, before);
        } catch {
          return undefined;
        }
      }

      if (classifyApplyPatchChunkKernelFuzz(before, chunk) === "bun_fuzz_only") return undefined;
      const resolvedEdit = resolveKernelApplyPatchChunkEdit(before, chunk, env);
      if (!resolvedEdit) return undefined;
      resolved.push({ kind: "edit", path: proj.path, old: resolvedEdit.old, new: resolvedEdit.new });
    }
  }
  if (resolved.length !== structural.length) return undefined;
  return resolved.length > 0 ? resolved : undefined;
}

type ApplyPatchResolveWalk = {
  opIndex: number;
  editChunkInOp: number;
  fileCache: Map<string, string>;
};

function advanceApplyPatchEditChunk(
  ops: FileOp[],
  walk: ApplyPatchResolveWalk,
): { op: FileOp & { kind: "update" }; chunk: PatchChunk } | undefined {
  while (walk.opIndex < ops.length) {
    const op = ops[walk.opIndex]!;
    if (op.kind !== "update") {
      walk.opIndex += 1;
      walk.editChunkInOp = 0;
      continue;
    }
    const editable = op.chunks.filter((c) => {
      const bytes = chunkExactBytes(c);
      return bytes !== undefined && bytes.old !== bytes.new;
    });
    if (walk.editChunkInOp >= editable.length) {
      walk.opIndex += 1;
      walk.editChunkInOp = 0;
      continue;
    }
    const chunk = editable[walk.editChunkInOp]!;
    walk.editChunkInOp += 1;
    return { op, chunk };
  }
  return undefined;
}

/**
 * Resolve one edit projection against current file bytes (fuzz trim_end when enabled).
 * Returns the structural projection unchanged when resolution is unnecessary or unavailable
 * so kernel execute can still fail-closed mid multi-op apply_patch.
 */
export async function resolveApplyPatchEditProjectionStep(
  workspace: string,
  proj: Extract<KernelToolProjection, { kind: "edit" }>,
  ops: FileOp[],
  walk: ApplyPatchResolveWalk,
  env: Record<string, string | undefined> = process.env,
): Promise<Extract<KernelToolProjection, { kind: "edit" }>> {
  const step = advanceApplyPatchEditChunk(ops, walk);
  if (!step) return proj;
  const abs = resolvePathInWorkspace(workspace, proj.path);
  if (!abs) return proj;
  let before = walk.fileCache.get(abs);
  if (before === undefined) {
    try {
      const { readFile } = await import("node:fs/promises");
      before = (await readFile(abs)).toString("utf8");
      walk.fileCache.set(abs, before);
    } catch {
      return proj;
    }
  }
  if (classifyApplyPatchChunkKernelFuzz(before, step.chunk) === "bun_fuzz_only") return proj;
  const resolvedEdit = resolveKernelApplyPatchChunkEdit(before, step.chunk, env);
  if (!resolvedEdit) return proj;
  return { kind: "edit", path: proj.path, old: resolvedEdit.old, new: resolvedEdit.new };
}

export async function refreshApplyPatchFileCache(workspace: string, relPath: string, cache: Map<string, string>): Promise<void> {
  const abs = resolvePathInWorkspace(workspace, relPath);
  if (!abs) return;
  try {
    const { readFile } = await import("node:fs/promises");
    cache.set(abs, (await readFile(abs)).toString("utf8"));
  } catch {
    cache.delete(abs);
  }
}

const AST_DOLLAR_META_RE = /\$[A-Za-z_][A-Za-z0-9_]*/g;
const AST_VARIADIC_META_RE = /\$\$\$[A-Za-z_][A-Za-z0-9_]*/g;

function astMetavarNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(AST_DOLLAR_META_RE)) {
    const raw = m[0]!;
    if (raw.startsWith("$$")) continue;
    names.push(raw.slice(1));
  }
  return names;
}

function astVariadicMetavarNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(AST_VARIADIC_META_RE)) {
    names.push(m[0]!.slice(3));
  }
  return names;
}

/**
 * Shape gate: `out` `$NAME` / `$$$NAME` metvars ⊆ `pat` (same kind).
 * Kernel projection still fail-closes to one exact old→new via `rewriteMatches` (**320** variadic).
 */
export function astEditMetavarKernelShapeEligible(pat: string, out: string): boolean {
  const patNames = new Set(astMetavarNames(pat));
  for (const name of astMetavarNames(out)) {
    if (!patNames.has(name)) return false;
  }
  const patVariadic = new Set(astVariadicMetavarNames(pat));
  for (const name of astVariadicMetavarNames(out)) {
    if (!patVariadic.has(name)) return false;
  }
  return true;
}

export function astEditArgsEligibleForKernelRoute(args: Record<string, unknown>): boolean {
  if (typeof args.path !== "string" || args.path === "") return false;
  if (typeof args.pat !== "string" || args.pat === "") return false;
  if (typeof args.out !== "string") return false;
  return astEditMetavarKernelShapeEligible(String(args.pat), String(args.out));
}

export async function astEditKernelProjection(
  workspace: string,
  args: Record<string, unknown>,
): Promise<KernelToolProjection | undefined> {
  if (!astEditArgsEligibleForKernelRoute(args)) return undefined;
  const rawPath = String(args.path);
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspace, rawPath);
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  let before: string;
  try {
    const { readFile } = await import("node:fs/promises");
    before = (await readFile(resolved)).toString("utf8");
  } catch {
    return undefined;
  }
  const lang = typeof args.lang === "string" && args.lang !== "" ? args.lang : langFromPath(resolved);
  const rewrite = rewriteMatches(before, String(args.pat), String(args.out), { lang });
  if (rewrite.skipped !== null || rewrite.truncated || rewrite.lexIssues > 0) return undefined;
  if (rewrite.count !== 1 || rewrite.changes.length !== 1) return undefined;
  const change = rewrite.changes[0]!;
  if (change.before === change.after) return undefined;
  return { kind: "edit", path: rawPath, old: change.before, new: change.after };
}

/** Fail-closed reason when kernel `fs.edit` projection cannot run (ruling **322** require honesty). */
export type AstEditProjectionMissReason =
  | "shape_ineligible"
  | "path_escape"
  | "read_fail"
  | "multi_match"
  | "zero_match"
  | "lexer"
  | "truncated"
  | "skipped"
  | "no_change";

export async function classifyAstEditKernelProjectionMiss(
  workspace: string,
  args: Record<string, unknown>,
): Promise<AstEditProjectionMissReason | undefined> {
  if (!astEditArgsEligibleForKernelRoute(args)) return "shape_ineligible";
  const rawPath = String(args.path);
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspace, rawPath);
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return "path_escape";
  let before: string;
  try {
    const { readFile } = await import("node:fs/promises");
    before = (await readFile(resolved)).toString("utf8");
  } catch {
    return "read_fail";
  }
  const lang = typeof args.lang === "string" && args.lang !== "" ? args.lang : langFromPath(resolved);
  const rewrite = rewriteMatches(before, String(args.pat), String(args.out), { lang });
  if (rewrite.lexIssues > 0) return "lexer";
  if (rewrite.truncated) return "truncated";
  if (rewrite.skipped !== null) return "skipped";
  if (rewrite.count === 0) return "zero_match";
  if (rewrite.count !== 1 || rewrite.changes.length !== 1) return "multi_match";
  const change = rewrite.changes[0]!;
  if (change.before === change.after) return "no_change";
  return undefined;
}

export function astEditProjectionMissRequireDetail(reason: AstEditProjectionMissReason): string {
  switch (reason) {
    case "multi_match":
      return "ast_edit pattern matches multiple sites — Bun-owned under default; refused under require";
    case "zero_match":
      return "ast_edit pattern matched zero sites on disk";
    case "lexer":
      return "ast_edit lexer issues — kernel projection unavailable";
    case "truncated":
      return "ast_edit match budget truncated";
    case "skipped":
      return "ast_edit pattern skipped (budget or unsupported)";
    case "no_change":
      return "ast_edit rewrite is a no-op";
    case "read_fail":
      return "ast_edit target file unreadable";
    case "path_escape":
      return "ast_edit path outside workspace";
    case "shape_ineligible":
      return "ast_edit not literal/metavar kernel-shape-eligible";
  }
}

export function applyPatchKernelPath(args: Record<string, unknown>, workspace: string): string | undefined {
  const projections = applyPatchKernelProjections(args);
  const proj = projections?.[projections.length - 1];
  if (!proj) return undefined;
  const raw = proj.kind === "rename" ? proj.to : proj.path;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

export function astEditKernelPath(args: Record<string, unknown>, workspace: string): string | undefined {
  if (typeof args.path !== "string" || args.path === "") return undefined;
  const resolved = path.isAbsolute(args.path) ? path.resolve(args.path) : path.resolve(workspace, args.path);
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}
