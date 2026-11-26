/**
 * `apply_patch` — the GPT-5/Codex freeform patch tool.
 *
 * A single string argument carries the whole patch (the grammar lives in the
 * string, like codex/cline); ./apply-patch-parser.ts turns it into a structured
 * `Patch` and this module applies every file operation through the SAME kernel
 * guard -> approve -> preimage(sha256 TOCTOU) -> protectedTarget -> writeAtomic
 * discipline that `edit` and `write` use. It NEVER bypasses the guard and never
 * uses ambient authority: each mutated/created/deleted/moved path raises its own
 * `fs.write` GuardAction on its REAL (symlink-resolved) target, is confined to
 * cwd lexically, and records a change-journal entry.
 *
 * Context matching uses a GRADED FUZZ LADDER (docs/30; research A.5 + codex
 * seek_sequence 1.5) over the file's lines, carrying a fuzz cost:
 *
 *   (1) exact canonical match            -> fuzz 0
 *   (2) per-line trimEnd match           -> fuzz 1
 *   (3) per-line trim (both sides) match -> fuzz 100
 *   (4) Levenshtein similarity >= 0.66   -> fuzz 1000 (carries the similarity)
 *   (5) EOF-anchored retry from the tail -> +10000 on top of the rung cost
 *
 * The success output reports 'Patch applied with fuzz factor N' (the aggregate
 * maximum). An unmatched chunk is a WARNING, not a failure: it is skipped with a
 * <=200-char context preview and the rest of the patch still applies.
 *
 * Line endings: a LOCAL helper normalises to LF for matching and detects a
 * file's dominant ending for the write-back (another stream owns the shared
 * line-endings module; this module deliberately does not import it).
 *
 * Create-path safety (mirrors write.ts's discipline, implemented locally so
 * this module does not import write.ts): an `*** Add File:` whose target
 * already exists is REFUSED — the grammar means "new file", and silently
 * overwriting would destroy content with no undo preimage. A move DESTINATION
 * that already exists is not refused (a move may legitimately replace a file),
 * but its real bytes are read and JOURNALLED as the `before` preimage so undo
 * can restore the clobbered content; a brand-new destination journals
 * `before: null` as before.
 *
 * NAMED RESIDUAL — cross-op atomicity: a multi-op patch applies its ops in
 * source order and returns on the FIRST failure, so ops that already succeeded
 * stay written to disk; there is no all-or-nothing staging/rollback across ops.
 * Each individual effect is still undoable via the change journal, and the
 * failure message names which ops already applied so the model/user can
 * recover. Full staging-and-atomic-commit across ops is deliberately left as a
 * follow-up.
 */

