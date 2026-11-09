/**
 * durability-perms.test.ts — state durability under a hostile filesystem:
 * owner-only modes for every state store and the spawn ledger's torn-tail rule.
 *
 * docs/03 D12: kernel/app state is owner-only. Every store here is created in a
 * temp path, then its mode is read back with `statSync` — the tests do not trust
 * the mode argument passed to the create call, because umask can strip it. The
 * mode assertions are Unix-only (skipped on win32; the implementation guards the
 * chmods the same way).
 *
 * The spawn-ledger half pins the crash shape the audit confirmed: a single torn
 * trailing line (no terminating newline) must be skipped with `torn: true` while
 * the intact earlier rows survive and the file is NOT quarantined; genuine
 * mid-file corruption still quarantines the whole ledger.
 *
 * The last section reproduces the audit's orphan scenario: a ledger append that
 * fails on a read-only state dir must take the NON-detached child's whole tree
 * down (a bare proc.kill leaves grandchildren with ppid 1), and the error must
 * still surface.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { curate, proposalsFilePath } from "../../src/core/curator";
import { kernelStateDir, readSpawnLedger, spawnLedgerPath, spawnOwned } from "../../src/core/owned-spawn";
import { planToolOutputCap, writeSpillFile } from "../../src/core/output-budget";
import { postmortemPath, postmortemsDir, recordPostmortem } from "../../src/core/postmortem";
import { SessionStore } from "../../src/core/session";
import { loadHistory, rememberHistory } from "../../src/tui/interactive";
import { cleanupTemps, permissionBitsBind, tempDir } from "./helpers";

afterAll(cleanupTemps);

const onUnix = process.platform !== "win32";

/** Permission bits of a path (the tests' only way to observe a mode). */
function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

/* ------------------------------ session store ------------------------------ */

describe.skipIf(!onUnix)("session state permissions", () => {
  test("the state dir is 0700 and hzcode.db 0600 on create, and a loose pair is tightened on reopen", () => {
    const workspace = tempDir("hz-perm-session-");
    const first = new SessionStore(workspace);
    const stateDir = path.dirname(first.dbPath);
    try {
      first.createSession("forces a WAL write");
      expect(modeOf(stateDir)).toBe(0o700);
      expect(modeOf(first.dbPath)).toBe(0o600);
      const wal = `${first.dbPath}-wal`;
      if (existsSync(wal)) expect(modeOf(wal)).toBe(0o600);
    } finally {
      first.close();
    }

    // An older store left loose: the next open is the site that tightens it.
    chmodSync(first.dbPath, 0o644);
    chmodSync(stateDir, 0o755);
    const reopened = new SessionStore(workspace);
    try {
      expect(modeOf(stateDir)).toBe(0o700);
      expect(modeOf(reopened.dbPath)).toBe(0o600);
      reopened.createSession("brings any sidecar back");
      const wal = `${reopened.dbPath}-wal`;
      if (existsSync(wal)) expect(modeOf(wal)).toBe(0o600);
    } finally {
      reopened.close();
    }
  });
});

/* --------------------------------- spills --------------------------------- */

describe.skipIf(!onUnix)("spill permissions", () => {
  test("an over-cap spill lands under a 0700 dir as a 0600 file; a loose spill is tightened on the next plan", () => {
    const workspace = tempDir("hz-perm-spill-");
    const spillDir = path.join(workspace, ".hz", "state", "spills");
    const full = "spill me\n".repeat(200);

    const plan = planToolOutputCap(full, { maxBytes: 64, maxTokens: 16, spillDir });
    const file = plan.spill?.file ?? "";
    expect(file.startsWith(spillDir + path.sep)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(full); // the full output, not the cap
    expect(modeOf(spillDir)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);

    // A loose spill is tightened the next time the plan touches it, bytes intact.
    chmodSync(file, 0o644);
    const again = planToolOutputCap(full, { maxBytes: 64, maxTokens: 16, spillDir });
    expect(again.spill?.file).toBe(file);
    expect(modeOf(file)).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(full); // never rewritten
  });

  test("writeSpillFile never throws on an existing spill and keeps the first bytes", () => {
    const dir = tempDir("hz-perm-spill2-");
    const file = path.join(dir, "sub", "hash.txt");
    writeSpillFile({ file, contents: "full text" });
    expect(modeOf(path.dirname(file))).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);

    writeSpillFile({ file, contents: "other text" }); // same name = same text by construction
    expect(readFileSync(file, "utf8")).toBe("full text");
    expect(modeOf(file)).toBe(0o600);
  });
});

