import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import {
  chatMessageDigest,
  longestStablePrefixLength,
  ProviderHistorySync,
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
