import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSessionArchive, renderHzsArchive, writeSessionArchive } from "../../src/core/archive";
import { recordCheckpoint } from "../../src/core/checkpoints";
import { sanitizeStream } from "../../src/core/kernel";
import { kernelStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-archive-"));
  dirs.push(d);
  return d;
};

test("buildSessionArchive includes messages and session checkpoints only", () => {
  const ws = tmp();
  const store = new SessionStore(ws);
  const session = store.createSession("arc");
  store.appendMessage(session.id, { role: "user", content: "hello" });
  recordCheckpoint(ws, session.id, 1, [], { label: "hello" });
  const other = store.createSession("other");
  recordCheckpoint(ws, other.id, 0, []);

  const archive = buildSessionArchive(ws, session.id, { exportedAt: "2026-01-01T00:00:00.000Z", includeEvents: false });
  expect(archive.manifest.format).toBe("hzs-json-v1");
  expect(archive.manifest.sessionId).toBe(session.id);
  expect(archive.messages).toHaveLength(1);
  expect(archive.checkpoints).toHaveLength(1);
  expect(archive.checkpoints[0]?.sessionId).toBe(session.id);
  expect(archive.manifest.includes.messages).toBe(true);
  expect(archive.manifest.includes.sessionEvents).toBe(false);
  const json = JSON.parse(renderHzsArchive(archive));
  expect(json.manifest.version).toBe(1);
});

test("writeSessionArchive writes .hzs under exports", () => {
  const ws = tmp();
  const store = new SessionStore(ws);
  const session = store.createSession("write");
  store.appendMessage(session.id, { role: "user", content: "x" });
  const { path: out, messageCount } = writeSessionArchive(ws, session.id);
  expect(messageCount).toBe(1);
  expect(existsSync(out)).toBe(true);
  expect(out.endsWith(".hzs")).toBe(true);
  const parsed = JSON.parse(readFileSync(out, "utf8")) as { messages: unknown[] };
  expect(parsed.messages.length).toBe(1);
});

test("session events included when log file exists", () => {
  const ws = tmp();
  const store = new SessionStore(ws);
  const session = store.createSession("ev");
  const kdir = kernelStateDir(ws);
  const evDir = path.join(kdir, "events");
  mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `${sanitizeStream(`session:${session.id}`)}.jsonl`);
  writeFileSync(evFile, `${JSON.stringify({ seq: 1, type: "test", stream: `session:${session.id}` })}\n`, { mode: 0o600 });
  const archive = buildSessionArchive(ws, session.id, { includeEvents: true });
  expect(archive.events?.length).toBe(1);
  expect(archive.manifest.includes.sessionEvents).toBe(true);
});
