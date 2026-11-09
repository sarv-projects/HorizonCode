/**
 * apply-patch.test.ts — the GPT-5/Codex freeform `apply_patch` tool (FEAT-002).
 *
 * Parser: Add/Update/Delete/Move, duplicate-file rejection, BASH_WRAPPERS,
 * Add-File-all-'+'. Fuzz ladder: one case per rung (0 / 1 / 100 / 1000 / EOF
 * +10000). Canonicalization: a smart-quote / unicode-dash / NBSP match after
 * Unicode-fold. Unmatched chunk -> warning + skip. Guard/receipt/preimage/
 * cwd-confinement discipline. Every test fails if the behaviour is reverted.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { applyPatchTool } from "../../src/tools/apply-patch";
import { canonicalize, parse } from "../../src/tools/apply-patch-parser";
import { readTool } from "../../src/tools/read";
import { makeWorkspace, mockToolContext, readFixture } from "./helpers";

/** A context that has already read `rel`, so update/delete preimage reads pass. */
async function ctxHavingRead(ws: string, rels: string[]) {
  const ctx = mockToolContext({ cwd: ws });
  for (const rel of rels) {
    const r = await readTool.execute({ path: rel }, ctx);
    if (!r.ok) throw new Error(`fixture read failed: ${r.error}`);
  }
  return ctx;
}

function wrap(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch\n`;
}

/* --------------------------------- parser --------------------------------- */

describe("apply_patch parser", () => {
  test("parses an Add File with an all-'+' body", () => {
    const r = parse(wrap("*** Add File: a.txt\n+hello\n+world"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.ops).toEqual([{ kind: "add", path: "a.txt", addBody: ["hello", "world"] }]);
  });

  test("rejects an Add File body line that does not start with '+'", () => {
    const r = parse(wrap("*** Add File: a.txt\n+ok\nnot-a-plus"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("must start with '+'");
  });

  test("parses an Update File with @@ context, deletes and inserts", () => {
    const r = parse(wrap("*** Update File: a.txt\n@@ ctx\n ctx-line\n-old\n+new"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.patch.ops[0];
    expect(op?.kind).toBe("update");
    if (op?.kind !== "update") return;
    expect(op.chunks[0]?.oldLines).toEqual(["ctx-line", "old"]);
    expect(op.chunks[0]?.newLines).toEqual(["ctx-line", "new"]);
    expect(op.chunks[0]?.header).toBe("ctx");
  });

  test("parses a Delete File", () => {
    const r = parse(wrap("*** Delete File: gone.txt"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.ops).toEqual([{ kind: "delete", path: "gone.txt" }]);
  });

  test("parses a Move (Update + '*** Move to:')", () => {
    const r = parse(wrap("*** Update File: a.txt\n*** Move to: b.txt\n@@\n-old\n+new"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const op = r.patch.ops[0];
    expect(op?.kind).toBe("update");
    if (op?.kind !== "update") return;
    expect(op.movePath).toBe("b.txt");
  });

  test("rejects a duplicate operation on the same path", () => {
    const r = parse(wrap("*** Update File: a.txt\n@@\n-x\n+y\n*** Update File: a.txt\n@@\n-p\n+q"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Duplicate update for file");
  });

  test("tolerates BASH_WRAPPERS around the patch body", () => {
    const text = "%%bash\napply_patch\n```\n*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch\n```\nEOF\n";
    const r = parse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.ops[0]).toEqual({ kind: "add", path: "a.txt", addBody: ["hi"] });
  });

  test("errors on a missing Begin/End envelope", () => {
    expect(parse("*** Add File: a.txt\n+hi").ok).toBe(false);
    expect(parse("*** Begin Patch\n*** Add File: a.txt\n+hi").ok).toBe(false);
  });

  test("flags a move destination that collides with another named op (issue 3)", () => {
    // '*** Move to: b.txt' targets b.txt, which the patch also Adds -> collision.
    const r = parse(wrap("*** Add File: b.txt\n+seed\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Duplicate move destination for file: b.txt");
  });

  test("flags two move destinations onto the same path (issue 3)", () => {
    const r = parse(
      wrap("*** Update File: a.txt\n*** Move to: z.txt\n@@\n-x\n+y\n*** Update File: b.txt\n*** Move to: z.txt\n@@\n-p\n+q"),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Duplicate move destination for file: z.txt");
  });
});

/* ------------------------------ canonicalize ------------------------------ */

describe("canonicalize (Unicode-fold)", () => {
  test("folds dashes, smart quotes and odd spaces to ASCII", () => {
    expect(canonicalize("a\u2014b")).toBe("a-b"); // em dash
    expect(canonicalize("a\u2212b")).toBe("a-b"); // minus sign
    expect(canonicalize("\u2018x\u2019")).toBe("'x'"); // smart single quotes
    expect(canonicalize("\u201Cx\u201D")).toBe('"x"'); // smart double quotes
    expect(canonicalize("a\u00A0b")).toBe("a b"); // NBSP
    expect(canonicalize("a\u3000b")).toBe("a b"); // ideographic space
  });

  test("unescapes backslash-escaped backtick/quotes", () => {
    expect(canonicalize("\\`\\'\\\"")).toBe("`'\"");
  });
});

