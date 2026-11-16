import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import {
  AppendOnlyLog,
  chatMessageDigest,
  freezeStablePrefix,
  longestStablePrefixLength,
  PROVIDER_SYNC_CAPABILITIES,
  ProviderHistorySync,
  resolveHistorySyncGate,
  stablePrefixFingerprint,
  stablePrefixMatches,
  syncForkedHistory,
  syncMessages,
} from "../../src/core/sync-messages";

function msg(
  role: ChatMsg["role"],
  content: string,
  extra?: Partial<ChatMsg>,
): ChatMsg {
  return { role, content, ...extra };
}

describe("chatMessageDigest", () => {
  test("equal wire fields share a digest across object identity", () => {
    const a = msg("user", "hello");
    const b = msg("user", "hello");
    expect(a).not.toBe(b);
    expect(chatMessageDigest(a)).toBe(chatMessageDigest(b));
  });

  test("content or role drift changes the digest", () => {
    const base = msg("user", "hello");
    expect(chatMessageDigest(base)).not.toBe(chatMessageDigest(msg("user", "HELLO")));
    expect(chatMessageDigest(base)).not.toBe(chatMessageDigest(msg("assistant", "hello")));
  });

  test("tool fields participate in the digest", () => {
    const withId = msg("tool", "ok", { toolCallId: "c1", toolName: "read" });
    const otherId = msg("tool", "ok", { toolCallId: "c2", toolName: "read" });
    expect(chatMessageDigest(withId)).not.toBe(chatMessageDigest(otherId));
  });
});

describe("longestStablePrefixLength", () => {
  test("empty histories yield 0", () => {
    expect(longestStablePrefixLength([], [])).toBe(0);
    expect(longestStablePrefixLength([msg("user", "a")], [])).toBe(0);
    expect(longestStablePrefixLength([], [msg("user", "a")])).toBe(0);
  });

  test("full match returns the shared length", () => {
    const prev = [msg("user", "a"), msg("assistant", "b")];
    const next = [msg("user", "a"), msg("assistant", "b")];
    expect(longestStablePrefixLength(prev, next)).toBe(2);
  });

  test("stops at the first digest mismatch", () => {
    const prev = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    const next = [msg("user", "a"), msg("assistant", "B"), msg("user", "c")];
    expect(longestStablePrefixLength(prev, next)).toBe(1);
  });
});

describe("syncMessages", () => {
  test("identical histories are a no-op kind and reuse previous objects", () => {
    const previous = [msg("user", "a"), msg("assistant", "b")];
    const desired = [msg("user", "a"), msg("assistant", "b")];
    const synced = syncMessages(previous, desired);
    expect(synced.kind).toBe("identical");
    expect(synced.stablePrefixLength).toBe(2);
    expect(synced.messages).toHaveLength(2);
    expect(synced.messages[0]).toBe(previous[0]);
    expect(synced.messages[1]).toBe(previous[1]);
  });

  test("pure append keeps the prior prefix and attaches the new tail", () => {
    const previous = [msg("user", "a")];
    const desired = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    const synced = syncMessages(previous, desired);
    expect(synced.kind).toBe("append");
    expect(synced.stablePrefixLength).toBe(1);
    expect(synced.messages[0]).toBe(previous[0]);
    expect(synced.messages.slice(1)).toEqual(desired.slice(1));
  });

  test("in-place rewrite truncates to the longest byte-stable prefix", () => {
    const previous = [
      msg("user", "stable"),
      msg("assistant", "old"),
      msg("user", "tail"),
    ];
    const desired = [
      msg("user", "stable"),
      msg("assistant", "new"),
      msg("user", "tail-2"),
    ];
    const synced = syncMessages(previous, desired);
    expect(synced.kind).toBe("rewrite");
    expect(synced.stablePrefixLength).toBe(1);
    expect(synced.messages[0]).toBe(previous[0]);
    expect(synced.messages[1]).toEqual(desired[1]);
    expect(synced.messages[2]).toEqual(desired[2]);
    expect(synced.messages).toHaveLength(3);
  });

  test("compaction that preserves a prefix truncates then replays the shorter desired", () => {
    const previous = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
    ];
    const desired = [msg("user", "a"), msg("assistant", "summary")];
    const synced = syncMessages(previous, desired);
    expect(synced.kind).toBe("rewrite");
    expect(synced.stablePrefixLength).toBe(1);
    expect(synced.messages).toEqual([previous[0], desired[1]]);
  });

  test("true compact: desired is a byte-stable prefix of previous", () => {
    const previous = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    const desired = [msg("user", "a"), msg("assistant", "b")];
    const synced = syncMessages(previous, desired);
    expect(synced.kind).toBe("compact");
    expect(synced.stablePrefixLength).toBe(2);
    expect(synced.messages[0]).toBe(previous[0]);
    expect(synced.messages[1]).toBe(previous[1]);
    expect(synced.messages).toHaveLength(2);
  });

  test("full divergence truncates to empty prefix and takes desired wholesale", () => {
    const previous = [msg("user", "old")];
    const desired = [msg("user", "new"), msg("assistant", "x")];
    const synced = syncMessages(previous, desired);
    expect(synced.kind).toBe("rewrite");
    expect(synced.stablePrefixLength).toBe(0);
    expect(synced.messages).toEqual(desired);
  });

  test("does not mutate inputs", () => {
    const previous = [msg("user", "a"), msg("assistant", "b")];
    const desired = [msg("user", "a"), msg("assistant", "B")];
    const prevCopy = previous.map((m) => ({ ...m }));
    const desCopy = desired.map((m) => ({ ...m }));
    syncMessages(previous, desired);
    expect(previous).toEqual(prevCopy);
    expect(desired).toEqual(desCopy);
  });
});

