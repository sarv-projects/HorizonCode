/**
 * model-tool-routing.test.ts — the declarative model->tool routing table.
 *
 * Pins the four behaviours FEAT-003 promises and that must fail on revert:
 *  - GPT/Codex + openai => apply_patch enabled, edit disabled;
 *  - anthropic/claude keeps edit (apply_patch not forced on, edit not disabled);
 *  - ENABLE WINS OVER DISABLE within a single rule;
 *  - matching is case-insensitive substring on both model id and provider id.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_TOOL_ROUTING_RULES,
  resolveToolRoutingConfig,
  type ToolRoutingRule,
} from "../../src/tools/model-tool-routing";

describe("resolveToolRoutingConfig (model->tool routing)", () => {
  test("gpt model routes to apply_patch and disables edit", () => {
    const decision = resolveToolRoutingConfig({ model: "gpt-4o-mini", provider: "openai" });
    expect(decision.isToolEnabled("apply_patch")).toBe(true);
    expect(decision.isToolEnabled("edit")).toBe(false);
    expect(decision.enabled.has("apply_patch")).toBe(true);
    expect(decision.disabled.has("edit")).toBe(true);
  });

  test("codex model (any provider) routes to apply_patch and disables edit", () => {
    const decision = resolveToolRoutingConfig({ model: "o4-codex-preview", provider: "mock" });
    expect(decision.isToolEnabled("apply_patch")).toBe(true);
    expect(decision.isToolEnabled("edit")).toBe(false);
  });

  test("openai provider alone routes to apply_patch even for a non-gpt model id", () => {
    const decision = resolveToolRoutingConfig({ model: "o3-mini", provider: "openai" });
    expect(decision.isToolEnabled("apply_patch")).toBe(true);
    expect(decision.isToolEnabled("edit")).toBe(false);
  });

  test("anthropic/claude keeps edit and does not force apply_patch", () => {
    const decision = resolveToolRoutingConfig({ model: "claude-sonnet-4-5", provider: "anthropic" });
    expect(decision.isToolEnabled("edit")).toBe(true);
    expect(decision.disabled.has("edit")).toBe(false);
    // apply_patch is unmentioned for this model: not force-enabled by routing.
    expect(decision.enabled.has("apply_patch")).toBe(false);
    // An unmentioned tool is still "enabled" by the predicate (routing only
    // removes disabled tools; it does not hide tools it never named).
    expect(decision.isToolEnabled("apply_patch")).toBe(true);
  });

  test("ENABLE WINS OVER DISABLE within a single rule", () => {
    const rules: ToolRoutingRule[] = [
      { name: "both", modelIdIncludes: ["glm"], disableTools: ["edit"], enableTools: ["edit"] },
    ];
    const decision = resolveToolRoutingConfig({ model: "glm-4", provider: "mock", rules });
    // The same rule both disables and enables `edit`: enable wins.
    expect(decision.isToolEnabled("edit")).toBe(true);
    expect(decision.enabled.has("edit")).toBe(true);
    expect(decision.disabled.has("edit")).toBe(false);
  });

  test("matching is case-insensitive substring on model id and provider id", () => {
    const upperModel = resolveToolRoutingConfig({ model: "GPT-5-CODEX", provider: "unknown" });
    expect(upperModel.isToolEnabled("edit")).toBe(false);
    expect(upperModel.isToolEnabled("apply_patch")).toBe(true);

    const upperProvider = resolveToolRoutingConfig({ model: "some-model", provider: "OpenAI" });
    expect(upperProvider.isToolEnabled("edit")).toBe(false);
    expect(upperProvider.isToolEnabled("apply_patch")).toBe(true);
  });

  test("toToolFilter composes with a prior filter (narrows, never widens)", () => {
    const decision = resolveToolRoutingConfig({ model: "gpt-4o-mini", provider: "openai" });
    // Prior filter already excludes `agent`; routing must keep it excluded.
    const prior = (name: string): boolean => name !== "agent";
    const filter = decision.toToolFilter(prior);
    expect(filter("agent")).toBe(false); // prior exclusion preserved
    expect(filter("edit")).toBe(false); // routing-disabled
    expect(filter("apply_patch")).toBe(true); // routing-enabled, prior allows
    expect(filter("read")).toBe(true); // untouched by either

    // Routing never widens: a tool the prior filter removed stays removed even
    // if routing would enable it.
    const priorHidesApply = (name: string): boolean => name !== "apply_patch";
    const narrowed = decision.toToolFilter(priorHidesApply);
    expect(narrowed("apply_patch")).toBe(false);
  });

  test("the shipped defaults are exactly the two apply_patch rules", () => {
    expect(DEFAULT_MODEL_TOOL_ROUTING_RULES.length).toBe(2);
    for (const rule of DEFAULT_MODEL_TOOL_ROUTING_RULES) {
      expect(rule.enableTools).toEqual(["apply_patch"]);
      expect(rule.disableTools).toEqual(["edit"]);
    }
  });
});
