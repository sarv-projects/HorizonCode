/**
 * codemode-kv.ts — session-scoped KV for code_mode programs (ruling 641+).
 *
 * Values survive across separate code_mode runs in the same session; the parent
 * owns persistence under `<workspace>/.hz/state/codemode-kv/<sessionId>.json`.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
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

function nullProtoCopy(source?: Record<string, unknown>): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  if (source !== undefined) {
    for (const [k, v] of Object.entries(source)) {
      if (k === "__proto__") continue;
      out[k] = v;
    }
  }
  return out;
}

function loadFromDisk(file: string): Record<string, unknown> {
  try {
    const text = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return nullProtoCopy();
    return nullProtoCopy(parsed as Record<string, unknown>);
  } catch {
    return nullProtoCopy();
  }
}

function flushToDisk(file: string, text: string): void {
  if (text.length > MAX_KV_BYTES) {
    throw new Error(`codemode kv exceeds ${MAX_KV_BYTES} bytes for this session`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, flags, 0o600);
    writeSync(fd, text, 0, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
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
    const k = String(key);
    const next = nullProtoCopy(this.data);
    next[k] = value;
    const text = JSON.stringify(next);
    if (text.length > MAX_KV_BYTES) {
      throw new Error(`codemode kv exceeds ${MAX_KV_BYTES} bytes for this session`);
    }
    flushToDisk(this.file, text);
    this.data = next;
  }

  /** Current snapshot (tests). */
  snapshot(): Record<string, unknown> {
    return nullProtoCopy(this.data);
  }
}