/**
 * diagnostics-ledger.test.ts — the context de-charge contract for diagnostics.
 *
 * `diagnosticIdentity` collapses a `file:line:col ` prefix so the same problem
 * at a shifted location is one identity; `DiagnosticsLedger.reduce` returns only
 * fresh messages per (instance, file) and replaces the seen-set with the current
 * identities, so a diagnostic that vanishes and returns is fresh again. These
 * tests fail if the identity-strip or the fresh-only/replace logic is reverted.
 */

import { expect, test } from "bun:test";
import { DiagnosticsLedger, diagnosticIdentity } from "../../src/core/diagnostics-ledger";

test("diagnosticIdentity strips the file:line:col prefix and collapses location", () => {
  expect(diagnosticIdentity("src/a.ts:12:5 Type 'string' is not assignable to 'number'")).toBe(
    "Type 'string' is not assignable to 'number'",
  );
  // A message without a location prefix is returned unchanged.
  const bare = "unterminated string literal";
  expect(diagnosticIdentity(bare)).toBe(bare);
  // Two messages that differ ONLY by line:col map to the same identity.
  const a = diagnosticIdentity("src/a.ts:12:5 Cannot find name 'foo'");
  const b = diagnosticIdentity("src/a.ts:88:1 Cannot find name 'foo'");
  expect(a).toBe(b);
  expect(a).toBe("Cannot find name 'foo'");
});

test("reduce returns all messages on first sight, none on a repeat", () => {
  const ledger = new DiagnosticsLedger();
  const first = ["src/a.ts:1:1 err one", "src/a.ts:2:1 err two"];
  expect(ledger.reduce("/abs/a.ts", first)).toEqual(first);
  // Same messages again: nothing fresh, even if the line:col shifted.
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:9:4 err one", "src/a.ts:30:2 err two"])).toEqual([]);
});

test("reduce surfaces only newly-appearing messages and suppresses seen ones", () => {
  const ledger = new DiagnosticsLedger();
  ledger.reduce("/abs/a.ts", ["src/a.ts:1:1 alpha"]);
  // alpha is still present (suppressed); beta is new (surfaced as given).
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:1:1 alpha", "src/a.ts:5:1 beta"])).toEqual([
    "src/a.ts:5:1 beta",
  ]);
});

test("a diagnostic that disappears then reappears is fresh again (seen-set replaced, not unioned)", () => {
  const ledger = new DiagnosticsLedger();
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:1:1 gamma"])).toEqual(["src/a.ts:1:1 gamma"]);
  // gamma gone, only delta present: the seen-set becomes {delta}.
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:2:1 delta"])).toEqual(["src/a.ts:2:1 delta"]);
  // gamma reappears: it is no longer in the seen-set, so it is fresh again.
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:3:1 gamma"])).toEqual(["src/a.ts:3:1 gamma"]);
});

test("an empty current set clears the file entry so the next sighting is fresh", () => {
  const ledger = new DiagnosticsLedger();
  ledger.reduce("/abs/a.ts", ["src/a.ts:1:1 epsilon"]);
  // The file is now clean: empty input clears the entry.
  expect(ledger.reduce("/abs/a.ts", [])).toEqual([]);
  // The same message returns: it is fresh because the entry was cleared.
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:7:2 epsilon"])).toEqual(["src/a.ts:7:2 epsilon"]);
});

test("two different files keep independent seen-sets", () => {
  const ledger = new DiagnosticsLedger();
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:1:1 shared"])).toEqual(["src/a.ts:1:1 shared"]);
  // The same identity in a different file is fresh for that file.
  expect(ledger.reduce("/abs/b.ts", ["src/b.ts:1:1 shared"])).toEqual(["src/b.ts:1:1 shared"]);
  // And a.ts still suppresses its own seen identity.
  expect(ledger.reduce("/abs/a.ts", ["src/a.ts:4:1 shared"])).toEqual([]);
});
