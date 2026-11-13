import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  applyPatchArgsEligibleForKernelRoute,
  applyPatchKernelProjection,
  applyPatchKernelProjections,
  astEditArgsEligibleForKernelRoute,
  astEditKernelProjection,
} from "../../src/core/effect-kernel-tool-projection";

const ADD_PATCH = `*** Begin Patch
*** Add File: new.txt
+hello
*** End Patch`;

const UPDATE_PATCH = `*** Begin Patch
*** Update File: src.txt
@@
-old
+new
*** End Patch`;

describe("applyPatchKernelProjection", () => {
  test("single add → write", () => {
    expect(applyPatchArgsEligibleForKernelRoute({ input: ADD_PATCH })).toBe(true);
    const proj = applyPatchKernelProjection({ input: ADD_PATCH });
    expect(proj?.kind).toBe("write");
    if (proj?.kind === "write") {
      expect(proj.path).toBe("new.txt");
      expect(proj.content).toBe("hello\n");
    }
  });

  test("single-chunk update → edit", () => {
    const proj = applyPatchKernelProjection({ input: UPDATE_PATCH });
    expect(proj?.kind).toBe("edit");
    if (proj?.kind === "edit") {
      expect(proj.old).toBe("old");
      expect(proj.new).toBe("new");
    }
  });

  test("same-file multi-chunk exact update → ordered edits (ruling 299)", () => {
    const multi = `*** Begin Patch
*** Update File: src.txt
@@
-a
+b
@@
-c
+d
*** End Patch`;
    expect(applyPatchArgsEligibleForKernelRoute({ input: multi })).toBe(true);
    const projs = applyPatchKernelProjections({ input: multi });
    expect(projs?.length).toBe(2);
    expect(projs?.[0]).toEqual({ kind: "edit", path: "src.txt", old: "a", new: "b" });
    expect(projs?.[1]).toEqual({ kind: "edit", path: "src.txt", old: "c", new: "d" });
  });

  test("sequential multi-op add → write projections (ruling 293)", () => {
    const multi = `*** Begin Patch
*** Add File: a.txt
+one
*** Add File: b.txt
+two
*** End Patch`;
    expect(applyPatchArgsEligibleForKernelRoute({ input: multi })).toBe(true);
    const projs = applyPatchKernelProjections({ input: multi });
    expect(projs?.length).toBe(2);
    expect(projs?.[0]?.kind).toBe("write");
    expect(projs?.[1]?.kind).toBe("write");
    expect(applyPatchKernelProjection({ input: multi })).toBeUndefined();
  });

  test("exact move → rename projection (ruling 297)", () => {
    const moveOnly = `*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
-same
+same
*** End Patch`;
    expect(applyPatchArgsEligibleForKernelRoute({ input: moveOnly })).toBe(true);
    const projs = applyPatchKernelProjections({ input: moveOnly });
    expect(projs?.length).toBe(1);
    expect(projs?.[0]?.kind).toBe("rename");
    if (projs?.[0]?.kind === "rename") {
      expect(projs[0].from).toBe("a.txt");
      expect(projs[0].to).toBe("b.txt");
    }
  });

  test("move + single-chunk edit → edit then rename (ruling 297)", () => {
    const mv = `*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
@@
-old
+new
*** End Patch`;
    const projs = applyPatchKernelProjections({ input: mv });
    expect(projs?.length).toBe(2);
    expect(projs?.[0]?.kind).toBe("edit");
    expect(projs?.[1]?.kind).toBe("rename");
  });

  test("EOF-anchored exact single-chunk update → edit (ruling 300)", () => {
    const eof = `*** Begin Patch
*** Update File: tail.txt
@@
-last
+LAST
*** End of File
*** End Patch`;
    expect(applyPatchArgsEligibleForKernelRoute({ input: eof })).toBe(true);
    const proj = applyPatchKernelProjection({ input: eof });
    expect(proj?.kind).toBe("edit");
    if (proj?.kind === "edit") {
      expect(proj.old).toBe("last");
      expect(proj.new).toBe("LAST");
    }
  });

  test("single delete → delete projection (ruling 296)", () => {
    const del = `*** Begin Patch
*** Delete File: gone.txt
*** End Patch`;
    expect(applyPatchArgsEligibleForKernelRoute({ input: del })).toBe(true);
    const proj = applyPatchKernelProjection({ input: del });
    expect(proj?.kind).toBe("delete");
    if (proj?.kind === "delete") expect(proj.path).toBe("gone.txt");
  });
});

