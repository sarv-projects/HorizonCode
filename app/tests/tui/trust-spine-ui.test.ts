/**
 * trust-spine-ui.test.ts — Wave A / Track A4 regression tests:
 *   1. Human-principal signed / unsigned badge in approvalCard()
 *   2. composeStatusBar() chips (eh:require, egress:advisory vs egress:netns+tls, pii:3 masked)
 *   3. status-line.ts stdin JSON payload includes trust-spine fields
 *   4. toolVerb("code_mode") displays active sandbox posture
 *   5. /reconcile dispatch + 3 kernel effect.owner.recover modes
 *   6. Fullscreen UNKNOWN / R170 latch persistent warning banner row
 *   7. Host-gated /skill save <name> [description] feature-detection
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Runtime } from "../../src/contracts";
import { approvalCard, formatPrincipalBadge } from "../../src/tui/approval-card";
import { buildFullscreenFrame, LATCH_BANNER_STYLE } from "../../src/tui/fullscreen-layout";
import { tryRunFullscreenLocalSlash } from "../../src/tui/fullscreen-slash";
import { runSkillSlashCommand, type PlanCommandState } from "../../src/tui/interactive";
import { composeStatusBar, toolVerb } from "../../src/tui/live";
import { formatFullscreenLatchBanner } from "../../src/tui/reconcile-block-chip";
import type { Renderer } from "../../src/tui/render";
import { isFullscreenLocalSlash } from "../../src/tui/slash-dispatch";
import { buildStatusLinePayload } from "../../src/tui/status-line";
import { strip } from "../../src/tui/style";
import { EFFECT_OWNER_RECOVER_MODES, runReconcileCommand } from "../../src/tui/unknown-slash";

function mockRenderer(): Renderer & { lines: string[]; notices: string[]; chunks: string[] } {
  const lines: string[] = [];
  const notices: string[] = [];
  const chunks: string[] = [];
  return {
    lines,
    notices,
    chunks,
    line: (t) => lines.push(t),
    notice: (t) => notices.push(t),
    write: (t) => chunks.push(t),
    handle: () => {},
    ensureLineStart: () => {},
    error: (t) => notices.push(t),
    atLineStart: () => true,
    lastThinking: () => "",
  };
}

function minimalRuntime(overrides: Record<string, unknown> = {}): Runtime {
  return {
    sessionId: "s-trust-spine",
    model: "claude-sonnet-4",
    providerName: "anthropic",
    kernelMode: "trusted",
    send: async () => ({ exit: { terminal: "succeeded" } }),
    abort: () => {},
    ...overrides,
  } as unknown as Runtime;
}

describe("Track A4 — 1: Human-Principal Signed Badge in approvalCard", () => {
  test("renders ed25519 signed badge with key fingerprint", () => {
    const lines = approvalCard({
      kind: "shell.exec",
      title: "Run command",
      detail: "ls -la",
      width: 72,
      principalMode: "ed25519",
      principalKeyFingerprint: "a1b2c3d4e5f6",
    });
    const plain = lines.map(strip).join("\n");
    expect(plain).toContain("principal: ed25519 (a1b2c3d4e5f6)");
    expect(formatPrincipalBadge("ed25519", "a1b2c3d4e5f6")).toBe("principal: ed25519 (a1b2c3d4e5f6)");
  });

  test("renders unsigned parent-pipe badge when unsigned or parent", () => {
    const unsignedLines = approvalCard({
      kind: "fs.write",
      title: "Write file",
      detail: "app.ts",
      width: 72,
      principalMode: "unsigned",
    });
    const parentLines = approvalCard({
      kind: "fs.write",
      title: "Write file",
      detail: "app.ts",
      width: 72,
      principalMode: "parent",
    });
    expect(unsignedLines.map(strip).join("\n")).toContain("principal: parent-pipe (unsigned)");
    expect(parentLines.map(strip).join("\n")).toContain("principal: parent-pipe (unsigned)");
  });
});

describe("Track A4 — 2: EffectHost, Egress/Netns, PII-Vault status chips & code_mode toolVerb", () => {
  test("composeStatusBar renders eh:require, egress:advisory, and pii:3 masked", () => {
    const bar = strip(
      composeStatusBar(
        {
          badge: "PLAN",
          model: "claude-sonnet-4",
          provider: "anthropic",
          path: "~/proj",
          effectHostMode: "require",
          egressPosture: { netns: true, tlsMode: "terminate", enforced: false },
          piiVault: { active: true, tokenCount: 3 },
        },
        140,
      ),
    );
    expect(bar).toContain("eh:require");
    expect(bar).toContain("egress:advisory");
    expect(bar).not.toContain("egress:netns+tls");
    expect(bar).not.toContain("enforced");
    expect(bar).toContain("pii:3 masked");
  });

  test("composeStatusBar renders egress:netns+tls ONLY when enforced === true", () => {
    const enforcedBar = strip(
      composeStatusBar(
        {
          badge: "",
          model: "claude-sonnet-4",
          provider: "anthropic",
          path: "~/proj",
          egressPosture: { netns: true, tlsMode: "terminate", enforced: true },
          piiVault: { active: true, tokenCount: 0 },
        },
        140,
      ),
    );
    expect(enforcedBar).toContain("egress:netns+tls");
    expect(enforcedBar).not.toContain("egress:advisory");
    // tokenCount === 0 should NOT render pii chip
    expect(enforcedBar).not.toContain("masked");
  });

  test("toolVerb('code_mode') displays active sandbox posture", () => {
    expect(toolVerb("code_mode")).toBe("Running code_mode (sandbox)");
    expect(toolVerb("code_mode", { sandbox: "vm+netns" })).toBe("Running code_mode (vm+netns)");
  });

  test("buildStatusLinePayload includes trust-spine fields for stdin JSON", () => {
    const payload = buildStatusLinePayload({
      badge: "",
      model: "m",
      provider: "p",
      path: "~/ws",
      effectHostMode: "require",
      egressPosture: { netns: false, tlsMode: "off", enforced: false },
      piiVault: { active: true, tokenCount: 2 },
      principalMode: "ed25519",
      principalKeyFingerprint: "deadbeef1234",
    });
    expect(payload.effectHostMode).toBe("require");
    expect(payload.egressPosture).toEqual({ netns: false, tlsMode: "off", enforced: false });
    expect(payload.piiVault).toEqual({ active: true, tokenCount: 2 });
    expect(payload.principalMode).toBe("ed25519");
    expect(payload.principalKeyFingerprint).toBe("deadbeef1234");
  });
});

describe("Track A4 — 3: /reconcile dispatch & Fullscreen UNKNOWN R170 Latch Banner", () => {
  test("/reconcile is a fullscreen local slash command and shows the 3 kernel recover modes", async () => {
    expect(isFullscreenLocalSlash("reconcile")).toBe(true);
    expect(EFFECT_OWNER_RECOVER_MODES).toEqual([
      "prepare_only",
      "executed_unknown_abandon",
      "executed_unknown_observe_settle",
    ]);

    const ws = mkdtempSync(path.join(tmpdir(), "hz-a4-reconcile-"));
    try {
      const renderer = mockRenderer();
      const planState: PlanCommandState = { on: false };
      const rt = minimalRuntime({
        workspace: ws,
        unknownEffects: () => [],
        reconcileBlockLatch: () => ({ latched: false, mode: "off" as const }),
      });
      const consumed = await tryRunFullscreenLocalSlash("/reconcile", {
        runtime: rt,
        renderer,
        workspace: ws,
        write: () => {},
        planState,
      });
      expect(consumed).toBe(true);
      const output = [...renderer.lines, ...renderer.notices].map(strip).join("\n");
      expect(output).toContain("prepare_only");
      expect(output).toContain("executed_unknown_abandon");
      expect(output).toContain("executed_unknown_observe_settle");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("/reconcile recover invokes ownerRecover with validated recovery mode", async () => {
    const calls: Array<{ effectId: string; mode?: string }> = [];
    const renderer = mockRenderer();
    const rt = minimalRuntime({
      unknownEffects: () => [{ effectId: "eff-1234567890", tool: "write", state: "UNKNOWN" }],
      ownerRecover: async (effectId: string, opts?: { mode?: string }) => {
        calls.push({ effectId, mode: opts?.mode });
      },
    });
    await runReconcileCommand(rt, renderer, "recover eff-1234 executed_unknown_observe_settle");
    expect(calls).toEqual([
      { effectId: "eff-1234567890", mode: "executed_unknown_observe_settle" },
    ]);
    expect(renderer.notices.join("\n")).toContain("executed_unknown_observe_settle");
  });

  test("fullscreen UNKNOWN R170 latch banner formats and paints high-visibility row 1", () => {
    const banner = formatFullscreenLatchBanner(2, { latched: true, mode: "session" });
    expect(banner).toBe("⚠ R170 LATCH ACTIVE (2 UNKNOWN) — run /reconcile to inspect or recover");
    expect(formatFullscreenLatchBanner(0, { latched: false, mode: "off" })).toBeUndefined();

    const frame = buildFullscreenFrame({
      width: 90,
      height: 10,
      status: "PLAN · claude-sonnet-4",
      banner,
      transcript: ["hello world"],
      input: "",
    });
    // Row 1 should contain the banner text and carry LATCH_BANNER_STYLE
    const row1Cells = frame.cells.slice(frame.width, frame.width * 2);
    const row1Text = row1Cells.map((c) => c.ch).join("").trimEnd();
    expect(row1Text).toContain("R170 LATCH ACTIVE (2 UNKNOWN)");
    expect(row1Text).toContain("/reconcile");
    expect(row1Cells[0]?.style).toEqual(LATCH_BANNER_STYLE);
  });
});

describe("Track A4 — 4: Host-gated /skill save <name> command", () => {
  test("validates usage and gracefully handles missing Track A3 codemode/skills hooks", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-a4-skill-"));
    try {
      const r1 = mockRenderer();
      await runSkillSlashCommand("save", minimalRuntime(), r1, ws);
      expect(r1.notices.join("\n")).toContain("usage: /skill save <name> [description]");

      const r2 = mockRenderer();
      await runSkillSlashCommand("save deploy-check Verify deployment", minimalRuntime(), r2, ws);
      const out = r2.notices.join("\n");
      // Either reports missing verified script / module unavailable cleanly without crashing
      expect(out.length).toBeGreaterThan(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
