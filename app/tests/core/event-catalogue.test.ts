/**
 * event-catalogue.test.ts — every runtime-emitted log type is listed (docs/33 §6.3).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { EventTypes } from "../../src/contracts";
import {
  HZ_CANONICAL_EVENTS,
  hzEventCoverageReport,
  RESERVED_UNEMITTED_EVENT_TYPES,
  SHIPPED_EVENT_CATALOGUE,
  SHIPPED_TO_HZ_MAP,
  unimplementedHzEvents,
} from "../../src/core/event-catalogue";
import { COMPACTION_EVENT } from "../../src/core/compaction";
import { PENDING_TODOS_EVENT, UNVERIFIED_COMPLETION_EVENT } from "../../src/core/loop";

const APP_ROOT = path.resolve(import.meta.dir, "../..");

const EMITTER_SOURCES = [
  "src/core/loop.ts",
  "src/core/index.ts",
  "src/core/hooks.ts",
].map((rel) => path.join(APP_ROOT, rel));

function collectEmittedTypes(sources: string[]): Set<string> {
  const found = new Set<string>();
  const addSymbol = (sym: string) => {
    if (sym === "COMPACTION_EVENT") found.add(COMPACTION_EVENT);
    else if (sym === "PENDING_TODOS_EVENT") found.add(PENDING_TODOS_EVENT);
    else if (sym === "UNVERIFIED_COMPLETION_EVENT") found.add(UNVERIFIED_COMPLETION_EVENT);
    else if (sym in EventTypes) found.add(EventTypes[sym as keyof typeof EventTypes]);
  };
  for (const file of sources) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\blogEvent\(\s*[^,]+,\s*[^,]+,\s*EventTypes\.(\w+)/g)) addSymbol(m[1]!);
    for (const m of src.matchAll(/\blogEvent\(\s*[^,]+,\s*[^,]+,\s*(COMPACTION_EVENT|PENDING_TODOS_EVENT|UNVERIFIED_COMPLETION_EVENT)\b/g)) addSymbol(m[1]!);
    for (const m of src.matchAll(/\.append\([^,]+,\s*EventTypes\.(\w+)/g)) addSymbol(m[1]!);
    for (const m of src.matchAll(/\.append\([^,]+,\s*"([^"]+)"/g)) found.add(m[1]!);
    for (const m of src.matchAll(/emitEvent\([^,]+,\s*"([^"]+)"/g)) found.add(m[1]!);
    // Hook listeners forward arbitrary types from hooks; only hook.* are catalogue-listed.
    for (const m of src.matchAll(/onEvent:\s*\(type,\s*payload\)\s*=>\s*void\s+logEvent/g)) void m;
  }
  return found;
}

describe("shipped event catalogue", () => {
  test("catalogue includes the admitted-prompt canonical event (24 shipped types)", () => {
    expect(SHIPPED_EVENT_CATALOGUE).toHaveLength(24);
    expect(new Set(SHIPPED_EVENT_CATALOGUE).size).toBe(24);
  });

  test("reserved message.delta is not in the shipped catalogue", () => {
    expect(RESERVED_UNEMITTED_EVENT_TYPES).toContain(EventTypes.messageDelta);
    expect(SHIPPED_EVENT_CATALOGUE).not.toContain(EventTypes.messageDelta);
  });

  test("every emitter references only catalogue types", () => {
    const allowed = new Set(SHIPPED_EVENT_CATALOGUE);
    const emitted = collectEmittedTypes(EMITTER_SOURCES);
    const unknown = [...emitted].filter((t) => !allowed.has(t)).sort();
    expect(unknown).toEqual([]);
  });

  test("every catalogue entry is emitted somewhere", () => {
    const emitted = collectEmittedTypes(EMITTER_SOURCES);
    const missing = SHIPPED_EVENT_CATALOGUE.filter((t) => !emitted.has(t)).sort();
    expect(missing).toEqual([]);
  });
});

describe("RC-18 shipped → hz.* mapping", () => {
  test("canonical catalogue is exactly 44 names", () => {
    expect(HZ_CANONICAL_EVENTS).toHaveLength(44);
    expect(new Set(HZ_CANONICAL_EVENTS).size).toBe(44);
  });

  test("every shipped type has exactly one map row", () => {
    expect(SHIPPED_TO_HZ_MAP.map((r) => r.shipped).sort()).toEqual([...SHIPPED_EVENT_CATALOGUE].sort());
  });

  test("every mapped hz name is in the canonical 44", () => {
    const allowed = new Set(HZ_CANONICAL_EVENTS);
    const bad: string[] = [];
    for (const row of SHIPPED_TO_HZ_MAP) {
      for (const h of row.hz) if (!allowed.has(h)) bad.push(h);
    }
    expect(bad).toEqual([]);
  });

  test("separates shipped event names, canonical mappings, equivalence, and literal hz.* emission", () => {
    const coverage = hzEventCoverageReport();
    expect(coverage.canonicalTotal).toBe(44);
    expect(coverage.shippedTypes).toBe(24);
    expect(coverage.mappedCanonicalNames).toHaveLength(21);
    expect(coverage.unmappedCanonicalNames).toHaveLength(23);
    expect(coverage.equivalentCanonicalNames).toHaveLength(10);
    expect(coverage.literalCanonicalEmitted).toEqual([
      "hz.session.prompt.admitted",
      "hz.effect.settled", "hz.effect.unknown", "hz.effect.reconciled",
    ]);
    expect(coverage.mappedCanonicalNames.length + coverage.unmappedCanonicalNames.length).toBe(44);
    expect(coverage.mappedCanonicalNames.length).toBeGreaterThan(coverage.literalCanonicalEmitted.length);
    expect(coverage.equivalentCanonicalNames.length + coverage.subsetOnlyCanonicalNames.length)
      .toBe(coverage.mappedCanonicalNames.length);
    expect(coverage.unmappedCanonicalNames).toEqual(unimplementedHzEvents());
    // A mapped legacy alias is not claimed as a directly emitted hz.* row.
    expect(coverage.literalCanonicalEmitted).not.toContain("hz.step.started");
  });

  test("unimplementedHzEvents excludes covered names", () => {
    const unimplemented = new Set(unimplementedHzEvents());
    for (const row of SHIPPED_TO_HZ_MAP) {
      for (const h of row.hz) expect(unimplemented.has(h)).toBe(false);
    }
    expect(unimplemented.size).toBeGreaterThan(0);
  });
});

