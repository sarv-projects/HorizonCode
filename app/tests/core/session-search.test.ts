/**
 * session-search.test.ts — FTS sidecar over titles + user prompts (docs/12 F8).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SessionStore } from "../../src/core/session";
import {
  searchSessions,
  sessionSearchDbPath,
  sessionSearchRankScore,
  upsertSessionSearch,
} from "../../src/core/session-search";
import { cleanupTemps, tempDir } from "./helpers";

let workspace = "";
let store: SessionStore;

beforeAll(() => {
  workspace = tempDir("hz-ws-session-search-");
  store = new SessionStore(workspace);
});

afterAll(() => {
  store?.close();
  cleanupTemps();
});

describe("session FTS sidecar", () => {
  test("append user prompts indexes and search returns snippet", () => {
    const a = store.createSession("Landlock fence");
    store.appendMessage(a.id, {
      role: "user",
      content: "please harden the landlock path fence for workspace-write",
    });
    const b = store.createSession("Unrelated");
    store.appendMessage(b.id, { role: "user", content: "what is the weather in Paris" });

    expect(existsSync(sessionSearchDbPath(workspace))).toBe(true);
    const hits = searchSessions(workspace, "landlock fence");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.sessionId).toBe(a.id);
    expect(hits[0]?.snippet.toLowerCase()).toContain("landlock");
    expect(hits.every((h) => h.sessionId !== b.id || h.title.includes("Landlock"))).toBe(true);
  });

  test("content_hash skip leaves identical upsert as no-op", () => {
    upsertSessionSearch(workspace, {
      sessionId: "manual-1",
      title: "t",
      updated: "2026-01-01T00:00:00.000Z",
      content: "alpha beta",
    });
    upsertSessionSearch(workspace, {
      sessionId: "manual-1",
      title: "t",
      updated: "2026-01-01T00:00:00.000Z",
      content: "alpha beta",
    });
    const hits = searchSessions(workspace, "alpha");
    expect(hits.some((h) => h.sessionId === "manual-1")).toBe(true);
  });

  test("empty query terms yield no matches", () => {
    expect(searchSessions(workspace, "   ")).toEqual([]);
    expect(searchSessions(workspace, '""')).toEqual([]);
  });

  test("recency boost prefers a newer session when BM25 is similar", () => {
    const base = "shared keyword corpus for ranking";
    const now = Date.now();
    const oldUpdated = new Date(now - 14 * 86_400_000).toISOString();
    const newUpdated = new Date(now - 86_400_000).toISOString();
    upsertSessionSearch(workspace, {
      sessionId: "recency-old",
      title: "old",
      updated: oldUpdated,
      content: base,
    });
    upsertSessionSearch(workspace, {
      sessionId: "recency-new",
      title: "new",
      updated: newUpdated,
      content: base,
    });
    const hits = searchSessions(workspace, "keyword corpus", 10);
    expect(hits[0]?.sessionId).toBe("recency-new");
    expect(sessionSearchRankScore(-1, newUpdated)).toBeLessThan(sessionSearchRankScore(-1, oldUpdated));
  });

  test("lastUserPromptPreview is first line of the latest user turn", () => {
    const s = store.createSession("Preview chat");
    store.appendMessage(s.id, {
      role: "user",
      content: "first line of ask\nsecond line ignored",
    });
    store.appendMessage(s.id, { role: "assistant", content: "ok" });
    store.appendMessage(s.id, {
      role: "user",
      content: "  \nlatest headline\nmore",
    });
    expect(store.lastUserPromptPreview(s.id)).toBe("latest headline");
  });
});
