/**
 * alternating-roles.test.ts — port of aider ensure_alternating_roles (Group G).
 * DeepSeek R1 / reasoner models reject consecutive same-role messages.
 */
import { describe, expect, test } from "bun:test";
import {
  ensureAlternatingRoles,
  sanityCheckMessages,
} from "../../src/core/providers/alternating-roles";

const m = (role: string, content: string) => ({ role, content });

describe("alternating role sanitizer (aider port)", () => {
  test("inserts an empty opposite-role message between consecutive same-role messages", () => {
    const out = ensureAlternatingRoles([m("system", "s"), m("user", "u1"), m("user", "u2"), m("assistant", "a"), m("user", "u3")]);
    expect(out.map((x) => x.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(out[2]!.content).toBe(""); // the inserted assistant stub
    expect(sanityCheckMessages(out)).toBe(true);
  });

  test("system messages are interspersed freely and do not break alternation", () => {
    const out = ensureAlternatingRoles([m("user", "u"), m("system", "s1"), m("system", "s2"), m("assistant", "a"), m("user", "u2")]);
    expect(out.map((x) => x.role)).toEqual(["user", "system", "system", "assistant", "user"]);
    expect(sanityCheckMessages(out)).toBe(true);
  });

  test("a trailing assistant message fails the last-is-user sanity check", () => {
    expect(sanityCheckMessages([m("user", "u"), m("assistant", "a")])).toBe(false);
  });

  test("empty input is a no-op", () => {
    expect(ensureAlternatingRoles([])).toEqual([]);
  });
});
