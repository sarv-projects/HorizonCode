/**
 * hunk-tracker.ts — grok xai-hunk-tracker ADAPT (VCS surface).
 * Source: repo_take/grok-build/crates/codegen/xai-hunk-tracker/src/{types.rs:68-89,550-598}.
 *
 * Pure per-hunk agent-vs-external attribution with per-prompt indexing and a
 * cwd-change path rewrite that tries both raw and canonical prefixes (macOS
 * /var→/private/var). No filesystem I/O, no git subprocess, no authority — the
 * attribution data model + rewrite seam, not a full diff engine.
 */

export type HunkSource =
  | { type: "agent_edit"; promptIndex: number }
  | { type: "external_edit_on_agent_file" }
  | { type: "external" };

export interface TrackedHunk {
  id: string;
  path: string;
  source: HunkSource;
}

/** Rewrite one absolute path from an old cwd prefix to a new one; raw + canonical. */
export function rewriteSinglePath(
  path: string,
  oldCwd: string,
  canonicalOldCwd: string,
  newCwd: string,
): string | undefined {
  for (const prefix of [canonicalOldCwd, oldCwd]) {
    if (prefix !== "" && (path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
      const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      const rel = path.slice(base.length).replace(/^\//, "");
      return rel === "" ? newCwd : `${newCwd.replace(/\/+$/, "")}/${rel}`;
    }
  }
  return undefined;
}

export class HunkTracker {
  private hunks: TrackedHunk[] = [];
  private seq = 0;

  record(path: string, source: HunkSource): TrackedHunk {
    const hunk: TrackedHunk = { id: `hunk-${this.seq++}`, path, source };
    this.hunks.push(hunk);
    return hunk;
  }

  forFile(path: string): TrackedHunk[] {
    return this.hunks.filter((h) => h.path === path);
  }

  forPrompt(promptIndex: number): TrackedHunk[] {
    return this.hunks.filter((h) => h.source.type === "agent_edit" && h.source.promptIndex === promptIndex);
  }

  rewritePaths(oldCwd: string, canonicalOldCwd: string, newCwd: string): void {
    this.hunks = this.hunks.map((h) => {
      const next = rewriteSinglePath(h.path, oldCwd, canonicalOldCwd, newCwd);
      return next === undefined ? h : { ...h, path: next };
    });
  }
}
