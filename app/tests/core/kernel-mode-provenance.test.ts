/**
 * kernel-mode-provenance.test.ts — ruling 33: the kernel mode is first-class,
 * recorded and observable.
 *
 * The distrust-reaudit triage (`docs/audit/triage-external-review-2026-11-07.md`,
 * "Kernel-absent posture") demanded a fail-closed posture decision. Ruling 33
 * keeps full functionality — decision parity is interop-pinned in
 * `tests/core/interop.test.ts`, which needs the Rust binary — and makes the
 * MODE itself the first-class fact: every session.start event records the mode
 * the run actually came up in, and a runtime that comes up in the fallback says
 * so, exactly once, in the human's first turn.
 *
 * Fallback is forced the way the fallback suite forces it: HZ_KERNEL_BIN points
 * at a path that does not exist — the real binary is never touched. The trusted
 * halves run against the repository's release/debug build when one exists and
 * skip when it genuinely does not (the kernel-trusted.test.ts cadence).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as path from "node:path";
import type { EventEnvelope, RuntimeEvent } from "../../src/contracts";
import { EventTypes } from "../../src/contracts";
import { createRuntime, type HzRuntime } from "../../src/core/index";
import { KernelClient } from "../../src/core/kernel";
import { streamFor } from "../../src/core/loop";
import {
  assertEventChain,
  cleanupTemps,
  hasRustKernel,
  restoreEnv,
  rustKernelPath,
  setEnv,
  snapshotEnv,
  tempDir,
  type EnvSnapshot,
} from "./helpers";

/** The unfallible marker of the mode notice. */
const MODE_NOTICE = /without the Rust kernel binary \(untrusted\/fallback\)/;
/** The notice must be honest about the weaker guarantees, not just name a mode. */
const WEAKER = /weaker in this mode/;

let envBackup: EnvSnapshot;
let missingBinary = "";

beforeAll(() => {
  envBackup = snapshotEnv();
  missingBinary = path.join(tempDir("hz-mode-nowhere-"), "hz-kernel");
  expect(missingBinary).not.toBe(rustKernelPath);
});

afterAll(() => {
  restoreEnv(envBackup);
  cleanupTemps();
});

/** The notices one runtime emits over one turn. */
async function turnNotices(runtime: HzRuntime, text: string): Promise<string[]> {
  const notices: string[] = [];
  await runtime.send(text, {
    onEvent: (event: RuntimeEvent) => {
      if (event.type === "notice") notices.push(event.message);
    },
  });
  return notices;
}

/** The session stream, read through the kernel itself (kernel.readEvents). */
async function readSessionStream(workspace: string, sessionId: string): Promise<EventEnvelope[]> {
  const reader = new KernelClient({ workspace });
  try {
    return await reader.readEvents(streamFor(sessionId));
  } finally {
    await reader.close();
  }
}

function sessionStarts(events: EventEnvelope[]): EventEnvelope[] {
  return events.filter((event) => event.type === EventTypes.sessionStart);
}

function kernelModeOf(event: EventEnvelope): unknown {
  return (event.payload as Record<string, unknown>).kernelMode;
}

test("a fallback runtime records kernelMode 'untrusted' and says so once, on the first turn", async () => {
  setEnv({ HZ_KERNEL_BIN: missingBinary, HZ_STATE_DIR: undefined });
  const workspace = tempDir("hz-mode-fb-");
  const runtime = await createRuntime({ workspace, mock: true });
  const sessionId = runtime.sessionId;
  try {
    expect(runtime.kernelMode).toBe("untrusted");

    const first = await turnNotices(runtime, "hello");
    const warned = first.filter((message) => MODE_NOTICE.test(message));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("untrusted");
    expect(warned[0]).toMatch(WEAKER);
    // Honest about what does NOT change: the guard decisions are pinned equal.
    expect(warned[0]).toContain("contract-identical");

    // Exactly once per runtime lifetime: a second turn repeats nothing.
    const second = await turnNotices(runtime, "again");
    expect(second.filter((message) => MODE_NOTICE.test(message))).toEqual([]);
  } finally {
    await runtime.close();
  }

  const events = await readSessionStream(workspace, sessionId);
  // Every record — including the modified session.start payload — hashes back
  // to its canonical-JSON preimage, so the added field is byte-stable.
  assertEventChain(events, "fallback session stream");
  const starts = sessionStarts(events);
  expect(starts).toHaveLength(1);
  expect(starts[0]!.payload).toEqual({
    sessionId,
    workspace,
    provider: runtime.providerName,
    model: runtime.model,
    kernelMode: "untrusted",
  });
});

