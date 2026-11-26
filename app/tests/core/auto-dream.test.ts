import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  acquireAutoDreamLock,
  autoDreamEnabled,
  autoDreamLockPath,
  buildStartupMemoryMap,
  DEFAULT_MIN_ELAPSED_MS,
  DEFAULT_MIN_SESSIONS,
  maybeScheduleAutoDream,
  normalizeRelativeDates,
  runAutoDream,
  shouldRunAutoDream,
  STARTUP_MEMORY_MAP_MAX_LINES,
  verifyFactFilePaths,
  writeAutoDreamState,
  type SessionSignalTurn,
} from "../../src/core/memory/auto-dream";
import {
  applyMemoryDeltas,
  listMemoryFacts,
  rememberMemoryFact,
  type MemoryDelta,
} from "../../src/core/memory/store";
import { MEMORY_FILE } from "../../src/core/memory/manifest";
import { stateRoot } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

const roots: string[] = [];
const envRestore = { ...process.env };

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in envRestore)) delete process.env[key];
  }
  Object.assign(process.env, envRestore);
});

function makeWorkspace(prefix = "hz-autodream-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe("Auto-Dream Dual-Gate Trigger", () => {
  test("blocks when <24h elapsed OR <5 sessions; fires only when BOTH met", () => {
    const ws = makeWorkspace();
    const t0 = Date.parse("2026-11-20T00:00:00.000Z");
    writeAutoDreamState(ws, {
      lastDreamAtMs: t0,
      lastDreamAtIso: new Date(t0).toISOString(),
      sessionsConsolidated: 5,
    });

    // Neither met (<24h and <5 sessions)
    const neither = shouldRunAutoDream(ws, {
      nowMs: t0 + 12 * 60 * 60 * 1000,
      sessionsSinceLastDream: 2,
      env: {},
    });
    expect(neither.shouldRun).toBe(false);
    expect(neither.reason).toBe("both_gates");

    // Elapsed met (>=24h), sessions NOT met (<5)
    const sessionsShort = shouldRunAutoDream(ws, {
      nowMs: t0 + DEFAULT_MIN_ELAPSED_MS,
      sessionsSinceLastDream: DEFAULT_MIN_SESSIONS - 1,
      env: {},
    });
    expect(sessionsShort.shouldRun).toBe(false);
    expect(sessionsShort.reason).toBe("session_gate");

    // Sessions met (>=5), elapsed NOT met (<24h)
    const elapsedShort = shouldRunAutoDream(ws, {
      nowMs: t0 + DEFAULT_MIN_ELAPSED_MS - 1_000,
      sessionsSinceLastDream: DEFAULT_MIN_SESSIONS,
      env: {},
    });
    expect(elapsedShort.shouldRun).toBe(false);
    expect(elapsedShort.reason).toBe("elapsed_gate");

    // Both met -> eligible!
    const bothMet = shouldRunAutoDream(ws, {
      nowMs: t0 + DEFAULT_MIN_ELAPSED_MS,
      sessionsSinceLastDream: DEFAULT_MIN_SESSIONS,
      env: {},
    });
    expect(bothMet.shouldRun).toBe(true);
    expect(bothMet.reason).toBe("eligible");
  });

  test("respects HZ_AUTO_DREAM=0 opt-out across gate, runner, and scheduler", () => {
    const ws = makeWorkspace();
    const env = { HZ_AUTO_DREAM: "0" };
    expect(autoDreamEnabled(env)).toBe(false);

    const gate = shouldRunAutoDream(ws, {
      nowMs: Date.now(),
      lastDreamAtMs: 0,
      sessionsSinceLastDream: 10,
      env,
    });
    expect(gate.shouldRun).toBe(false);
    expect(gate.reason).toBe("disabled");

    const res = runAutoDream(ws, {
      force: true,
      sessionsSinceLastDream: 10,
      env,
    });
    expect(res.ran).toBe(false);
    expect(res.skippedReason).toBe("disabled");

    const handle = maybeScheduleAutoDream(ws, { env, delayMs: 1 });
    expect(handle.scheduled).toBe(false);
    handle.cancel();
  });

  test("counts real sessions from SessionStore when sessionsSinceLastDream is omitted", () => {
    const ws = makeWorkspace();
    const store = new SessionStore(ws);
    try {
      for (let i = 0; i < 5; i += 1) {
        store.createSession(`Session ${i + 1}`);
      }
    } finally {
      store.close();
    }
    const gate = shouldRunAutoDream(ws, {
      nowMs: Date.now() + DEFAULT_MIN_ELAPSED_MS,
      lastDreamAtMs: 0,
      env: {},
    });
    expect(gate.sessionsSinceLastDream).toBe(5);
    expect(gate.shouldRun).toBe(true);
  });
});

