/**
 * dream-consolidation.ts — text-only dream stub (docs/28 ruling 242).
 *
 * Without embeddings: when `HZ_MEMORY_DREAM=1`, append hash-deduped snippets from
 * recent handoffs and memory bank/topic text into `<stateRoot>/memory/dream.md`.
 * Off by default; the existing `dream/plan-*.md` runner still applies nothing.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "../canon";
import { handoffDbPath } from "./handoff";
import { loadMemoryManifest, listMemoryTopicFiles, MEMORY_TOPIC_DIR, memoryTopicDir } from "./manifest";

export const MEMORY_DREAM_ENV = "HZ_MEMORY_DREAM";
export const DREAM_CONSOLIDATION_FILE = "dream.md";
const DREAM_HASH_MARKER = /<!--\s*dream-hash:\s*([0-9a-f]{64})\s*-->/g;
const SNIPPET_CAP = 400;

export function memoryDreamConsolidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MEMORY_DREAM_ENV] === "1";
}

export function dreamConsolidationPath(workspace: string): string {
  return path.join(memoryTopicDir(workspace), DREAM_CONSOLIDATION_FILE);
}

export function parseDreamContentHashes(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(DREAM_HASH_MARKER)) {
    const h = match[1];
    if (typeof h === "string") found.add(h);
  }
  return found;
}

function normalizeSnippet(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CAP);
}

function recentHandoffSnippets(workspace: string, limit = 5): string[] {
  const dbPath = handoffDbPath(workspace);
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(`SELECT summary FROM handoffs ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as Array<{ summary: string }>;
    db.close();
    return rows
      .map((r) => normalizeSnippet(r.summary))
      .filter((s) => s.length > 0)
      .map((s) => `handoff: ${s}`);
  } catch {
    return [];
  }
}

function memoryBankSnippets(workspace: string): string[] {
  const out: string[] = [];
  const manifest = loadMemoryManifest(workspace);
  if (manifest !== undefined) {
    for (const line of manifest.split(/\r?\n/)) {
      const text = normalizeSnippet(line.replace(/^[-*]\s+/, ""));
      if (text.length > 0 && !text.startsWith(">")) out.push(`index: ${text}`);
    }
  }
  const dir = memoryTopicDir(workspace);
  for (const name of listMemoryTopicFiles(workspace)) {
    if (name === DREAM_CONSOLIDATION_FILE) continue;
    try {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      const body = readFileSync(file, "utf8").trim();
      if (body === "") continue;
      const first = normalizeSnippet(body.split(/\r?\n/).find((l) => l.trim() !== "") ?? body);
      if (first.length > 0) out.push(`topic ${name}: ${first}`);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Collect candidate snippets from handoffs + MEMORY index + topic files. */
export function collectDreamConsolidationSnippets(workspace: string): string[] {
  const merged = [...recentHandoffSnippets(workspace), ...memoryBankSnippets(workspace)];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of merged) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export interface DreamConsolidationAppend {
  /** Full file content after merge. */
  content: string;
  /** New snippets appended this run. */
  appended: number;
  /** Snippets skipped because the hash was already recorded. */
  skippedDuplicate: number;
  /** Nothing new to write. */
  noop: boolean;
}

/** Build the next `memory/dream.md` bytes; does not write. */
export function buildDreamConsolidationAppend(workspace: string, existing: string | null, snippets: readonly string[]): DreamConsolidationAppend {
  const prior = existing ?? "";
  const known = parseDreamContentHashes(prior);
  const stamp = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  if (prior === "") {
    lines.push(`# Dream consolidation`, ``, `Origin: \`dream\` (text stub; hash-deduped; not auto-applied to MEMORY.md)`, ``);
  }
  let appended = 0;
  let skippedDuplicate = 0;
  const section: string[] = [];
  for (const snippet of snippets) {
    const hash = sha256Hex(snippet);
    if (known.has(hash)) {
      skippedDuplicate += 1;
      continue;
    }
    known.add(hash);
    section.push(`- ${snippet}`);
    section.push(`<!-- dream-hash: ${hash} -->`);
    appended += 1;
  }
  if (appended === 0) {
    return { content: prior, appended: 0, skippedDuplicate, noop: true };
  }
  const block = [`\n\n## Consolidation ${stamp}`, ``, ...section, ``].join("\n");
  const content = prior === "" ? lines.join("\n") + block : (prior.endsWith("\n") ? prior : `${prior}\n`) + block;
  return { content, appended, skippedDuplicate, noop: false };
}

export interface DreamConsolidationResult extends DreamConsolidationAppend {
  dreamPath: string;
  dryRun: boolean;
}

/**
 * Append new snippets into `memory/dream.md` when enabled. With `dryRun: true`
 * or when the env flag is off, returns the planned merge without writing.
 */
export function runDreamConsolidation(
  workspace: string,
  opts: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {},
): DreamConsolidationResult {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun === true || !memoryDreamConsolidationEnabled(env);
  const dreamPath = dreamConsolidationPath(workspace);
  let existing: string | null = null;
  if (existsSync(dreamPath)) {
    try {
      existing = readFileSync(dreamPath, "utf8");
    } catch {
      existing = null;
    }
  }
  const snippets = collectDreamConsolidationSnippets(workspace);
  const built = buildDreamConsolidationAppend(workspace, existing, snippets);
  if (!dryRun && !built.noop) {
    mkdirSync(path.dirname(dreamPath), { recursive: true });
    writeFileSync(dreamPath, built.content, { mode: 0o600 });
  }
  return { dreamPath, dryRun, ...built };
}