import { lstat, mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { sha256Hex } from "../core/canon";
import { checkpointDirtyPathBeforeEdit, formatLintFixCommitSuffixes } from "../core/git-dirty-checkpoint";
import { realpathish } from "../core/paths";
import { guardEffectivelyAllows } from "../core/guard-g1-wire";
import { tunnelPermissionError } from "../core/guards/defect-tunnel";
import {
  captureWorkspaceBinding,
  isWorkspaceBindingError,
  refuseWorkspaceIdentityDrift,
} from "../core/workspace-binding";
import { isRefused, writeAtomic } from "./atomic-write";
import { withEffectR170BunMutationFence } from "../core/effect-r170-bun-mutation-fence";
import { acquireLock, targetLockPath } from "../core/file-lock";
import { recordChangeGuarded } from "./change-journal";
import { canonicalize, parse, type FileOp, type PatchChunk } from "./apply-patch-parser";
import { isBinary, relPath, resolveRealTarget, type RealTarget } from "./helpers";
import { noteRead } from "./read-ledger";
import { noteToolContext } from "./repo-map-context";
import { protectedTargetRefusal } from "./verified-open";

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * E-1: the same default-on dirty checkpoint `edit` takes before its write, applied
 * to each path a patch op is about to mutate (add / update / delete / move
 * destination). No flag → no-op; no dirt → no commit. Mirrors edit.ts exactly.
 */
function dirtyCheckpointPrefix(ctx: ToolContext, rel: string): string {
  const cp = checkpointDirtyPathBeforeEdit(ctx.workspace, rel);
  if (cp.committed && cp.notice) return `${cp.notice}\n`;
  if (cp.error) return `[git checkpoint failed: ${cp.error}]\n`;
  return "";
}

/* --------------------------- local line endings --------------------------- */

const CRLF = "\r\n";

/** The file's dominant ending for write-back: CRLF if a `\r\n` appears anywhere. */
function detectEnding(text: string): "\r\n" | "\n" {
  return text.includes(CRLF) ? CRLF : "\n";
}

/** Split into lines on the LF view (a trailing "" when the text ends in "\n"). */
function toLines(text: string): string[] {
  return text.replaceAll(CRLF, "\n").split("\n");
}

/** Join `lines` with `eol`; mirrors the LF-view split so a round-trip is stable. */
function fromLines(lines: string[], eol: "\r\n" | "\n"): string {
  return lines.join(eol);
}

/* ------------------------------- fuzz ladder ------------------------------ */

/** True when `resolved` names an existing filesystem entry (file, dir, …). */
async function pathExists(resolved: string): Promise<boolean> {
  return stat(resolved).then(
    () => true,
    () => false,
  );
}

/** Confinement: the resolved path must stay inside the workspace/cwd. */
function escapesCwd(cwd: string, resolved: string): boolean {
  const rel = path.relative(cwd, resolved);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** Levenshtein edit distance between two strings (iterative, O(n*m) space O(m)). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] as number) + 1, (curr[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length] as number;
}

/** Bun apply_patch rung (4) — mirrored on kernel path in `apply-patch-kernel-fuzz.ts`. */
export const APPLY_PATCH_LEVENSHTEIN_THRESHOLD = 0.66;

/** Similarity in [0,1]: 1 - distance / max(len). Two empty strings are identical. */
export function applyPatchBlockSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function similarity(a: string, b: string): number {
  return applyPatchBlockSimilarity(a, b);
}

const SIMILARITY_THRESHOLD = APPLY_PATCH_LEVENSHTEIN_THRESHOLD;

interface MatchResult {
  /** The 0-based line index where the window matched. */
  start: number;
  /** The fuzz cost of this match (0 / 1 / 50 / 100 / 500 / 1000, plus +10000 if eof-anchored). */
  fuzz: number;
  /** The Levenshtein similarity when rung 4 matched; 1 otherwise (for messages). */
  similarity: number;
  /** Optional re-indentation offsets for relative indent matches (rung 2b). */
  reindent?: { add: string; base: string };
}

function commonIndentPrefix(lines: string[]): string {
  let prefix: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = line.match(/^[ \t]+/);
    const indent = match ? match[0] : "";
    if (prefix === null) {
      prefix = indent;
    } else {
      let i = 0;
      while (i < prefix.length && i < indent.length && prefix[i] === indent[i]) i++;
      prefix = prefix.slice(0, i);
    }
  }
  return prefix ?? "";
}

function stripIndent(lines: string[], prefix: string): string[] {
  if (prefix === "") return lines;
  return lines.map((l) => (l.trim() === "" ? "" : l.startsWith(prefix) ? l.slice(prefix.length) : l));
}

function reindentLines(lines: string[], addPrefix: string, basePrefix: string): string[] {
  if (addPrefix === basePrefix) return lines;
  return lines.map((line) => {
    if (line.trim() === "") return "";
    if (basePrefix !== "" && line.startsWith(basePrefix)) {
      return addPrefix + line.slice(basePrefix.length);
    }
    return addPrefix + line;
  });
}

function collapseWs(s: string): string {
  return s.trim().replace(/[ \t]+/g, " ");
}

/**
 * Locate `want` (a chunk's canonicalised old-lines) inside `fileLines`
 * (canonicalised) starting the search at `from`. The graded ladder is tried in
 * order per candidate start; the FIRST start that matches any rung wins, with
 * the lowest-cost rung reported. EOF-anchored chunks search from the tail and
 * add +10000.
 */
