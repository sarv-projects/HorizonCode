/**
 * repo-map-context.ts — B-2 residual: derive "no files in context" from the
 * conversation rather than only from the `focus` tool argument.
 *
 * Aider's `map-multiplier-no-files` expands the repo-map budget when the chat
 * has no named files. This module supplies BOTH halves of that decision:
 *
 *  - a PURE detector (`looksLikeFilePath` / `filePathMentions` /
 *    `conversationHasFilesInContext`) over the signals a conversation can carry
 *    — file-path mentions, read/edit/write/apply_patch targets and attachments;
 *  - a bounded, session-scoped tracker (`noteFileInSession` /
 *    `sessionHasFilesInContext`) that the file-touching tools update, because
 *    `ToolContext` deliberately carries no transcript history.
 *
 * Zero dependencies, no I/O, no contract changes. The tracker is process-local
 * and keyed by session id; callers that want a different scope can use the pure
 * functions directly.
 */

/** Code-ish extensions that make a bare token unambiguously a file name. */
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "pyi", "rs", "go", "java", "kt", "cs", "rb", "php",
  "c", "h", "cc", "cpp", "hpp", "zig", "swift", "scala",
  "json", "jsonc", "md", "markdown", "yaml", "yml", "toml", "txt",
  "sh", "bash", "sql", "html", "css", "scss", "vue", "svelte",
]);

/**
 * True when `value` names a file: an absolute/relative path, a `path:line`
 * reference, a bare `name.ext`, a markdown/backtick-wrapped path, or an
 * attachment-style `{path|name|filename}` value. Pure and conservative —
 * prose like "e.g." or "v1.2.3" is NOT a file.
 */
export function looksLikeFilePath(value: unknown, depth = 0): boolean {
  if (depth > 1) return false;
  if (typeof value === "object" && value !== null) {
    const obj = value as { path?: unknown; name?: unknown; filename?: unknown; type?: unknown };
    // An attachment is a file when any of its name fields looks like a path,
    // but never merely because it has a media `type`.
    return (
      looksLikeFilePath(obj.path, depth + 1) ||
      looksLikeFilePath(obj.name, depth + 1) ||
      looksLikeFilePath(obj.filename, depth + 1)
    );
  }
  if (typeof value !== "string") return false;
  let text = value.trim();
  if (text === "" || text.length > 1024) return false;
  if (/[\r\n\u0000]/.test(text)) return false;
  // Trim leading list/quote/backtick decorations and a trailing :line:col ref.
  text = text.replace(/^[\s`'">*\-]+/, "").replace(/[`'",;\s]+$/, "");
  text = text.replace(/:\d+(:\d+)?$/, "");
  if (text === "" || text.includes("..")) return false;
  // A path with at least one separator is a file when its last component has
  // an extension or the path is absolute (so `/etc/hosts` counts).
  if (text.includes("/")) {
    const parts = text.split("/").filter((p) => p !== "");
    if (parts.length === 0) return false;
    const base = parts[parts.length - 1] as string;
    return /^[A-Za-z0-9_@.\-]+\.[A-Za-z0-9]+$/.test(base) || text.startsWith("/");
  }
  // Windows-style path.
  if (/^[A-Za-z]:[\\/]/.test(text) || text.includes("\\")) return true;
  // A bare filename with a known code extension.
  const bare = /^([A-Za-z0-9_@.\-]+)\.([A-Za-z0-9]+)$/.exec(text);
  if (bare === null) return false;
  return CODE_EXT.has((bare[2] as string).toLowerCase());
}

/** Split free-form conversation text into candidate file-path mentions. */
export function filePathMentions(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const candidates = text.match(/[^\s`'\"()\[\]{},;]+/g) ?? [];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (looksLikeFilePath(candidate)) out.push(candidate);
  }
  return out;
}

export type ConversationContextItem = string | { path?: unknown; name?: unknown; filename?: unknown } | null | undefined;

/**
 * Pure: did the conversation name any file? `items` may mix raw text (scanned
 * for path mentions), exact target paths, and attachment-like objects. Used by
 * tests and by callers that already hold the signals without a session store.
 */
export function conversationHasFilesInContext(items: readonly ConversationContextItem[]): boolean {
  if (!Array.isArray(items)) return false;
  for (const item of items) {
    if (typeof item === "string") {
      if (looksLikeFilePath(item) || filePathMentions(item).length > 0) return true;
    } else if (looksLikeFilePath(item)) {
      return true;
    }
  }
  return false;
}

/* ------------------------- session-scoped tracker ------------------------- */

const MAX_PATHS_PER_SESSION = 256;
const MAX_SESSIONS = 512;
const sessionFiles = new Map<string, Set<string>>();

function setFor(sessionId: string): Set<string> {
  let set = sessionFiles.get(sessionId);
  if (set === undefined) {
    if (sessionFiles.size >= MAX_SESSIONS) {
      const oldest = sessionFiles.keys().next().value;
      if (oldest !== undefined) sessionFiles.delete(oldest);
    }
    set = new Set<string>();
    sessionFiles.set(sessionId, set);
  }
  return set;
}

/** Record file targets a tool touched (only values that look like paths count). */
export function noteFileInSession(sessionId: string, ...paths: unknown[]): void {
  if (typeof sessionId !== "string" || sessionId === "") return;
  const set = setFor(sessionId);
  for (const value of paths) {
    if (!looksLikeFilePath(value)) continue;
    set.add(typeof value === "string" ? value : String((value as { path?: unknown }).path ?? ""));
    if (set.size > MAX_PATHS_PER_SESSION) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }
}

/**
 * Record the file mentions extracted from the CURRENT conversation message
 * (aider `get_file_mentions` / `get_ident_mentions`). Called by the loop when a
 * user turn begins; together with the tool-target ledger this is the faithful
 * `conversationFiles` signal — files the conversation has actually named.
 */
export function noteConversationMessage(sessionId: string, text: string): void {
  if (typeof sessionId !== "string" || sessionId === "") return;
  noteFileInSession(sessionId, ...filePathMentions(text));
}

/** The deduped files currently in this session's conversation context. */
export function conversationFilesForSession(sessionId: string): readonly string[] {
  const set = sessionFiles.get(sessionId);
  return set === undefined ? [] : [...set];
}

/** Record the file targets carried by a read/edit/write/apply_patch argument set. */
export function noteToolContext(sessionId: string, args: Record<string, unknown>): void {
  const targets: unknown[] = [];
  if (typeof args.path === "string") targets.push(args.path);
  if (typeof args.file_path === "string") targets.push(args.file_path);
  if (Array.isArray(args.paths)) targets.push(...args.paths);
  if (typeof args.input === "string") targets.push(...filePathMentions(args.input));
  if (typeof args.text === "string") targets.push(...filePathMentions(args.text));
  noteFileInSession(sessionId, ...targets);
}

/** True when a session has at least one recorded file target. */
export function sessionHasFilesInContext(sessionId: string): boolean {
  const set = sessionFiles.get(sessionId);
  return set !== undefined && set.size > 0;
}

/** Test/diagnostic helpers. */
export function resetFileContextSession(sessionId: string): void {
  sessionFiles.delete(sessionId);
}
export function resetAllFileContext(): void {
  sessionFiles.clear();
}
