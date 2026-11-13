import { describe, expect, test } from "bun:test";
import {
  assertEvalApprovalFresh,
  buildEvalApproval,
  casesContentHash,
} from "../../src/core/eval-approval";
import type { PostmortemEvalCase } from "../../src/core/evals";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CASES: PostmortemEvalCase[] = [
  {
    id: "b",
    from: "test",
    task: "do B",
    setup: { tools: [] },
    assertions: [{ kind: "terminal", value: "succeeded" }],
  },
  {
    id: "a",
    from: "test",
    task: "do A",
    setup: { tools: [] },
    assertions: [{ kind: "terminal", value: "succeeded" }],
  },
];

describe("eval approval freshness", () => {
  test("casesContentHash is order-independent by id", () => {
    const h1 = casesContentHash(CASES);
    const h2 = casesContentHash([...CASES].reverse());
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  test("stale approval refuses", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eval-appr-"));
    const file = path.join(dir, "approval.json");
    const approval = buildEvalApproval(CASES);
    writeFileSync(file, JSON.stringify(approval));
    assertEvalApprovalFresh(CASES, file);
    const mutated = [...CASES, { ...CASES[0], id: "c", task: "new" }];
    expect(() => assertEvalApprovalFresh(mutated, file)).toThrow(/stale/);
  });
});
