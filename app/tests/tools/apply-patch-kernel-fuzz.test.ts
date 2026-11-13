import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveApplyPatchKernelProjections } from "../../src/core/effect-kernel-tool-projection";
import {
  applyPatchFirstHitScoreFuzzBunOwned,
  bunApplyPatchFirstHitLevenshteinStart,
  classifyApplyPatchChunkKernelFuzz,
  classifyApplyPatchScoreMatchPolicy,
  resolveKernelApplyPatchChunkEdit,
} from "../../src/tools/apply-patch-kernel-fuzz";
import { restoreEnv, setEnv, snapshotEnv } from "../core/helpers";

describe("apply-patch kernel fuzz (ruling 299)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-kernel-fuzz-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("trim_end chunk ineligible for kernel route without repair flag", async () => {
    writeFileSync(path.join(workspace, "f.txt"), "line one\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: f.txt
@@
-line one  
+line one fixed
*** End Patch`;
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: undefined });
      const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
      expect(projs).toBeUndefined();
    } finally {
      restoreEnv(snap);
    }
  });

  test("trim_end chunk resolves with HZ_EFFECT_HOST_EDIT_REPAIR=1", async () => {
    writeFileSync(path.join(workspace, "f.txt"), "line one\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: f.txt
@@
-line one  
+line one fixed
*** End Patch`;
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
      expect(projs?.length).toBe(1);
      expect(projs?.[0]?.kind).toBe("edit");
      if (projs?.[0]?.kind === "edit") {
        expect(projs[0].old).toBe("line one");
        expect(projs[0].new).toBe("line one fixed");
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("EOF-anchored exact unique match resolves for kernel fs.edit", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "head\nmid\nlast\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
-last
+LAST
*** End of File
*** End Patch`;
    const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
    expect(projs?.length).toBe(1);
    expect(projs?.[0]?.kind).toBe("edit");
    if (projs?.[0]?.kind === "edit") {
      expect(projs[0].old).toBe("last");
      expect(projs[0].new).toBe("LAST");
    }
  });

  test("EOF-anchored ambiguous exact matches fail-closed on kernel path", async () => {
    writeFileSync(path.join(workspace, "dup.txt"), "same\nx\nsame\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: dup.txt
@@
-same
+OTHER
*** End of File
*** End Patch`;
    const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
    expect(projs).toBeUndefined();
  });

  test("per-line trim chunk resolves with HZ_EFFECT_HOST_EDIT_REPAIR=1", async () => {
    writeFileSync(path.join(workspace, "t.txt"), "  spaced line\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: t.txt
@@
- spaced line
+spaced line fixed
*** End Patch`;
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
      expect(projs?.length).toBe(1);
      expect(projs?.[0]?.kind).toBe("edit");
      if (projs?.[0]?.kind === "edit") {
        expect(projs[0].old).toBe("  spaced line");
        expect(projs[0].new).toBe("spaced line fixed");
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("ambiguous per-line trim matches fail-closed on kernel path", () => {
    const before = "  x\n  x\n";
    const chunk = {
      oldLines: ["x"],
      newLines: ["y"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("bun_fuzz_only");
    expect(resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" })).toBeUndefined();
  });

  test("unique Levenshtein chunk resolves with HZ_EFFECT_HOST_EDIT_REPAIR=1", async () => {
    writeFileSync(path.join(workspace, "lev.txt"), "alpha beta gamma\n", "utf8");
    const patch = `*** Begin Patch
*** Update File: lev.txt
@@
-alfa beta gamma
+alpha beta gamma fixed
*** End Patch`;
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
      expect(projs?.length).toBe(1);
      expect(projs?.[0]?.kind).toBe("edit");
      if (projs?.[0]?.kind === "edit") {
        expect(projs[0].old).toBe("alpha beta gamma");
        expect(projs[0].new).toBe("alpha beta gamma fixed");
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("below-threshold Levenshtein chunk is bun_fuzz_only", () => {
    const before = "short\n";
    const chunk = {
      oldLines: ["totally different chunk"],
      newLines: ["replacement"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("bun_fuzz_only");
    expect(resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" })).toBeUndefined();
  });

  test("dominant-score chunk resolves when top clearly beats second-best", () => {
    const line =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const typo = `${line.slice(0, 20)}Y${line.slice(21)}`;
    const before = `${line}\nzzz\n`;
    const chunk = {
      oldLines: [typo],
      newLines: [`${line} fixed`],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("dominant_score");
    const resolved = resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(resolved?.old).toBe(line);
    expect(resolved?.new).toBe(`${line} fixed`);
  });

  test("near-tied high scores fail dominant-score rung", () => {
    const line = "alpha beta gamma delta\n";
    const before = line + line;
    const chunk = {
      oldLines: ["alpha beta gamma delto"],
      newLines: ["alpha beta gamma fixed"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("bun_fuzz_only");
    expect(resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" })).toBeUndefined();
  });

  test("tied max-score Levenshtein matches fail-closed on kernel path", () => {
    const before = "alfa beta\nalfa beta\n";
    const chunk = {
      oldLines: ["alpha beta"],
      newLines: ["alpha beta fixed"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("bun_fuzz_only");
    expect(resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" })).toBeUndefined();
  });

  test("first-hit score fuzz is Bun-owned when kernel ties (ruling 313)", () => {
    const before = "alfa beta\nalfa beta\n";
    const chunk = {
      oldLines: ["alpha beta"],
      newLines: ["alpha beta fixed"],
      eofAnchored: false,
    };
    const lines = before.replace(/\r\n/g, "\n").split("\n").slice(0, -1);
    expect(bunApplyPatchFirstHitLevenshteinStart(lines, chunk.oldLines)).toBe(0);
    expect(classifyApplyPatchScoreMatchPolicy(lines, chunk.oldLines)).toBe("bun_first_hit");
    expect(applyPatchFirstHitScoreFuzzBunOwned(before, chunk)).toBe(true);
  });

  test("unique dominant score is kernel policy not Bun first-hit", () => {
    const line =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaXbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const typo = `${line.slice(0, 20)}Y${line.slice(21)}`;
    const before = `${line}\nzzz\n`;
    const chunk = {
      oldLines: [typo],
      newLines: [`${line} fixed`],
      eofAnchored: false,
    };
    const lines = before.replace(/\r\n/g, "\n").split("\n").slice(0, -1);
    expect(classifyApplyPatchScoreMatchPolicy(lines, chunk.oldLines)).toBe("kernel_unique_dominant");
    expect(applyPatchFirstHitScoreFuzzBunOwned(before, chunk)).toBe(false);
  });

  test("unicode-fold chunk resolves with HZ_EFFECT_HOST_EDIT_REPAIR=1", async () => {
    const smart = "say \u201chello\u201d\n";
    writeFileSync(path.join(workspace, "q.txt"), smart, "utf8");
    const patch = `*** Begin Patch
*** Update File: q.txt
@@
-say "hello"
+say "HELLO"
*** End Patch`;
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
      expect(projs?.length).toBe(1);
      expect(projs?.[0]?.kind).toBe("edit");
      if (projs?.[0]?.kind === "edit") {
        expect(projs[0].old).toBe(smart.trimEnd());
        expect(projs[0].new).toBe('say "HELLO"');
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("relative-indent chunk resolves with HZ_EFFECT_HOST_EDIT_REPAIR=1", () => {
    const before = "    xx\n    yy\njunk\n  xx\n    yy\n";
    const chunk = {
      oldLines: ["xx", "  yy"],
      newLines: ["xx", "  zz"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("relative_indent");
    const resolved = resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(resolved?.old).toBe("  xx\n    yy");
    expect(resolved?.new).toBe("  xx\n    zz");
  });

  test("ambiguous relative-indent matches fail-closed on kernel path", () => {
    const before = "  a\n  a\n";
    const chunk = {
      oldLines: ["a"],
      newLines: ["b"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("bun_fuzz_only");
    expect(resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" })).toBeUndefined();
  });

  test("ambiguous unicode-fold matches fail-closed on kernel path", () => {
    const before = "foo\u2014bar\nfoo\u2014bar\n";
    const chunk = {
      oldLines: ["foo-bar"],
      newLines: ["foo-baz"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("bun_fuzz_only");
    expect(resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" })).toBeUndefined();
  });

  test("unique line-patch anchors resolve with HZ_EFFECT_HOST_EDIT_REPAIR=1", async () => {
    const before = "function foo() {\n  old middle\n  return 1;\n}\n";
    writeFileSync(path.join(workspace, "lp.txt"), before, "utf8");
    const patch = `*** Begin Patch
*** Update File: lp.txt
@@
 function foo() {
-  model middle
+  new middle
   return 1;
 }
*** End Patch`;
    const snap = snapshotEnv();
    try {
      setEnv({ HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
      const projs = await resolveApplyPatchKernelProjections(workspace, { input: patch });
      expect(projs?.length).toBe(1);
      expect(projs?.[0]?.kind).toBe("edit");
      if (projs?.[0]?.kind === "edit") {
        expect(projs[0].old).toContain("old middle");
        expect(projs[0].new).toContain("new middle");
      }
    } finally {
      restoreEnv(snap);
    }
  });

  test("line-patch chunk classifies when middle differs but anchors are unique", () => {
    const before = "function foo() {\n  keep\n  return 1;\n}\n";
    const chunk = {
      oldLines: ["function foo() {", "  model mid", "  return 1;", "}"],
      newLines: ["function foo() {", "  new mid", "  return 1;", "}"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("line_patch");
    const resolved = resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" });
    expect(resolved?.old).toContain("keep");
    expect(resolved?.new).toContain("new mid");
  });

  test("ambiguous line-patch anchor pairs fail-closed on kernel path", () => {
    const before = [
      "function foo() {",
      "  a",
      "  return 1;",
      "}",
      "function foo() {",
      "  b",
      "  return 1;",
      "}",
    ].join("\n");
    const chunk = {
      oldLines: ["function foo() {", "  x", "  return 1;", "}"],
      newLines: ["function foo() {", "  y", "  return 1;", "}"],
      eofAnchored: false,
    };
    expect(classifyApplyPatchChunkKernelFuzz(before, chunk)).toBe("bun_fuzz_only");
    expect(resolveKernelApplyPatchChunkEdit(before, chunk, { HZ_EFFECT_HOST_EDIT_REPAIR: "1" })).toBeUndefined();
  });
});
