/**
 * jsonl-append.ts — durable O_APPEND for JSONL state files (docs/33 §6.5 / docs/12 F10).
 *
 * Default: write the line then `fsync` the file and best-effort fsync the parent
 * directory so a rename/create entry is less likely to vanish on power loss.
 * Some filesystems refuse directory sync; that path is ignored. Set
 * `HZ_JSONL_FSYNC=0` for the fast/test path (no file or directory sync).
 */

import { appendFileSync, closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import path from "node:path";

export function jsonlFsyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.HZ_JSONL_FSYNC;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false" && raw.toLowerCase() !== "off";
}

/** Best-effort directory fsync after a file append (same contract as `tools/atomic-write.ts`). */
export function syncJsonlParentDirBestEffort(file: string): void {
  const dir = path.dirname(file);
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms/filesystems refuse directory sync.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function syncJsonlParentDirBestEffortAsync(file: string): Promise<void> {
  const dir = path.dirname(file);
  try {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* best-effort */
  }
}

/** Async append of `data` (already includes trailing `\n` when needed) with optional fsync. */
export async function appendJsonl(file: string, data: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!jsonlFsyncEnabled(env)) {
    await appendFile(file, data, "utf8");
    return;
  }
  const fh = await open(file, "a", 0o600);
  try {
    await fh.write(data, undefined, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await syncJsonlParentDirBestEffortAsync(file);
}

/** Sync counterpart for modules that already use appendFileSync. */
export function appendJsonlSync(file: string, data: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!jsonlFsyncEnabled(env)) {
    appendFileSync(file, data, "utf8");
    return;
  }
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, data, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncJsonlParentDirBestEffort(file);
}
