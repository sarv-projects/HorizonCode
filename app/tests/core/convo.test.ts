import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMsg, Runtime } from "../../src/contracts";
import { chainLine, convoStats, lastOfRole, osc52, renderExportHtml, renderExportJson, renderStats } from "../../src/core/convo";
import { loadCommands } from "../../src/core/commands";
import { SessionStore } from "../../src/core/session";
import { runConvoCommand } from "../../src/tui/interactive";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-convo-"));
  dirs.push(d);
  return d;
};

const history: ChatMsg[] = [
  { role: "user", content: "hi <b>" },
  { role: "assistant", content: "hello", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
];

test("stats, last-of-role and OSC 52", () => {
  expect(lastOfRole(history, "assistant")).toBe("hello");
  expect(convoStats(history).toolCalls).toBe(1);
  expect(renderStats(convoStats(history))).toContain("2 message(s)");
  expect(osc52("hi")).toBe("\u001b]52;c;aGk=\u0007");
});

test("html export escapes text and shows the chain status", () => {
  const meta = { sessionId: "s1", title: "T", model: "m", exportedAt: "now", chain: { ok: true, count: 4, head: "abc" } };
  const html = renderExportHtml(history, meta);
  expect(html).toContain("hi &lt;b&gt;");
  expect(html).toContain("receipt chain verified: 4 receipt(s)");
  expect(html).toContain("abc");
  expect(renderExportHtml(history, { ...meta, chain: { ok: false, count: 1, brokenAt: 2 } })).toContain("BROKEN at receipt 2");
  expect(JSON.parse(renderExportJson(history, meta)).messages.length).toBe(2);
  expect(chainLine(undefined)).toContain("not checked");
});

test("/export writes the file, /rename and /copy use the runtime", async () => {
  const ws = tmp();
  const notices: string[] = [];
  const renderer = { notice: (m: string) => notices.push(m), line: () => {} } as never;
  let title = "old";
  const rt = {
    sessionId: "s1",
    model: "m",
    history: () => history,
    renameSession: (t: string) => (title = t),
    sessionTitle: () => title,
    receiptChain: async () => ({ ok: true, count: 2 }),
  } as unknown as Runtime;
  const out: string[] = [];
  await runConvoCommand("export", "html", rt, renderer, ws, (t) => void out.push(t));
  const file = path.join(ws, ".hz", "exports", "s1.html");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("receipt chain verified: 2");
  await runConvoCommand("rename", "new name", rt, renderer, ws);
  expect(title).toBe("new name");
  await runConvoCommand("copy", "", rt, renderer, ws, (t) => void out.push(t));
  expect(out[0]).toBe(osc52("hello"));
  expect(await runConvoCommand("bogus", "", rt, renderer, ws)).toBe(false);
});

test("the new verbs are builtin names, and truncating to the last user row drops the reply", () => {
  const ws = tmp();
  const names = ["rename", "retry", "stats", "export", "copy"];
  const dir = path.join(ws, ".hz", "commands");
  require("node:fs").mkdirSync(dir, { recursive: true });
  for (const n of names) require("node:fs").writeFileSync(path.join(dir, n + ".md"), "x");
  expect(loadCommands(ws).shadowed).toEqual([...names].sort());
  const store = new SessionStore(ws);
  const s = store.createSession();
  store.appendMessage(s.id, { role: "user", content: "q" });
  store.appendMessage(s.id, { role: "assistant", content: "a" });
  store.truncateMessages(s.id, 0);
  expect(store.history(s.id).length).toBe(0);
  store.close();
});
