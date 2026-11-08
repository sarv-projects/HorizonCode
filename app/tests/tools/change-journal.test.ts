/**
 * change-journal.test.ts -- the durable workspace journal at the module level:
 * appended records and consume tombstones, the per-entry content cap, the
 * live-entry cap, torn tails, quarantine-on-corruption and atomic compaction.
 *
 * Every fixture is its own workspace, so the journal file lives under that
 * fixture's state root (`<ws>/.hz/state/undo.jsonl` canonical, or
 * `<ws>/.hzcode/undo.jsonl` for a legacy workspace -- paths.ts owns the rule).
 */

import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BEFORE_MAX_BYTES,
  JOURNAL_COMPACT_BYTES,
  MAX_JOURNAL_ENTRIES,
  __resetJournalForTests,
  consumeChange,
  consumeEntry,
  journalPath,
  journalSize,
  lastChange,
  lastChangeFor,
  recordChange,
  reloadFromDisk,
  type ChangeEntry,
} from "../../src/tools/change-journal";
import { makeWorkspace } from "./helpers";

/** A synthetic entry for a file inside `ws`, with a deterministic hash. */
function synthetic(ws: string, rel: string, before: string | null = "old\n", at = Date.now()): ChangeEntry {
  return {
    path: path.join(ws, rel),
    rel,
    before,
    afterSha256: `sha256:${rel}:${String(at)}`,
    at,
    tool: "write",
  };
}

