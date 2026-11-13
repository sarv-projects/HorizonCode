/**
 * G-7 reduced: ASCII “learning graph” of curator proposals (Hermes growth surface).
 * Read-only view of `<stateDir>/proposals.jsonl`; does not apply anything.
 */

import { loadProposals, type StoredProposalRow } from "./curator";
import { workspaceStateDir } from "./paths";

const KIND_ABBR: Record<string, string> = {
  memory: "mem",
  skill: "sk",
  prompt: "pr",
  hook: "hk",
  policy: "po",
};

function abbrev(kind: string): string {
  return KIND_ABBR[kind] ?? kind.slice(0, 3);
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** One node per proposal, edges by chronological order (not causal inference). */
export function renderLearningGraphAscii(proposals: readonly StoredProposalRow[]): string {
  if (proposals.length === 0) return "learning graph: (no curator proposals yet)\n  proposals.jsonl is empty — run `bun run grow` after post-mortems.";
  const lines: string[] = ["learning graph (curator proposals, oldest → newest)", ""];
  for (let i = 0; i < proposals.length; i += 1) {
    const row = proposals[i]!;
    const tag = abbrev(row.kind);
    const title = clip(row.title, 48);
    const digest = row.digest.slice(0, 8);
    if (i === 0) {
      lines.push(`  [${tag}] ${title}  (${digest})`);
    } else {
      lines.push(`    |`);
      lines.push(`    v`);
      lines.push(`  [${tag}] ${title}  (${digest})`);
    }
  }
  lines.push("", `  ${proposals.length} proposal(s) in store — none applied (ADR-010).`);
  return lines.join("\n");
}

export function renderWorkspaceLearningGraph(workspace: string): string {
  const stateDir = workspaceStateDir(workspace);
  const load = loadProposals(stateDir);
  if (load.missing) return renderLearningGraphAscii([]);
  return renderLearningGraphAscii(load.proposals);
}