describe("Auto-Dream Exclusive Lockfile Contention & Stale Recovery", () => {
  test("second concurrent caller skips cleanly while lock is held by live process", () => {
    const ws = makeWorkspace();
    const nowMs = Date.parse("2026-11-26T10:00:00.000Z");

    const lock = acquireAutoDreamLock(ws, { nowMs, isAlive: () => true });
    expect(lock.acquired).toBe(true);
    expect(existsSync(autoDreamLockPath(ws))).toBe(true);

    try {
      const concurrent = runAutoDream(ws, {
        nowMs,
        lastDreamAtMs: 0,
        sessionsSinceLastDream: 6,
        env: {},
        lockOptions: { isAlive: () => true },
      });
      expect(concurrent.ran).toBe(false);
      expect(concurrent.skippedReason).toBe("locked");
      expect(concurrent.lockHolderPid).toBe(process.pid);
    } finally {
      if (lock.acquired) lock.release();
    }

    expect(existsSync(autoDreamLockPath(ws))).toBe(false);
  });

  test("reclaims stale lock from dead PID and cleans up after run", () => {
    const ws = makeWorkspace();
    const lockPath = autoDreamLockPath(ws);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const nowMs = Date.parse("2026-11-26T10:00:00.000Z");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, token: "dead-token", acquiredAtMs: nowMs - 1_000 }) + "\n",
    );

    const res = runAutoDream(ws, {
      nowMs,
      lastDreamAtMs: 0,
      sessionsSinceLastDream: 5,
      env: {},
      turns: [],
      lockOptions: { isAlive: (pid) => pid === process.pid },
    });
    expect(res.ran).toBe(true);
    expect(res.reclaimedStaleLock).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("Auto-Dream Relative -> Absolute ISO-8601 Date Normalization", () => {
  test("normalizes relative phrases anchored to session timestamp", () => {
    const anchor = "2026-11-26T14:30:00.000Z";
    expect(normalizeRelativeDates("Deployed hotfix today", anchor)).toBe(
      "Deployed hotfix 2026-11-26",
    );
    expect(normalizeRelativeDates("Migrated DB yesterday and tested 3 days ago", anchor)).toBe(
      "Migrated DB 2026-11-25 and tested 2026-11-23",
    );
    expect(normalizeRelativeDates("Release cut last week, next check tomorrow", anchor)).toBe(
      "Release cut 2026-11-19, next check 2026-11-27",
    );
    expect(normalizeRelativeDates("Budget finalized last month for this year", anchor)).toBe(
      "Budget finalized 2026-10 for 2026",
    );
  });
});

describe("Auto-Dream Dead File Path Verification & Pruning", () => {
  test("verifies against git ls-files and prunes facts referencing deleted files", () => {
    const ws = makeWorkspace("hz-autodream-git-");
    mkdirSync(path.join(ws, "src"), { recursive: true });
    writeFileSync(path.join(ws, "src", "alive.ts"), "export const alive = true;\n");
    writeFileSync(path.join(ws, "src", "deleted.ts"), "export const gone = true;\n");

    const gitInit = Bun.spawnSync(["git", "init"], { cwd: ws, stdout: "ignore", stderr: "ignore" });
    expect(gitInit.exitCode).toBe(0);
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: ws });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: ws });
    Bun.spawnSync(["git", "add", "src/alive.ts", "src/deleted.ts"], { cwd: ws });
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: ws, stdout: "ignore", stderr: "ignore" });

    // Seed two facts: one for alive.ts, one for deleted.ts
    rememberMemoryFact(ws, "runtime: entry point lives in src/alive.ts");
    rememberMemoryFact(ws, "legacy: helper lives in src/deleted.ts");

    // Delete src/deleted.ts from repo & disk
    Bun.spawnSync(["git", "rm", "src/deleted.ts"], { cwd: ws, stdout: "ignore", stderr: "ignore" });

    const res = runAutoDream(ws, {
      nowMs: Date.parse("2026-11-26T15:00:00.000Z"),
      lastDreamAtMs: 0,
      sessionsSinceLastDream: 6,
      env: {},
      turns: [],
    });
    expect(res.ran).toBe(true);
    expect(res.deltas?.some((d) => d.op === "DELETE" && d.text.includes("src/deleted.ts"))).toBe(true);

    const remaining = listMemoryFacts(ws).map((f) => f.content);
    expect(remaining).toContain("runtime: entry point lives in src/alive.ts");
    expect(remaining.some((c) => c.includes("src/deleted.ts"))).toBe(false);
  });

  test("falls back to filesystem stat when workspace is not a git repo", () => {
    const ws = makeWorkspace("hz-autodream-nogit-");
    mkdirSync(path.join(ws, "app", "src"), { recursive: true });
    writeFileSync(path.join(ws, "app", "src", "real.ts"), "export {};\n");

    const ok = verifyFactFilePaths(ws, "Check app/src/real.ts for config");
    expect(ok.valid).toBe(true);
    expect(ok.referenced).toEqual(["app/src/real.ts"]);

    const missing = verifyFactFilePaths(ws, "Check app/src/ghost.ts for config");
    expect(missing.valid).toBe(false);
    expect(missing.missing).toEqual(["app/src/ghost.ts"]);
  });
});