function findWindow(fileLines: string[], want: string[], from: number, eofAnchored: boolean): MatchResult | null {
  const n = want.length;
  if (n === 0) return { start: Math.min(from, fileLines.length), fuzz: eofAnchored ? 10000 : 0, similarity: 1 };
  if (n > fileLines.length) return null;

  const base = eofAnchored ? 10000 : 0;
  const starts: number[] = [];
  if (eofAnchored) {
    // Try the tail first, then fall back to the running start.
    const tail = Math.max(0, fileLines.length - n);
    for (let s = tail; s >= Math.max(0, from); s -= 1) starts.push(s);
    for (let s = Math.max(0, from); s + n <= fileLines.length; s += 1) if (!starts.includes(s)) starts.push(s);
  } else {
    for (let s = Math.max(0, from); s + n <= fileLines.length; s += 1) starts.push(s);
  }

  for (const s of starts) {
    const window = fileLines.slice(s, s + n);
    // (1) exact
    if (equalLines(window, want)) return { start: s, fuzz: base + 0, similarity: 1 };
    // (2) per-line trimEnd
    if (equalLines(window.map(trimEnd), want.map(trimEnd))) return { start: s, fuzz: base + 1, similarity: 1 };
    // (2b) relative indent match
    const winPrefix = commonIndentPrefix(window);
    const wantPrefix = commonIndentPrefix(want);
    if (winPrefix !== wantPrefix) {
      const winStripped = stripIndent(window, winPrefix);
      const wantStripped = stripIndent(want, wantPrefix);
      if (equalLines(winStripped, wantStripped)) {
        return { start: s, fuzz: base + 50, similarity: 1, reindent: { add: winPrefix, base: wantPrefix } };
      }
    }
    // (3) per-line trim
    if (equalLines(window.map((l) => l.trim()), want.map((l) => l.trim()))) return { start: s, fuzz: base + 100, similarity: 1 };
    // (3b) whitespace collapse
    if (equalLines(window.map(collapseWs), want.map(collapseWs))) return { start: s, fuzz: base + 500, similarity: 1 };
    // (4) Levenshtein similarity over the joined block
    const sim = similarity(window.join("\n"), want.join("\n"));
    if (sim >= SIMILARITY_THRESHOLD) return { start: s, fuzz: base + 1000, similarity: sim };
  }
  return null;
}

function equalLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function trimEnd(s: string): string {
  return s.replace(/[ \t\r\f\v]+$/, "");
}

/* ------------------------------- warnings --------------------------------- */

export interface PatchWarning {
  path: string;
  chunkIndex: number;
  message: string;
  context: string;
}

/** A <=200-char preview of a chunk's old-lines, for the skipped-chunk warning. */
function contextPreview(chunk: PatchChunk): string {
  const text = chunk.oldLines.join("\n");
  return text.length <= 200 ? text : text.slice(0, 200);
}

/* ------------------------------ update apply ------------------------------ */

interface UpdateOutcome {
  after: string;
  fuzz: number;
  warnings: PatchWarning[];
}

/**
 * Apply every chunk of an update to `before`, returning the new content, the
 * aggregate fuzz factor, and any skipped-chunk warnings. Matching runs on the
 * CANONICALISED line view; the splice is applied to the raw LF-view lines so
 * untouched bytes survive, then re-joined with the file's dominant ending.
 */
function applyUpdate(before: string, rel: string, chunks: PatchChunk[]): UpdateOutcome {
  const eol = detectEnding(before);
  let lines = toLines(before);
  const warnings: PatchWarning[] = [];
  let fuzz = 0;
  let cursor = 0;

  chunks.forEach((chunk, idx) => {
    const canonFile = lines.map(canonicalize);
    const want = chunk.oldLines.map(canonicalize);
    const match = findWindow(canonFile, want, cursor, chunk.eofAnchored);
    if (match === null) {
      const sim = closestSimilarity(canonFile, want, cursor);
      warnings.push({
        path: rel,
        chunkIndex: idx,
        message: `Could not find matching context (similarity: ${sim.toFixed(2)}). Chunk skipped.`,
        context: contextPreview(chunk),
      });
      return;
    }
    fuzz = Math.max(fuzz, match.fuzz);
    const n = want.length;
    let replacement = chunk.newLines;
    if (match.reindent) {
      replacement = reindentLines(chunk.newLines, match.reindent.add, match.reindent.base);
    }
    // Replace the matched window [start, start+n) with the chunk's new-lines.
    lines = [...lines.slice(0, match.start), ...replacement, ...lines.slice(match.start + n)];
    cursor = match.start + replacement.length;
  });

  return { after: fromLines(lines, eol), fuzz, warnings };
}

