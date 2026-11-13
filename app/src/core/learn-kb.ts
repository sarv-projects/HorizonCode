/**
 * G-5 reduced: `/learn` lists chapter ids from a lean index and prints one
 * chapter body at a time — not an engine, just prompt material.
 *
 * Layout under `<state root>/learn/`:
 *   index.json  { "chapters": [{ "id", "title", "file", "seeAlso"?: string[] }] }
 *   chapters/*.md
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "./paths";

const CHAPTER_BODY_CAP = 12_000;

export interface LearnChapterIndex {
  id: string;
  title: string;
  file: string;
  seeAlso?: string[];
}

interface LearnIndexFile {
  chapters?: LearnChapterIndex[];
}

export function learnKbRoot(workspace: string): string {
  return path.join(stateRoot(workspace), "learn");
}

export function learnIndexPath(workspace: string): string {
  return path.join(learnKbRoot(workspace), "index.json");
}

function readLearnIndex(workspace: string): LearnChapterIndex[] {
  const file = learnIndexPath(workspace);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LearnIndexFile;
    if (!Array.isArray(parsed.chapters)) return [];
    return parsed.chapters.filter(
      (c) =>
        c !== null &&
        typeof c === "object" &&
        typeof c.id === "string" &&
        c.id.trim() !== "" &&
        typeof c.title === "string" &&
        typeof c.file === "string",
    );
  } catch {
    return [];
  }
}

export function renderLearnIndex(workspace: string): string {
  const chapters = readLearnIndex(workspace);
  const root = learnKbRoot(workspace);
  if (chapters.length === 0) {
    return [
      "No learn index yet.",
      `Add ${learnIndexPath(workspace)} with a chapters array and markdown under ${path.join(root, "chapters")}/.`,
      "Usage: /learn <chapter-id>",
    ].join("\n");
  }
  const lines = ["Knowledge base chapters (read one at a time):", ""];
  for (const ch of chapters) {
    const refs = (ch.seeAlso ?? []).length > 0 ? ` · see also: ${ch.seeAlso!.join(", ")}` : "";
    lines.push(`  ${ch.id} — ${ch.title}${refs}`);
  }
  lines.push("", "Usage: /learn <chapter-id>");
  return lines.join("\n");
}

export function renderLearnChapter(workspace: string, chapterId: string): string {
  const id = chapterId.trim().toLowerCase();
  if (id === "") return renderLearnIndex(workspace);
  const chapters = readLearnIndex(workspace);
  const ch = chapters.find((c) => c.id.toLowerCase() === id);
  if (ch === undefined) {
    const known = chapters.map((c) => c.id).join(", ");
    return known === "" ? `Unknown chapter ${JSON.stringify(chapterId)}.` : `Unknown chapter ${JSON.stringify(chapterId)}. Known: ${known}`;
  }
  const base = learnKbRoot(workspace);
  const rel = ch.file.replace(/\\/g, "/").replace(/^\//, "");
  const file = path.resolve(base, rel);
  if (!file.startsWith(path.resolve(base)) || !existsSync(file)) {
    return `Chapter ${ch.id} file missing: ${ch.file}`;
  }
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    return `Chapter ${ch.id} file unreadable: ${ch.file}`;
  }
  if (body.length > CHAPTER_BODY_CAP) {
    body = `${body.slice(0, CHAPTER_BODY_CAP)}\n\n[truncated at ${CHAPTER_BODY_CAP} characters]`;
  }
  const refs =
    (ch.seeAlso ?? []).length > 0
      ? `\n\nSee also: ${ch.seeAlso!.map((r) => `/learn ${r}`).join(", ")}`
      : "";
  return `# ${ch.title}\n\n${body.trim()}${refs}`;
}
