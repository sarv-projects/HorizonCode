/**
 * checkpoints.test.ts — the durable checkpoint store and the rewind plan.
 *
 * Checkpoints are the change journal's companion (the substrate landed in
 * tools/change-journal.ts): a checkpoint names the journal entry ids one turn
 * created, and rewindPlan names the live entries that came after it. These
 * tests pin both halves:
 *
 *   - the FILE: append-only JSONL, a torn tail skipped and reported (intact
 *     rows kept, no quarantine), corruption quarantined with its bytes
 *     preserved and the store restarted empty, a simulated restart seeing what
 *     a previous process wrote, owner-only modes, and the view cap;
 *   - the PLAN: only live entries newer than the checkpoint, minus the
 *     checkpoint's own changes; tombstoned entries gone; non-restorable
 *     entries flagged and named but never applied; newest-first and
 *     byte-stable; a typed refusal when the journal cannot be verified; and
 *     that planning writes nothing at all.
 *
 * Hermetic: every case runs in a temp workspace, and both stores are reset per
 * test so each case starts exactly like a fresh process.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "../../src/contracts";
import {
  __resetCheckpointsForTests,
  MAX_CHECKPOINTS,
  changesSince,
  checkpointByNumber,
  checkpointNumber,
  checkpointPath,
  checkpointViews,
  listCheckpoints,
  recordCheckpoint,
  rewindPlan,
} from "../../src/core/checkpoints";
import {
  __resetJournalForTests,
  consumeEntry,
  journalPath,
  recordChange,
  reloadFromDisk,
  type ChangeEntry,
} from "../../src/tools/change-journal";
import { cleanupTemps, tempDir } from "./helpers";

beforeEach(() => {
  __resetJournalForTests();
  __resetCheckpointsForTests();
});

afterAll(() => {
  cleanupTemps();
});

/* -------------------------------- helpers -------------------------------- */

/** A journal entry whose path+rel let recordChange derive `ws` as its workspace. */
function change(
  ws: string,
  rel: string,
  opts: {
    id: string;
    at: number;
    before?: string | null;
    sessionId?: string;
    nonRestorable?: boolean;
    beforeUnreadable?: boolean;
  },
): ChangeEntry {
  return {
    id: opts.id,
    at: opts.at,
    sessionId: opts.sessionId ?? "cp-session",
    path: path.join(ws, rel),
    rel,
    before: opts.before === undefined ? "old\n" : opts.before,
    ...(opts.nonRestorable === true ? { nonRestorable: true } : {}),
    ...(opts.beforeUnreadable === true ? { beforeUnreadable: true } : {}),
    afterSha256: sha256Hex(`after-${opts.id}`),
    tool: "write",
  };
}

/** The live journal entry with this id; fails the test loudly when it is gone. */
function entryById(ws: string, id: string): ChangeEntry {
  const entry = reloadFromDisk(ws).entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`test setup: no live journal entry ${id}`);
  return entry;
}

function quarantinedCheckpointFiles(ws: string): string[] {
  try {
    return readdirSync(path.dirname(checkpointPath(ws))).filter((name) => name.startsWith("checkpoints.jsonl.corrupt-"));
  } catch {
    return [];
  }
}

function quarantinedJournalFiles(ws: string): string[] {
  try {
    return readdirSync(path.dirname(journalPath(ws))).filter((name) => name.startsWith("undo.jsonl.corrupt-"));
  } catch {
    return [];
  }
}

/* ------------------------------ the store ------------------------------ */