describe("Auto-Dream Itemized SQLite Deltas (No Monolithic Rewrite)", () => {
  test("applies UPSERT, SUPERSEDE, and DELETE atomically without rewriting MEMORY.md", () => {
    const ws = makeWorkspace();
    const root = stateRoot(ws);
    mkdirSync(root, { recursive: true });
    const originalMemoryMd = "# Curated MEMORY.md\n- Do not overwrite this monolithic file\n";
    writeFileSync(path.join(root, MEMORY_FILE), originalMemoryMd);

    mkdirSync(path.join(ws, "src"), { recursive: true });
    writeFileSync(path.join(ws, "src", "live.ts"), "export const ok = 1;\n");

    // Existing facts: one to keep untouched, one to supersede by key, one referencing dead file to delete
    rememberMemoryFact(ws, "untouched: keep this fact intact");
    rememberMemoryFact(ws, "build tool: use npm run build");
    rememberMemoryFact(ws, "obsolete: remove src/missing-file.ts");

    const turns: SessionSignalTurn[] = [
      {
        sessionId: "s-1",
        role: "user",
        timestampIso: "2026-11-26T12:00:00.000Z",
        content: [
          "build tool: switched to bun run build today",
          "decision: pin SQLite journal in src/live.ts yesterday",
          "decision: broken ref in src/does-not-exist.ts",
        ].join("\n"),
      },
    ];

    const res = runAutoDream(ws, {
      nowMs: Date.parse("2026-11-26T15:00:00.000Z"),
      lastDreamAtMs: 0,
      sessionsSinceLastDream: 5,
      env: {},
      turns,
    });

    expect(res.ran).toBe(true);
    expect(res.deltas).toBeDefined();
    expect(res.deltas!.some((d) => d.op === "DELETE" && d.text.includes("src/missing-file.ts"))).toBe(true);
    expect(res.deltas!.some((d) => d.op === "SUPERSEDE" && d.key === "build tool")).toBe(true);
    expect(res.deltas!.some((d) => d.op === "UPSERT" && d.text.includes("2026-11-25"))).toBe(true);

    expect(res.applied?.deleted).toBe(1);
    expect(res.applied?.superseded).toBe(1);
    expect(res.applied?.upserted).toBe(1);

    const facts = listMemoryFacts(ws).map((f) => f.content);
    expect(facts).toContain("untouched: keep this fact intact");
    expect(facts).toContain("build tool: switched to bun run build 2026-11-26");
    expect(facts).toContain("decision: pin SQLite journal in src/live.ts 2026-11-25");
    expect(facts.some((c) => c.includes("npm run build"))).toBe(false);
    expect(facts.some((c) => c.includes("src/missing-file.ts"))).toBe(false);
    expect(facts.some((c) => c.includes("src/does-not-exist.ts"))).toBe(false);

    // Monolithic MEMORY.md must remain byte-identical (never rewritten)
    expect(readFileSync(path.join(root, MEMORY_FILE), "utf8")).toBe(originalMemoryMd);
  });

  test("respects HZ_R170_SQLITE_BARRIER=1 on delta writes", () => {
    const ws = makeWorkspace();
    const store = new SessionStore(ws);
    process.env.HZ_R170_SQLITE_BARRIER = "1";
    store.setReconcileBarrierCheck(() => ({
      blocked: true,
      unresolvedCount: 1,
      unresolvedIds: ["eff_1"],
      reason: "test barrier active",
    }));

    const deltas: MemoryDelta[] = [
      { op: "UPSERT", key: "k", text: "k: value", reason: "test" },
    ];
    try {
      expect(() => applyMemoryDeltas(ws, deltas)).toThrow(/barrier|reconcile/i);
    } finally {
      store.close();
    }
  });
});