/** Best similarity for a failed match, for the warning's reported number. */
function closestSimilarity(fileLines: string[], want: string[], from: number): number {
  const n = want.length;
  if (n === 0 || n > fileLines.length) return 0;
  const wantJoined = want.join("\n");
  let best = 0;
  for (let s = Math.max(0, from); s + n <= fileLines.length; s += 1) {
    const sim = similarity(fileLines.slice(s, s + n).join("\n"), wantJoined);
    if (sim > best) best = sim;
  }
  return best;
}

/* --------------------------------- tool ----------------------------------- */

/** One guarded effect: guard -> approve -> protectedTarget -> preimage TOCTOU. */
async function guardAndPreimage(
  target: RealTarget,
  rel: string,
  verb: string,
  needsPreimage: boolean,
  ctx: ToolContext,
  held: Array<() => void>,
  wsBinding: Exclude<Awaited<ReturnType<typeof captureWorkspaceBinding>>, { error: string }>,
): Promise<{ ok: true; before: string | null } | { ok: false; error: string }> {
  const resolved = target.requested;
  const real = target.real;
  // The guard classifies the REAL target, not the patch's lexical spelling: a
  // symlinked file (or directory) must make the policy see "outside" and ask or
  // deny, never let an "inside" decision authorize bytes outside the workspace.
  const action: GuardAction = { kind: "fs.write", target: real };

  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return { ok: false, error: `apply_patch: denied by policy${decision.reason ? `: ${decision.reason}` : ""} (${rel})` };
  }

  // Preimage AFTER guard and BEFORE approval window (TOCTOU, like edit.ts).
  let before: string | null = null;
  let preSha = "absent";
  if (needsPreimage) {
    try {
      const buf = await readFile(real);
      if (isBinary(buf)) return { ok: false, error: `apply_patch: binary file (contains a NUL byte): ${rel}` };
      before = buf.toString("utf8");
      preSha = sha256Hex(before);
    } catch {
      return { ok: false, error: `apply_patch: file not found: ${rel}` };
    }
  }
  if (decision.decision === "ask" && !guardEffectivelyAllows(decision)) {
    const targetNote = real === resolved ? "" : `; resolves to ${real}`;
    const approved = await ctx.approve({ title: `${verb} ${rel}`, detail: `${verb}${targetNote}`, kind: "fs.write" }, action);
    if (!approved) return { ok: false, error: `apply_patch: declined by user (${rel})` };
  }

  // Effect-time protected-target refusal against the kernel state dir. The path
  // is re-resolved first: a racer that swapped the requested spelling while the
  // human was deciding must not redirect a delete/read to a path the policy
  // never classified. The refusal names the requested and the new real path.
  const effectReal = realpathish(resolved);
  if (effectReal !== real) {
    return {
      ok: false,
      error:
        `HZ_PRECONDITION_FAILED: apply_patch refused: ${resolved} now resolves to ${effectReal} ` +
        `(the approved target was ${real}); nothing was written`,
    };
  }
  const refused = await protectedTargetRefusal(resolved, effectReal, ctx);
  if (refused !== undefined) return { ok: false, error: refused };

  // Cross-process (core/file-lock.ts): take the per-file lock AFTER approval (never
  // hold it across a human decision) and keep it until applyOp's effect is done,
  // so verify -> write is one critical section. The caller releases `held`.
  try {
    held.push(await acquireLock(targetLockPath(ctx.workspace, effectReal)));
  } catch (e) {
    return { ok: false, error: `apply_patch: ${msg(e)} (${rel})` };
  }

  const wsDrift = await refuseWorkspaceIdentityDrift(ctx.workspace, wsBinding);
  if (wsDrift !== undefined) {
    return { ok: false, error: wsDrift };
  }

  // Re-read immediately before the effect: a change in the window is a conflict.
  if (needsPreimage) {
    let actual = "absent";
    try {
      actual = sha256Hex((await readFile(effectReal)).toString("utf8"));
    } catch {
      actual = "unreadable";
    }
    if (actual !== preSha) {
      return {
        ok: false,
        error:
          `HZ_PRECONDITION_FAILED: apply_patch refused: preimage changed: ${rel} ` +
          `(expected sha256 ${preSha}; actual sha256 ${actual}; re-read the file and retry)`,
      };
    }
  }

  return { ok: true, before };
}

