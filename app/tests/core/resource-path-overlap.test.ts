import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assessResourcePathOverlap,
  assessResourcePathOverlapDetailed,
} from "../../src/core/resource-path-overlap";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-overlap-"));
  dirs.push(d);
  return d;
}

describe("resource-path-overlap dangling symlink honesty (ruling 699)", () => {
  test("dangling symlink to blocked spelling overlaps even when final target is absent", () => {
    const ws = workspace();
    const blocked = path.join(ws, "hot.ts");
    const link = path.join(ws, "via-link.ts");
    symlinkSync(blocked, link);
    expect(assessResourcePathOverlap(blocked, link)).toBe("overlap");
    expect(assessResourcePathOverlap(link, blocked)).toBe("overlap");
  });

  test("dangling alias to existing blocked file overlaps without (dev,ino) false negative", () => {
    const ws = workspace();
    const blocked = path.join(ws, "blocked-primary.ts");
    writeFileSync(blocked, "x");
    const link = path.join(ws, "alias.ts");
    symlinkSync(blocked, link);
    rmSync(blocked);
    const target = path.join(ws, "alias.ts");
    expect(assessResourcePathOverlap(blocked, target)).toBe("overlap");
  });

  test("disjoint chains with dangling symlink fail closed uncertain — not non-overlap", () => {
    const ws = workspace();
    const link = path.join(ws, "dangle.ts");
    symlinkSync(path.join(ws, "missing-cold.ts"), link);
    const hot = path.join(ws, "hot.ts");
    writeFileSync(hot, "y");
    const detail = assessResourcePathOverlapDetailed(link, hot);
    expect(detail.overlap).toBe("uncertain");
    expect(detail.uncertainReason).toBe("dangling_symlink_target");
  });

  test("unresolved symlink loop is uncertain", () => {
    const ws = workspace();
    symlinkSync("loopB", path.join(ws, "loopA"));
    symlinkSync("loopA", path.join(ws, "loopB"));
    const hot = path.join(ws, "hot.ts");
    writeFileSync(hot, "z");
    const detail = assessResourcePathOverlapDetailed(path.join(ws, "loopA"), hot);
    expect(detail.overlap).toBe("uncertain");
    expect(detail.uncertainReason).toBe("symlink_chain_unresolved");
  });
});