/**
 * owner-worker-control-pipe.test.ts — C-12 reduced framed control-pipe protocol
 * (ruling 471). Pure encode/decode + handshake; no product spawn wiring.
 */

import { describe, expect, test } from "bun:test";
import {
  ControlPipeFramer,
  OWNER_WORKER_CONTROL_PIPE_V,
  OWNER_WORKER_MAX_FRAME_BYTES,
  RESERVE_SEQ_FIRST,
  OwnerWorkerHandshake,
  decodeBootstrap,
  decodeFrameLine,
  decodeHello,
  decodeReserve,
  decodeTurnFrame,
  encodeFrame,
  makeBootstrap,
  makeHello,
  makeReserve,
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

/** Construct a handshake and perform the documented publish step. */
function publishedHandshake() {
  const boot = sampleBootstrap();
  const hs = new OwnerWorkerHandshake(boot, { liveProcCheck: liveOk });
  expect(hs.publishBootstrap().ok).toBe(true);
  return { boot, hs };
}

function goodHello(boot: ReturnType<typeof sampleBootstrap>) {
  return makeHello({
    executionId: boot.executionId,
    identity,
    secret: boot.secret,
    epoch: boot.epoch,
  });
}

describe("owner-worker control pipe — handshake before reserve", () => {
  test("verified hello unlocks the single FIFO reserve", () => {
    const { boot, hs } = publishedHandshake();
    expect(hs.mayReserveWork).toBe(false);
    expect(hs.reserveWork().ok).toBe(false);

    const verdict = hs.acceptHello(goodHello(boot));
    expect(verdict.ok).toBe(true);
    expect(hs.state).toBe("verified");
    expect(hs.mayReserveWork).toBe(true);

    const reserved = hs.reserveWork();
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.value.kind).toBe("reserve");
    expect(reserved.value.executionId).toBe("exec_1");
    expect(reserved.value.pid).toBe(identity.pid);
    expect(reserved.value.startTicks).toBe(identity.startTicks);
    expect(reserved.value.seq).toBe(RESERVE_SEQ_FIRST);
  });

  test("stale epoch refuses and blocks reservation", () => {
    const { boot, hs } = publishedHandshake();
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
    const { boot, hs } = publishedHandshake();
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
    const { boot, hs } = publishedHandshake();
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
    expect(hs.publishBootstrap().ok).toBe(true);
    const verdict = hs.acceptHello(goodHello(boot));
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

describe("owner-worker control pipe — publish order + FIFO reserve (ruling 492)", () => {
  test("enforces publish → hello → verify → reserve order", () => {
    const boot = sampleBootstrap();
    const hs = new OwnerWorkerHandshake(boot, { liveProcCheck: liveOk });
    const hello = goodHello(boot);

    // Hello before the publish step is refused, without transitioning state.
    const early = hs.acceptHello(hello);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toContain("bootstrap not published");
    expect(hs.state).toBe("awaiting_bootstrap");

    // Publish advances the state; a second publish is refused.
    expect(hs.publishBootstrap().ok).toBe(true);
    expect(hs.state).toBe("awaiting_hello");
    const pub2 = hs.publishBootstrap();
    expect(pub2.ok).toBe(false);
    if (!pub2.ok) expect(pub2.reason).toContain("already published");

    // Reserve before a verified hello is refused.
    const earlyReserve = hs.reserveWork();
    expect(earlyReserve.ok).toBe(false);
    if (!earlyReserve.ok) expect(earlyReserve.reason).toContain("handshake incomplete");

    // Verified hello then the single reserve; a late hello is refused.
    expect(hs.acceptHello(hello).ok).toBe(true);
    expect(hs.state).toBe("verified");
    expect(hs.reserveWork().ok).toBe(true);
    expect(hs.state).toBe("reserved");
    const late = hs.acceptHello(hello);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toContain("already accepted");
  });

  test("duplicate reserve is refused after the FIFO slot is consumed", () => {
    const { boot, hs } = publishedHandshake();
    expect(hs.acceptHello(goodHello(boot)).ok).toBe(true);
    const first = hs.reserveWork();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.seq).toBe(RESERVE_SEQ_FIRST);
    expect(hs.reservedFrame).toEqual(first.value);

    const second = hs.reserveWork();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("duplicate reserve");
    expect(hs.state).toBe("reserved");
    expect(hs.reservedFrame).toEqual(first.value); // unchanged by the refusal
  });

  test("refuses unknown protocol version on bootstrap, hello, and reserve", () => {
    const boot = sampleBootstrap();
    const reserve = makeReserve({ executionId: boot.executionId, identity });
    const badFrames = [
      { ...boot, v: 99 },
      { ...goodHello(boot), v: 99 },
      { ...reserve, v: 99 },
    ];
    for (const bad of badFrames) {
      const result = decodeFrameLine(JSON.stringify(bad));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("unsupported protocol version");
    }
    const direct = decodeReserve({ ...reserve, v: 0 });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.reason).toContain("unsupported protocol version");
  });

  test("reserve frame is closed and round-trips through the framer", () => {
    const boot = sampleBootstrap();
    const reserve = makeReserve({ executionId: boot.executionId, identity });
    expect(reserve.kind).toBe("reserve");
    expect(reserve.seq).toBe(RESERVE_SEQ_FIRST);
    const enc = encodeFrame(reserve);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(decodeFrameLine(enc.value)).toEqual({ ok: true, value: reserve });
    expect(decodeReserve({ ...reserve, extra: 1 }).ok).toBe(false);

    const framer = new ControlPipeFramer();
    expect(framer.push(`${enc.value}\n`)).toEqual([{ ok: true, value: reserve }]);
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
