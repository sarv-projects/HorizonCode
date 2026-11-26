/**
 * permission-defect-tunnel-steering.test.ts — Track 2 P0 verification suite:
 * 1. Permission Defect Tunnel (`PermissionDeclinedError` never swallowed by tool catch/wrappers).
 * 2. Steering feedback propagation (`PermissionCorrectedError` stays structured to the loop).
 * 3. 3-stage Reject-with-Steering UX in both inline and fullscreen TUI approval prompts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApprovalRequest, GuardAction, Lease, Runtime, Tool, ToolContext } from "../src/contracts";
import {
  CorrectedError,
  PERMISSION_CORRECTED_BRAND,
  PERMISSION_DECLINED_BRAND,
  PermissionCorrectedError,
  PermissionDeclinedError,
  UserDeclinedDefect,
  formatSteeringToolOutput,
  isPermissionCorrectedError,
  isPermissionDeclinedError,
  mapToolErrorKeepingDecline,
  mapToolErrorKeepingDeclineAsync,
  normalizeApprovalOutcome,
  tunnelDecline,
  tunnelPermissionError,
} from "../src/core/guards/defect-tunnel";
import { GuardGate } from "../src/core/loop";
import type { KernelClient } from "../src/core/kernel";
import { executeToolWithDefectTunnel, wrapToolWithDefectTunnel } from "../src/tools";
import {
  createApprovalHandler,
  createApprovalUi,
  createStructuredApprovalHandler,
  parseInlineSteeringAnswer,
} from "../src/tui/approval";
import {
  approvalCard,
  createApprovalStageState,
  reduceApprovalStageKey,
  type ApprovalStageResolution,
  type ApprovalStageState,
} from "../src/tui/approval-card";
import { normalizeApprovalKeyPrompt } from "../src/tui/approval-key-prompt";
import {
  APPROVAL_TYPE_AHEAD_MS,
  consumeFullscreenStagedApprovalKey,
  fullscreenApprovalStageStatusExtra,
} from "../src/tui/fullscreen-approval";
import {
  permissionAlwaysConfirmLines,
  permissionRejectSteeringLines,
} from "../src/tui/permission-presentation";
import { createRenderer } from "../src/tui/render";
import { colorEnabled, setColorEnabled, strip, visibleWidth } from "../src/tui/style";

let prevColor = false;
beforeAll(() => {
  prevColor = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(prevColor));

function fakeToolContext(): ToolContext {
  return {
    cwd: "/ws",
    workspace: "/ws",
    sessionId: "sess-track2",
    signal: new AbortController().signal,
    guard: async () => ({ decision: "allow" }),
    approve: async () => true,
    receipt: async () => ({ id: "r1", seq: 1 }),
  };
}

function fakeKernelAsk(): KernelClient {
  return {
    checkGuard: async () => ({ decision: "ask" as const, reason: "requires approval" }),
  } as unknown as KernelClient;
}

describe("Track 2: Permission Defect Tunnel", () => {
  test("PermissionDeclinedError and UserDeclinedDefect carry branded symbol and tunnel through sync/async mappers", async () => {
    const declined = new PermissionDeclinedError("user said no", { kind: "shell.exec", target: "rm -rf build" });
    const legacy = new UserDeclinedDefect();
    const crossRealm = { [PERMISSION_DECLINED_BRAND]: true, message: "foreign decline" };

    expect(isPermissionDeclinedError(declined)).toBe(true);
    expect(isPermissionDeclinedError(legacy)).toBe(true);
    expect(isPermissionDeclinedError(crossRealm)).toBe(true);
    expect(isPermissionDeclinedError(new PermissionCorrectedError("steer"))).toBe(false);
    expect(isPermissionDeclinedError(new Error("boom"))).toBe(false);

    expect(() =>
      mapToolErrorKeepingDecline(
        () => {
          throw declined;
        },
        () => ({ ok: false, output: "swallowed" }),
      ),
    ).toThrow(PermissionDeclinedError);

    await expect(
      mapToolErrorKeepingDeclineAsync(
        async () => {
          throw declined;
        },
        () => ({ ok: false, output: "swallowed" }),
      ),
    ).rejects.toBe(declined);

    expect(() => tunnelDecline(crossRealm)).toThrow();
  });

  test("wrapToolWithDefectTunnel and executeToolWithDefectTunnel never swallow PermissionDeclinedError", async () => {
    const throwingTool: Tool = {
      name: "dangerous_tool",
      description: "test tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new PermissionDeclinedError("declined by user", { kind: "shell.exec", target: "rm -rf /" });
      },
    };

    const wrapped = wrapToolWithDefectTunnel(throwingTool, (err) => ({
      ok: false,
      output: `mapped: ${err instanceof Error ? err.message : String(err)}`,
      error: "mapped",
    }));

    await expect(wrapped.execute({}, fakeToolContext())).rejects.toBeInstanceOf(PermissionDeclinedError);
    await expect(
      executeToolWithDefectTunnel(throwingTool, {}, fakeToolContext(), () => ({
        ok: false,
        output: "swallowed",
        error: "swallowed",
      })),
    ).rejects.toBeInstanceOf(PermissionDeclinedError);
  });

  test("wrapToolWithDefectTunnel still maps ordinary tool errors normally", async () => {
    const failingTool: Tool = {
      name: "ordinary_tool",
      description: "test tool",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("ENOENT: file not found");
      },
    };

    const wrapped = wrapToolWithDefectTunnel(failingTool, (err) => ({
      ok: false,
      output: `handled: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    }));

    const result = await wrapped.execute({}, fakeToolContext());
    expect(result.ok).toBe(false);
    expect(result.output).toBe("handled: ENOENT: file not found");
  });

  test("PermissionCorrectedError preserves structured steering feedback across mappers and tunnelPermissionError", async () => {
    const corrected = new PermissionCorrectedError("  use src/safe.ts instead of src/prod.ts  ", {
      kind: "fs.write",
      target: "/ws/src/prod.ts",
    });
    const legacy = new CorrectedError("run unit tests only");
    const crossRealm = { [PERMISSION_CORRECTED_BRAND]: true, feedback: "foreign steer" };

    expect(corrected.feedback).toBe("use src/safe.ts instead of src/prod.ts");
    expect(corrected.message).toBe("use src/safe.ts instead of src/prod.ts");
    expect(isPermissionCorrectedError(corrected)).toBe(true);
    expect(isPermissionCorrectedError(legacy)).toBe(true);
    expect(isPermissionCorrectedError(crossRealm)).toBe(true);
    expect(isPermissionCorrectedError(new PermissionDeclinedError())).toBe(false);

    // Sync mapper maps CorrectedError (not a plain decline defect)
    const mapped = mapToolErrorKeepingDecline(
      () => {
        throw corrected;
      },
      (err) => ({
        ok: false,
        output: formatSteeringToolOutput(isPermissionCorrectedError(err) ? err.feedback : ""),
      }),
    );
    expect(mapped).toEqual({
      ok: false,
      output: "User rejected this action with steering instructions: use src/safe.ts instead of src/prod.ts",
    });

    // tunnelPermissionError preserves both declined and corrected errors for outer loop boundaries
    expect(() => tunnelPermissionError(corrected)).toThrow(PermissionCorrectedError);
    expect(() => tunnelPermissionError(new PermissionDeclinedError())).toThrow(PermissionDeclinedError);
    expect(tunnelPermissionError(new Error("normal"))).toBeUndefined();
  });

  test("GuardGate propagates PermissionDeclinedError and PermissionCorrectedError without swallowing", async () => {
    const action: GuardAction = { kind: "shell.exec", target: "npm run deploy" };
    const req: ApprovalRequest = { kind: "shell.exec", title: "Deploy", detail: "npm run deploy" };

    // 1. Plain PermissionDeclinedError tunnels out of GuardGate.approve
    const gateDeclined = new GuardGate(
      "/ws",
      fakeKernelAsk(),
      [],
      () => async () => {
        throw new PermissionDeclinedError("declined", { kind: "shell.exec", target: "npm run deploy" });
      },
      "sess-1",
    );
    await expect(gateDeclined.approve(req, action)).rejects.toBeInstanceOf(PermissionDeclinedError);

    // 2. PermissionCorrectedError propagates steering feedback out of GuardGate.approve
    const gateCorrected = new GuardGate(
      "/ws",
      fakeKernelAsk(),
      [],
      () => async () => {
        throw new PermissionCorrectedError("run dry-run instead", { kind: "shell.exec", target: "npm run deploy" });
      },
      "sess-1",
    );
    try {
      await gateCorrected.approve(req, action);
      expect.unreachable("expected PermissionCorrectedError");
    } catch (err) {
      expect(isPermissionCorrectedError(err)).toBe(true);
      if (isPermissionCorrectedError(err)) {
        expect(err.feedback).toBe("run dry-run instead");
        expect(err.kind).toBe("shell.exec");
        expect(err.target).toBe("npm run deploy");
      }
    }

    // 3. StructuredApprovalOutcome { decision: "rejected_with_steering" } converts to PermissionCorrectedError
    const gateStructured = new GuardGate(
      "/ws",
      fakeKernelAsk(),
      [],
      () =>
        (async () => ({
          decision: "rejected_with_steering",
          feedback: "only touch tests/",
        })) as unknown as () => Promise<boolean>,
      "sess-1",
    );
    try {
      await gateStructured.approve(req, action);
      expect.unreachable("expected PermissionCorrectedError");
    } catch (err) {
      expect(isPermissionCorrectedError(err)).toBe(true);
      if (isPermissionCorrectedError(err)) {
        expect(err.feedback).toBe("only touch tests/");
      }
    }

    // 4. Ordinary unexpected handler error still fails closed (returns false)
    const gateFailClosed = new GuardGate(
      "/ws",
      fakeKernelAsk(),
      [],
      () => async () => {
        throw new Error("tty disconnected");
      },
      "sess-1",
    );
    expect(await gateFailClosed.approve(req, action)).toBe(false);
    expect(normalizeApprovalOutcome(true)).toEqual({ decision: "approved", scope: "once" });
    expect(normalizeApprovalOutcome(false)).toEqual({ decision: "declined" });
  });
});

describe("Track 2: 3-Stage Reject-with-Steering State Machine", () => {
  test("Stage 1 -> Stage 2 (always_confirm) -> confirm always and Esc back to Stage 1", () => {
    const s0 = createApprovalStageState({ canAlways: true, alwaysPattern: "npm test" });
    expect(s0.stage).toBe("permission");

    // Press 'a' -> Stage 2
    const step1 = reduceApprovalStageKey(s0, "a", { name: "a" });
    expect(step1.done).toBe(false);
    expect(step1.state.stage).toBe("always_confirm");

    // Card in Stage 2 shows exact pattern/scope
    const card2 = approvalCard({
      kind: "shell.exec",
      title: "Shell command",
      detail: "npm test",
      width: 68,
      stage: step1.state.stage,
      alwaysPattern: step1.state.alwaysPattern,
    });
    const plain2 = card2.map(strip).join("\n");
    expect(plain2).toContain("Confirm always");
    expect(plain2).toContain("Pattern: npm test");
    expect(plain2).toContain("Enter/y confirm always");
    for (const line of card2) expect(visibleWidth(line)).toBe(68);

    // Press Esc -> back to Stage 1
    const back = reduceApprovalStageKey(step1.state, "\u001b", { name: "escape" });
    expect(back.done).toBe(false);
    expect(back.state.stage).toBe("permission");

    // Press 'a' again -> Stage 2 -> Enter confirms always
    const step2 = reduceApprovalStageKey(back.state, "a", { name: "a" });
    const confirmed = reduceApprovalStageKey(step2.state, "\r", { name: "return" });
    expect(confirmed.done).toBe(true);
    if (confirmed.done) {
      expect(confirmed.resolution).toEqual({ kind: "approved", scope: "always" });
    }
  });

  test("Stage 1 ignores 'a' when canAlways is false", () => {
    const s0 = createApprovalStageState({ canAlways: false });
    const step = reduceApprovalStageKey(s0, "a", { name: "a" });
    expect(step.done).toBe(false);
    expect(step.state.stage).toBe("permission");
  });

  test("Stage 1 -> Stage 3 (reject_steer) with steering text, editing, and Enter", () => {
    let st: ApprovalStageState = createApprovalStageState({ canAlways: true, alwaysPattern: "rm -rf dist" });

    // Press 'n' -> Stage 3
    let step = reduceApprovalStageKey(st, "n", { name: "n" });
    expect(step.done).toBe(false);
    st = step.state;
    expect(st.stage).toBe("reject_steer");

    // Type "use rm -rf buildx", backspace 'x', press Enter
    for (const ch of "use rm -rf buildx") {
      step = reduceApprovalStageKey(st, ch, { name: ch });
      expect(step.done).toBe(false);
      st = step.state;
    }
    step = reduceApprovalStageKey(st, undefined, { name: "backspace" });
    expect(step.done).toBe(false);
    st = step.state;
    expect(st.steeringInput).toBe("use rm -rf build");

    // Card in Stage 3 renders steering prompt and live input
    const card3 = approvalCard({
      kind: "shell.exec",
      title: "Shell command",
      detail: "rm -rf dist",
      width: 68,
      stage: st.stage,
      steeringInput: st.steeringInput,
    });
    const plain3 = card3.map(strip).join("\n");
    expect(plain3).toContain("Reject & steer");
    expect(plain3).toContain("use rm -rf build");
    expect(plain3).toContain("Enter confirm reject");
    for (const line of card3) expect(visibleWidth(line)).toBe(68);

    const final = reduceApprovalStageKey(st, "\r", { name: "return" });
    expect(final.done).toBe(true);
    if (final.done) {
      expect(final.resolution).toEqual({
        kind: "rejected_with_steering",
        feedback: "use rm -rf build",
      });
    }
  });

  test("Stage 1 -> Stage 3 -> Enter with empty text returns plain declined", () => {
    const s0 = createApprovalStageState({ canAlways: true });
    const s3 = reduceApprovalStageKey(s0, "n", { name: "n" }).state;
    expect(s3.stage).toBe("reject_steer");

    const final = reduceApprovalStageKey(s3, "\r", { name: "return" });
    expect(final.done).toBe(true);
    if (final.done) {
      expect(final.resolution).toEqual({ kind: "declined" });
    }
  });

  test("Stage 3 Esc cancels back to Stage 1 and Ctrl+C clears text before returning", () => {
    const s0 = createApprovalStageState({ canAlways: true });
    let st = reduceApprovalStageKey(s0, "r", { name: "r" }).state;
    st = reduceApprovalStageKey(st, "h", { name: "h" }).state;
    st = reduceApprovalStageKey(st, "i", { name: "i" }).state;
    expect(st.steeringInput).toBe("hi");

    // First Ctrl+C clears buffer
    st = reduceApprovalStageKey(st, "\u0003", { name: "c", ctrl: true }).state;
    expect(st.stage).toBe("reject_steer");
    expect(st.steeringInput).toBe("");

    // Second Ctrl+C returns to Stage 1
    st = reduceApprovalStageKey(st, "\u0003", { name: "c", ctrl: true }).state;
    expect(st.stage).toBe("permission");

    // Re-enter Stage 3, type text, press Esc -> back to Stage 1 with cleared buffer
    st = reduceApprovalStageKey(st, "n", { name: "n" }).state;
    st = reduceApprovalStageKey(st, "x", { name: "x" }).state;
    const escaped = reduceApprovalStageKey(st, "\u001b", { name: "escape" });
    expect(escaped.done).toBe(false);
    expect(escaped.state.stage).toBe("permission");
    expect(escaped.state.steeringInput).toBe("");
  });
});

describe("Track 2: Fullscreen & Inline 3-Stage TUI Integration", () => {
  test("fullscreen staged approval enforces type-ahead, paste-block, and drives 3 stages", () => {
    const armedAt = 1000;
    let state = createApprovalStageState({ canAlways: true, alwaysPattern: "bun test" });

    expect(fullscreenApprovalStageStatusExtra("permission")).toContain("y once");
    expect(fullscreenApprovalStageStatusExtra("always_confirm")).toContain("confirm always");
    expect(fullscreenApprovalStageStatusExtra("reject_steer")).toContain("reject & steer");

    // Type-ahead ignored in Stage 1
    expect(
      consumeFullscreenStagedApprovalKey(state, armedAt, armedAt - 1, false, { name: "y" }, "y"),
    ).toEqual({ kind: "ignore" });

    // Paste blocked in Stage 1
    expect(
      consumeFullscreenStagedApprovalKey(state, armedAt, armedAt + APPROVAL_TYPE_AHEAD_MS, true, { name: "y" }, "y"),
    ).toEqual({ kind: "paste-block" });

    // Transition Stage 1 -> Stage 2 -> paste blocked in Stage 2 -> Esc back to Stage 1
    const toAlways = consumeFullscreenStagedApprovalKey(state, armedAt, armedAt + 10, false, { name: "a" }, "a");
    expect(toAlways.kind).toBe("transition");
    if (toAlways.kind === "transition") {
      state = toAlways.state;
      expect(state.stage).toBe("always_confirm");
    }
    expect(
      consumeFullscreenStagedApprovalKey(state, armedAt, armedAt + 20, true, { name: "y" }, "y"),
    ).toEqual({ kind: "paste-block" });

    const backToStage1 = consumeFullscreenStagedApprovalKey(
      state,
      armedAt,
      armedAt + 30,
      false,
      { name: "escape" },
      "\u001b",
    );
    expect(backToStage1.kind).toBe("transition");
    if (backToStage1.kind === "transition") {
      state = backToStage1.state;
      expect(state.stage).toBe("permission");
    }

    // Transition Stage 1 -> Stage 3 -> type steering -> Enter resolves rejected_with_steering
    const toReject = consumeFullscreenStagedApprovalKey(state, armedAt, armedAt + 40, false, { name: "n" }, "n");
    expect(toReject.kind).toBe("transition");
    if (toReject.kind === "transition") state = toReject.state;

    for (const ch of "check git status first") {
      const typed = consumeFullscreenStagedApprovalKey(state, armedAt, armedAt + 50, false, { name: ch }, ch);
      expect(typed.kind).toBe("transition");
      if (typed.kind === "transition") state = typed.state;
    }

    const resolved = consumeFullscreenStagedApprovalKey(
      state,
      armedAt,
      armedAt + 60,
      false,
      { name: "return" },
      "\r",
    );
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") {
      expect(resolved.resolution).toEqual({
        kind: "rejected_with_steering",
        feedback: "check git status first",
      });
    }
  });

  test("inline 3-stage line mode supports always confirmation with Esc back and reject steering", async () => {
    const req: ApprovalRequest = { kind: "shell.exec", title: "Run tests", detail: "bun test" };
    const action: GuardAction = { kind: "shell.exec", target: "bun test" };

    // 1. permission -> always -> back -> always -> confirm
    const chunks1: string[] = [];
    const seenLeases: Array<{ kind: string; pattern: string }> = [];
    const ui1 = createApprovalUi(true);
    ui1.threeStage = true;
    ui1.renderer = createRenderer({ wrap: false, out: (c) => void chunks1.push(c) });
    ui1.runtime = {
      grantLease(kind: string, pattern: string): Lease {
        seenLeases.push({ kind, pattern });
        return { leaseId: "l1", kind, pattern, expiry: new Date(Date.now() + 60_000).toISOString() };
      },
    } as unknown as Runtime;
    const answers1 = ["a", "esc", "a", "y"];
    ui1.ask = async () => answers1.shift() ?? "";

    const out1 = await createStructuredApprovalHandler(ui1)(req, action);
    expect(out1).toEqual({ decision: "approved", scope: "always" });
    expect(seenLeases).toEqual([{ kind: "shell.exec", pattern: "bun test" }]);
    expect(chunks1.join("")).toContain("Pattern: bun test");

    // 2. permission -> reject -> steering text -> PermissionCorrectedError through createApprovalHandler
    const ui2 = createApprovalUi(true);
    ui2.threeStage = true;
    ui2.renderer = createRenderer({ wrap: false, out: () => {} });
    const answers2 = ["n", "only run tests/core"];
    ui2.ask = async () => answers2.shift() ?? "";

    const handler2 = createApprovalHandler(ui2) as unknown as (r: ApprovalRequest, a?: GuardAction) => Promise<boolean>;
    await expect(handler2(req, action)).rejects.toMatchObject({
      name: "PermissionCorrectedError",
      feedback: "only run tests/core",
    });

    // 3. permission -> reject -> empty Enter -> plain declined (false by default, PermissionDeclinedError when throwDeclinedDefect=true)
    const ui3 = createApprovalUi(true);
    ui3.threeStage = true;
    ui3.throwDeclinedDefect = true;
    ui3.renderer = createRenderer({ wrap: false, out: () => {} });
    const answers3 = ["n", ""];
    ui3.ask = async () => answers3.shift() ?? "";

    const handler3 = createApprovalHandler(ui3) as unknown as (r: ApprovalRequest, a?: GuardAction) => Promise<boolean>;
    await expect(handler3(req, action)).rejects.toBeInstanceOf(PermissionDeclinedError);
  });

  test("inline askStagedKey renders stage cards via ApprovalKeyPrompt and propagates steering", async () => {
    const req: ApprovalRequest = { kind: "fs.write", title: "Write config", detail: "/ws/a.ts" };
    const action: GuardAction = { kind: "fs.write", target: "/ws/a.ts" };
    const ui = createApprovalUi(true);
    ui.renderer = createRenderer({ wrap: false, out: () => {} });
    let renderedStage3 = "";

    ui.askStagedKey = async (prompt, initial): Promise<ApprovalStageResolution> => {
      const normalized = normalizeApprovalKeyPrompt(prompt);
      expect(normalized.stage).toBe("permission");
      expect(typeof normalized.renderStage).toBe("function");

      let st = reduceApprovalStageKey(initial, "n", { name: "n" }).state;
      for (const ch of "edit b.ts") {
        st = reduceApprovalStageKey(st, ch, { name: ch }).state;
      }
      renderedStage3 = (normalized.renderStage?.(st) ?? []).map(strip).join("\n");
      const done = reduceApprovalStageKey(st, "\r", { name: "return" });
      if (!done.done) throw new Error("expected done");
      return done.resolution;
    };

    const outcome = await createStructuredApprovalHandler(ui)(req, action);
    expect(outcome).toEqual({ decision: "rejected_with_steering", feedback: "edit b.ts" });
    expect(renderedStage3).toContain("Reject & steer");
    expect(renderedStage3).toContain("edit b.ts");
  });

  test("headless auto-deny, presentation helpers, and inline steering shortcut remain intact", async () => {
    const req: ApprovalRequest = { kind: "shell.exec", title: "Run", detail: "npm test" };
    const uiHeadless = createApprovalUi(false);
    uiHeadless.threeStage = true;
    uiHeadless.renderer = createRenderer({ wrap: false, out: () => {} });
    expect(await createStructuredApprovalHandler(uiHeadless)(req)).toEqual({ decision: "declined" });

    expect(parseInlineSteeringAnswer("n: use vitest instead")).toBe("use vitest instead");
    expect(parseInlineSteeringAnswer("reject: keep existing file")).toBe("keep existing file");
    expect(parseInlineSteeringAnswer("n")).toBeUndefined();
    expect(parseInlineSteeringAnswer("no")).toBeUndefined();

    expect(permissionAlwaysConfirmLines("shell.exec", "npm test").join("\n")).toContain("Pattern: npm test");
    expect(permissionRejectSteeringLines("Run tests").join("\n")).toContain("Reject permission: Run tests");
  });
});
