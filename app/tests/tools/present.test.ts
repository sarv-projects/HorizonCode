import { describe, expect, test } from "bun:test";
import { __resetDeliverablesForTests, declaredDeliverables } from "../../src/core/deliverables";
import { presentTool } from "../../src/tools/present";
import { makeWorkspace, mockToolContext } from "./helpers";

describe("present tool (reduced)", () => {
  test("records declared paths", async () => {
    __resetDeliverablesForTests();
    const ws = makeWorkspace({ "out.txt": "ok\n" });
    const ctx = mockToolContext({ workspace: ws, cwd: ws, sessionId: "s-present" });
    const res = await presentTool.execute({ files: ["out.txt"] }, ctx);
    expect(res.ok).toBe(true);
    expect(declaredDeliverables("s-present")).toEqual(["out.txt"]);
    expect(res.output).toContain("line(s)");
    expect(res.output).toContain("out.txt");
  });
});