describe("syncForkedHistory", () => {
  test("truncates to keep via syncMessages compact kind", () => {
    const parent = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    const synced = syncForkedHistory(parent, 2);
    expect(synced.kind).toBe("compact");
    expect(synced.stablePrefixLength).toBe(2);
    expect(synced.messages[0]).toBe(parent[0]);
    expect(synced.messages[1]).toBe(parent[1]);
    expect(synced.messages).toHaveLength(2);
  });

  test("keep beyond length is a no-op identical sync", () => {
    const parent = [msg("user", "a")];
    const synced = syncForkedHistory(parent, 99);
    expect(synced.kind).toBe("identical");
    expect(synced.messages).toHaveLength(1);
    expect(synced.messages[0]).toBe(parent[0]);
  });
});

describe("ProviderHistorySync", () => {
  test("preserves prefix object identity across append then rewrite", () => {
    const cursor = new ProviderHistorySync();
    const first = [msg("user", "a"), msg("assistant", "b")];
    const r1 = cursor.sync(first);
    expect(r1.kind).toBe("append");
    expect(r1.messages[0]).toBe(first[0]);

    const appended = [msg("user", "a"), msg("assistant", "b"), msg("user", "steer")];
    const r2 = cursor.sync(appended);
    expect(r2.kind).toBe("append");
    expect(r2.messages[0]).toBe(first[0]);
    expect(r2.messages[1]).toBe(first[1]);
    expect(r2.messages[2]).toBe(appended[2]);

    // Divergent rewrite of an earlier turn:
    const diverged = [msg("user", "a"), msg("assistant", "CHANGED"), msg("user", "tail")];
    const r3 = cursor.sync(diverged);
    expect(r3.kind).toBe("rewrite");
    expect(r3.stablePrefixLength).toBe(1);
    expect(r3.messages[0]).toBe(first[0]);
    expect(r3.messages[1]).toEqual(diverged[1]);
  });

  test("seed then sync appends from the seeded prefix", () => {
    const cursor = new ProviderHistorySync();
    const seeded = [msg("user", "forked"), msg("assistant", "ok")];
    cursor.seed(seeded);
    expect(cursor.last()?.kind).toBe("identical");
    const next = [...seeded, msg("user", "continue")];
    const r = cursor.sync(next);
    expect(r.kind).toBe("append");
    expect(r.messages[0]).toBe(seeded[0]);
    expect(r.messages[1]).toBe(seeded[1]);
  });
});

