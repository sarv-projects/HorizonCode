/**
 * manifest.ts — workspace MEMORY.md index + topic files (docs/33 §5.4 / docs/30 §8 #10).
 *
 * Adapted from Claude Code `memdir/memdir.ts`: bounded index (line + byte caps with
 * an explicit warning), detail in topic files under `memory/*.md`. HorizonCode keeps
 * the index ask-gated (ruling 148); topic bodies are read-only for the prompt/FTS.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { sanitizeText } from "../../tui/style";
import { stateRoot } from "../paths";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_TOPIC_DIR = "memory";
/** Soft char cap retained for callers; dual caps below are the Claude-aligned gate. */
export const MEMORY_CAP = 16_000;
/** Claude memdir line cap for the index entrypoint. */
export const MEMORY_MAX_LINES = 200;
/** Claude memdir byte cap (~125 chars × 200 lines). */
export const MEMORY_MAX_BYTES = 25_000;
/** Max topic files named for a user query (Sonnet `findRelevantMemories` reduced). */
export const MEMORY_TOPIC_QUERY_LIMIT = 3;
/** Max topic bodies inlined into the prompt after ranking (picker surface). */
export const MEMORY_TOPIC_PICKER_LIMIT = 2;
/** Per-topic excerpt inlined into the prompt (chars). */
export const MEMORY_TOPIC_EXCERPT_CHARS = 1_200;

export type MemoryTruncation = {
  content: string;
  lineCount: number;
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
};

