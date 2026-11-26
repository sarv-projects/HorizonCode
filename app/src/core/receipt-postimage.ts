/**
 * receipt-postimage.ts — independent observation digest for mutating file tools
 * (honesty P0 / EffectHost precursor; docs/33 priority overview).
 *
 * Today receipts digest the tool's self-reported `result.output`. For write/edit
 * (and apply_patch when a single path is known), re-read the workspace file after
 * the tool returns and hash those bytes as `postimageDigest`. Two independent
 * reads must agree or observation is marked unstable (fail-closed; docs/28 **256**).
 * A mismatch does not fail the tool; unstable observation forces EffectHost `unknown`.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { applyPatchKernelPath, astEditKernelPath } from "./effect-kernel-tool-projection";

const POSTIMAGE_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "ast_edit",
  "multi_edit",
  "rename",
  "fs.rename",
  "shell",
  "delete",
  "fs.delete",
]);

export const DIRECTORY_POSTIMAGE_DIGEST = "0000000000000000000000000000000000000000000000000000000000000000";
export const ABSENT_POSTIMAGE_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type ShellFsMutateShape = "touch" | "mkdir" | "mkdir_p" | "rm" | "rmdir" | "truncate" | "cp" | "mv" | "install";

export interface ParsedShellFsMutate {
  shape: ShellFsMutateShape;
  targetPath: string;
  sourcePath?: string;
}

function programBasename(argv0: string): string {
  const norm = argv0.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? argv0;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

export function splitShellArgv(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (inQuote !== null) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function parseReducedShellFsMutate(
  args: Record<string, unknown>,
  workspace: string,
): ParsedShellFsMutate | undefined {
  let argv: string[] | undefined;
  if (Array.isArray(args.argv) && args.argv.length > 0) {
    argv = args.argv.map(String);
  } else if (typeof args.command === "string" && args.command.trim()) {
    argv = splitShellArgv(args.command.trim());
  } else if (typeof args.cmd === "string" && args.cmd.trim()) {
    argv = splitShellArgv(args.cmd.trim());
  }
  if (!argv || argv.length === 0) return undefined;
  if (argv[0]!.includes("/") || argv[0]!.includes("\\")) return undefined;

  const base = programBasename(argv[0]!);
  let shape: ShellFsMutateShape | undefined;
  let rawTarget: string | undefined;
  let rawSource: string | undefined;

  if (base === "rm") {
    if (argv.length === 2 && !argv[1]!.startsWith("-")) {
      shape = "rm";
      rawTarget = argv[1];
    } else if (argv.length === 3 && argv[1] === "-f" && !argv[2]!.startsWith("-")) {
      shape = "rm";
      rawTarget = argv[2];
    }
  } else if (base === "touch") {
    if (argv.length === 2 && !argv[1]!.startsWith("-")) {
      shape = "touch";
      rawTarget = argv[1];
    }
  } else if (base === "mkdir") {
    if (argv.length === 2 && !argv[1]!.startsWith("-")) {
      shape = "mkdir";
      rawTarget = argv[1];
    } else if (argv.length === 3 && argv[1] === "-p" && !argv[2]!.startsWith("-")) {
      shape = "mkdir_p";
      rawTarget = argv[2];
    }
  } else if (base === "rmdir") {
    if (argv.length === 2 && !argv[1]!.startsWith("-")) {
      shape = "rmdir";
      rawTarget = argv[1];
    }
  } else if (base === "truncate") {
    if (argv.length === 2 && !argv[1]!.startsWith("-")) {
      shape = "truncate";
      rawTarget = argv[1];
    } else if (
      argv.length === 4 &&
      argv[1] === "-s" &&
      argv[2] !== "" &&
      /^[0-9]+$/.test(argv[2]!) &&
      !argv[3]!.startsWith("-")
    ) {
      shape = "truncate";
      rawTarget = argv[3];
    }
  } else if (base === "install") {
    if (argv.length === 3 && !argv[1]!.startsWith("-") && !argv[2]!.startsWith("-")) {
      shape = "install";
      rawSource = argv[1];
      rawTarget = argv[2];
    } else if (argv.length === 5 && argv[1] === "-m" && argv[2] !== "" && !argv[3]!.startsWith("-") && !argv[4]!.startsWith("-")) {
      shape = "install";
      rawSource = argv[3];
      rawTarget = argv[4];
    }
  } else if (base === "cp" || base === "mv") {
    const isMv = base === "mv";
    if (argv.length === 3) {
      if (!argv[1]!.startsWith("-") && !argv[2]!.startsWith("-")) {
        shape = isMv ? "mv" : "cp";
        rawSource = argv[1];
        rawTarget = argv[2];
      }
    } else if (argv.length === 4 && (argv[1] === "-f" || argv[1] === "-n")) {
      if (!argv[2]!.startsWith("-") && !argv[3]!.startsWith("-")) {
        shape = isMv ? "mv" : "cp";
        rawSource = argv[2];
        rawTarget = argv[3];
      }
    }
  }

  if (!shape || !rawTarget) return undefined;

  const resolvedTarget = path.isAbsolute(rawTarget) ? path.normalize(rawTarget) : path.resolve(workspace, rawTarget);
  const root = path.resolve(workspace);
  if (resolvedTarget !== root && !resolvedTarget.startsWith(root + path.sep)) {
    return undefined;
  }

  let resolvedSource: string | undefined;
  if (rawSource) {
    resolvedSource = path.isAbsolute(rawSource) ? path.normalize(rawSource) : path.resolve(workspace, rawSource);
    if (resolvedSource !== root && !resolvedSource.startsWith(root + path.sep)) {
      return undefined;
    }
  }

  return {
    shape,
    targetPath: resolvedTarget,
    ...(resolvedSource ? { sourcePath: resolvedSource } : {}),
  };
}

export interface ReceiptPostimage {
  path: string;
  digest: string;
  /** False when independent re-read digests disagree (observation not trusted). */
  observationStable: boolean;
  /** Present when `observationStable` is false. */
  confirmDigest?: string;
  /**
   * `mkdir -p` resultant directory rows from the first created-or-existing
   * component through the leaf. These are postimages, not proof each parent
   * was newly created.
   */
  rows?: ShellDirectoryPostimageRow[];
}