test.skipIf(!hasRustKernel)("a trusted runtime records kernelMode 'trusted' and stays quiet", async () => {
  setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_STATE_DIR: undefined });
  const workspace = tempDir("hz-mode-trusted-");
  const runtime = await createRuntime({ workspace, mock: true });
  const sessionId = runtime.sessionId;
  try {
    expect(runtime.kernelMode).toBe("trusted");
    const notices = await turnNotices(runtime, "hello");
    // No untrusted-mode notice — and no mention of the mode at all.
    expect(notices.filter((message) => MODE_NOTICE.test(message))).toEqual([]);
    expect(notices.some((message) => message.includes("untrusted"))).toBe(false);
  } finally {
    await runtime.close();
  }

  const events = await readSessionStream(workspace, sessionId);
  assertEventChain(events, "trusted session stream");
  const starts = sessionStarts(events);
  expect(starts).toHaveLength(1);
  expect(kernelModeOf(starts[0]!)).toBe("trusted");
});

test("resume (fallback): the resumed run re-records its own mode and earns its own single notice", async () => {
  setEnv({ HZ_KERNEL_BIN: missingBinary, HZ_STATE_DIR: undefined });
  const workspace = tempDir("hz-mode-resume-fb-");
  const first = await createRuntime({ workspace, mock: true });
  const sessionId = first.sessionId;
  try {
    expect(first.kernelMode).toBe("untrusted");
    await turnNotices(first, "hello");
  } finally {
    await first.close();
  }

  const resumed = await createRuntime({ workspace, mock: true, continueSession: true });
  try {
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.kernelMode).toBe("untrusted");
    const notices = await turnNotices(resumed, "carry on");
    expect(notices.filter((message) => MODE_NOTICE.test(message))).toHaveLength(1);
  } finally {
    await resumed.close();
  }

  const events = await readSessionStream(workspace, sessionId);
  const starts = sessionStarts(events);
  // The resume opens a NEW session.start: the mode is per-run provenance, not a
  // session constant, and the run re-records what it really ran under.
  expect(starts.length).toBe(2);
  expect(starts.map(kernelModeOf)).toEqual(["untrusted", "untrusted"]);
});

test.skipIf(!hasRustKernel)("resume (mode flip): each session.start reflects the CURRENT mode of THAT run", async () => {
  const workspace = tempDir("hz-mode-flip-");

  // Run 1: forced fallback.
  setEnv({ HZ_KERNEL_BIN: missingBinary, HZ_STATE_DIR: undefined });
  const first = await createRuntime({ workspace, mock: true });
  const sessionId = first.sessionId;
  try {
    expect(first.kernelMode).toBe("untrusted");
    await turnNotices(first, "hello");
  } finally {
    await first.close();
  }

  // Run 2: the Rust kernel is resolvable again; the SAME session is continued.
  setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_STATE_DIR: undefined });
  const second = await createRuntime({ workspace, mock: true, continueSession: true });
  try {
    expect(second.sessionId).toBe(sessionId);
    expect(second.kernelMode).toBe("trusted");
    const notices = await turnNotices(second, "carry on");
    expect(notices.filter((message) => MODE_NOTICE.test(message))).toEqual([]);
  } finally {
    await second.close();
  }

  const events = await readSessionStream(workspace, sessionId);
  assertEventChain(events, "flipped-mode session stream");
  const starts = sessionStarts(events);
  expect(starts.length).toBe(2);
  // The first run's record is untouched by the second: the one chained stream
  // carries 'untrusted' then 'trusted', each the truth of its own run.
  expect(starts.map(kernelModeOf)).toEqual(["untrusted", "trusted"]);
});
