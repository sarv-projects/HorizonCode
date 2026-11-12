/**
 * dream.ts — manual memory consolidation plan (docs/33 §5.4 reduced).
 *
 * Produces a plan markdown file under `.hz/dream/` and never applies it.
 * Approval + guarded write remain a separate step (grow `--apply` / human edit).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { stateRoot } from "../paths";
import { loadMemoryManifest } from "./manifest";
import { memoryDbPath } from "./store";
import { Database } from "bun:sqlite";

export const DREAM_DIR = "dream";

export interface DreamPlanResult {
  /** Absolute path of the written plan file. */
  planPath: string;
  /** Number of memory lines considered. */
  factCount: number;
  /** True when the plan notes there was nothing to consolidate. */
  empty: boolean;
}

function listIndexedFacts(workspace: string, limit = 40): string[] {
  const dbPath = memoryDbPath(workspace);
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(`SELECT content FROM memory_fts LIMIT ?`)
      .all(limit) as Array<{ content: string }>;
    db.close();
    return rows.map((r) => r.content.trim()).filter((c) => c.length > 0);
  } catch {
    return [];
  }
}

function collectFacts(workspace: string): string[] {
  const fromIndex = listIndexedFacts(workspace);
  if (fromIndex.length > 0) return fromIndex;
  const manifest = loadMemoryManifest(workspace);
  if (manifest === undefined) return [];
  return manifest
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("["));
}

function stamp(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

/** Build plan markdown; applies nothing. */
export function buildDreamPlanMarkdown(workspace: string, facts: readonly string[]): string {
  const lines: string[] = [
    `# Dream consolidation plan`,
    ``,
    `Workspace: \`${workspace}\``,
    `Generated: ${new Date().toISOString()}`,
    `Origin: \`dream\` (manual; not applied)`,
    ``,
    `## Status`,
    ``,
    facts.length === 0
      ? `- No MEMORY.md lines or FTS facts found. Nothing to consolidate.`
      : `- ${facts.length} fact(s) listed below. Review, edit MEMORY.md yourself, or use a guarded write — this file is a plan only.`,
    ``,
    `## Proposed checklist`,
    ``,
  ];
  if (facts.length === 0) {
    lines.push(`- [ ] (none)`);
  } else {
    for (const fact of facts) {
      lines.push(`- [ ] Consider consolidating: ${fact.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  lines.push(``, `## Verification`, ``);
  lines.push(`- [ ] Plan reviewed by a human`);
  lines.push(`- [ ] No automatic write performed by this runner`);
  lines.push(``);
  return lines.join("\n");
}

/**
 * Write a dream plan under `<stateRoot>/dream/plan-<stamp>.md`.
 * Never mutates MEMORY.md or the FTS index.
 */
export function writeDreamPlan(workspace: string): DreamPlanResult {
  const facts = collectFacts(workspace);
  const root = stateRoot(workspace);
  const dir = path.join(root, DREAM_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, `plan-${stamp()}.md`);
  writeFileSync(planPath, buildDreamPlanMarkdown(workspace, facts), { mode: 0o600 });
  return { planPath, factCount: facts.length, empty: facts.length === 0 };
}