async function applyOp(
  op: FileOp,
  ctx: ToolContext,
  summary: { added: string[]; updated: string[]; deleted: string[]; moved: string[] },
  warnings: PatchWarning[],
): Promise<{ ok: true; fuzz: number; checkpointNote: string } | { ok: false; error: string }> {
  const held: Array<() => void> = [];
  try {
    return await applyOpLocked(op, ctx, summary, warnings, held);
  } finally {
    for (const release of held.reverse()) release();
  }
}

async function applyOpLocked(
  op: FileOp,
  ctx: ToolContext,
  summary: { added: string[]; updated: string[]; deleted: string[]; moved: string[] },
  warnings: PatchWarning[],
  held: Array<() => void>,
): Promise<{ ok: true; fuzz: number; checkpointNote: string } | { ok: false; error: string }> {
  const wsBindingCap = await captureWorkspaceBinding(ctx.workspace);
  if (isWorkspaceBindingError(wsBindingCap)) return { ok: false, error: wsBindingCap.error };
  const wsBinding = wsBindingCap;

  if (op.kind === "add") {
    const target = resolveRealTarget(ctx.cwd, op.path, ctx.workspace);
    const resolved = target.requested;
    const real = target.real;
    const rel = relPath(ctx.cwd, resolved);
    if (escapesCwd(ctx.cwd, resolved) || escapesCwd(realpathish(ctx.cwd), real)) {
      return { ok: false, error: `apply_patch: path escapes the workspace: ${op.path}` };
    }
    // Add File means a NEW file: refuse when the target already exists rather
    // than silently clobbering content we have no undo preimage for. (write.ts
    // enforces the same read-before-overwrite discipline; here the grammar is
    // stricter — Add never overwrites.)
    if (await pathExists(real)) {
      return {
        ok: false,
        error: `apply_patch: Add File refused: ${rel} already exists (Add File creates a new file; use '*** Update File:' to modify it)`,
      };
    }
    const guarded = await guardAndPreimage(target, rel, "Add", false, ctx, held, wsBinding);
    if (guarded.ok !== true) return { ok: false, error: guarded.error };
    // Re-check existence INSIDE the per-file lock so a concurrent creator
    // during the approval window cannot be clobbered.
    if (await pathExists(real)) {
      return {
        ok: false,
        error: `HZ_PRECONDITION_FAILED: apply_patch: Add File refused: ${rel} appeared before write lock was acquired`,
      };
    }
    // E-1: Add creates a new file (no pre-existing dirt), so this is a no-op,
    // but call the same opt-in hook for uniform coverage of every op.
    const checkpointNote = dirtyCheckpointPrefix(ctx, rel);
    const content = op.addBody.join("\n") + (op.addBody.length > 0 ? "\n" : "");
    const outcome = await withEffectR170BunMutationFence(ctx.workspace, async () => {
      await mkdir(path.dirname(real), { recursive: true });
      return writeAtomic(real, content, ctx, real, wsBinding);
    });
    if (isRefused(outcome)) return { ok: false, error: outcome.refusal };
    // D-4: journal the real target (see write.ts).
    await recordChangeGuarded(ctx.sessionId, { workspace: ctx.workspace, path: real, rel, before: null, afterSha256: sha256Hex(content), at: Date.now(), tool: "write" });
    noteRead(ctx, real);
    summary.added.push(rel);
    return { ok: true, fuzz: 0, checkpointNote };
  }

  if (op.kind === "delete") {
    const target = resolveRealTarget(ctx.cwd, op.path, ctx.workspace);
    const resolved = target.requested;
    const rel = relPath(ctx.cwd, resolved);
    if (escapesCwd(ctx.cwd, resolved) || escapesCwd(realpathish(ctx.cwd), target.real)) {
      return { ok: false, error: `apply_patch: path escapes the workspace: ${op.path}` };
    }
    const guarded = await guardAndPreimage(target, rel, "Delete", true, ctx, held, wsBinding);
    if (guarded.ok !== true) return { ok: false, error: guarded.error };
    const checkpointNote = dirtyCheckpointPrefix(ctx, rel);
    // The removal only runs after the full guard + approval + protectedTarget +
    // preimage + workspace-drift checks above; inspect via lstat so symlinks are
    // unlinked safely (never following them or deleting a directory).
    const delErr = await withEffectR170BunMutationFence(ctx.workspace, async (): Promise<string | undefined> => {
      try {
        const st = await lstat(resolved);
        if (st.isDirectory()) {
          return `apply_patch: refusing to delete directory: ${rel}`;
        }
        if (st.isSymbolicLink()) {
          if (realpathish(resolved) !== target.real) {
            return `HZ_PRECONDITION_FAILED: apply_patch refused: symlink ${rel} drifted before delete`;
          }
          await unlink(resolved);
        } else {
          await rm(resolved);
        }
        return undefined;
      } catch (e) {
        return `apply_patch: could not delete ${rel}: ${msg(e)}`;
      }
    });
    if (delErr !== undefined) return { ok: false, error: delErr };
    await recordChangeGuarded(ctx.sessionId, { workspace: ctx.workspace, path: target.real, rel, before: guarded.before, afterSha256: sha256Hex(""), at: Date.now(), tool: "write" });
    summary.deleted.push(rel);
    return { ok: true, fuzz: 0, checkpointNote };
  }

  // update (optionally with a move)
  const target = resolveRealTarget(ctx.cwd, op.path, ctx.workspace);
  const resolved = target.requested;
  const real = target.real;
  const rel = relPath(ctx.cwd, resolved);
  if (escapesCwd(ctx.cwd, resolved) || escapesCwd(realpathish(ctx.cwd), real)) {
    return { ok: false, error: `apply_patch: path escapes the workspace: ${op.path}` };
  }

  const guarded = await guardAndPreimage(target, rel, op.movePath === undefined ? "Update" : "Move", true, ctx, held, wsBinding);
  if (guarded.ok !== true) return { ok: false, error: guarded.error };
  const before = guarded.before ?? "";

  const { after, fuzz, warnings: w } = applyUpdate(before, rel, op.chunks);
  warnings.push(...w);

  if (op.movePath === undefined) {
    const checkpointNote = dirtyCheckpointPrefix(ctx, rel);
    const outcome = await withEffectR170BunMutationFence(ctx.workspace, () => writeAtomic(real, after, ctx, real, wsBinding));
    if (isRefused(outcome)) return { ok: false, error: outcome.refusal };
    await recordChangeGuarded(ctx.sessionId, { workspace: ctx.workspace, path: real, rel, before, afterSha256: sha256Hex(after), at: Date.now(), tool: "edit" });
    noteRead(ctx, real);
    summary.updated.push(rel);
    return { ok: true, fuzz, checkpointNote };
  }

  // Move: the destination is its own guarded write target; the source is then
  // removed. Confine the destination to cwd as well.
  const destTarget = resolveRealTarget(ctx.cwd, op.movePath, ctx.workspace);
  const destResolved = destTarget.requested;
  const destReal = destTarget.real;
  const destRel = relPath(ctx.cwd, destResolved);
  if (escapesCwd(ctx.cwd, destResolved) || escapesCwd(realpathish(ctx.cwd), destReal)) {
    return { ok: false, error: `apply_patch: move destination escapes the workspace: ${op.movePath}` };
  }
  // A move may legitimately land on an existing file. Unlike Add File we do not
  // refuse, but we must NOT journal `before: null` and silently destroy the
  // destination's content: read its real bytes first (when `needsPreimage`,
  // guardAndPreimage returns that preimage) so undo can restore what the move
  // clobbered. A brand-new destination returns `before: null` as before.
  const destExists = await pathExists(destReal);
  const destGuarded = await guardAndPreimage(destTarget, destRel, "Create", destExists, ctx, held, wsBinding);
  if (destGuarded.ok !== true) return { ok: false, error: destGuarded.error };
  const destBefore = destGuarded.before; // the clobbered file's real preimage, or null for a new file
  // E-1: both the move destination (possibly overwritten) and the source
  // (about to be removed) get the same opt-in checkpoint before either effect.
  const checkpointNote = dirtyCheckpointPrefix(ctx, destRel) + dirtyCheckpointPrefix(ctx, rel);
  const moveErr = await withEffectR170BunMutationFence(ctx.workspace, async (): Promise<string | undefined> => {
    await mkdir(path.dirname(destReal), { recursive: true });
    const outcome = await writeAtomic(destReal, after, ctx, destReal, wsBinding);
    if (isRefused(outcome)) return outcome.refusal;
    try {
      const st = await lstat(resolved);
      if (st.isDirectory()) {
        return `apply_patch: refusing to remove directory during move: ${rel}`;
      }
      if (realpathish(resolved) !== real) {
        return `HZ_PRECONDITION_FAILED: apply_patch refused: source ${rel} drifted before move cleanup`;
      }
      if (st.isSymbolicLink()) {
        await unlink(resolved);
      } else {
        await rm(resolved);
      }
      return undefined;
    } catch (e) {
      return `apply_patch: moved content to ${destRel} but could not remove ${rel}: ${msg(e)}`;
    }
  });
  if (moveErr !== undefined) return { ok: false, error: moveErr };
  await recordChangeGuarded(ctx.sessionId, { workspace: ctx.workspace, path: destReal, rel: destRel, before: destBefore, afterSha256: sha256Hex(after), at: Date.now(), tool: "write" });
  await recordChangeGuarded(ctx.sessionId, { workspace: ctx.workspace, path: real, rel, before, afterSha256: sha256Hex(""), at: Date.now(), tool: "write" });
  noteRead(ctx, destReal);
  summary.moved.push(`${rel} -> ${destRel}`);
  return { ok: true, fuzz, checkpointNote };
}

