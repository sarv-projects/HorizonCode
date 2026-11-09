/**
 * model-instructions.test.ts — per-model prompt-template selection (§1.7).
 *
 * Pins the fail-soft contract FEAT-003 promises and that must fail on revert:
 *  - the GPT/Codex family gets the apply_patch grammar block;
 *  - a non-matching model returns "" WITHOUT throwing (fail-soft miss);
 *  - the miss path emits a warning but never crashes;
 *  - matching is case-insensitive substring on model id and provider id.
 */

import { describe, expect, test } from "bun:test";
import {
  MODEL_INSTRUCTION_TEMPLATES,
  resolveModelInstructions,
  type ModelInstructionTemplate,
} from "../../src/core/instructions";

describe("resolveModelInstructions (per-model prompt selection)", () => {
  test("gpt/codex family gets the apply_patch grammar block", () => {
    const block = resolveModelInstructions({ model: "gpt-4o-mini", provider: "openai", warn: () => {} });
    expect(block).not.toBe("");
    expect(block).toContain("apply_patch");
    // The exact freeform-grammar markers the apply_patch tool parses.
    expect(block).toContain("*** Begin Patch");
    expect(block).toContain("*** Add File:");
    expect(block).toContain("*** Update File:");
    expect(block).toContain("*** End Patch");
  });

  test("codex model matches on the model id alone", () => {
    const block = resolveModelInstructions({ model: "o4-codex", provider: "mock", warn: () => {} });
    expect(block).toContain("*** Begin Patch");
  });

  test("a non-matching model returns '' without throwing (fail-soft miss)", () => {
    let warned = "";
    const block = resolveModelInstructions({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      warn: (m) => {
        warned = m;
      },
    });
    expect(block).toBe("");
    // Fail-soft: the miss is recorded, not thrown.
    expect(warned).toContain("claude-sonnet-4-5");
  });

  test("the miss path never throws even with hostile inputs", () => {
    expect(() =>
      resolveModelInstructions({ model: undefined as unknown as string, provider: undefined as unknown as string, warn: () => {} }),
    ).not.toThrow();
    const block = resolveModelInstructions({ model: "", provider: "", warn: () => {} });
    expect(block).toBe("");
  });

  test("a malformed template table degrades to '' and warns, never crashes", () => {
    let warned = "";
    const bad = [{ name: "boom", get modelIdIncludes(): string[] { throw new Error("explode"); } }] as unknown as ModelInstructionTemplate[];
    const block = resolveModelInstructions({
      model: "gpt-4o",
      provider: "openai",
      templates: bad,
      warn: (m) => {
        warned = m;
      },
    });
    expect(block).toBe("");
    expect(warned).toContain("failed");
  });

  test("matching is case-insensitive substring on model id and provider id", () => {
    expect(resolveModelInstructions({ model: "GPT-5-CODEX", provider: "unknown", warn: () => {} })).toContain("*** Begin Patch");
    expect(resolveModelInstructions({ model: "some-model", provider: "OpenAI", warn: () => {} })).toContain("*** Begin Patch");
  });

  test("the shipped table carries the gpt/codex apply_patch template", () => {
    expect(MODEL_INSTRUCTION_TEMPLATES.length).toBeGreaterThanOrEqual(1);
    const codex = MODEL_INSTRUCTION_TEMPLATES.find((t) => t.modelIdIncludes?.includes("codex"));
    expect(codex).toBeDefined();
    expect(codex?.text).toContain("*** Begin Patch");
  });
});