/* ------------------------------- spawn ledger ------------------------------- */

function ledgerRow(label: string): string {
  return JSON.stringify({ pid: 4242, pgid: 4242, birthIdentity: "4242@1", label, ts: "2026-01-02T03:04:05.006Z", cmd: "echo x" });
}

function corruptFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".corrupt-"));
}

describe("spawn ledger durability", () => {
  test("a clean ledger reads with every row and no torn/corrupt flags", async () => {
    const stateDir = tempDir("hz-ledger-valid-");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(spawnLedgerPath(stateDir), `${ledgerRow("first")}\n${ledgerRow("second")}\n`, "utf8");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(false);
    expect(read.torn).toBeUndefined();
    expect(read.entries.map((entry) => entry.label)).toEqual(["first", "second"]);
    expect(read.quarantinedTo).toBeUndefined();
  });

  test("a torn trailing line is skipped (torn: true), earlier rows survive, the file is NOT renamed", async () => {
    const stateDir = tempDir("hz-ledger-torn-");
    mkdirSync(stateDir, { recursive: true });
    const file = spawnLedgerPath(stateDir);
    const torn = '{"pid": 7777, "pgid": 7777, "birthIdentity": "7';
    writeFileSync(file, `${ledgerRow("kept")}\n${torn}`, "utf8");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(false);
    expect(read.torn).toBe(true);
    expect(read.entries.map((entry) => entry.label)).toEqual(["kept"]);
    // The torn bytes stay where the crash left them — skip, never rename.
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`${ledgerRow("kept")}\n${torn}`);
    expect(corruptFiles(stateDir)).toEqual([]);
  });

  test("a torn tail that parses but is not a spawn row is skipped too", async () => {
    const stateDir = tempDir("hz-ledger-torn-shape-");
    mkdirSync(stateDir, { recursive: true });
    const file = spawnLedgerPath(stateDir);
    writeFileSync(file, `${ledgerRow("kept")}\n{"pid": "not-a-number"}`, "utf8");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(false);
    expect(read.torn).toBe(true);
    expect(read.entries.map((entry) => entry.label)).toEqual(["kept"]);
    expect(existsSync(file)).toBe(true);
  });

  test("mid-file garbage still quarantines the whole ledger", async () => {
    const stateDir = tempDir("hz-ledger-mid-");
    mkdirSync(stateDir, { recursive: true });
    const file = spawnLedgerPath(stateDir);
    writeFileSync(file, `${ledgerRow("gone")}\nnot json at all\n${ledgerRow("also-gone")}\n`, "utf8");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(true);
    expect(read.entries).toEqual([]);
    expect(read.quarantinedTo).toBeDefined();
    const quarantined = read.quarantinedTo as string;
    expect(path.basename(quarantined)).toMatch(/^spawns\.jsonl\.corrupt-\d+$/);
    expect(existsSync(file)).toBe(false);
    // The bytes are preserved for inspection — quarantined, never dropped.
    expect(readFileSync(quarantined, "utf8")).toContain("not json at all");
  });

  test("a malformed line the writer DID terminate with a newline is not a torn append", async () => {
    const stateDir = tempDir("hz-ledger-newline-");
    mkdirSync(stateDir, { recursive: true });
    const file = spawnLedgerPath(stateDir);
    writeFileSync(file, `${ledgerRow("kept")}\nnot a complete append\n`, "utf8");

    const read = await readSpawnLedger(stateDir);
    expect(read.corrupt).toBe(true);
    expect(read.entries).toEqual([]);
    expect(read.torn).toBeUndefined();
    expect(existsSync(file)).toBe(false); // quarantined exactly as before
  });

  test("empty and missing ledgers are empty and healthy — never torn, never quarantined", async () => {
    const stateDir = tempDir("hz-ledger-empty-");
    mkdirSync(stateDir, { recursive: true });
    expect(await readSpawnLedger(stateDir)).toEqual({ entries: [], corrupt: false });

    writeFileSync(spawnLedgerPath(stateDir), "", "utf8");
    expect(await readSpawnLedger(stateDir)).toEqual({ entries: [], corrupt: false });
  });
});

