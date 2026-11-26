/**
 * d13-admission-settle.test.ts — D-13(a): settle is session-scoped and cannot
 * mark a queued row done (nothing ran).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore } from "../../src/core/session";
import { AdmissionQueue } from "../../src/core/admission";

let dir = "";
afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows sqlite handle */
    }
  }
  dir = "";
});

function queue(): { q: AdmissionQueue; sessionId: string; store: SessionStore } {
  dir = mkdtempSync(path.join(tmpdir(), "hz-adm-"));
  const store = new SessionStore(dir);
  const session = store.createSession("t");
  return { q: new AdmissionQueue(store), sessionId: session.id, store };
}

describe("admission settle invariants", () => {
  test("a queued row cannot settle to done", () => {
    const { q, sessionId } = queue();
    const id = q.admit(sessionId, "hello");
    expect(q.settle(id, "done", undefined, sessionId)).toBe(false);
    expect(q.list(sessionId)[0]?.state).toBe("queued");
  });

  test("settle is session-scoped", () => {
    const { q, sessionId, store } = queue();
    const other = store.createSession("other");
    const id = q.admit(sessionId, "hello");
    q.begin(id);
    expect(q.settle(id, "done", undefined, other.id)).toBe(false);
    expect(q.settle(id, "done", undefined, sessionId)).toBe(true);
  });
});
