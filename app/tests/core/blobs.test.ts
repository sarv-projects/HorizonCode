/**
 * blobs.test.ts — F7 reduced CAS put/get (docs/12 §4.1, S-54/S-57).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/contracts";
import {
  blobBodyPath,
  blobShardSegments,
  blobSpillEnabled,
  displayBlobBodyPath,
  getBlob,
  getBlobForWorkspace,
  putBlob,
  putBlobForWorkspace,
} from "../../src/core/blobs";
import { blobsDir } from "../../src/core/paths";
import { planToolOutputCap } from "../../src/core/output-budget";

let workspace: string;
let root: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-blobs-"));
  root = blobsDir(workspace);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.HZ_BLOB_SPILL;
});

describe("blobShardSegments and paths", () => {
  test("two-level shard from a 64-char hex hash", () => {
    const hash = "ab".repeat(32);
    expect(blobShardSegments(hash)).toEqual({ ab: "ab", cd: "ab", normalized: hash });
    expect(blobBodyPath("/store", hash)).toBe(path.join("/store", "ab", "ab", hash));
  });

  test("rejects non-hex or short hashes", () => {
    expect(blobShardSegments("deadbeef")).toBeUndefined();
    expect(blobBodyPath("/store", "zz".repeat(32))).toBeUndefined();
  });
});

describe("putBlob / getBlob", () => {
  test("dedup: second put does not rewrite bytes", () => {
    const body = "hello blob store";
    const first = putBlob(root, body);
    expect(first.created).toBe(true);
    const mtime = readFileSync(first.path).byteLength;

    const corruptMarker = path.join(path.dirname(first.path), "touch");
    writeFileSync(corruptMarker, "x");

    const again = putBlob(root, body);
    expect(again.created).toBe(false);
    expect(again.path).toBe(first.path);
    expect(readFileSync(first.path).toString("utf8")).toBe(body);
    expect(readFileSync(first.path).byteLength).toBe(mtime);
  });

  test("hash mismatch on disk is replaced on put", () => {
    const body = "canonical bytes";
    const hash = sha256Hex(body);
    const target = blobBodyPath(root, hash)!;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "wrong bytes");
    const fixed = putBlob(root, body);
    expect(fixed.hash).toBe(hash);
    const got = getBlob(root, hash);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.body.toString("utf8")).toBe(body);
  });

  test("getBlob refuses corrupt content", () => {
    const body = "payload";
    const hash = sha256Hex(body);
    const target = blobBodyPath(root, hash)!;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "tampered");
    expect(getBlob(root, hash)).toEqual({ ok: false, reason: "hash_mismatch" });
  });

  test("workspace helpers resolve under canonical state", () => {
    const body = "workspace scoped";
    const put = putBlobForWorkspace(workspace, body);
    expect(put.path.startsWith(path.join(workspace, ".hz", "state", "blobs"))).toBe(true);
    const got = getBlobForWorkspace(workspace, put.hash);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.body.toString("utf8")).toBe(body);
    const shown = displayBlobBodyPath(workspace, put.hash);
    expect(shown).toMatch(/^\.hz\/state\/blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });
});

describe("tool spill optional CAS", () => {
  test("planToolOutputCap stores in blob CAS when blobCasWorkspace is set", () => {
    const full = "z".repeat(20_000);
    const plan = planToolOutputCap(full, { blobCasWorkspace: workspace, maxBytes: 200, maxTokens: 10_000 });
    expect(plan.spill).toBeUndefined();
    expect(plan.truncated?.spillPath).toMatch(/\.hz\/state\/blobs\//);
    const hash = sha256Hex(full);
    const got = getBlobForWorkspace(workspace, hash);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.body.toString("utf8")).toBe(full);
  });

  test("blobSpillEnabled reads HZ_BLOB_SPILL", () => {
    expect(blobSpillEnabled()).toBe(false);
    process.env.HZ_BLOB_SPILL = "1";
    expect(blobSpillEnabled()).toBe(true);
  });
});

describe("permissions", () => {
  test("putBlob creates owner-only blob file on Unix", () => {
    if (process.platform === "win32") return;
    const body = "mode check";
    const { path: filePath } = putBlob(root, body);
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
  });
});
