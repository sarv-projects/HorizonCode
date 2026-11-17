import { afterEach, describe, expect, test } from "bun:test";
import {
  conversationFilesForSession,
  conversationHasFilesInContext,
  filePathMentions,
  looksLikeFilePath,
  noteConversationMessage,
  noteFileInSession,
  noteToolContext,
  resetAllFileContext,
  resetFileContextSession,
  sessionHasFilesInContext,
} from "../../src/tools/repo-map-context";
import {
  effectiveRepoMapBudget,
  mapMultiplierNoFiles,
  MAP_MULTIPLIER_NO_FILES_ENV,
  repoMapContextCap,
  REPO_MAP_CONTEXT_PADDING,
} from "../../src/tools/repo-map-ladder";

afterEach(() => resetAllFileContext());

describe("repo-map context detector (B-2 residual)", () => {
  test("recognizes file-path mentions but not prose", () => {
    expect(looksLikeFilePath("src/core/loop.ts")).toBe(true);
    expect(looksLikeFilePath("foo.py:42")).toBe(true);
    expect(looksLikeFilePath("/etc/hosts")).toBe(true);
    expect(looksLikeFilePath("README.md")).toBe(true);
    expect(looksLikeFilePath("v1.2.3")).toBe(false);
    expect(looksLikeFilePath("e.g.")).toBe(false);
    expect(looksLikeFilePath("../secret.ts")).toBe(false); // traversal never counts
  });

  test("recognizes attachments and free-form text", () => {
    expect(filePathMentions("look at src/app.ts and also notes.md ok").length).toBe(2);
    expect(conversationHasFilesInContext([{ path: "src/app.ts" }])).toBe(true);
    expect(conversationHasFilesInContext(["just chatting about the plan"])).toBe(false);
    expect(conversationHasFilesInContext([])).toBe(false);
  });

  test("no context doubles the budget; explicit context does not; focus wins", () => {
    expect(effectiveRepoMapBudget(undefined, 4000, { multiplier: 2 })).toBe(8000);
    expect(effectiveRepoMapBudget(undefined, 4000, { hasFilesInContext: true, multiplier: 2 })).toBe(4000);
    expect(effectiveRepoMapBudget(["src/a.ts"], 4000, { multiplier: 2 })).toBe(4000);
    expect(effectiveRepoMapBudget(["src/a.ts"], 4000, { hasFilesInContext: true, multiplier: 2 })).toBe(4000);
    // legacy boolean third arg keeps the doubling behaviour
    expect(effectiveRepoMapBudget(undefined, 4000, false)).toBe(8000);
    expect(effectiveRepoMapBudget(undefined, 4000)).toBe(8000);
  });

  test("context-window cap (aider padding) binds the expanded budget", () => {
    expect(REPO_MAP_CONTEXT_PADDING).toBe(4096);
    expect(repoMapContextCap(10000)).toBe(10000 - 4096);
    // 4000 * 2 = 8000 but the window cap is 5904 ⇒ capped to 5904.
    expect(effectiveRepoMapBudget(undefined, 4000, { multiplier: 2, contextWindowTokens: 10000 })).toBe(5904);
    // A tiny window can cap below base.
    expect(effectiveRepoMapBudget(undefined, 4000, { multiplier: 2, contextWindowTokens: 5000 })).toBe(904);
    // Cap never applies when files/focus are present (no expansion).
    expect(effectiveRepoMapBudget(undefined, 4000, { hasFilesInContext: true, contextWindowTokens: 5000 })).toBe(4000);
  });

  test("config multiplier from env (aider --map-multiplier-no-files)", () => {
    expect(mapMultiplierNoFiles({})).toBe(2);
    expect(mapMultiplierNoFiles({ [MAP_MULTIPLIER_NO_FILES_ENV]: "3" })).toBe(3);
    expect(mapMultiplierNoFiles({ [MAP_MULTIPLIER_NO_FILES_ENV]: "2.5" })).toBe(2.5);
    expect(mapMultiplierNoFiles({ [MAP_MULTIPLIER_NO_FILES_ENV]: "bogus" })).toBe(2);
    const original = process.env[MAP_MULTIPLIER_NO_FILES_ENV];
    try {
      process.env[MAP_MULTIPLIER_NO_FILES_ENV] = "3";
      expect(effectiveRepoMapBudget(undefined, 4000)).toBe(12000);
    } finally {
      if (original === undefined) delete process.env[MAP_MULTIPLIER_NO_FILES_ENV];
      else process.env[MAP_MULTIPLIER_NO_FILES_ENV] = original;
    }
  });
});

describe("session-scoped file-context tracker", () => {
  test("tracks tool targets and resets cleanly", () => {
    expect(sessionHasFilesInContext("s1")).toBe(false);
    noteToolContext("s1", { path: "src/core/loop.ts" });
    expect(sessionHasFilesInContext("s1")).toBe(true);
    expect(sessionHasFilesInContext("s2")).toBe(false);
    resetFileContextSession("s1");
    expect(sessionHasFilesInContext("s1")).toBe(false);
  });

  test("read/edit/write/apply_patch style args all record targets", () => {
    noteToolContext("s", { paths: ["a.ts", "b.md"] });
    noteToolContext("s", { input: "*** Begin Patch\n*** Update File: c.py\n@@\n" });
    expect(sessionHasFilesInContext("s")).toBe(true);
  });

  test("ignores non-file targets", () => {
    noteFileInSession("s", "hello world", undefined, null);
    expect(sessionHasFilesInContext("s")).toBe(false);
  });

  test("current-message mentions become the conversationFiles signal", () => {
    noteConversationMessage("s", "please look at src/core/loop.ts and notes.md");
    const files = conversationFilesForSession("s");
    expect(files.some((f) => f.includes("src/core/loop.ts"))).toBe(true);
    expect(files.some((f) => f.includes("notes.md"))).toBe(true);
    expect(sessionHasFilesInContext("s")).toBe(true);
    // With files in the conversation the budget must NOT expand.
    expect(effectiveRepoMapBudget(undefined, 4000, { hasFilesInContext: true })).toBe(4000);
  });

  test("a plain message leaves the conversation file-free (budget expands)", () => {
    noteConversationMessage("s", "just chatting about the plan, no paths here");
    expect(sessionHasFilesInContext("s")).toBe(false);
    expect(effectiveRepoMapBudget(undefined, 4000, { hasFilesInContext: false })).toBe(8000);
  });
});
