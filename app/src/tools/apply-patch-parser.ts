/**
 * apply-patch-parser.ts — a pure parser for the GPT-5/Codex freeform
 * `apply_patch` grammar (docs/30; research/compare-cline-claude.md A.5 +
 * research/compare-codex-grok.md 1.5).
 *
 * This module is SIDE-EFFECT FREE: no `fs`, no `ctx`, no disk. It turns a block
 * of patch text into a structured `Patch` (an ordered list of file operations)
 * or a typed parse error. The tool (./apply-patch.ts) owns every effect, guard,
 * receipt and preimage check; the parser only decides shape.
 *
 * The grammar markers are EXACT (a leading `*** ` sentinel), mirroring codex's
 * `apply-patch/parser.rs` and cline's `apply-patch-parser.ts`:
 *
 *   *** Begin Patch           opens the patch
 *   *** End Patch             closes it
 *   *** Add File: <path>      a new file; every body line must start with '+'
 *   *** Update File: <path>   an edit; followed by @@ chunks
 *   *** Move to: <path>       (inside an Update) renames the file
 *   *** Delete File: <path>   removes a file
 *   @@ [context]              opens an update chunk (optional context header)
 *   *** End of File           marks the final chunk as EOF-anchored
 *
 * BASH_WRAPPERS ('%%bash', 'apply_patch', 'EOF', a bare markdown fence '```')
 * are tolerated anywhere OUTSIDE the Begin/End envelope so a model that wraps
 * the call in a heredoc or a fenced block still parses.
 *
 * `canonicalize(line)` is the Unicode-fold used by the tool's fuzz ladder: NFC
 * + typographic-dash fold + smart-quote fold + odd-space fold + unescape of
 * backslash-escaped backtick/quote forms. It is exported so the matcher and the
 * tests share one definition (the fold is a byte-stable contract once tests pin
 * it, docs/30 A-5).
 */

/** The exact grammar sentinels. A line is a marker only with this prefix. */
export const PATCH_MARKERS = {
  beginPatch: "*** Begin Patch",
  endPatch: "*** End Patch",
  addFile: "*** Add File: ",
  updateFile: "*** Update File: ",
  deleteFile: "*** Delete File: ",
  moveTo: "*** Move to: ",
  chunk: "@@",
  endOfFile: "*** End of File",
} as const;

/** Lines tolerated outside the Begin/End envelope (heredoc / fence wrappers). */
export const BASH_WRAPPERS = ["%%bash", "apply_patch", "EOF", "```"] as const;

/** One update chunk: a context window, the lines it deletes, the lines it inserts. */
export interface PatchChunk {
  /** Context lines (' '-prefixed) that precede the change, raw (uncanonicalised). */
  contextBefore: string[];
  /** Lines this chunk removes ('-'-prefixed), in order. */
  deletes: string[];
  /** Lines this chunk inserts ('+'-prefixed), in order. */
  inserts: string[];
  /**
   * The pre-image window to LOCATE in the file, in source order: every context
   * (' ') and delete ('-') line as it appeared, interleaving preserved. This is
   * what the fuzz ladder matches against the file's lines.
   */
  oldLines: string[];
  /**
   * The post-image the matched window becomes, in source order: every context
   * (' ') and insert ('+') line. Replacing `oldLines` with `newLines` applies
   * the chunk.
   */
  newLines: string[];
  /** The optional `@@ <header>` context string (may be empty). */
  header: string;
  /** True when `*** End of File` closed the chunk (anchor the search at EOF). */
  eofAnchored: boolean;
}

/** One file operation in the patch, in source order. */
export type FileOp =
  | { kind: "add"; path: string; addBody: string[] }
  | { kind: "update"; path: string; movePath?: string; chunks: PatchChunk[] }
  | { kind: "delete"; path: string };

export interface Patch {
  ops: FileOp[];
}

export type ParseResult = { ok: true; patch: Patch } | { ok: false; error: string };

/* ------------------------------ canonicalize ------------------------------ */

