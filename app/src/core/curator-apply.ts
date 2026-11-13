/**
 * curator-apply.ts — opt-in append-only memory bank note apply (docs/28 ruling 242).
 *
 * Default (ruling 27): the curator store applies nothing. When
 * `HZ_CURATOR_APPLY=1`, `grow --apply` may materialize **memory** proposals only
 * as append-only text under `<stateRoot>/memory/notes/` (dry-run without `--yes`).
 * Skill and prompt rows are refused while the flag is set (library apply remains
 * available with the flag unset). Target paths must stay inside the resolved
 * memory notes directory — any escape is refused.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "./canon";
import { realpathish } from "./paths";
import type { StoredProposalRow } from "./curator";
import { MEMORY_TOPIC_DIR, memoryTopicDir } from "./memory/manifest";

export const CURATOR_APPLY_ENV = "HZ_CURATOR_APPLY";
export const MEMORY_NOTES_SUBDIR = "notes";

export type CuratorApplyErrorReason = "path-escape" | "invalid-target";

export class CuratorApplyError extends Error {
  readonly reason: CuratorApplyErrorReason;
  readonly detail: string;

  constructor(reason: CuratorApplyErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CuratorApplyError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** True when env enables memory bank note apply (`HZ_CURATOR_APPLY=1`). */
export function curatorApplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CURATOR_APPLY_ENV] === "1";
}

function slugOf(title: string): string {
  const slug = (typeof title === "string" ? title : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug === "" ? "proposal" : slug;
}

/** Root for curated note files: `<stateRoot>/memory/notes/`. */
export function memoryBankNotesDir(workspace: string): string {
  return path.join(memoryTopicDir(workspace), MEMORY_NOTES_SUBDIR);
}

/** `<stateRoot>/memory/notes/<slug>-<digest8>.md` — one note file per proposal. */
export function memoryBankNotePath(workspace: string, row: Pick<StoredProposalRow, "title" | "digest">): string {
  return path.join(memoryBankNotesDir(workspace), `${slugOf(row.title)}-${row.digest.slice(0, 8)}.md`);
}

const PROPOSAL_MARKER_RE = /<!--\s*curator-apply\s+proposal\s+([0-9a-f]{64})/gi;

/** Proposal digests already recorded in note bytes (footer markers). */
export function appliedProposalDigestsInNote(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(PROPOSAL_MARKER_RE)) {
    const id = match[1];
    if (typeof id === "string" && id.length === 64) found.add(id);
  }
  return found;
}

/** True when this proposal's footer marker is already present. */
export function noteAlreadyContainsProposal(text: string, digest: string): boolean {
  return appliedProposalDigestsInNote(text).has(digest);
}

/** Markdown block appended to a bank note (append-only; never replaces prior bytes). */
export function memoryBankNoteAppendBlock(row: Pick<StoredProposalRow, "title" | "body" | "digest" | "createdAt">): string {
  return (
    `\n\n## ${row.title}\n\n${row.body}\n\n` +
    `<!-- curator-apply proposal ${row.digest} recorded ${row.createdAt} -->\n`
  );
}

/** Initial bytes for a new note file. */
export function memoryBankNoteFileHeader(): string {
  return `# Memory bank notes\n\nAppend-only curator-applied memory proposals (${MEMORY_TOPIC_DIR}/${MEMORY_NOTES_SUBDIR}/).\n`;
}

/**
 * Merge `existing` with one append block for `row`. Refuses when the digest is
 * already present. Returns null when the merge would be a no-op (duplicate).
 */
export function mergeMemoryBankNoteAppend(
  existing: string | null,
  row: Pick<StoredProposalRow, "title" | "body" | "digest" | "createdAt">,
): string | null {
  const prior = existing ?? "";
  if (prior !== "" && noteAlreadyContainsProposal(prior, row.digest)) return null;
  const base = prior === "" ? memoryBankNoteFileHeader() : prior.endsWith("\n") ? prior : `${prior}\n`;
  return base + memoryBankNoteAppendBlock(row);
}

function assertMemoryNotesDirContained(workspace: string): void {
  const topicRoot = path.resolve(realpathish(memoryTopicDir(workspace)));
  const notesRoot = path.resolve(realpathish(memoryBankNotesDir(workspace)));
  const rel = path.relative(topicRoot, notesRoot);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !(rel === MEMORY_NOTES_SUBDIR || rel.startsWith(`${MEMORY_NOTES_SUBDIR}${path.sep}`))) {
    throw new CuratorApplyError(
      "path-escape",
      `memory notes directory ${JSON.stringify(notesRoot)} must stay under ${JSON.stringify(topicRoot)}`,
    );
  }
}

/** Fail closed unless `target` resolves inside the memory notes directory. */
export function assertSafeMemoryBankNotePath(workspace: string, target: string): void {
  assertMemoryNotesDirContained(workspace);
  const root = path.resolve(realpathish(memoryBankNotesDir(workspace)));
  const resolved = path.resolve(realpathish(target));
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CuratorApplyError(
      "path-escape",
      `memory bank note path ${JSON.stringify(target)} must stay under ${JSON.stringify(root)}`,
    );
  }
  const segment = path.basename(resolved);
  if (segment.includes("..") || segment.includes("\0") || segment.startsWith(".")) {
    throw new CuratorApplyError("path-escape", `unsafe note filename ${JSON.stringify(segment)}`);
  }
}

/** Stable digest of the post-merge file content (receipt resultDigest). */
export function memoryBankNoteContentDigest(content: string): string {
  return sha256Hex(content);
}

/** Read existing note text; missing file => null; unreadable non-text => throw. */
export function readMemoryBankNoteText(target: string): string | null {
  try {
    if (!existsSync(target)) return null;
    const buf = readFileSync(target);
    const losslessUtf8 = Buffer.from(buf.toString("utf8"), "utf8").equals(buf);
    if (buf.includes(0) || !losslessUtf8) {
      throw new CuratorApplyError("invalid-target", `${target} exists but is not restorable UTF-8 text`);
    }
    return buf.toString("utf8");
  } catch (err) {
    if (err instanceof CuratorApplyError) throw err;
    throw new CuratorApplyError("invalid-target", `could not read ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Ensure the notes directory exists (owner-only on Unix best-effort). */
export function ensureMemoryBankNotesDir(workspace: string): string {
  const dir = memoryBankNotesDir(workspace);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertMemoryNotesDirContained(workspace);
  return dir;
}