describe.skipIf(!onUnix)("spawn ledger permissions", () => {
  test("spawnOwned creates the state dir 0700 and spawns.jsonl 0600, tightening a loose ledger on append", async () => {
    const workspace = tempDir("hz-perm-spawn-");
    const stateDir = kernelStateDir(workspace);
    const stdio = { stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;

    const first = await spawnOwned(["true"], { stateDir, label: "perms:first", stdio, longLived: false });
    await first.proc.exited;
    const file = spawnLedgerPath(stateDir);
    expect(modeOf(stateDir)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);

    // An existing loose ledger is tightened by the next append, which still appends.
    chmodSync(file, 0o644);
    chmodSync(stateDir, 0o755);
    const second = await spawnOwned(["true"], { stateDir, label: "perms:second", stdio, longLived: false });
    await second.proc.exited;
    expect(modeOf(stateDir)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);
    expect(readFileSync(file, "utf8").split("\n").filter((line) => line !== "").length).toBe(2);
  });
});

/* --------------------- spawn failure kills the whole tree --------------------- */

/** True while the pid exists (a zombie still counts); false when it is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pids whose /proc/<pid>/cmdline is exactly `command`. The test uses a
 * distinctive sleep duration so a concurrent test file's own children cannot
 * be mistaken for ours.
 */
function pidsWithCommandLine(command: string): number[] {
  const found: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8")
        .split("\0")
        .filter((part) => part !== "")
        .join(" ");
      if (cmdline === command) found.push(Number.parseInt(entry, 10));
    } catch {
      /* the process exited while we read it */
    }
  }
  return found;
}

// The failure-path kill walks /proc (Linux); elsewhere it degrades to the child only.
const hasProc = existsSync("/proc/self/stat");

// The ledger-append failure is induced with a read-only state dir: needs binding permission bits.
describe.skipIf(!hasProc || !permissionBitsBind)("spawn failure kills non-detached descendants", () => {
  test("a ledger-append failure kills the child AND its grandchildren, and still surfaces the error", async () => {
    const workspace = tempDir("hz-kill-tree-");
    const stateDir = kernelStateDir(workspace);
    mkdirSync(stateDir, { recursive: true });
    // A read-only (and trivially undoable) state dir: the ledger append fails EACCES.
    chmodSync(stateDir, 0o500);

    let failure: Error | undefined;
    try {
      await spawnOwned(["sh", "-c", "sleep 297 & sleep 297"], {
        stateDir,
        label: "test:grandchildren",
        stdio: { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        longLived: false, // non-detached: the audit's orphan shape
      });
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
    } finally {
      chmodSync(stateDir, 0o700); // undo the read-only setup before cleanup
    }

    // The refusal still surfaces, and it names the child it killed.
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("cannot write the spawn ledger");
    expect(failure?.message).toContain("child killed");
    const childPid = Number.parseInt(/pid (\d+)/.exec(failure?.message ?? "")?.[1] ?? "", 10);
    expect(Number.isInteger(childPid) && childPid > 0, `error must name the child pid: ${failure?.message}`).toBe(true);

    // Poll up to 2 s: neither the child nor any `sleep 297` descendant survives
    // (pre-fix, the grandchild reparented to init and stayed alive here).
    const deadline = Date.now() + 2000;
    const survivors = (): number[] => [childPid, ...pidsWithCommandLine("sleep 297")].filter(alive);
    while (Date.now() < deadline && survivors().length > 0) await wait(25);
    const escaped = survivors();
    // Fail loudly, but never leave an escapee behind: one live `sleep 297`
    // would poison every later run (and is exactly the bug under test).
    for (const pid of escaped) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* raced away */
      }
    }
    expect(escaped).toEqual([]);
    // The failed append never produced a row.
    expect(existsSync(spawnLedgerPath(stateDir))).toBe(false);
  }, 10000);
});