/** Typographic dashes U+2010..U+2015 and the minus sign U+2212 fold to '-'. */
const DASH_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
/** Smart single quotes (and primes) fold to a straight apostrophe. */
const SINGLE_QUOTE_RE = /[\u2018\u2019\u201A\u201B\u2032]/g;
/** Smart double quotes (and double prime) fold to a straight quote. */
const DOUBLE_QUOTE_RE = /[\u201C\u201D\u201E\u201F\u2033]/g;
/** NBSP, narrow NBSP, en/em/thin/hair/figure spaces and the ideographic space. */
const SPACE_RE = /[\u00A0\u202F\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u3000]/g;
/** Backslash-escaped backtick / quote forms the model sometimes emits. */
const UNESCAPE_RE = /\\([`'"])/g;

/**
 * Fold a single line to its canonical ASCII-leaning form: NFC first (so a
 * composed and a decomposed accent compare equal), then the typographic folds,
 * then unescape `\``, `\'`, `\"`. Pure; no newlines expected (callers split).
 */
export function canonicalize(line: string): string {
  return line
    .normalize("NFC")
    .replace(DASH_RE, "-")
    .replace(SINGLE_QUOTE_RE, "'")
    .replace(DOUBLE_QUOTE_RE, '"')
    .replace(SPACE_RE, " ")
    .replace(UNESCAPE_RE, "$1");
}

/* -------------------------------- parsing --------------------------------- */

function err(error: string): ParseResult {
  return { ok: false, error };
}

/** True when `line` is one of the tolerated wrapper lines (trimmed compare). */
function isBashWrapper(line: string): boolean {
  const t = line.trim();
  return (BASH_WRAPPERS as readonly string[]).includes(t);
}

/**
 * Parse `text` into a structured `Patch`. The body between `*** Begin Patch`
 * and `*** End Patch` is authoritative; wrapper lines are tolerated only
 * outside it. Returns a typed error (never throws) for a malformed patch.
 */
export function parse(text: string): ParseResult {
  const rawLines = text.split("\n");

  // Find the envelope, skipping wrapper lines before it.
  let i = 0;
  while (i < rawLines.length && (rawLines[i] as string).trim() !== PATCH_MARKERS.beginPatch) {
    const line = rawLines[i] as string;
    if (line.trim() === "" || isBashWrapper(line)) {
      i += 1;
      continue;
    }
    return err(`apply_patch: expected '${PATCH_MARKERS.beginPatch}' but found: ${line.trim().slice(0, 80)}`);
  }
  if (i >= rawLines.length) return err(`apply_patch: missing '${PATCH_MARKERS.beginPatch}'`);
  i += 1; // consume Begin Patch

  const ops: FileOp[] = [];
  const seenPaths = new Set<string>();
  let sawEnd = false;

  const noteDuplicate = (verb: string, p: string): string | undefined => {
    if (seenPaths.has(p)) return `apply_patch: Duplicate ${verb} for file: ${p}`;
    seenPaths.add(p);
    return undefined;
  };

  while (i < rawLines.length) {
    const line = rawLines[i] as string;

    if (line.trim() === PATCH_MARKERS.endPatch) {
      sawEnd = true;
      i += 1;
      break;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    /* ---- Add File ---- */
    if (line.startsWith(PATCH_MARKERS.addFile)) {
      const p = line.slice(PATCH_MARKERS.addFile.length).trim();
      if (p === "") return err("apply_patch: Add File requires a path");
      const dup = noteDuplicate("add", p);
      if (dup !== undefined) return err(dup);
      i += 1;
      const addBody: string[] = [];
      while (i < rawLines.length) {
        const body = rawLines[i] as string;
        if (body.startsWith("*** ")) break; // next op / End Patch
        // Every Add-File body line must start with '+'. An unprefixed non-empty
        // line is an error.
        if (!body.startsWith("+")) {
          return err(`apply_patch: Add File '${p}' body line must start with '+': ${body.slice(0, 80)}`);
        }
        addBody.push(body.slice(1));
        i += 1;
      }
      ops.push({ kind: "add", path: p, addBody });
      continue;
    }

    /* ---- Delete File ---- */
    if (line.startsWith(PATCH_MARKERS.deleteFile)) {
      const p = line.slice(PATCH_MARKERS.deleteFile.length).trim();
      if (p === "") return err("apply_patch: Delete File requires a path");
      const dup = noteDuplicate("delete", p);
      if (dup !== undefined) return err(dup);
      i += 1;
      ops.push({ kind: "delete", path: p });
      continue;
    }

    /* ---- Update File ---- */
    if (line.startsWith(PATCH_MARKERS.updateFile)) {
      const p = line.slice(PATCH_MARKERS.updateFile.length).trim();
      if (p === "") return err("apply_patch: Update File requires a path");
      const dup = noteDuplicate("update", p);
      if (dup !== undefined) return err(dup);
      i += 1;

      let movePath: string | undefined;
      // An optional '*** Move to:' immediately follows the Update header.
      if (i < rawLines.length && (rawLines[i] as string).startsWith(PATCH_MARKERS.moveTo)) {
        movePath = (rawLines[i] as string).slice(PATCH_MARKERS.moveTo.length).trim();
        if (movePath === "") return err("apply_patch: Move to requires a path");
        i += 1;
      }

      const chunks: PatchChunk[] = [];
      let current: PatchChunk | undefined;
      const pushCurrent = () => {
        if (current !== undefined) chunks.push(current);
        current = undefined;
      };

      while (i < rawLines.length) {
        const body = rawLines[i] as string;
        if (body.startsWith("*** ") && body.trim() !== PATCH_MARKERS.endOfFile) {
          break; // next op or End Patch
        }
        if (body.trim() === PATCH_MARKERS.endOfFile) {
          if (current === undefined) current = newChunk("");
          current.eofAnchored = true;
          i += 1;
          continue;
        }
        if (body.startsWith(PATCH_MARKERS.chunk)) {
          pushCurrent();
          current = newChunk(body.slice(PATCH_MARKERS.chunk.length).trim());
          i += 1;
          continue;
        }
        if (current === undefined) current = newChunk("");
        // Diff body line: '+' insert, '-' delete, ' ' (or bare) context. The
        // ordered old/new windows preserve interleaving for the fuzz matcher.
        if (body.startsWith("+")) {
          const v = body.slice(1);
          current.inserts.push(v);
          current.newLines.push(v);
        } else if (body.startsWith("-")) {
          const v = body.slice(1);
          current.deletes.push(v);
          current.oldLines.push(v);
        } else {
          const v = body.startsWith(" ") ? body.slice(1) : body;
          current.contextBefore.push(v);
          current.oldLines.push(v);
          current.newLines.push(v);
        }
        i += 1;
      }
      pushCurrent();
      if (chunks.length === 0) {
        return err(`apply_patch: Update File '${p}' has no @@ chunks`);
      }
      ops.push(movePath === undefined ? { kind: "update", path: p, chunks } : { kind: "update", path: p, movePath, chunks });
      continue;
    }

    return err(`apply_patch: unexpected line: ${line.trim().slice(0, 80)}`);
  }

  if (!sawEnd) return err(`apply_patch: missing '${PATCH_MARKERS.endPatch}'`);
  if (ops.length === 0) return err("apply_patch: empty patch (no file operations)");
  return { ok: true, patch: { ops } };
}

function newChunk(header: string): PatchChunk {
  return { contextBefore: [], deletes: [], inserts: [], oldLines: [], newLines: [], header, eofAnchored: false };
}