describe("Auto-Dream Phase 4 Startup Memory Map (<= 200 lines)", () => {
  test("strictly caps startup memory map at <= 200 lines and omits superseded facts", () => {
    const ws = makeWorkspace();
    const baseMs = Date.parse("2026-11-26T00:00:00.000Z");
    const facts = [];
    // Add 240 distinct active facts
    for (let i = 0; i < 240; i += 1) {
      facts.push({
        id: `id-${String(i).padStart(4, "0")}`,
        bank: "project" as const,
        content: `topic_${String(i).padStart(3, "0")}: active fact number ${i}`,
        storedAtMs: baseMs + i * 1000,
      });
    }
    // Add an older superseded fact with duplicate key `topic_239`
    facts.push({
      id: "id-old-239",
      bank: "project" as const,
      content: "topic_239: stale superseded version",
      storedAtMs: baseMs - 10_000,
    });

    const map = buildStartupMemoryMap(ws, { facts, topics: ["architecture.md"] });
    const lines = map.content.split("\n");

    expect(map.lineCount).toBeLessThanOrEqual(STARTUP_MEMORY_MAP_MAX_LINES);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(lines.length).toBe(map.lineCount);
    expect(map.supersededCount).toBe(1);
    expect(map.totalActiveFacts).toBe(240);
    expect(map.truncated).toBe(true);
    expect(map.content).toContain("topic_239: active fact number 239");
    expect(map.content).not.toContain("stale superseded version");
  });
});

describe("Auto-Dream Non-Blocking Idle Hook", () => {
  test("maybeScheduleAutoDream returns immediately and executes in background", async () => {
    const ws = makeWorkspace();
    let completed = false;
    const t0 = performance.now();
    const handle = maybeScheduleAutoDream(ws, {
      delayMs: 10,
      nowMs: Date.parse("2026-11-26T15:00:00.000Z"),
      lastDreamAtMs: 0,
      sessionsSinceLastDream: 5,
      env: {},
      turns: [],
      onComplete: (res) => {
        completed = res.ran;
      },
    });
    const elapsed = performance.now() - t0;
    expect(handle.scheduled).toBe(true);
    expect(elapsed).toBeLessThan(50);

    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.cancel();
    expect(completed).toBe(true);
  });
});