describe("the checkpoint store", () => {
  test("record + list round-trips across a simulated reload", () => {
    const ws = tempDir("hz-checkpoints-");
    const first = recordCheckpoint(ws, "sess-a", 4, ["e1", "e2"], { label: "after turn 1", now: 1000, id: "cp-1" });
    const second = recordCheckpoint(ws, "sess-a", 9, ["e3"], { label: "after turn 2", now: 2000 });

    expect(first).toEqual({ id: "cp-1", at: 1000, sessionId: "sess-a", messageIndex: 4, label: "after turn 1", changes: ["e1", "e2"] });
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.at).toBe(2000);

    const file = checkpointPath(ws);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0] as string)).toEqual(first);
    expect(JSON.parse(lines[1] as string)).toEqual(second);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }

    __resetCheckpointsForTests(); // a fresh process: read what the file holds
    const load = listCheckpoints(ws);
    expect(load.corrupt).toBe(false);
    expect(load.torn).toBeUndefined();
    expect(load.checkpoints).toEqual([second, first]); // newest first
  });

  test("duplicate journal ids fold away and the default label is empty", () => {
    const ws = tempDir("hz-checkpoints-");
    const record = recordCheckpoint(ws, "sess", 0, ["e1", "e1", "e2", "e1"], { now: 5 });

    expect(record.changes).toEqual(["e1", "e2"]);
    expect(record.label).toBe("");
    __resetCheckpointsForTests();
    expect(listCheckpoints(ws).checkpoints[0]?.changes).toEqual(["e1", "e2"]);
  });

  test("invalid input is refused typed, and nothing lands on disk", () => {
    const ws = tempDir("hz-checkpoints-");

    expect(() => recordCheckpoint(ws, "", 0, [])).toThrow("sessionId");
    expect(() => recordCheckpoint(ws, "s", -1, [])).toThrow("messageIndex");
    expect(() => recordCheckpoint(ws, "s", 0, ["ok", ""])).toThrow("journal entry ids");
    expect(() => recordCheckpoint(ws, "s", 0, [], { now: Number.NaN })).toThrow("now must be a finite");
    expect(() => recordCheckpoint(ws, "s", 0, [], { label: 7 as unknown as string })).toThrow("label must be a string");

    expect(existsSync(checkpointPath(ws))).toBe(false);
  });

  test("a torn tail is skipped and reported, and the intact rows are kept", () => {
    const ws = tempDir("hz-checkpoints-");
    recordCheckpoint(ws, "s", 1, ["e1"], { label: "kept", now: 10 });
    appendFileSync(checkpointPath(ws), '{"id":"torn-partial"', "utf8"); // crash mid-append
    __resetCheckpointsForTests();

    const load = listCheckpoints(ws);
    expect(load.torn).toBe(true);
    expect(load.corrupt).toBe(false);
    expect(load.checkpoints.map((c) => c.label)).toEqual(["kept"]);
    expect(quarantinedCheckpointFiles(ws)).toEqual([]);
    expect(existsSync(checkpointPath(ws))).toBe(true);
  });

  test("a file that is only a torn line reads empty and torn, never corrupt", () => {
    const ws = tempDir("hz-checkpoints-");
    mkdirSync(path.dirname(checkpointPath(ws)), { recursive: true });
    writeFileSync(checkpointPath(ws), '{"id":"torn', "utf8");
    __resetCheckpointsForTests();

    const load = listCheckpoints(ws);
    expect(load.checkpoints).toEqual([]);
    expect(load.torn).toBe(true);
    expect(load.corrupt).toBe(false);
  });

  test("a corrupt file is quarantined with its bytes, and the store restarts empty", () => {
    const ws = tempDir("hz-checkpoints-");
    mkdirSync(path.dirname(checkpointPath(ws)), { recursive: true });
    writeFileSync(checkpointPath(ws), "this is not a checkpoint\n", "utf8");
    __resetCheckpointsForTests();

    const load = listCheckpoints(ws);
    expect(load.corrupt).toBe(true);
    expect(load.checkpoints).toEqual([]); // never read as "no checkpoints"
    expect(load.reason).toContain("not JSON");
    expect(load.quarantinedTo).toBeDefined();
    expect(readFileSync(load.quarantinedTo as string, "utf8")).toBe("this is not a checkpoint\n");
    expect(quarantinedCheckpointFiles(ws).length).toBe(1);
    expect(existsSync(checkpointPath(ws))).toBe(false);

    // A fresh process sees the restarted store as empty and healthy...
    __resetCheckpointsForTests();
    const empty = listCheckpoints(ws);
    expect(empty.corrupt).toBe(false);
    expect(empty.checkpoints).toEqual([]);

    // ...and the store records and lists again.
    const record = recordCheckpoint(ws, "s", 1, ["e1"], { label: "after", now: 5 });
    const again = listCheckpoints(ws);
    expect(again.corrupt).toBe(false);
    expect(again.checkpoints).toEqual([record]);
  });

  test("a bad line in the middle of the file quarantines, it is not skipped as torn", () => {
    const ws = tempDir("hz-checkpoints-");
    const one = recordCheckpoint(ws, "s", 1, [], { label: "one", now: 1 });
    const two = recordCheckpoint(ws, "s", 2, [], { label: "two", now: 2 });
    const file = checkpointPath(ws);
    writeFileSync(file, `${JSON.stringify(one)}\nnot json\n${JSON.stringify(two)}\n`, "utf8");
    __resetCheckpointsForTests();

    const load = listCheckpoints(ws);
    expect(load.corrupt).toBe(true);
    expect(load.checkpoints).toEqual([]);
    expect(load.reason).toContain("line 2");
  });

  test("checkpoints with the same timestamp list the later append first", () => {
    const ws = tempDir("hz-checkpoints-");
    const first = recordCheckpoint(ws, "s", 1, [], { label: "first", now: 7 });
    const second = recordCheckpoint(ws, "s", 2, [], { label: "second", now: 7 });

    const load = listCheckpoints(ws);
    expect(load.checkpoints.map((c) => c.id)).toEqual([second.id, first.id]);
  });

  test("a legacy .hzcode workspace keeps its checkpoints there", () => {
    const ws = tempDir("hz-checkpoints-legacy-");
    mkdirSync(path.join(ws, ".hzcode"));

    recordCheckpoint(ws, "s", 1, ["e1"], { label: "legacy", now: 5 });
    expect(existsSync(path.join(ws, ".hzcode", "checkpoints.jsonl"))).toBe(true);
    expect(existsSync(path.join(ws, ".hz", "state", "checkpoints.jsonl"))).toBe(false);
    expect(checkpointPath(ws)).toBe(path.join(ws, ".hzcode", "checkpoints.jsonl"));

    __resetCheckpointsForTests();
    expect(listCheckpoints(ws).checkpoints.map((c) => c.label)).toEqual(["legacy"]);
  });

  test("the view cap keeps the newest records", () => {
    const ws = tempDir("hz-checkpoints-cap-");
    for (let i = 0; i < MAX_CHECKPOINTS + 3; i += 1) {
      recordCheckpoint(ws, "s", i, [], { label: `cp-${i}`, now: i });
    }

    const load = listCheckpoints(ws);
    expect(load.checkpoints.length).toBe(MAX_CHECKPOINTS);
    expect(load.checkpoints[0]?.label).toBe(`cp-${MAX_CHECKPOINTS + 2}`);
    expect(load.checkpoints.some((c) => c.label === "cp-0")).toBe(false);
  });
});

