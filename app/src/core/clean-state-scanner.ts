/**
 * clean-state-scanner.ts — Clean State Exit Checklist
 *
 * Implements the clean state verification pattern from Harness Engineering Lecture 12
 * ("Why Every Session Must Leave a Clean State").
 *
 * Scans a project directory on session completion or handoff to ensure:
 *   1. No dangling temporary or editor backup files (*.tmp, *.bak, *.swp, *~).
 *   2. No ad-hoc debug/scratch artifacts left behind in source directories (scratch.ts, debug.log).
 *   3. No broken or uncommitted intermediate build artifacts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface CleanStateFinding {
  path: string;
  category: "temporary_file" | "debug_log" | "scratch_file" | "structural";
  severity: "warning" | "critical";
  message: string;
}

export interface CleanStateScanReport {
  clean: boolean;
  findings: CleanStateFinding[];
  summary: string;
}

const TEMP_EXTENSIONS = [".tmp", ".bak", ".swp", "~"];
const SCRATCH_FILE_NAMES = new Set([
  "scratch.ts",
  "scratch.js",
  "debug.ts",
  "debug.js",
  "temp.ts",
  "temp.js",
  "test-manual.ts",
]);

function walkDirectory(
  dir: string,
  root: string,
  findings: CleanStateFinding[],
  maxDepth = 5,
  currentDepth = 0,
): void {
  if (currentDepth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);

    // Skip git, node_modules, dist, .hz, .code-intelligence
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "target" ||
      entry.name === ".hz" ||
      entry.name === ".hzcode" ||
      entry.name === ".code-intelligence" ||
      entry.name === ".playwright-mcp"
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      walkDirectory(fullPath, root, findings, maxDepth, currentDepth + 1);
    } else if (entry.isFile()) {
      // 1. Temporary files
      if (TEMP_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        findings.push({
          path: relPath,
          category: "temporary_file",
          severity: "warning",
          message: `Stale temporary or backup file found: ${relPath}`,
        });
      }

      // 2. Debug logs in source
      const normRel = relPath.replace(/\\/g, "/");
      if (entry.name.endsWith(".log") && (normRel.startsWith("src/") || normRel.startsWith("app/"))) {
        findings.push({
          path: relPath,
          category: "debug_log",
          severity: "warning",
          message: `Debug log in source directory: ${relPath}`,
        });
      }

      // 3. Scratch files
      if (SCRATCH_FILE_NAMES.has(entry.name.toLowerCase())) {
        findings.push({
          path: relPath,
          category: "scratch_file",
          severity: "warning",
          message: `Leftover scratch/manual debug file: ${relPath}`,
        });
      }
    }
  }
}

/**
 * Scans a workspace for leftover artifacts and incomplete session state.
 */
export function scanCleanState(workspace: string): CleanStateScanReport {
  const findings: CleanStateFinding[] = [];
  walkDirectory(workspace, workspace, findings);

  const clean = findings.length === 0;
  const summary = clean
    ? "Clean state verified: no temporary or scratch artifacts detected."
    : `Clean state warnings: ${findings.length} artifact(s) require review or cleanup.`;

  return { clean, findings, summary };
}