export interface ShellDirectoryPostimageRow {
  path: string;
  digest: string;
  state: "present";
}

const MAX_MKDIR_P_COMPONENTS = 64;

function directoryEntryStable(dir: string): boolean {
  const probe = (): boolean | undefined => {
    try {
      const st = lstatSync(dir);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      return undefined;
    }
  };
  const first = probe();
  return first === true && probe() === true;
}

/** Resultant directory chain for `mkdir -p`. Undefined when the path is not a bounded normal relative chain. */
export function mkdirPDirectoryRows(workspace: string, target: string): ShellDirectoryPostimageRow[] | undefined {
  const root = path.resolve(workspace);
  const rel = path.relative(root, path.resolve(target));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel === "" ? [] : rel.split(path.sep).filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..") || parts.length > MAX_MKDIR_P_COMPONENTS) return undefined;
  if (parts.length === 0) {
    return [{ path: root, digest: DIRECTORY_POSTIMAGE_DIGEST, state: "present" }];
  }
  const rows: ShellDirectoryPostimageRow[] = [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    rows.push({ path: current, digest: DIRECTORY_POSTIMAGE_DIGEST, state: "present" });
  }
  return rows;
}

export function postimagePathForTool(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
): string | undefined {
  if (!POSTIMAGE_TOOLS.has(tool)) return undefined;
  if (tool === "apply_patch") return applyPatchKernelPath(args, workspace);
  if (tool === "ast_edit") return astEditKernelPath(args, workspace);
  if (tool === "shell") {
    const parsed = parseReducedShellFsMutate(args, workspace);
    return parsed?.targetPath;
  }
  if (tool === "rename" || tool === "fs.rename") {
    const rawTo =
      (typeof args.to === "string" && args.to) ||
      (typeof args.destination === "string" && args.destination) ||
      (typeof args.target === "string" && args.target);
    if (!rawTo) return undefined;
    const resolved = path.isAbsolute(rawTo) ? rawTo : path.resolve(workspace, rawTo);
    const root = path.resolve(workspace);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
    return resolved;
  }
  const raw =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file === "string" && args.file) ||
    (typeof args.file_path === "string" && args.file_path) ||
    undefined;
  if (!raw) return undefined;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw);
  // Refuse escaping the workspace for observation (best-effort lexical).
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

