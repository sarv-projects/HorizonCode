import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { admissionFor, applyPatchPaths } from "../../src/core/loop";

describe("apply_patch multi-resource admission (ruling 567)", () => {
  test("applyPatchPaths lists Add/Update/Delete/Move in order without duplicates", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: a.ts",
      "+x",
      "*** Update File: b.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: c.ts",
      "*** Update File: a.ts",
      "*** Update File: d.ts",
      "*** Move to: e.ts",
      "*** End Patch",
    ].join("\n");
    expect(applyPatchPaths(input)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  test("admissionFor puts remaining paths in also", () => {
    const ws = "/tmp/ws-apply-admit";
    const input = [
      "*** Begin Patch",
      "*** Add File: one.ts",
      "+a",
      "*** Update File: two.ts",
      "@@",
      "-b",
      "+c",
      "*** End Patch",
    ].join("\n");
    const admission = admissionFor("apply_patch", { input }, ws);
    expect(admission?.kind).toBe("guard");
    if (admission?.kind !== "guard") return;
    expect(admission.action).toEqual({ kind: "fs.write", target: path.resolve(ws, "one.ts") });
    expect(admission.also).toEqual([{ kind: "fs.write", target: path.resolve(ws, "two.ts") }]);
  });
});