describe("astEditKernelProjection", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-ast-proj-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("literal pat/out projects to single edit", async () => {
    writeFileSync(path.join(workspace, "f.ts"), "const x = 1;\n", "utf8");
    expect(astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "const", out: "let" })).toBe(true);
    const proj = await astEditKernelProjection(workspace, { path: "f.ts", pat: "const", out: "let" });
    expect(proj?.kind).toBe("edit");
    if (proj?.kind === "edit") {
      expect(proj.old).toBe("const");
      expect(proj.new).toBe("let");
    }
  });

  test("simple single-metavar projects via rewriteMatches", async () => {
    writeFileSync(path.join(workspace, "f.ts"), "function foo(x) {}\n", "utf8");
    expect(astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "foo($A)", out: "bar($A)" })).toBe(true);
    const proj = await astEditKernelProjection(workspace, { path: "f.ts", pat: "foo($A)", out: "bar($A)" });
    expect(proj?.kind).toBe("edit");
    if (proj?.kind === "edit") {
      expect(proj.old).toBe("foo(x)");
      expect(proj.new).toBe("bar(x)");
    }
  });

  test("multi-metavar single-match projects when rewrite is unique (ruling 302)", async () => {
    writeFileSync(path.join(workspace, "f.ts"), "call(a, b);\n", "utf8");
    expect(astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "call($A, $B)", out: "invoke($A, $B)" })).toBe(true);
    const proj = await astEditKernelProjection(workspace, {
      path: "f.ts",
      pat: "call($A, $B)",
      out: "invoke($A, $B)",
    });
    expect(proj?.kind).toBe("edit");
    if (proj?.kind === "edit") {
      expect(proj.old).toBe("call(a, b)");
      expect(proj.new).toBe("invoke(a, b)");
    }
  });

  test("variadic $$$ shape-eligible when out metvars ⊆ pat; unknown out metavar ineligible", () => {
    expect(astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "foo($A)", out: "bar" })).toBe(true);
    expect(astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "foo($A)", out: "bar($B)" })).toBe(false);
    expect(astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "foo($$$A)", out: "baz($$$A)" })).toBe(true);
    expect(astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "foo($$$A)", out: "baz($$$B)" })).toBe(false);
  });

  test("variadic $$$ unique rewrite projects to single edit (ruling 320)", async () => {
    writeFileSync(path.join(workspace, "f.ts"), "call(a, b, c);\n", "utf8");
    const proj = await astEditKernelProjection(workspace, {
      path: "f.ts",
      pat: "call($$$A)",
      out: "invoke($$$A)",
    });
    expect(proj?.kind).toBe("edit");
    if (proj?.kind === "edit") {
      expect(proj.old).toBe("call(a, b, c)");
      expect(proj.new).toBe("invoke(a, b, c)");
    }
  });

  test("variadic multi-match shape-eligible but projection fail-closed (Bun-owned)", async () => {
    writeFileSync(path.join(workspace, "f.ts"), "foo(a); bar(b);\nfoo(c);\n", "utf8");
    expect(
      astEditArgsEligibleForKernelRoute({ path: "f.ts", pat: "foo($$$A)", out: "baz($$$A)" }),
    ).toBe(true);
    expect(
      await astEditKernelProjection(workspace, { path: "f.ts", pat: "foo($$$A)", out: "baz($$$A)" }),
    ).toBeUndefined();
  });

  test("classifyAstEditKernelProjectionMiss names multi_match (ruling 322)", async () => {
    writeFileSync(path.join(workspace, "f.ts"), "foo(a); foo(b);\n", "utf8");
    const { classifyAstEditKernelProjectionMiss } = await import("../../src/core/effect-kernel-tool-projection");
    expect(
      await classifyAstEditKernelProjectionMiss(workspace, {
        path: "f.ts",
        pat: "foo($$$A)",
        out: "baz($$$A)",
      }),
    ).toBe("multi_match");
  });
});