/** sha256 hex of file bytes from one read, or directory/empty digest, or undefined if unreadable. */
export function observePostimageDigest(filePath: string): string | undefined {
  try {
    const st = statSync(filePath);
    if (st.isDirectory()) {
      return DIRECTORY_POSTIMAGE_DIGEST;
    }
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Pure: whether two independent observation digests agree. */
export function assessPostimageObservation(
  primaryDigest: string | undefined,
  confirmDigest: string | undefined,
): Pick<ReceiptPostimage, "observationStable" | "confirmDigest"> {
  if (primaryDigest === undefined || confirmDigest === undefined) {
    return { observationStable: false };
  }
  if (primaryDigest === confirmDigest) {
    return { observationStable: true };
  }
  return { observationStable: false, confirmDigest };
}

export function postimageObservationNotice(obs: ReceiptPostimage): string {
  const detail =
    obs.confirmDigest !== undefined
      ? `${obs.digest.slice(0, 12)}… vs ${obs.confirmDigest.slice(0, 12)}…`
      : "re-read failed";
  return `postimage observation unstable (independent re-read disagree): ${obs.path} (${detail}); effect marked unknown`;
}

export const SNAPSHOT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  ".system_generated",
  "dist",
  "build",
  ".cache",
]);

export interface FsEntryMetadata {
  mtimeMs: number;
  size: number;
  isDir: boolean;
}

export type WorkspaceFsSnapshot = Map<string, FsEntryMetadata> & { complete: boolean };

export function takeWorkspaceFsSnapshot(
  workspace: string,
  options?: { maxDepth?: number; maxEntries?: number },
): WorkspaceFsSnapshot {
  const root = path.resolve(workspace);
  const snapshot = new Map<string, FsEntryMetadata>() as WorkspaceFsSnapshot;
  snapshot.complete = true;
  const maxDepth = options?.maxDepth ?? 8;
  const maxEntries = options?.maxEntries ?? 2000;

  function walk(currentDir: string, currentDepth: number) {
    if (currentDepth > maxDepth || snapshot.size >= maxEntries) {
      snapshot.complete = false;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      snapshot.complete = false;
      return;
    }
    for (const entry of entries) {
      if (snapshot.size >= maxEntries) {
        snapshot.complete = false;
        break;
      }
      if (currentDepth === 0 && SNAPSHOT_IGNORED_DIRS.has(entry)) continue;
      if (entry.startsWith(".hz-")) continue;
      const full = path.join(currentDir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        snapshot.complete = false;
        continue;
      }
      const rel = path.relative(root, full).replace(/\\/g, "/");
      const isDir = st.isDirectory();
      snapshot.set(rel, { mtimeMs: st.mtimeMs, size: st.size, isDir });
      if (isDir) {
        if (!SNAPSHOT_IGNORED_DIRS.has(entry)) {
          walk(full, currentDepth + 1);
        }
      }
    }
  }

  walk(root, 0);
  return snapshot;
}

export interface WorkspaceFileMutation {
  relPath: string;
  absPath: string;
  kind: "added" | "modified" | "deleted";
  digest: string;
}

export interface WorkspaceMutationDiff {
  mutations: WorkspaceFileMutation[];
  combinedDigest: string;
  observationStable: boolean;
}