/* ------------------------------- post-mortems ------------------------------- */

describe.skipIf(!onUnix)("post-mortem permissions", () => {
  test("recordPostmortem creates the dir 0700 and each record 0600, and tightens a loose dir", async () => {
    const stateDir = tempDir("hz-perm-pm-");
    const record = await recordPostmortem({
      stateDir,
      sessionId: "sess-perms",
      terminal: "failed",
      transcript: "raw log text",
      failureClass: "unknown",
      now: 1_760_000_000_000,
    });
    expect(modeOf(postmortemsDir(stateDir))).toBe(0o700);
    expect(modeOf(postmortemPath(stateDir, record.id))).toBe(0o600);

    // A dir that was left loose is tightened by the next record.
    chmodSync(postmortemsDir(stateDir), 0o755);
    await recordPostmortem({
      stateDir,
      sessionId: "sess-perms-2",
      terminal: "failed",
      transcript: "raw log text",
      failureClass: "unknown",
      now: 1_760_000_000_001,
    });
    expect(modeOf(postmortemsDir(stateDir))).toBe(0o700);
  });
});

/* --------------------------------- curator --------------------------------- */

const CURATOR_PROPOSAL = {
  kind: "memory" as const,
  title: "Hash stored rows canonically",
  body: "Keep stored digests byte-stable by hashing the canonical JSON of the stored row.",
  evidence: ["src/core/canon.ts"],
  reads: [] as string[],
};

describe.skipIf(!onUnix)("curator permissions", () => {
  test("curate creates proposals.jsonl 0600 in an 0700 state dir and tightens a loose pair on the next call", () => {
    const stateDir = tempDir("hz-perm-curator-");
    const first = curate([CURATOR_PROPOSAL], { stateDir, transcriptIds: [], now: () => "2026-01-02T03:04:05.006Z" });
    expect(first.appended.length).toBe(1);
    const file = proposalsFilePath(stateDir);
    expect(modeOf(stateDir)).toBe(0o700);
    expect(modeOf(file)).toBe(0o600);

    chmodSync(file, 0o644);
    chmodSync(stateDir, 0o755);
    const second = curate([{ ...CURATOR_PROPOSAL, title: "A second stored lesson" }], {
      stateDir,
      transcriptIds: [],
      now: () => "2026-01-02T03:04:05.007Z",
    });
    expect(second.appended.length).toBe(1);
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(stateDir)).toBe(0o700);
  });
});

/* ------------------------------- history file ------------------------------- */

describe.skipIf(!onUnix)("interactive history permissions", () => {
  test("rememberHistory writes 0600 and tightens a loose file; loadHistory tightens on open", () => {
    const file = path.join(tempDir("hz-perm-history-"), "history");
    rememberHistory(file, "first entry");
    expect(modeOf(file)).toBe(0o600);

    chmodSync(file, 0o644);
    rememberHistory(file, "second entry");
    expect(modeOf(file)).toBe(0o600);

    // A loose history file is tightened when the next run loads it.
    chmodSync(file, 0o644);
    const rl = { history: [] as string[] } as unknown as Parameters<typeof loadHistory>[1];
    loadHistory(file, rl);
    expect(modeOf(file)).toBe(0o600);
    expect((rl as unknown as { history: string[] }).history).toEqual(["second entry", "first entry"]);
  });
});
