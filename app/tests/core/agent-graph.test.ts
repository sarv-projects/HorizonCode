import { describe, expect, test } from "bun:test";
import {
  AGENT_GRAPH_MAX_EDGES,
  AGENT_GRAPH_MAX_NODES,
  buildAgentGraphModel,
  renderAgentGraphAscii,
  type AgentGraphInput,
} from "../../src/core/agent-graph";

const input: AgentGraphInput = {
  sessions: [
    { id: "sess-1", title: "first session", tools: ["read", "repo_map"] },
    { id: "sess-2", title: "second session", tools: ["edit"] },
  ],
  tools: ["read", "repo_map", "edit", "shell"],
  skills: [{ name: "code-review" }, { name: "deploy" }],
  proposals: [
    {
      digest: "a".repeat(64),
      title: "alpha",
      kind: "memory",
      reads: ["src/core/loop.ts", "code-review"],
      evidence: ["sess-1"],
    },
    {
      digest: "b".repeat(64),
      title: "beta",
      kind: "skill",
      reads: ["src/core/loop.ts"],
      evidence: ["sess-2"],
    },
  ],
};

describe("whole-agent graph (G-7 residual)", () => {
  test("includes all four agent-level node kinds", () => {
    const model = buildAgentGraphModel(input);
    const kinds = new Set(model.nodes.map((n) => n.kind));
    expect(kinds.has("session")).toBe(true);
    expect(kinds.has("tool")).toBe(true);
    expect(kinds.has("skill")).toBe(true);
    expect(kinds.has("proposal")).toBe(true);
    expect(model.nodes.length).toBe(10);
  });

  test("emits used / mentions / derived-from / next edges", () => {
    const model = buildAgentGraphModel(input);
    const kinds = new Set(model.edges.map((e) => e.kind));
    expect(kinds.has("used")).toBe(true);
    expect(kinds.has("mentions")).toBe(true);
    expect(kinds.has("derived-from")).toBe(true);
    expect(kinds.has("next")).toBe(true);
  });

  test("respects caps and reports honest totals", () => {
    const many: AgentGraphInput = {
      sessions: Array.from({ length: 60 }, (_, i) => ({ id: `s${i}` })),
      tools: Array.from({ length: 60 }, (_, i) => `tool${i}`),
    };
    const model = buildAgentGraphModel(many, { maxNodes: 12, maxEdges: 5 });
    expect(model.nodes.length).toBeLessThanOrEqual(12);
    expect(model.edges.length).toBeLessThanOrEqual(5);
    expect(model.totalNodes).toBeGreaterThan(model.nodes.length);
    expect(AGENT_GRAPH_MAX_NODES).toBeGreaterThan(0);
    expect(AGENT_GRAPH_MAX_EDGES).toBeGreaterThan(0);
  });

  test("is deterministic for the same input", () => {
    expect(buildAgentGraphModel(input)).toEqual(buildAgentGraphModel(input));
  });

  test("render is bounded and cycle-safe (no infinite walk)", () => {
    const text = renderAgentGraphAscii(buildAgentGraphModel(input));
    expect(text).toContain("whole-agent");
    expect(text).toContain("sessions / tools / skills / proposals");
    expect(text).toContain("cycle-safe");
    expect(text).toContain("s0");
    expect(text).toContain("p1");
    // A cycle marker appears for the shared-source `reads` references.
    expect(text).toContain("cycle/seen");
  });

  test("empty input renders an honest empty graph", () => {
    const text = renderAgentGraphAscii(buildAgentGraphModel({}));
    expect(text).toContain("nodes (0)");
    expect(text).toContain("(no agent-level relationships yet)");
  });
});
