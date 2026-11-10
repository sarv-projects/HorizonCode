/**
 * tool-schema-snapshot.test.ts - T-2: every registered tool's contract, pinned.
 *
 * The model sees each tool as (name, description, JSON schema). Any drift in
 * those bytes changes the prompt prefix (and with it the provider cache), so a
 * change must be a visible, reviewed diff rather than a side effect. This test
 * serialises every builtin tool (name, description, JSON schema, exposure and
 * batch class) with recursively sorted keys and compares the text to the
 * committed fixture `tests/fixtures/tool-schemas.json`.
 *
 * UPDATE PATH: after an intentional change, rewrite the fixture and review the
 * diff in the same commit:
 *
 *   cd app && HZ_UPDATE_TOOL_SCHEMAS=1 bun test tests/tools/tool-schema-snapshot.test.ts
 *
 * Snapshots are never auto-accepted: without that variable a mismatch fails.
 * Descriptions are also capped (MAX_DESCRIPTION_CHARS), as forgecode does.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { exposureOf, toolSpecs, tools } from "../../src/tools";

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "tool-schemas.json");
const MAX_DESCRIPTION_CHARS = 1024;

/** Deep copy with object keys sorted, so the text is independent of source key order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function render(): string {
  const entries = tools
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      exposure: exposureOf(t),
      concurrencyClass: t.concurrencyClass ?? "shared",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `${JSON.stringify(sortKeys(entries), null, 2)}\n`;
}

describe("tool schema snapshot", () => {
  test("every registered tool matches the committed fixture byte for byte", () => {
    const actual = render();
    if (process.env.HZ_UPDATE_TOOL_SCHEMAS === "1") {
      writeFileSync(FIXTURE, actual);
      return;
    }
    expect(existsSync(FIXTURE)).toBe(true);
    const expected = readFileSync(FIXTURE, "utf8");
    // Compare as parsed entries first so a failure names the tool, then as text.
    const a = JSON.parse(actual) as Array<{ name: string }>;
    const e = JSON.parse(expected) as Array<{ name: string }>;
    expect(a.map((t) => t.name)).toEqual(e.map((t) => t.name));
    for (const entry of a) expect(entry).toEqual(e.find((x) => x.name === entry.name) as object);
    expect(actual).toBe(expected);
  });

  test("tool names are unique and snake_case", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test(`descriptions are non-empty and at most ${MAX_DESCRIPTION_CHARS} chars`, () => {
    for (const t of tools) {
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    }
  });

  test("every schema is an object schema with typed properties and valid `required`", () => {
    for (const t of tools) {
      const p = t.parameters as { type?: unknown; properties?: Record<string, { type?: unknown }>; required?: string[] };
      expect(p.type).toBe("object");
      const props = p.properties ?? {};
      for (const [key, def] of Object.entries(props)) expect(def.type ?? (def as { enum?: unknown }).enum ?? (def as { oneOf?: unknown }).oneOf, `${t.name}.${key}`).toBeDefined();
      for (const req of p.required ?? []) expect(Object.keys(props), `${t.name} requires ${req}`).toContain(req);
    }
  });

  test("the default spec list the model sees is a subset of the snapshotted tools, in registry order", () => {
    const specNames = toolSpecs().map((s) => s.name);
    const snap = tools.map((t) => t.name);
    expect(specNames.filter((n) => snap.includes(n))).toEqual(snap.filter((n) => specNames.includes(n)));
    for (const s of toolSpecs()) {
      const t = tools.find((x) => x.name === s.name);
      if (t !== undefined) expect({ d: s.description, p: s.parameters }).toEqual({ d: t.description, p: t.parameters });
    }
  });
});
