import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  COMMIT_CONVERSATION_CAP,
  COMMIT_SUBJECT_MAX,
  COMMIT_WEAK_MODEL_ENV,
  cleanCommitMessage,
  commitCommand,
  commitMessageModels,
  commitPrompt,
  commitPromptFitsWindow,
  formatCommitConversationExcerpt,
  formatCommitModelFallbackNotices,
  formatConventionalCommitSubject,
  generateCommitMessageWithModelFallback,
  isCommitTokenLimitFailure,
  isConventionalCommitSubject,
  latestCommitConversationExcerpt,
  normalizeConventionalCommitMessage,
  parseConventionalCommitSubject,
  resolveCommitWeakModel,
  shellQuote,
  stagedDiff,
  withReceiptTrailer,
} from "../../src/core/commit";
import { estimateTokens } from "../../src/core/output-budget";
import { SessionStore } from "../../src/core/session";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("message cleanup, trailer and quoting", () => {
  expect(cleanCommitMessage("```\nfix: a\n\nbody\n```")).toBe("fix: a\n\nbody");
  expect(cleanCommitMessage('"fix: b"')).toBe("fix: b");
  expect(withReceiptTrailer("s", "abc")).toBe("s\n\nHZ-Receipt: abc");
  expect(withReceiptTrailer("s", undefined)).toBe("s");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(commitCommand("a'b; rm -rf /")).toBe(`git commit -m 'a'\\''b; rm -rf /'`);
  const p = commitPrompt("DIFF", true, "ctx");
  expect(p).toContain("DIFF");
  expect(p).toContain("[diff truncated]");
  expect(p).toContain("ctx");
  expect(p).toContain("Conventional Commits");
  expect(p).toContain("type(scope): subject");
  expect(p).toContain("feat, fix");
});

test("commitPrompt includes capped conversation excerpt", () => {
  const excerpt = "user: fix the login bug\nassistant: I'll patch auth.ts";
  const p = commitPrompt("DIFF", false, "", excerpt);
  expect(p).toContain("Recent conversation (intent only; the staged diff is authoritative):");
  expect(p).toContain(excerpt);
  expect(p).toContain("```diff\nDIFF\n```");
  expect(commitPrompt("DIFF", false, "", "")).not.toContain("Recent conversation");
});

test("parse/isConventionalCommitSubject accept type(scope): subject", () => {
  expect(parseConventionalCommitSubject("feat(auth): add retry")).toEqual({
    type: "feat",
    scope: "auth",
    breaking: false,
    description: "add retry",
  });
  expect(parseConventionalCommitSubject("FIX: patch null deref")).toEqual({
    type: "fix",
    scope: null,
    breaking: false,
    description: "patch null deref",
  });
  expect(parseConventionalCommitSubject("feat(api)!: drop v1")).toEqual({
    type: "feat",
    scope: "api",
    breaking: true,
    description: "drop v1",
  });
  expect(isConventionalCommitSubject("feat(auth): add retry")).toBe(true);
  expect(isConventionalCommitSubject("wip: temp")).toBe(false);
  expect(isConventionalCommitSubject("just a subject")).toBe(false);
  expect(parseConventionalCommitSubject("")).toBe(null);
  expect(parseConventionalCommitSubject("feat:")).toBe(null);
});

test("normalizeConventionalCommitMessage enforces type(scope): subject", () => {
  expect(normalizeConventionalCommitMessage("Feat(Auth):  Add Retry  ")).toBe("feat(Auth): Add Retry");
  expect(normalizeConventionalCommitMessage("fix: patch null deref\n\nDetails here.")).toBe(
    "fix: patch null deref\n\nDetails here.",
  );
  expect(normalizeConventionalCommitMessage("update the login flow")).toBe("chore: update the login flow");
  expect(normalizeConventionalCommitMessage("Commit: ship the excerpt")).toBe("chore: ship the excerpt");
  expect(normalizeConventionalCommitMessage("wip: scratch")).toBe("wip: scratch");
  expect(normalizeConventionalCommitMessage("")).toBe("");

  const long = "x".repeat(COMMIT_SUBJECT_MAX + 40);
  const capped = normalizeConventionalCommitMessage(`feat: ${long}`);
  expect(capped.startsWith("feat: ")).toBe(true);
  expect(capped.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX);
  expect(isConventionalCommitSubject(capped)).toBe(true);

  expect(formatConventionalCommitSubject("docs", "clarify handoff", { scope: "33" })).toBe(
    "docs(33): clarify handoff",
  );
});