function rawLines(ws: string): string[] {
  return readFileSync(journalPath(ws), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

describe("change-journal", () => {
  test("recordChange appends a whole owner-only record under the state root", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "a.txt", null, 1000));
    const file = journalPath(ws);
    expect(file).toBe(path.join(ws, ".hz", "state", "undo.jsonl"));
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(rawLines(ws)[0] as string) as Record<string, unknown>;
    // The persisted shape and key order are the documented ones.
    expect(Object.keys(parsed)).toEqual(["id", "at", "sessionId", "path", "rel", "before", "afterSha256", "tool"]);
    expect(parsed).toMatchObject({
      at: 1000,
      sessionId: "s-one",
      path: path.join(ws, "a.txt"),
      rel: "a.txt",
      before: null,
      afterSha256: "sha256:a.txt:1000",
      tool: "write",
    });
    expect(typeof parsed.id).toBe("string");
    expect(lastChange("s-one")?.rel).toBe("a.txt");
    expect(lastChangeFor("s-one", path.join(ws, "a.txt"))?.at).toBe(1000);
    expect(journalSize("s-one")).toBe(1);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  test("a fresh journal instance re-reads the same live entries (restart)", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "a.txt", "one\n", 1000));
    recordChange("s-one", synthetic(ws, "b.txt", "two\n", 2000));
    __resetJournalForTests(); // no in-memory journal, no session binding
    const load = reloadFromDisk(ws);
    expect(load.corrupt).toBe(false);
    expect(load.torn).toBeUndefined();
    expect(load.entries.map((e) => e.rel)).toEqual(["a.txt", "b.txt"]);
    expect(load.entries.map((e) => e.sessionId)).toEqual(["s-one", "s-one"]);
    expect(lastChange("s-one")?.rel).toBe("b.txt");
    expect(lastChangeFor("s-one", path.join(ws, "a.txt"))?.before).toBe("one\n");
    expect(journalSize("s-one")).toBe(2);
  });

  test("the journal is shared by every session of the workspace", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "a.txt", null, 1000));
    // Another session sees the entry without having written anything itself.
    expect(lastChange("s-two")?.rel).toBe("a.txt");
    expect(journalSize("s-two")).toBe(1);
    const [entry] = reloadFromDisk(ws).entries;
    expect(consumeChange("s-two", entry as ChangeEntry)).toBe(true);
    expect(consumeChange("s-two", entry as ChangeEntry)).toBe(false); // already gone
    expect(journalSize("s-one")).toBe(0);
    __resetJournalForTests();
    expect(reloadFromDisk(ws).entries).toEqual([]);
  });

  test("a consume tombstone survives a reload and is written as {consume: id}", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "a.txt", null, 1000));
    recordChange("s-one", synthetic(ws, "b.txt", null, 2000));
    const first = reloadFromDisk(ws).entries[0] as ChangeEntry;
    expect(consumeEntry(ws, first)).toBe(true);
    const tombstones = rawLines(ws).map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => "consume" in row);
    expect(tombstones).toEqual([{ consume: first.id }]);
    __resetJournalForTests();
    expect(reloadFromDisk(ws).entries.map((e) => e.rel)).toEqual(["b.txt"]);
    expect(journalSize("s-one")).toBe(1);
  });

  test("the per-entry cap drops oversized content and marks it nonRestorable", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "big.txt", "x".repeat(BEFORE_MAX_BYTES + 1), 1000));
    recordChange("s-one", synthetic(ws, "at-cap.txt", "y".repeat(BEFORE_MAX_BYTES), 2000));
    const entries = reloadFromDisk(ws).entries;
    const big = entries.find((e) => e.rel === "big.txt");
    expect(big?.nonRestorable).toBe(true);
    expect(big?.before).toBeNull();
    expect(big?.afterSha256).toBe("sha256:big.txt:1000"); // the hash still records
    const atCap = entries.find((e) => e.rel === "at-cap.txt");
    expect(atCap?.nonRestorable).toBeUndefined();
    expect(atCap?.before?.length).toBe(BEFORE_MAX_BYTES);
    // The oversized bytes are nowhere in the file.
    expect(readFileSync(journalPath(ws), "utf8").length).toBeLessThan(BEFORE_MAX_BYTES + 2000);
  });

  test("the live set is capped at MAX_JOURNAL_ENTRIES, oldest evicted", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 25; i += 1) {
      recordChange("s-one", synthetic(ws, `f${String(i)}.txt`, "old\n", 1000 + i));
    }
    expect(journalSize("s-one")).toBe(MAX_JOURNAL_ENTRIES);
    expect(lastChange("s-one")?.rel).toBe(`f${String(MAX_JOURNAL_ENTRIES + 24)}.txt`);
    __resetJournalForTests();
    const entries = reloadFromDisk(ws).entries;
    expect(entries.length).toBe(MAX_JOURNAL_ENTRIES);
    expect(entries[0]?.rel).toBe("f25.txt"); // the 25 oldest were evicted
  });

  test("an oversized journal compacts atomically to its live entries", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    const big = 200_000;
    for (let i = 0; i < 12; i += 1) {
      recordChange("s-one", synthetic(ws, `big${String(i)}.txt`, "z".repeat(big), 1000 + i));
    }
    expect(statSync(journalPath(ws)).size).toBeGreaterThan(JOURNAL_COMPACT_BYTES);
    for (const entry of reloadFromDisk(ws).entries.slice(0, 6)) consumeEntry(ws, entry);
    // The next append folds the consumed records and tombstones away first.
    recordChange("s-one", synthetic(ws, "small.txt", "s\n", 9000));
    expect(statSync(journalPath(ws)).size).toBeLessThan(JOURNAL_COMPACT_BYTES);
    const text = readFileSync(journalPath(ws), "utf8");
    expect(text).not.toContain('"consume"');
    const entries = reloadFromDisk(ws).entries;
    expect(entries.map((e) => e.rel)).toEqual(["big6.txt", "big7.txt", "big8.txt", "big9.txt", "big10.txt", "big11.txt", "small.txt"]);
    // No temp file is left behind (the rewrite was a temp file + rename).
    expect(readdirSync(path.dirname(journalPath(ws)))).toEqual(["undo.jsonl"]);
  }, 30000);

  test("a torn final line is skipped and reported, never quarantined", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "a.txt", null, 1000));
    appendFileSync(journalPath(ws), '{"id":"torn-partial"', "utf8");
    __resetJournalForTests();
    const load = reloadFromDisk(ws);
    expect(load.torn).toBe(true);
    expect(load.corrupt).toBe(false);
    expect(load.entries.map((e) => e.rel)).toEqual(["a.txt"]);
    const quarantined = readdirSync(path.dirname(journalPath(ws))).filter((name) => name.includes("corrupt-"));
    expect(quarantined).toEqual([]);
  });

  test("a corrupt line is quarantined with its bytes kept, and the journal restarts empty", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "a.txt", null, 1000));
    writeFileSync(journalPath(ws), "this is not a journal\n");
    __resetJournalForTests();
    const load = reloadFromDisk(ws);
    expect(load.corrupt).toBe(true);
    expect(load.entries).toEqual([]);
    expect(load.torn).toBeUndefined();
    expect(load.reason).toContain("not JSON");
    expect(load.quarantinedTo).toBeDefined();
    const kept = load.quarantinedTo as string;
    expect(kept.startsWith(`${journalPath(ws)}.corrupt-`)).toBe(true);
    expect(existsSync(kept)).toBe(true);
    expect(readFileSync(kept, "utf8")).toBe("this is not a journal\n");
    expect(existsSync(journalPath(ws))).toBe(false);
    // A new record appends into a fresh file and the reader stays honest.
    recordChange("s-one", synthetic(ws, "b.txt", null, 2000));
    const after = reloadFromDisk(ws);
    expect(after.corrupt).toBe(false);
    expect(after.entries.map((e) => e.rel)).toEqual(["b.txt"]);
  });

  test("an unreadable journal is quarantined, not read as empty", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    mkdirSync(journalPath(ws), { recursive: true }); // a directory where the file belongs
    const load = reloadFromDisk(ws);
    expect(load.corrupt).toBe(true);
    expect(load.entries).toEqual([]);
    expect(load.quarantinedTo).toBeDefined();
    expect(load.reason).toContain("unreadable");
    expect(existsSync(load.quarantinedTo as string)).toBe(true);
    // The journal restarts empty and appends cleanly.
    recordChange("s-one", synthetic(ws, "a.txt", null, 1000));
    expect(reloadFromDisk(ws).entries.map((e) => e.rel)).toEqual(["a.txt"]);
  });

  test("an explicit id and sessionId from the caller are preserved", () => {
    const ws = makeWorkspace({});
    __resetJournalForTests();
    recordChange("caller-session", { ...synthetic(ws, "a.txt", null, 1000), id: "fixed-id", sessionId: "explicit" });
    const [entry] = reloadFromDisk(ws).entries;
    expect(entry?.id).toBe("fixed-id");
    expect(entry?.sessionId).toBe("explicit");
  });

  test("a legacy .hzcode workspace keeps its journal in place", () => {
    const ws = makeWorkspace({});
    mkdirSync(path.join(ws, ".hzcode"));
    __resetJournalForTests();
    recordChange("s-one", synthetic(ws, "a.txt", null, 1000));
    expect(journalPath(ws)).toBe(path.join(ws, ".hzcode", "undo.jsonl"));
    expect(existsSync(journalPath(ws))).toBe(true);
    expect(existsSync(path.join(ws, ".hz", "state", "undo.jsonl"))).toBe(false);
    __resetJournalForTests();
    expect(reloadFromDisk(ws).entries.map((e) => e.rel)).toEqual(["a.txt"]);
  });
});