/** A compact "added X; updated Y; …" list of ops that already landed, for the error. */
function summarizeApplied(summary: { added: string[]; updated: string[]; deleted: string[]; moved: string[] }): string {
  const parts: string[] = [];
  if (summary.added.length > 0) parts.push(`added ${summary.added.join(", ")}`);
  if (summary.updated.length > 0) parts.push(`updated ${summary.updated.join(", ")}`);
  if (summary.deleted.length > 0) parts.push(`deleted ${summary.deleted.join(", ")}`);
  if (summary.moved.length > 0) parts.push(`moved ${summary.moved.join(", ")}`);
  return parts.join("; ");
}

export const applyPatchTool: Tool = {
  name: "apply_patch",
  description:
    "Apply a freeform patch in the GPT-5/Codex apply_patch format. The single `input` string must be wrapped in '*** Begin Patch' / '*** End Patch' and use '*** Add File: <path>', '*** Update File: <path>' (with '@@' context chunks of ' ' context, '-' deletions and '+' additions, optionally '*** End of File'), '*** Delete File: <path>' and '*** Move to: <path>'. Context is matched with a graded fuzz ladder; chunks that cannot be located are skipped with a warning.",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description:
          "The full patch text, from '*** Begin Patch' to '*** End Patch'. Every Add File body line starts with '+'; Update chunks use ' '/'-'/'+' line prefixes under '@@' headers.",
      },
    },
    required: ["input"],
  },

  // NF-072: a mutating tool — an exclusive call is its own barrier in a batch.
  concurrencyClass: "exclusive",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      // B-2: the patch text names its file targets ("Update File: ...") — record
      // them as "files in context" for the repo-map budget.
      noteToolContext(ctx.sessionId, args);
      if (typeof args.input !== "string" || args.input === "") return fail("input is required");

      const parsed = parse(args.input);
      if (parsed.ok !== true) return fail(parsed.error);

      const summary = { added: [] as string[], updated: [] as string[], deleted: [] as string[], moved: [] as string[] };
      const warnings: PatchWarning[] = [];
      let fuzz = 0;
      let checkpointNotes = "";

      // Ops apply in source order. There is NO cross-op rollback (named residual
      // in this module's header), so on a mid-patch failure the ops that already
      // landed stay on disk — name them in the error so the caller can recover
      // (each is individually undoable via the change journal).
      for (const op of parsed.patch.ops) {
        const r = await applyOp(op, ctx, summary, warnings);
        if (r.ok !== true) {
          const applied = summarizeApplied(summary);
          const note = applied === "" ? "no ops were applied before this failure" : `already applied before this failure: ${applied}`;
          return fail(`${r.error} (${note})`);
        }
        fuzz = Math.max(fuzz, r.fuzz);
        checkpointNotes += r.checkpointNote;
      }

      const parts: string[] = [];
      if (summary.added.length > 0) parts.push(`added ${summary.added.length} (${summary.added.join(", ")})`);
      if (summary.updated.length > 0) parts.push(`updated ${summary.updated.length} (${summary.updated.join(", ")})`);
      if (summary.deleted.length > 0) parts.push(`deleted ${summary.deleted.length} (${summary.deleted.join(", ")})`);
      if (summary.moved.length > 0) parts.push(`moved ${summary.moved.length} (${summary.moved.join(", ")})`);

      const lines = [`Patch applied with fuzz factor ${fuzz}`];
      // E-1: surface any dirty-checkpoint notices from the mutated paths.
      if (checkpointNotes !== "") lines.push(checkpointNotes.trimEnd());
      if (parts.length > 0) lines.push(parts.join("; "));
      for (const w of warnings) {
        lines.push(`WARNING ${w.path} chunk ${w.chunkIndex}: ${w.message}\n${w.context}`);
      }
      // E-1 residual: opt-in lint-fix commit after successful mutations of
      // recently linted paths (add / update / move destination).
      const lintTargets: string[] = [
        ...summary.added,
        ...summary.updated,
        ...summary.moved.map((m) => {
          const arrow = m.lastIndexOf(" -> ");
          return arrow === -1 ? m : m.slice(arrow + 4);
        }),
      ];
      const lintFixNote = formatLintFixCommitSuffixes(ctx.sessionId, ctx.workspace, lintTargets);
      if (lintFixNote !== "") lines.push(lintFixNote.trimStart());

      // POST-EDIT NOTICE ONLY: every op has already landed on disk. Opt-in via
      // HZ_APPLY_PATCH_LSP_NOTICE=1; default off keeps existing output byte-
      // identical. This can NEVER reject or block the edit — a missing hook, a
      // failed query, or an absent config all reduce to "no notice". Deleted
      // paths are excluded (there is nothing on disk to diagnose).
      if (process.env.HZ_APPLY_PATCH_LSP_NOTICE === "1" && ctx.postEditDiagnosticsNotice !== undefined) {
        try {
          const mutatedRels: string[] = [
            ...summary.added,
            ...summary.updated,
            ...summary.moved.map((m) => {
              const arrow = m.lastIndexOf(" -> ");
              return arrow === -1 ? m : m.slice(arrow + 4);
            }),
          ];
          const notice = await ctx.postEditDiagnosticsNotice(mutatedRels.map((rel) => path.resolve(ctx.cwd, rel)));
          if (notice !== "") lines.push(notice);
        } catch {
          /* a post-edit diagnostic failure must never sink a successful patch */
        }
      }

      return { ok: true, output: lines.join("\n") };
    } catch (e) {
      tunnelPermissionError(e);
      return fail(msg(e));
    }
  },
};