/* ------------------------------ numbering ------------------------------ */

describe("numbering and views", () => {
  test("newest is 1; the number, the view and the record always agree", () => {
    const ws = tempDir("hz-checkpoints-numbers-");
    const older = recordCheckpoint(ws, "s", 1, ["e1"], { label: "older", now: 1000 });
    const newer = recordCheckpoint(ws, "s", 2, ["e2"], { label: "newer", now: 2000 });
    const load = listCheckpoints(ws);

    expect(checkpointNumber(0)).toBe(1);
    expect(checkpointNumber(9)).toBe(10);
    expect(checkpointNumber(-1)).toBe(0);
    expect(checkpointNumber(Number.NaN)).toBe(0);

    const views = checkpointViews(load.checkpoints);
    expect(views.map((v) => v.n)).toEqual([1, 2]);
    expect(views.map((v) => v.label)).toEqual(["newer", "older"]);
    expect(views[0]?.changes).toEqual(["e2"]);

    expect(checkpointByNumber(load, 1)?.id).toBe(newer.id);
    expect(checkpointByNumber(load, 2)?.id).toBe(older.id);
    expect(checkpointByNumber(load, 0)).toBeUndefined();
    expect(checkpointByNumber(load, 3)).toBeUndefined();
  });
});

/* ------------------------------ changesSince ------------------------------ */