test("formatCommitConversationExcerpt keeps recent user/assistant turns under cap", () => {
  expect(formatCommitConversationExcerpt([])).toBe("");
  expect(
    formatCommitConversationExcerpt([
      { role: "system", content: "ignore" },
      { role: "tool", content: "tool out" },
      { role: "user", content: "  " },
    ]),
  ).toBe("");

  const excerpt = formatCommitConversationExcerpt([
    { role: "user", content: "old request" },
    { role: "assistant", content: "old reply" },
    { role: "tool", content: "skipped" },
    { role: "user", content: "please add retry" },
    { role: "assistant", content: "retry added" },
  ]);
  expect(excerpt).toBe("user: old request\nassistant: old reply\nuser: please add retry\nassistant: retry added");

  const tight = formatCommitConversationExcerpt(
    [
      { role: "user", content: "aaaaaaaaaa" },
      { role: "assistant", content: "bbbbbbbbbb" },
      { role: "user", content: "cccccccccc" },
    ],
    28,
  );
  expect(tight).toContain("user: cccccccccc");
  expect(tight).toContain("[conversation truncated]");
  expect(tight).not.toContain("aaaaaaaaaa");

  const huge = "x".repeat(COMMIT_CONVERSATION_CAP + 50);
  const one = formatCommitConversationExcerpt([{ role: "user", content: huge }], COMMIT_CONVERSATION_CAP);
  expect(one.startsWith("user: ")).toBe(true);
  expect(one).toContain("[conversation truncated]");
  expect(one.indexOf("\n[conversation truncated]")).toBeGreaterThan(0);
});

test("latestCommitConversationExcerpt reads the workspace latest session", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-commit-convo-"));
  dirs.push(d);
  expect(latestCommitConversationExcerpt(d)).toBe("");

  const store = new SessionStore(d);
  const session = store.createSession("chat");
  store.appendMessage(session.id, { role: "user", content: "ship the excerpt" });
  store.appendMessage(session.id, { role: "assistant", content: "done" });
  store.appendMessage(session.id, { role: "tool", content: "noise" });
  store.close();

  expect(latestCommitConversationExcerpt(d)).toBe("user: ship the excerpt\nassistant: done");
});

test("stagedDiff reads only the index", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-commit-"));
  dirs.push(d);
  spawnSync("git", ["init", "-q", d]);
  writeFileSync(path.join(d, "a.txt"), "one\n");
  expect(stagedDiff(d)).toEqual({ diff: "", truncated: false });
  spawnSync("git", ["add", "a.txt"], { cwd: d });
  const r = stagedDiff(d);
  expect("diff" in r && r.diff).toContain("+one");
});

test("commitMessageModels is weak-first and dedupes", () => {
  expect(commitMessageModels("gpt-4o", "gpt-4o-mini")).toEqual(["gpt-4o-mini", "gpt-4o"]);
  expect(commitMessageModels("gpt-4o", "gpt-4o")).toEqual(["gpt-4o"]);
  expect(commitMessageModels("gpt-4o", "")).toEqual(["gpt-4o"]);
  expect(commitMessageModels("gpt-4o", null)).toEqual(["gpt-4o"]);
  expect(commitMessageModels("", "mini")).toEqual([]);
});