/* ----------------------------- apply: add/update -------------------------- */

describe("apply_patch effects", () => {
  test("adds a new file via writeAtomic", async () => {
    const ws = makeWorkspace();
    const ctx = mockToolContext({ cwd: ws });
    const r = await applyPatchTool.execute({ input: wrap("*** Add File: new.txt\n+alpha\n+beta") }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "new.txt")).toBe("alpha\nbeta\n");
    expect(r.output).toContain("Patch applied with fuzz factor 0");
    expect(ctx.guardCalls).toEqual([{ kind: "fs.write", target: path.join(ws, "new.txt") }]);
  });

  test("updates a file (exact match, fuzz 0)", async () => {
    const ws = makeWorkspace({ "a.txt": "one\ntwo\nthree\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n two\n-three\n+THREE") }, ctx);
    expect(r.ok).toBe(true);
    expect(readFixture(ws, "a.txt")).toBe("one\ntwo\nTHREE\n");
    expect(r.output).toContain("Patch applied with fuzz factor 0");
  });

  test("deletes a file after the guard/preimage window", async () => {
    const ws = makeWorkspace({ "gone.txt": "bye\n" });
    const ctx = await ctxHavingRead(ws, ["gone.txt"]);
    const r = await applyPatchTool.execute({ input: wrap("*** Delete File: gone.txt") }, ctx);
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(ws, "gone.txt"))).toBe(false);
    expect(r.output).toContain("deleted 1");
  });

  test("moves a file (update + Move to)", async () => {
    const ws = makeWorkspace({ "a.txt": "x\ny\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const r = await applyPatchTool.execute(
      { input: wrap("*** Update File: a.txt\n*** Move to: b.txt\n@@\n x\n-y\n+Y") },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(ws, "a.txt"))).toBe(false);
    expect(readFixture(ws, "b.txt")).toBe("x\nY\n");
    expect(r.output).toContain("moved 1");
  });
});

/* ---------------------- create-path overwrite safety (issue 1) ------------ */

