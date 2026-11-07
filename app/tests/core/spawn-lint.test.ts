/**
 * spawn-lint.test.ts — NF-071: every child spawn goes through `spawnOwned`.
 *
 * The lint scans every `.ts` under app/src for `Bun.spawn(` call sites. A site
 * is allowed only when the file appears in the ALLOWLIST below, and every
 * allowlist entry MUST carry a non-empty reason — a future opt-out cannot be
 * silent, and a stale entry (a file that no longer spawns) fails too.
 *
 * Outside the scan by design: `node:child_process` spawn sites (`core/kernel.ts`
 * starts the Rust kernel with its own exit hook; `core/supervisor.ts` cannot
 * start a supervisor through spawnOwned without recursing, since every owned
 * spawn gets its own supervisor). Those are named here so the exclusion is
 * explicit rather than accidental; the design lint's subject is the Bun.spawn
 * surface.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";

const SRC = path.resolve(import.meta.dir, "../../src");

/**
 * Files allowed to call `Bun.spawn` directly. One entry, carrying its reason:
 * the single spawn path is the only place a Bun subprocess may be created.
 */
const ALLOWLIST: Record<string, string> = {
  "core/owned-spawn.ts": "the single spawn path itself — the one Bun.spawn call every other spawn in app/src routes through",
};

const BUN_SPAWN = /Bun\s*\.\s*spawn\s*\(/;

/** Every .ts file under `dir`, relative to SRC, in a stable order. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...tsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(path.relative(SRC, abs).split(path.sep).join("/"));
    }
  }
  return out;
}

test("the scan covers app/src", () => {
  const files = tsFiles(SRC);
  expect(files.length).toBeGreaterThan(10);
  expect(files).toContain("core/owned-spawn.ts");
  expect(files).toContain("tools/shell.ts");
});

test("every Bun.spawn call site is allowlisted with a reason", () => {
  const offenders: string[] = [];
  for (const rel of tsFiles(SRC)) {
    if (rel in ALLOWLIST) continue;
    const lines = readFileSync(path.join(SRC, rel), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (BUN_SPAWN.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(
    offenders,
    "Bun.spawn call sites outside the spawnOwned allowlist (route them through spawnOwned, or add an entry WITH a reason):",
  ).toEqual([]);
});

test("every allowlist entry exists, carries a reason, and really spawns", () => {
  const entries = Object.entries(ALLOWLIST);
  expect(entries.length).toBeGreaterThan(0);
  for (const [rel, reason] of entries) {
    expect(reason.trim().length, `${rel}: reason must be non-empty`).toBeGreaterThan(0);
    const abs = path.join(SRC, rel);
    expect(existsSync(abs), `${rel}: allowlisted file must exist`).toBe(true);
    expect(BUN_SPAWN.test(readFileSync(abs, "utf8")), `${rel}: allowlisted file must contain a Bun.spawn call`).toBe(true);
  }
});