export function diffWorkspaceFsSnapshot(
  pre: WorkspaceFsSnapshot,
  workspace: string,
  observe: (filePath: string) => string | undefined = observePostimageDigest,
  options?: { maxDepth?: number; maxEntries?: number },
): WorkspaceMutationDiff {
  const root = path.resolve(workspace);
  const post = takeWorkspaceFsSnapshot(root, options);
  const mutations: WorkspaceFileMutation[] = [];
  // Missing coverage means no independent workspace observation, even if every
  // path that happened to be scanned produced a stable digest.
  let allStable = pre.complete && post.complete;

  // Check additions and modifications
  for (const [rel, postMeta] of post.entries()) {
    const abs = path.join(root, rel);
    const preMeta = pre.get(rel);
    if (!preMeta) {
      // Added
      if (postMeta.isDir) {
        mutations.push({ relPath: rel, absPath: abs, kind: "added", digest: DIRECTORY_POSTIMAGE_DIGEST });
      } else {
        const d1 = observe(abs);
        const d2 = observe(abs);
        const stable = assessPostimageObservation(d1, d2).observationStable;
        if (!stable) allStable = false;
        mutations.push({ relPath: rel, absPath: abs, kind: "added", digest: d1 ?? ABSENT_POSTIMAGE_DIGEST });
      }
    } else if (
      preMeta.isDir !== postMeta.isDir ||
      preMeta.size !== postMeta.size ||
      Math.abs(preMeta.mtimeMs - postMeta.mtimeMs) > 1
    ) {
      // Modified
      if (postMeta.isDir) {
        mutations.push({ relPath: rel, absPath: abs, kind: "modified", digest: DIRECTORY_POSTIMAGE_DIGEST });
      } else {
        const d1 = observe(abs);
        const d2 = observe(abs);
        const stable = assessPostimageObservation(d1, d2).observationStable;
        if (!stable) allStable = false;
        mutations.push({ relPath: rel, absPath: abs, kind: "modified", digest: d1 ?? ABSENT_POSTIMAGE_DIGEST });
      }
    }
  }

  // Check deletions
  for (const [rel] of pre.entries()) {
    if (!post.has(rel)) {
      const abs = path.join(root, rel);
      mutations.push({ relPath: rel, absPath: abs, kind: "deleted", digest: ABSENT_POSTIMAGE_DIGEST });
    }
  }

  // Sort mutations deterministically
  mutations.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Compute canonical combined digest
  const canonPayload = mutations.map(m => `${m.kind}:${m.relPath}:${m.digest}`).join("\n");
  const combinedDigest = createHash("sha256").update(canonPayload).digest("hex");

  return {
    mutations,
    combinedDigest,
    observationStable: allStable,
  };
}

export function observeArbitraryShellWorkspacePostimage(
  workspace: string,
  preSnapshot: WorkspaceFsSnapshot,
  observe: (filePath: string) => string | undefined = observePostimageDigest,
): ReceiptPostimage {
  const root = path.resolve(workspace);
  const diff = diffWorkspaceFsSnapshot(preSnapshot, root, observe);
  if (diff.mutations.length === 1) {
    const single = diff.mutations[0]!;
    return {
      path: single.absPath,
      digest: single.digest,
      observationStable: diff.observationStable,
    };
  }
  return {
    path: root,
    digest: diff.combinedDigest,
    observationStable: diff.observationStable,
  };
}