describe("apply_patch create-path overwrite safety", () => {
  test("Add File onto an existing path is refused (no overwrite, no data loss)", async () => {
    const ws = makeWorkspace({ "a.txt": "original\n" });
    const ctx = mockToolContext({ cwd: ws });
    const r = await applyPatchTool.execute({ input: wrap("*** Add File: a.txt\n+clobber") }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Add File refused");
    expect(r.error).toContain("already exists");
    // The original content is untouched.
    expect(readFixture(ws, "a.txt")).toBe("original\n");
  });

  test("a move onto an existing destination journals the destination's real preimage", async () => {
    const ws = makeWorkspace({ "a.txt": "x\ny\n", "dest.txt": "DESTINATION-ORIGINAL\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const { lastChangeFor } = await import("../../src/tools/change-journal");
    const r = await applyPatchTool.execute(
      { input: wrap("*** Update File: a.txt\n*** Move to: dest.txt\n@@\n x\n-y\n+Y") },
      ctx,
    );
    expect(r.ok).toBe(true);
    // The destination was overwritten with the moved content ...
    expect(readFixture(ws, "dest.txt")).toBe("x\nY\n");
    // ... but the journal recorded its real preimage so undo can restore it
    // (NOT `before: null`, which is the data-loss bug this fix closes).
    const entry = lastChangeFor(ctx.sessionId, path.join(ws, "dest.txt"));
    expect(entry).toBeDefined();
    expect(entry?.before).toBe("DESTINATION-ORIGINAL\n");
  });

  test("a move onto a brand-new destination still journals before: null", async () => {
    const ws = makeWorkspace({ "a.txt": "x\ny\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const { lastChangeFor } = await import("../../src/tools/change-journal");
    const r = await applyPatchTool.execute(
      { input: wrap("*** Update File: a.txt\n*** Move to: fresh.txt\n@@\n x\n-y\n+Y") },
      ctx,
    );
    expect(r.ok).toBe(true);
    const entry = lastChangeFor(ctx.sessionId, path.join(ws, "fresh.txt"));
    expect(entry).toBeDefined();
    expect(entry?.before).toBe(null);
  });
});

/* --------------------- partial application across ops (issue 2) ----------- */

describe("apply_patch partial application reporting", () => {
  test("a mid-patch failure names the ops that already applied", async () => {
    const ws = makeWorkspace({ "a.txt": "keep\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    // Op 1 (update a.txt) succeeds; op 2 (Add File onto the now-existing b.txt
    // we create in op... ) — instead use op 2 = Delete of a missing file, which
    // fails its preimage read, after op 1 already wrote.
    const r = await applyPatchTool.execute(
      {
        input: wrap("*** Update File: a.txt\n@@\n-keep\n+done\n*** Delete File: missing.txt"),
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("file not found");
    expect(r.error).toContain("already applied before this failure");
    expect(r.error).toContain("updated a.txt");
    // Op 1's write did land (there is no cross-op rollback — the named residual).
    expect(readFixture(ws, "a.txt")).toBe("done\n");
  });
});

/* ------------------------------- fuzz ladder ------------------------------ */

describe("apply_patch fuzz ladder", () => {
  test("rung 2: per-line trimEnd match -> fuzz 1", async () => {
    const ws = makeWorkspace({ "a.txt": "keep  \ntarget\n" }); // trailing spaces in file
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n keep\n-target\n+done") }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Patch applied with fuzz factor 1");
    // The matched context line is rewritten to the patch's canonical form (the
    // trailing whitespace the trimEnd rung tolerated is not carried through).
    expect(readFixture(ws, "a.txt")).toBe("keep\ndone\n");
  });

  test("rung 3: per-line trim (both sides) match -> fuzz 100", async () => {
    const ws = makeWorkspace({ "a.txt": "   keep\ntarget\n" }); // leading spaces in file
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n keep\n-target\n+done") }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Patch applied with fuzz factor 100");
  });

  test("rung 4: Levenshtein similarity >= 0.66 -> fuzz 1000", async () => {
    const ws = makeWorkspace({ "a.txt": "the quick brown fox\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    // One-character typo keeps similarity well above 0.66.
    const r = await applyPatchTool.execute(
      { input: wrap("*** Update File: a.txt\n@@\n-the quick brwn fox\n+the quick brown FOX") },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Patch applied with fuzz factor 1000");
    expect(readFixture(ws, "a.txt")).toBe("the quick brown FOX\n");
  });

  test("rung 5: EOF-anchored match adds +10000", async () => {
    const ws = makeWorkspace({ "a.txt": "head\nmid\nlast\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const r = await applyPatchTool.execute(
      { input: wrap("*** Update File: a.txt\n@@\n-last\n+LAST\n*** End of File") },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Patch applied with fuzz factor 10000");
    expect(readFixture(ws, "a.txt")).toBe("head\nmid\nLAST\n");
  });
});

/* ------------------------- canonicalisation matching ---------------------- */

describe("apply_patch canonicalisation matching", () => {
  test("a smart-quote / unicode-dash / NBSP in file context matches after fold", async () => {
    // File carries an em dash, a smart quote and an NBSP; the patch uses ASCII.
    const ws = makeWorkspace({ "a.txt": "a\u2014b\u2019c\u00A0d\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n-a-b'c d\n+folded") }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Patch applied with fuzz factor 0");
    expect(readFixture(ws, "a.txt")).toBe("folded\n");
  });
});

/* ----------------------------- unmatched warning -------------------------- */

describe("apply_patch unmatched chunk", () => {
  test("reports a warning and skips the chunk while other chunks apply", async () => {
    const ws = makeWorkspace({ "a.txt": "alpha\nbeta\ngamma\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const r = await applyPatchTool.execute(
      {
        input: wrap(
          "*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n@@\n-this line is nowhere in the file at all\n+ignored",
        ),
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("WARNING a.txt chunk 1");
    expect(r.output).toContain("Could not find matching context");
    expect(r.output).toContain("Chunk skipped.");
    // The first chunk still applied.
    expect(readFixture(ws, "a.txt")).toBe("ALPHA\nbeta\ngamma\n");
  });
});

/* --------------------------- guard / preimage / cwd ----------------------- */

describe("apply_patch guard & preimage discipline", () => {
  test("a guard deny fails with no file change", async () => {
    const ws = makeWorkspace({ "a.txt": "keep\n" });
    const denyCtx = mockToolContext({ cwd: ws, decision: "deny", decisionReason: "read-only" });
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n-keep\n+changed") }, denyCtx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("denied by policy: read-only");
    expect(readFixture(ws, "a.txt")).toBe("keep\n");
  });

  test("a declined 'ask' makes no change", async () => {
    const ws = makeWorkspace({ "a.txt": "keep\n" });
    const ctx = mockToolContext({ cwd: ws, decision: "ask", approve: false });
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n-keep\n+changed") }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("declined by user");
    expect(ctx.approveCalls.length).toBe(1);
    expect(readFixture(ws, "a.txt")).toBe("keep\n");
  });

  test("a preimage change between guard and effect yields HZ_PRECONDITION_FAILED", async () => {
    const ws = makeWorkspace({ "a.txt": "keep\n" });
    // Only fs.write is gated with "ask"; the mutation fires once, inside the
    // apply_patch approval window (after its preimage read, before the effect).
    let mutated = false;
    const ctx = mockToolContext({
      cwd: ws,
      decision: (a) => ({ decision: a.kind === "fs.write" ? "ask" : "allow" }),
      approve: () => {
        if (!mutated) {
          writeFileSync(path.join(ws, "a.txt"), "changed-underfoot\n");
          mutated = true;
        }
        return true;
      },
    });
    const read = await readTool.execute({ path: "a.txt" }, ctx);
    expect(read.ok).toBe(true);
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n-keep\n+new") }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("HZ_PRECONDITION_FAILED");
    expect(r.error).toContain("preimage changed");
  });

  test("a path escaping cwd is refused", async () => {
    const ws = makeWorkspace();
    const ctx = mockToolContext({ cwd: ws });
    const r = await applyPatchTool.execute({ input: wrap("*** Add File: ../escape.txt\n+nope") }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("escapes the workspace");
    expect(existsSync(path.join(ws, "..", "escape.txt"))).toBe(false);
  });

  test("a successful apply records a change (goes through the journal)", async () => {
    const ws = makeWorkspace({ "a.txt": "keep\n" });
    const ctx = await ctxHavingRead(ws, ["a.txt"]);
    const { journalSize } = await import("../../src/tools/change-journal");
    const before = journalSize(ctx.sessionId);
    const r = await applyPatchTool.execute({ input: wrap("*** Update File: a.txt\n@@\n-keep\n+done") }, ctx);
    expect(r.ok).toBe(true);
    expect(journalSize(ctx.sessionId)).toBe(before + 1);
  });
});