describe("frozen StablePrefix (B-5 / 489)", () => {
  test("fingerprint is a stable canonical sha256 over system+tools", () => {
    const a = stablePrefixFingerprint({ system: "S", tools: [{ name: "read" }] });
    const b = stablePrefixFingerprint({ system: "S", tools: [{ name: "read" }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(stablePrefixFingerprint({ system: "S2", tools: [{ name: "read" }] }));
    expect(a).not.toBe(stablePrefixFingerprint({ system: "S", tools: [{ name: "write" }] }));
  });

  test("freeze is immutable and matches only the same system+tools", () => {
    const prefix = freezeStablePrefix("S", [{ name: "read" }, { name: "grep" }]);
    expect(Object.isFrozen(prefix)).toBe(true);
    expect(Object.isFrozen(prefix.tools)).toBe(true);
    expect(prefix.toolCount).toBe(2);
    expect(stablePrefixMatches(prefix, "S", [{ name: "read" }, { name: "grep" }])).toBe(true);
    expect(stablePrefixMatches(prefix, "S", [{ name: "read" }])).toBe(false);
    expect(stablePrefixMatches(prefix, "CHANGED", [{ name: "read" }, { name: "grep" }])).toBe(false);
  });
});

describe("per-provider gate from data (B-5 / 489)", () => {
  test("auto reads the local capability table — no live calls", () => {
    expect(resolveHistorySyncGate("anthropic", { env: {} })).toBe("on");
    expect(resolveHistorySyncGate("ollama", { env: {} })).toBe("off");
    // Unknown provider keeps the harmless local optimization.
    expect(resolveHistorySyncGate("some-new-host", { env: {} })).toBe("on");
    expect(PROVIDER_SYNC_CAPABILITIES["ollama"]?.prefixCaching).toBe(false);
  });

  test("injected local data drives auto; env overrides", () => {
    const caps = { vendorx: { prefixCaching: false }, vendory: { prefixCaching: true } };
    expect(resolveHistorySyncGate("vendorx", { env: {}, capabilities: caps })).toBe("off");
    expect(resolveHistorySyncGate("vendory", { env: {}, capabilities: caps })).toBe("on");
    expect(resolveHistorySyncGate("vendorx", { env: { HZ_HISTORY_SYNC: "on" }, capabilities: caps })).toBe("on");
    expect(resolveHistorySyncGate("anthropic", { env: { HZ_HISTORY_SYNC: "off" } })).toBe("off");
  });
});

describe("AppendOnlyLog (B-5 / 489)", () => {
  test("keeps the byte-stable prefix and appends the tail", () => {
    const log = new AppendOnlyLog();
    const first = [msg("user", "a"), msg("assistant", "b")];
    const r1 = log.sync(first);
    expect(r1.messages[0]).toBe(first[0]);
    const next = [...first, msg("user", "c")];
    const r2 = log.sync(next);
    expect(r2.kind).toBe("append");
    expect(r2.messages[0]).toBe(first[0]);
    expect(r2.messages[2]).toBe(next[2]);
    expect(log.messages()).toHaveLength(3);
  });

  test("frozen prefix drift invalidates the whole log and rebuilds from empty", () => {
    const prefix = freezeStablePrefix("S", [{ name: "read" }]);
    const log = new AppendOnlyLog({ stablePrefix: prefix });
    const first = [msg("user", "a"), msg("assistant", "b")];
    log.sync(first, { system: "S", tools: [{ name: "read" }] });
    expect(log.prefixInvalidations()).toBe(0);

    const drifted = log.sync([msg("user", "a2"), msg("assistant", "b")], {
      system: "S",
      tools: [{ name: "write" }],
    });
    expect(drifted.prefixInvalidated).toBe(true);
    expect(drifted.stablePrefixLength).toBe(0);
    expect(drifted.messages[0]).not.toBe(first[0]);
    expect(log.prefixInvalidations()).toBe(1);
  });

  test("disabled gate passes desired through as fresh copies (no reuse)", () => {
    const log = new AppendOnlyLog({ enabled: false });
    const first = [msg("user", "a")];
    const r1 = log.sync(first);
    expect(r1.messages[0]).not.toBe(first[0]);
    const next = [...first, msg("user", "c")];
    const r2 = log.sync(next);
    expect(r2.messages[0]).not.toBe(r1.messages[0]);
    expect(r2.messages).toEqual(next);
  });
});

describe("ProviderHistorySync gate + prefix wiring (B-5 / 489)", () => {
  test("resolved off gate disables prefix reuse but keeps the sync API", () => {
    const cursor = new ProviderHistorySync({ gate: "off" });
    expect(cursor.gate()).toBe("off");
    const first = [msg("user", "a")];
    const r1 = cursor.sync(first);
    expect(r1.messages[0]).not.toBe(first[0]);
    expect(cursor.last()?.kind).toBe("rewrite");
  });

  test("currentPrefix callback invalidates the cursor on system/tools drift", () => {
    let system = "S";
    const cursor = new ProviderHistorySync({
      gate: "on",
      stablePrefix: freezeStablePrefix("S", [{ name: "read" }]),
      currentPrefix: () => ({ system, tools: [{ name: "read" }] }),
    });
    const first = [msg("user", "a")];
    cursor.sync(first);
    expect(cursor.prefixInvalidations()).toBe(0);
    system = "CHANGED";
    const r = cursor.sync([msg("user", "a2")]);
    expect(cursor.prefixInvalidations()).toBe(1);
    expect(r.messages[0]).not.toBe(first[0]);
  });
});