export function computeReceiptPostimage(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
  ok: boolean,
  observe: (filePath: string) => string | undefined = observePostimageDigest,
): ReceiptPostimage | undefined {
  if (!ok) return undefined;
  if (tool === "shell") {
    const parsed = parseReducedShellFsMutate(args, workspace);
    if (parsed) {
      const filePath = parsed.targetPath;
      if (parsed.shape === "mkdir_p") {
        const rows = mkdirPDirectoryRows(workspace, filePath);
        if (!rows) return undefined;
        return {
          path: filePath,
          digest: DIRECTORY_POSTIMAGE_DIGEST,
          observationStable: rows.every((row) => directoryEntryStable(row.path)),
          rows,
        };
      }
      if (parsed.shape === "rm" || parsed.shape === "rmdir") {
        const absent1 = !existsSync(filePath);
        const absent2 = !existsSync(filePath);
        if (absent1 && absent2) {
          return {
            path: filePath,
            digest: ABSENT_POSTIMAGE_DIGEST,
            observationStable: true,
          };
        }
        return {
          path: filePath,
          digest: ABSENT_POSTIMAGE_DIGEST,
          observationStable: false,
        };
      }
      const digest = observe(filePath);
      if (!digest) return undefined;
      const confirmDigest = observe(filePath);
      const stability = assessPostimageObservation(digest, confirmDigest);
      return {
        path: filePath,
        digest,
        observationStable: stability.observationStable,
        ...(stability.confirmDigest !== undefined ? { confirmDigest: stability.confirmDigest } : {}),
      };
    }
    const preSnapshot = (args.__preSnapshot ?? args.preSnapshot) as WorkspaceFsSnapshot | undefined;
    if (preSnapshot instanceof Map) {
      return observeArbitraryShellWorkspacePostimage(workspace, preSnapshot, observe);
    }
    return undefined;
  }
  const filePath = postimagePathForTool(tool, args, workspace);
  if (!filePath) return undefined;
  if (tool === "delete" || tool === "fs.delete") {
    const absent1 = !existsSync(filePath);
    const absent2 = !existsSync(filePath);
    if (absent1 && absent2) {
      return {
        path: filePath,
        digest: ABSENT_POSTIMAGE_DIGEST,
        observationStable: true,
      };
    }
    return {
      path: filePath,
      digest: ABSENT_POSTIMAGE_DIGEST,
      observationStable: false,
    };
  }
  const digest = observe(filePath);
  if (!digest) return undefined;
  const confirmDigest = observe(filePath);
  const stability = assessPostimageObservation(digest, confirmDigest);
  return {
    path: filePath,
    digest,
    observationStable: stability.observationStable,
    ...(stability.confirmDigest !== undefined ? { confirmDigest: stability.confirmDigest } : {}),
  };
}

/** Digest fields safe to attach to a receipt (omitted when observation is unstable). */
export function receiptPostimageFields(
  postimage: ReceiptPostimage | undefined,
): { postimageDigest: string; postimagePath: string } | undefined {
  if (!postimage?.observationStable) return undefined;
  return {
    postimageDigest: postimage.digest,
    postimagePath: postimage.path,
    ...(postimage.rows !== undefined ? { postimageRows: postimage.rows } : {}),
  };
}

/** Kernel `effect.execute` postimage facts mirrored into loop observe (ruling **280**). */
export interface KernelExecutePostimageObserve {
  contentDigest?: string;
  postimageObservationStable?: boolean;
  postimageConfirmDigest?: string;
  /** Kernel canonical tool-output digest for write/edit/shell observe (**314**, **327**). */
  resultDigest?: string;
  /** Kernel double-hash observe on result payload (**314** shell; **327** write/edit). */
  resultDigestStable?: boolean;
  stdoutDigest?: string;
  stderrDigest?: string;
}

/**
 * Map kernel fs.write/fs.edit double-read into the same receipt shape as TS **256**.
 * Falls back to ordinary file re-read when kernel did not supply a stable digest.
 */
export function computeReceiptPostimageFromKernel(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
  ok: boolean,
  kernel: KernelExecutePostimageObserve | undefined,
  observe: (filePath: string) => string | undefined = observePostimageDigest,
): ReceiptPostimage | undefined {
  if (!ok) return undefined;
  const filePath = postimagePathForTool(tool, args, workspace);
  if (!filePath || kernel === undefined) return undefined;
  const kernelStable =
    kernel.postimageObservationStable !== false && typeof kernel.contentDigest === "string" && kernel.contentDigest !== "";
  if (kernelStable) {
    return { path: filePath, digest: kernel.contentDigest!, observationStable: true };
  }
  if (kernel.postimageObservationStable === false) {
    const fallback = observe(filePath);
    return {
      path: filePath,
      digest: fallback ?? kernel.contentDigest ?? "",
      observationStable: false,
      ...(kernel.postimageConfirmDigest !== undefined ? { confirmDigest: kernel.postimageConfirmDigest } : {}),
    };
  }
  return computeReceiptPostimage(tool, args, workspace, ok, observe);
}