test("resolveCommitWeakModel reads HZ_WEAK_MODEL", () => {
  expect(resolveCommitWeakModel({ [COMMIT_WEAK_MODEL_ENV]: "gpt-4o-mini" })).toBe("gpt-4o-mini");
  expect(resolveCommitWeakModel({ [COMMIT_WEAK_MODEL_ENV]: "  " })).toBeUndefined();
  expect(resolveCommitWeakModel({})).toBeUndefined();
});

test("commitPromptFitsWindow and isCommitTokenLimitFailure", () => {
  expect(commitPromptFitsWindow("hi", undefined)).toBe(true);
  expect(commitPromptFitsWindow("hi", 0)).toBe(true);
  expect(commitPromptFitsWindow("a".repeat(400), 50)).toBe(false);
  expect(commitPromptFitsWindow("short", estimateTokens("short") + 1)).toBe(true);

  expect(isCommitTokenLimitFailure({ failureCode: "CONTEXT_WINDOW_EXCEEDED" })).toBe(true);
  expect(isCommitTokenLimitFailure({ errorText: "maximum context length exceeded" })).toBe(true);
  expect(isCommitTokenLimitFailure({ errorText: "prompt too long for model" })).toBe(true);
  expect(isCommitTokenLimitFailure({ failureCode: "RATE_LIMIT", errorText: "slow down" })).toBe(false);
  expect(isCommitTokenLimitFailure({ exitDetail: "provider_error", errorText: "auth failed" })).toBe(false);
});

test("generateCommitMessageWithModelFallback prefers weak then falls back on token limit", async () => {
  const calls: string[] = [];
  const ok = await generateCommitMessageWithModelFallback({
    models: ["weak", "main"],
    prompt: "draft me",
    attempt: async (model) => {
      calls.push(model);
      if (model === "weak") {
        return {
          text: "",
          failureCode: "CONTEXT_WINDOW_EXCEEDED",
          errorText: "context window exceeded",
          exitDetail: "provider_error",
        };
      }
      return { text: "feat: ship fallback" };
    },
  });
  expect(calls).toEqual(["weak", "main"]);
  expect("message" in ok && ok.message).toBe("feat: ship fallback");
  expect("model" in ok && ok.model).toBe("main");
  expect("failedTokenLimit" in ok && ok.failedTokenLimit).toEqual(["weak"]);
  expect(formatCommitModelFallbackNotices(ok).some((n) => n.includes("token/context limit"))).toBe(true);
});

test("generateCommitMessageWithModelFallback skips weak when prompt exceeds window", async () => {
  const calls: string[] = [];
  const prompt = "x".repeat(400);
  const ok = await generateCommitMessageWithModelFallback({
    models: ["weak", "main"],
    prompt,
    windowForModel: (model) => (model === "weak" ? 10 : 10_000),
    attempt: async (model) => {
      calls.push(model);
      return { text: "fix: after skip" };
    },
  });
  expect(calls).toEqual(["main"]);
  expect("message" in ok && ok.model).toBe("main");
  expect("skipped" in ok && ok.skipped).toEqual(["weak"]);
});

test("generateCommitMessageWithModelFallback stops on first usable message", async () => {
  const calls: string[] = [];
  const ok = await generateCommitMessageWithModelFallback({
    models: ["weak", "main"],
    prompt: "p",
    attempt: async (model) => {
      calls.push(model);
      return { text: "chore: from weak" };
    },
  });
  expect(calls).toEqual(["weak"]);
  expect("message" in ok && ok.message).toBe("chore: from weak");
  expect("model" in ok && ok.model).toBe("weak");
});

test("generateCommitMessageWithModelFallback errors when every model fails", async () => {
  const err = await generateCommitMessageWithModelFallback({
    models: ["weak", "main"],
    prompt: "p",
    attempt: async () => ({ text: "", failureCode: "CONTEXT_WINDOW_EXCEEDED", errorText: "too many tokens" }),
  });
  expect("error" in err).toBe(true);
  expect("failedTokenLimit" in err && err.failedTokenLimit).toEqual(["weak", "main"]);
  expect("tried" in err && err.tried).toEqual(["weak", "main"]);
});