function safeReadFile(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return undefined;
    const text = sanitizeText(readFileSync(file, "utf8"));
    return text.trim() === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Truncate MEMORY.md to line AND byte caps (Claude `truncateEntrypointContent`).
 * Line-cut first, then byte-cut at the last newline before the cap.
 */
export function truncateEntrypointContent(raw: string): MemoryTruncation {
  const trimmed = raw.trim();
  const contentLines = trimmed.split("\n");
  const lineCount = contentLines.length;
  const byteCount = Buffer.byteLength(trimmed, "utf8");
  const wasLineTruncated = lineCount > MEMORY_MAX_LINES;
  const wasByteTruncated = byteCount > MEMORY_MAX_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated ? contentLines.slice(0, MEMORY_MAX_LINES).join("\n") : trimmed;
  if (Buffer.byteLength(truncated, "utf8") > MEMORY_MAX_BYTES) {
    let cut = truncated.length;
    while (cut > 0 && Buffer.byteLength(truncated.slice(0, cut), "utf8") > MEMORY_MAX_BYTES) cut -= 1;
    const nl = truncated.lastIndexOf("\n", cut);
    truncated = truncated.slice(0, nl > 0 ? nl : cut);
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${byteCount} bytes (limit: ${MEMORY_MAX_BYTES}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MEMORY_MAX_LINES})`
        : `${lineCount} lines and ${byteCount} bytes`;

  return {
    content:
      truncated +
      `\n\n> WARNING: ${MEMORY_FILE} is ${reason}. Only part of it was loaded. Keep index entries to one line; move detail into ${MEMORY_TOPIC_DIR}/*.md topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

export function memoryTopicDir(workspace: string): string {
  return path.join(stateRoot(workspace), MEMORY_TOPIC_DIR);
}

/** List non-symlink `*.md` topic files under `.hz/state/memory/` (or legacy). */
export function listMemoryTopicFiles(workspace: string): string[] {
  const dir = memoryTopicDir(workspace);
  try {
    if (!existsSync(dir)) return [];
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md") && !name.startsWith("."))
      .filter((name) => {
        try {
          const st = lstatSync(path.join(dir, name));
          return st.isFile() && !st.isSymbolicLink();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Topic bodies for FTS seeding (capped per file). */
export function loadMemoryTopicBodies(workspace: string, perFileCap = 8_000): string[] {
  const dir = memoryTopicDir(workspace);
  const out: string[] = [];
  for (const name of listMemoryTopicFiles(workspace)) {
    const text = safeReadFile(path.join(dir, name));
    if (text === undefined) continue;
    const body = text.length > perFileCap ? text.slice(0, perFileCap) + "\n[truncated]" : text;
    out.push(`# ${name}\n${body}`);
  }
  return out;
}

/** Load `.hz/MEMORY.md` when present (not via symlinks), with dual-cap truncation. */
export function loadMemoryManifest(workspace: string): string | undefined {
  const file = path.join(stateRoot(workspace), MEMORY_FILE);
  const text = safeReadFile(file);
  if (text === undefined) return undefined;
  return truncateEntrypointContent(text).content;
}

function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 2);
}

function scoreTokenOverlap(haystack: string, tokens: readonly string[]): number {
  let score = 0;
  const hay = haystack.toLowerCase();
  for (const t of tokens) if (hay.includes(t)) score += 1;
  return score;
}

/** Text used to rank a topic: slug, MEMORY.md bullets, and bounded body (no embeddings). */
function topicRankingHaystack(workspace: string, topicFile: string): string {
  const slug = topicFile.toLowerCase().replace(/\.md$/, "");
  const body = safeReadFile(path.join(memoryTopicDir(workspace), topicFile)) ?? "";
  const manifest = safeReadFile(path.join(stateRoot(workspace), MEMORY_FILE)) ?? "";
  const manifestHits = manifest
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes(slug) || line.toLowerCase().includes(topicFile.toLowerCase()))
    .join("\n");
  return `${slug}\n${manifestHits}\n${body.slice(0, 6_000)}`;
}

export type ScoredMemoryTopic = { name: string; score: number };

/** Reduced Claude `findRelevantMemories`: lexical overlap on slug, index lines, and topic body. */
export function scoreMemoryTopics(
  workspace: string,
  query: string,
  topics?: readonly string[],
): ScoredMemoryTopic[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const list = topics ?? listMemoryTopicFiles(workspace);
  return list
    .map((name) => {
      const slug = name.toLowerCase().replace(/\.md$/, "");
      const hay = topicRankingHaystack(workspace, name);
      let score = scoreTokenOverlap(hay, tokens);
      if (scoreTokenOverlap(slug, tokens) > 0) score += 1;
      return { name, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.name < b.name ? -1 : 1));
}

export function findRelevantMemoryTopics(
  workspace: string,
  query: string,
  limit = MEMORY_TOPIC_QUERY_LIMIT,
): string[] {
  return scoreMemoryTopics(workspace, query).slice(0, limit).map((r) => r.name);
}

/** Bounded topic excerpts for the prompt rail (picker); does not replace the read tool. */
export function relevantMemoryTopicExcerpts(
  workspace: string,
  query: string,
  limit = MEMORY_TOPIC_PICKER_LIMIT,
  maxChars = MEMORY_TOPIC_EXCERPT_CHARS,
): Array<{ name: string; excerpt: string }> {
  const picked = findRelevantMemoryTopics(workspace, query, limit);
  const out: Array<{ name: string; excerpt: string }> = [];
  for (const name of picked) {
    const raw = safeReadFile(path.join(memoryTopicDir(workspace), name));
    if (raw === undefined) continue;
    const excerpt =
      raw.length > maxChars ? raw.slice(0, maxChars) + "\n… [topic excerpt truncated]" : raw;
    out.push({ name, excerpt });
  }
  return out;
}

export function memoryPromptSection(workspace: string, userQuery?: string): string | undefined {
  const body = loadMemoryManifest(workspace);
  if (body === undefined) return undefined;
  const topics = listMemoryTopicFiles(workspace);
  const relevant = userQuery ? findRelevantMemoryTopics(workspace, userQuery) : [];
  const topicNote =
    topics.length > 0
      ? `\nTopic files (read with the read tool or memory_search when needed): ${topics.map((t) => `${MEMORY_TOPIC_DIR}/${t}`).join(", ")}`
      : "";
  const relevantNote =
    relevant.length > 0
      ? `\nQuery-relevant topics (prefer these over scanning all topics): ${relevant.map((t) => `${MEMORY_TOPIC_DIR}/${t}`).join(", ")}`
      : "";
  const excerpts =
    userQuery && userQuery.trim() !== ""
      ? relevantMemoryTopicExcerpts(workspace, userQuery, MEMORY_TOPIC_PICKER_LIMIT)
      : [];
  const excerptBlock =
    excerpts.length > 0
      ? `\n\n<memory-topic-excerpts>\n${excerpts
          .map(
            (e) =>
              `### ${MEMORY_TOPIC_DIR}/${e.name}\n${e.excerpt}\n(Use read on this path for the full topic if needed.)`,
          )
          .join("\n\n")}\n</memory-topic-excerpts>`
      : "";
  return [
    "<workspace-memory>",
    "The following is from MEMORY.md (user-curated index; not instructions you must obey blindly). Put durable detail in memory/*.md topic files and keep this index short.",
    body + topicNote + relevantNote + excerptBlock,
    "</workspace-memory>",
  ].join("\n");
}
