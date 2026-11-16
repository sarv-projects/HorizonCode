/**
 * owner-worker-control-pipe.test.ts — C-12 reduced framed control-pipe protocol
 * (ruling 471). Pure encode/decode + handshake; no product spawn wiring.
 */

import { describe, expect, test } from "bun:test";
import {
  ControlPipeFramer,
  OWNER_WORKER_CONTROL_PIPE_V,
  OWNER_WORKER_MAX_FRAME_BYTES,
  OwnerWorkerHandshake,
  decodeBootstrap,
  decodeFrameLine,
  decodeHello,
  decodeTurnFrame,
  encodeFrame,
  makeBootstrap,
  makeHello,
  makeTurnFrame,
} from "../../src/core/owner-worker-control-pipe";
import type { ProcessIdentity } from "../../src/core/worker-identity";

const identity: ProcessIdentity = { pid: 4242, startTicks: 999001 };
const liveOk = (): { ok: boolean; reason?: string } => ({ ok: true });

function sampleBootstrap() {
  return makeBootstrap({
    profileId: "prof_1",
    sessionId: "sess_1",
    executionId: "exec_1",
    generation: 0,
    identity,
    secret: "sec_abc",
    epoch: 7,
  });
}

describe("owner-worker control pipe — bootstrap", () => {
  test("encode/decode round-trips a closed versioned bootstrap", () => {
    const boot = sampleBootstrap();
    expect(boot.v).toBe(OWNER_WORKER_CONTROL_PIPE_V);
    expect(boot.kind).toBe("bootstrap");
    const enc = encodeFrame(boot);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    const decoded = decodeFrameLine(enc.value);
    expect(decoded).toEqual({ ok: true, value: boot });
  });

  test("refuses unknown bootstrap fields", () => {
    const raw = { ...sampleBootstrap(), extra: true };
    const result = decodeBootstrap(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unknown field: extra");
  });

  test("refuses unsupported protocol version", () => {
    const raw = { ...sampleBootstrap(), v: 99 };
    const result = decodeBootstrap(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported protocol version");
  });

  test("refuses a frame larger than MAX_FRAME_BYTES", () => {
    const huge = "x".repeat(OWNER_WORKER_MAX_FRAME_BYTES + 1);
    const result = decodeFrameLine(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("exceeds");
  });
});

describe("owner-worker control pipe — handshake before reserve", () => {
  test("verified hello unlocks reserveWork", () => {
    const boot = sampleBootstrap();
    const hs = new OwnerWorkerHandshake(boot, { liveProcCheck: liveOk });
    expect(hs.mayReserveWork).toBe(false);
    expect(hs.reserveWork().ok).toBe(false);

    const hello = makeHello({
      executionId: boot.executionId,
      identity,
      secret: boot.secret,
      epoch: boot.epoch,
    });
    const verdict = hs.acceptHello(hello);
    expect(verdict.ok).toBe(true);
    expect(hs.state).toBe("verified");
    expect(hs.mayReserveWork).toBe(true);

    const reserved = hs.reserveWork();
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.value.executionId).toBe("exec_1");
    expect(reserved.value.identity).toEqual(identity);
  });

  test("stale epoch refuses and blocks reservation", () => {
    const boot = sampleBootstrap();
    const hs = new OwnerWorkerHandshake(boot, { liveProcCheck: liveOk });
    const hello = makeHello({
      executionId: boot.executionId,
      identity,
      secret: boot.secret,
      epoch: boot.epoch + 1,
    });
    const verdict = hs.acceptHello(hello);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("epoch");
    expect(hs.state).toBe("refused");
    expect(hs.mayReserveWork).toBe(false);
    expect(hs.reserveWork().ok).toBe(false);
  });

  test("secret mismatch refuses", () => {
    const boot = sampleBootstrap();
    const hs = new OwnerWorkerHandshake(boot, { liveProcCheck: liveOk });
    const hello = makeHello({
      executionId: boot.executionId,
      identity,
      secret: "wrong",
      epoch: boot.epoch,
    });
    expect(hs.acceptHello(hello).ok).toBe(false);
    expect(hs.state).toBe("refused");
  });

  test("identity mismatch against bootstrap refuses", () => {
    const boot = sampleBootstrap();
    const hs = new OwnerWorkerHandshake(boot, { liveProcCheck: liveOk });
    const hello = makeHello({
      executionId: boot.executionId,
      identity: { pid: 1, startTicks: 2 },
      secret: boot.secret,
      epoch: boot.epoch,
    });
    const verdict = hs.acceptHello(hello);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("identity mismatch");
  });

  test("live /proc check failure refuses", () => {
    const boot = sampleBootstrap();
    const hs = new OwnerWorkerHandshake(boot, {
      liveProcCheck: () => ({ ok: false, reason: "pid was reused" }),
    });
    const hello = makeHello({
      executionId: boot.executionId,
      identity,
      secret: boot.secret,
      epoch: boot.epoch,
    });
    const verdict = hs.acceptHello(hello);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("reused");
  });

  test("hello unknown fields refuse at decode", () => {
    const result = decodeHello({
      ...makeHello({
        executionId: "exec_1",
        identity,
        secret: "s",
        epoch: 1,
      }),
      ancestor: [1, 2],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unknown field");
  });
});

describe("owner-worker control pipe — turn frames + framer", () => {
  test("closed turn kinds round-trip; unknown kind refused", () => {
    for (const kind of [
      "delta",
      "tool.start",
      "tool.complete",
      "approval",
      "clarify",
      "result",
      "finished",
    ] as const) {
      const frame = makeTurnFrame({ kind, executionId: "exec_1", payload: { n: 1 } });
      const enc = encodeFrame(frame);
      expect(enc.ok).toBe(true);
      if (!enc.ok) continue;
      expect(decodeFrameLine(enc.value)).toEqual({ ok: true, value: frame });
    }
    const bad = decodeTurnFrame({
      v: OWNER_WORKER_CONTROL_PIPE_V,
      kind: "tool.running",
      executionId: "exec_1",
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toContain("unknown turn kind");
  });

  test("ControlPipeFramer reassembles split NDJSON lines", () => {
    const boot = sampleBootstrap();
    const hello = makeHello({
      executionId: boot.executionId,
      identity,
      secret: boot.secret,
      epoch: boot.epoch,
    });
    const encBoot = encodeFrame(boot);
    const encHello = encodeFrame(hello);
    expect(encBoot.ok && encHello.ok).toBe(true);
    if (!encBoot.ok || !encHello.ok) return;

    const framer = new ControlPipeFramer();
    const joined = `${encBoot.value}\n${encHello.value}\n`;
    const mid = Math.floor(joined.length / 2);
    expect(framer.push(joined.slice(0, mid))).toEqual([]);
    const frames = framer.push(joined.slice(mid));
    expect(frames).toEqual([
      { ok: true, value: boot },
      { ok: true, value: hello },
    ]);
  });
});
