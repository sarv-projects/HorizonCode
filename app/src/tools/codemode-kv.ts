/**
 * codemode-kv.ts — session-scoped KV for code_mode programs (ruling 641+).
 *
 * Values survive across separate code_mode runs in the same session; the parent
 * owns persistence under `<workspace>/.hz/state/codemode-kv/<sessionId>.json`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { workspaceStateDir } from "../core/paths";

const KV_SUBDIR = "codemode-kv";
/** Bound disk growth from a single session's intermediates. */
const MAX_KV_BYTES = 2_000_000;

function safeSessionFileName(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed === "") return "_empty_session";
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function codemodeKvPath(workspace: string, sessionId: string): string {
  return path.join(workspaceStateDir(workspace), KV_SUBDIR, `${safeSessionFileName(sessionId)}.json`);
}

function loadFromDisk(file: string): Record<string, unknown> {
  try {
    const text = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return { ...(parsed as Record<string, unknown>) };
  } catch {
    return {};
  }
}

function flushToDisk(file: string, data: Record<string, unknown>): void {
  const text = JSON.stringify(data);
  if (text.length > MAX_KV_BYTES) {
    throw new Error(`codemode kv exceeds ${MAX_KV_BYTES} bytes for this session`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

/** In-memory view backed by a session JSON file; parent process only. */
export class CodemodeSessionKv {
  private readonly file: string;
  private data: Record<string, unknown>;

  constructor(workspace: string, sessionId: string) {
    this.file = codemodeKvPath(workspace, sessionId);
    this.data = loadFromDisk(this.file);
  }

  get(key: string): unknown {
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : undefined;
  }

  set(key: string, value: unknown): void {
    this.data[String(key)] = value;
    flushToDisk(this.file, this.data);
  }

  /** Current snapshot (tests). */
  snapshot(): Record<string, unknown> {
    return { ...this.data };
  }
}