describe("changesSince", () => {
  test("filters live entries by time and session, carrying the read status", () => {
    const ws = tempDir("hz-checkpoints-since-");
    recordChange("s1", change(ws, "a.txt", { id: "e-a", at: 100, sessionId: "s1" }));
    recordChange("s1", change(ws, "b.txt", { id: "e-b", at: 200, sessionId: "s1" }));
    recordChange("s2", change(ws, "c.txt", { id: "e-c", at: 300, sessionId: "s2" }));

    const all = changesSince(ws, 200);
    expect(all.corrupt).toBe(false);
    expect(all.entries.map((e) => e.id)).toEqual(["e-b", "e-c"]);

    const mine = changesSince(ws, 0, "s1");
    expect(mine.entries.map((e) => e.id)).toEqual(["e-a", "e-b"]);

    consumeEntry(ws, entryById(ws, "e-b"));
    const afterUndo = changesSince(ws, 0);
    expect(afterUndo.entries.map((e) => e.id)).toEqual(["e-a", "e-c"]);
  });
});

/* -------------------------------- the plan -------------------------------- */

describe("rewindPlan", () => {
  test("targets only live entries newer than the checkpoint, minus its own changes", () => {
    const ws = tempDir("hz-checkpoints-plan-");
    recordChange("s", change(ws, "before.txt", { id: "e-before", at: 100, before: "before-0\n" }));
    recordChange("s", change(ws, "edge.txt", { id: "e-edge", at: 150, before: "edge-0\n" }));
    recordChange("s", change(ws, "own.txt", { id: "e-own", at: 160, before: "own-0\n" }));
    recordChange("s", change(ws, "target.txt", { id: "e-target", at: 200, before: "target-0\n" }));
    recordChange("s", change(ws, "undone.txt", { id: "e-undone", at: 250, before: "undone-0\n" }));
    recordChange("s", change(ws, "late.txt", { id: "e-late", at: 300, before: "late-0\n" }));
    const checkpoint = recordCheckpoint(ws, "s", 2, ["e-own"], { label: "after its own change", now: 150 });
    consumeEntry(ws, entryById(ws, "e-undone"));

    const plan = rewindPlan(ws, checkpoint.id);
    expect(plan.refusal).toBeUndefined();
    expect(plan.checkpoint?.id).toBe(checkpoint.id);
    // `at` is an inclusive boundary; the checkpoint's own change (e-own, at
    // 160) is excluded even though it is newer; the consumed entry is gone.
    expect(plan.restores.map((r) => r.entryId)).toEqual(["e-late", "e-target", "e-edge"]);
    expect(plan.restores.every((r) => r.restorable)).toBe(true);
    expect(plan.restores[0]).toEqual({
      path: path.join(ws, "late.txt"),
      rel: "late.txt",
      before: "late-0\n",
      entryId: "e-late",
      restorable: true,
    });
    expect(plan.skipped).toEqual([]);
  });

  test("same-millisecond entries keep append order, newest first", () => {
    const ws = tempDir("hz-checkpoints-ties-");
    recordChange("s", change(ws, "first.txt", { id: "e-1", at: 500, before: "1\n" }));
    recordChange("s", change(ws, "second.txt", { id: "e-2", at: 500, before: "2\n" }));
    const checkpoint = recordCheckpoint(ws, "s", 0, [], { now: 100 });

    const plan = rewindPlan(ws, checkpoint.id);
    expect(plan.restores.map((r) => r.entryId)).toEqual(["e-2", "e-1"]);
  });

  test("an entry whose before was not kept is flagged and named, never applied", () => {
    const ws = tempDir("hz-checkpoints-skips-");
    recordChange("s", change(ws, "ok.txt", { id: "e-ok", at: 200, before: "ok-0\n" }));
    recordChange("s", change(ws, "big.txt", { id: "e-big", at: 300, before: null, nonRestorable: true }));
    recordChange("s", change(ws, "bin.txt", { id: "e-bin", at: 400, before: null, beforeUnreadable: true }));
    recordChange("s", change(ws, "created.txt", { id: "e-created", at: 500, before: null }));
    const checkpoint = recordCheckpoint(ws, "s", 0, [], { now: 100 });

    const plan = rewindPlan(ws, checkpoint.id);
    expect(plan.refusal).toBeUndefined();
    expect(plan.restores.map((r) => [r.entryId, r.restorable])).toEqual([
      ["e-created", false],
      ["e-bin", false],
      ["e-big", false],
      ["e-ok", true],
    ]);
    expect(plan.skipped.map((s) => [s.entryId, s.reason])).toEqual([
      ["e-created", "created"],
      ["e-bin", "beforeUnreadable"],
      ["e-big", "nonRestorable"],
    ]);
    // Nothing moved: planning never restores, never tombstones.
    expect(reloadFromDisk(ws).entries.map((e) => e.id)).toEqual(["e-ok", "e-big", "e-bin", "e-created"]);
  });

  test("an unknown checkpoint refuses typed instead of planning", () => {
    const ws = tempDir("hz-checkpoints-unknown-");
    recordCheckpoint(ws, "s", 0, [], { label: "one", now: 1 });

    const plan = rewindPlan(ws, "no-such-checkpoint");
    expect(plan.checkpoint).toBeUndefined();
    expect(plan.refusal).toContain("no checkpoint no-such-checkpoint");
    expect(plan.restores).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  test("a corrupt checkpoint store refuses with the quarantine clause", () => {
    const ws = tempDir("hz-checkpoints-corrupt-store-");
    mkdirSync(path.dirname(checkpointPath(ws)), { recursive: true });
    writeFileSync(checkpointPath(ws), "garbage\n");
    __resetCheckpointsForTests();

    const plan = rewindPlan(ws, "anything");
    expect(plan.refusal).toContain("no checkpoint anything");
    expect(plan.refusal).toContain("moved aside");
    expect(plan.restores).toEqual([]);
  });

  test("a corrupt journal refuses typed, and its bytes survive the quarantine", () => {
    const ws = tempDir("hz-checkpoints-corrupt-journal-");
    recordChange("s", change(ws, "a.txt", { id: "e-a", at: 100, before: "a-0\n" }));
    const checkpoint = recordCheckpoint(ws, "s", 0, [], { now: 50 });
    writeFileSync(journalPath(ws), "this is not a journal\n");
    __resetJournalForTests();

    const plan = rewindPlan(ws, checkpoint.id);
    expect(plan.checkpoint?.id).toBe(checkpoint.id);
    expect(plan.refusal).toContain("change journal is unreadable");
    expect(plan.refusal).toContain("cannot be verified");
    expect(plan.restores).toEqual([]);
    expect(plan.skipped).toEqual([]);
    const kept = quarantinedJournalFiles(ws);
    expect(kept.length).toBe(1);
    expect(readFileSync(path.join(path.dirname(journalPath(ws)), kept[0] as string), "utf8")).toBe("this is not a journal\n");
  });

  test("identical inputs give byte-identical plans, and planning writes nothing", () => {
    const ws = tempDir("hz-checkpoints-stable-");
    recordChange("s", change(ws, "a.txt", { id: "e-a", at: 100, before: "a-0\n" }));
    recordChange("s", change(ws, "b.txt", { id: "e-b", at: 200, before: "b-0\n" }));
    const checkpoint = recordCheckpoint(ws, "s", 1, ["e-a"], { label: "stable", now: 150 });

    const journalBefore = readFileSync(journalPath(ws), "utf8");
    const checkpointsBefore = readFileSync(checkpointPath(ws), "utf8");
    const once = JSON.stringify(rewindPlan(ws, checkpoint.id));
    const twice = JSON.stringify(rewindPlan(ws, checkpoint.id));

    expect(twice).toBe(once);
    expect(readFileSync(journalPath(ws), "utf8")).toBe(journalBefore);
    expect(readFileSync(checkpointPath(ws), "utf8")).toBe(checkpointsBefore);
    expect(reloadFromDisk(ws).entries.map((e) => e.id)).toEqual(["e-a", "e-b"]);
  });
});
