import { describe, expect, test } from "bun:test";
import {
  buildLearningGraphModel,
  renderLearningGraphAscii,
  renderLearningGraphExpandedAscii,
} from "../../src/core/learning-graph";
import type { StoredProposalRow } from "../../src/core/curator";
import { REVIEW_FORK_ORIGIN } from "../../src/core/review";

function row(partial: Partial<StoredProposalRow> & Pick<StoredProposalRow, "title" | "digest">): StoredProposalRow {
  return {
    schemaVersion: 1,
    kind: "memory",
    title: partial.title,
    body: "b",
    evidence: [],
    reads: [],
    digest: partial.digest,
    origin: REVIEW_FORK_ORIGIN,
    createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("renderLearningGraphAscii", () => {
  test("empty store", () => {
    expect(renderLearningGraphAscii([])).toContain("no curator proposals");
  });

  test("chains nodes with ascii edges", () => {
    const text = renderLearningGraphAscii([
      row({ title: "first", digest: "a".repeat(64) }),
      row({ title: "second", digest: "b".repeat(64) }),
    ]);
    expect(text).toContain("|");
    expect(text).toContain("v");
    expect(text).toContain("first");
    expect(text).toContain("2 proposal");
  });
});

function graphRows() {
  return [
    row({
      title: "alpha",
      digest: "a".repeat(64),
      kind: "memory",
      reads: ["src/core/curator.ts"],
      evidence: ["ev-1", "shared.log"],
    }),
    row({
      title: "beta",
      digest: "b".repeat(64),
      kind: "skill",
      reads: ["src/core/curator.ts"],
      evidence: ["ev-2", "shared.log"],
    }),
    row({
      title: "gamma",
      digest: "c".repeat(64),
      kind: "prompt",
      reads: ["docs/x.md"],
      evidence: ["ev-3"],
    }),
  ];
}

describe("bounded learning graph (G-7 fuller)", () => {
  test("model is deterministic for identical input", () => {
    const a = buildLearningGraphModel(graphRows());
    const b = buildLearningGraphModel(graphRows());
    expect(a).toEqual(b);
    expect(a.nodes.map((n) => n.id)).toEqual(["n0", "n1", "n2"]);
  });

  test("shared reads/evidence add labelled bidirectional edges (cycles)", () => {
    const model = buildLearningGraphModel(graphRows());
    const labels = model.edges.map((e) => e.label);
    expect(labels).toContain("next");
    expect(labels).toContain("reads:src/core/curator.ts");
    expect(labels).toContain("evidence:shared.log");
    // n0 <-> n1 both via reads and via evidence → a real cycle is representable.
    const aToB = model.edges.find((e) => e.from === "n0" && e.to === "n1" && e.kind === "reads");
    const bToA = model.edges.find((e) => e.from === "n1" && e.to === "n0" && e.kind === "reads");
    expect(aToB).toBeDefined();
    expect(bToA).toBeDefined();
  });

  test("expanded render is cycle-safe and shows nodes, edges and walk", () => {
    const text = renderLearningGraphExpandedAscii(graphRows());
    expect(text).toContain("learning graph (expanded");
    expect(text).toContain("nodes (3)");
    expect(text).toContain("edges (");
    expect(text).toContain("n0 --next--> n1");
    expect(text).toContain("cycle-safe");
    expect(text).toContain("(cycle/seen)");
    // A cycle would hang a naive recursive walk; this test itself proves termination.
  });

  test("caps are reported honestly", () => {
    const model = buildLearningGraphModel(graphRows(), { maxNodes: 2, maxEdges: 2 });
    expect(model.nodes.length).toBe(2);
    expect(model.edges.length).toBeLessThanOrEqual(2);
    expect(model.totalNodes).toBe(3);
    expect(model.totalEdges).toBeGreaterThan(model.edges.length);
    const text = renderLearningGraphExpandedAscii(graphRows(), { maxNodes: 2, maxEdges: 2 });
    expect(text).toContain("bounded: +1 node(s)");
  });

  test("default render stays the compatible chain, distinct from expanded", () => {
    const chain = renderLearningGraphAscii(graphRows());
    const expanded = renderLearningGraphExpandedAscii(graphRows());
    expect(chain).not.toBe(expanded);
    expect(chain).toContain("oldest → newest");
  });
});
