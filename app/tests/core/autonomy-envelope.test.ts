import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { GuardAction } from "../../src/contracts";
import {
  classifyEnvelopeAction,
  envelopeAutoApproves,
  envelopeTierForAutonomyName,
  envelopeTierForPreset,
  permissionModeAutoApproves,
} from "../../src/core/autonomy-envelope";
import { pathInsideWorkspace } from "../../src/core/loop";
import { isGitPushCommand, isVerificationShellCommand } from "../../src/core/verification-shell";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

const workspace = tempDir("hz-env-ws-");

const fsw = (target: string): GuardAction => ({ kind: "fs.write", target });
const fsr = (target: string): GuardAction => ({ kind: "fs.read", target });
const shell = (command: string, cwd?: string): GuardAction => ({
  kind: "shell.exec",
  target: command,
  ...(cwd !== undefined ? { detail: { cwd } } : {}),
});

describe("envelope tier classification", () => {
  test("preset ids map to envelope tiers", () => {
    expect(envelopeTierForPreset("pilot")).toBe("pilot-autonomous");
    expect(envelopeTierForPreset("autonomous")).toBe("pilot-autonomous");
    expect(envelopeTierForPreset("unattended")).toBe("unattended");
    expect(envelopeTierForPreset("regulated")).toBe("regulated");
    expect(envelopeTierForPreset("manual")).toBe("interactive");
    expect(envelopeTierForAutonomyName("auto_edits")).toBe("interactive");
  });

  test("classifyEnvelopeAction marks boundaries", () => {
    expect(classifyEnvelopeAction("pilot-autonomous", { kind: "net.fetch", target: "https://x" })).toBe("boundary");
    expect(classifyEnvelopeAction("pilot-autonomous", shell("git push origin main"))).toBe("boundary");
    expect(classifyEnvelopeAction("pilot-autonomous", shell("npm run test"))).toBe("auto-verification-shell");
    expect(classifyEnvelopeAction("unattended", fsw(path.join(workspace, "src/a.ts")))).toBe("auto-write");
  });
});

describe("envelopeAutoApproves", () => {
  test("pilot-autonomous: read + verification shell inside workspace; not push or write", () => {
    const tier = "pilot-autonomous";
    const inside = pathInsideWorkspace;
    expect(envelopeAutoApproves(tier, "default", fsr(path.join(workspace, "a.ts")), workspace, inside)).toBe(true);
    expect(envelopeAutoApproves(tier, "default", shell("bun test"), workspace, inside)).toBe(true);
    expect(envelopeAutoApproves(tier, "default", shell("git push"), workspace, inside)).toBe(false);
    expect(envelopeAutoApproves(tier, "default", fsw(path.join(workspace, "src/a.ts")), workspace, inside)).toBe(false);
    expect(envelopeAutoApproves(tier, "default", { kind: "net.fetch", target: "https://x" }, workspace, inside)).toBe(
      false,
    );
    expect(
      envelopeAutoApproves(tier, "default", fsw(path.join(workspace, "package.json")), workspace, inside),
    ).toBe(false);
  });

  test("unattended: non-sensitive in-workspace write auto; sensitive still blocked at envelope", () => {
    const tier = "unattended";
    const inside = pathInsideWorkspace;
    expect(envelopeAutoApproves(tier, "default", fsw(path.join(workspace, "src/a.ts")), workspace, inside)).toBe(true);
    expect(envelopeAutoApproves(tier, "default", fsw(path.join(workspace, "package.json")), workspace, inside)).toBe(
      false,
    );
  });

  test("regulated: writes via accept-edits path only; not verification shell", () => {
    const tier = "regulated";
    const inside = pathInsideWorkspace;
    expect(envelopeAutoApproves(tier, "accept-edits", shell("npm run test"), workspace, inside)).toBe(false);
    expect(
      envelopeAutoApproves(tier, "accept-edits", fsw(path.join(workspace, "src/a.ts")), workspace, inside),
    ).toBe(true);
    expect(permissionModeAutoApproves(tier, "accept-edits", fsw(path.join(workspace, "src/a.ts")), workspace, inside)).toBe(
      true,
    );
  });

  test("autonomous preset does not get permission-mode write auto-approve", () => {
    expect(
      permissionModeAutoApproves(
        "pilot-autonomous",
        "accept-edits",
        fsw(path.join(workspace, "src/a.ts")),
        workspace,
        pathInsideWorkspace,
      ),
    ).toBe(false);
  });
});

describe("verification-shell helpers", () => {
  test("detects verification and git push", () => {
    expect(isVerificationShellCommand("cd app && npm run typecheck")).toBe(true);
    expect(isVerificationShellCommand("cargo test")).toBe(true);
    expect(isVerificationShellCommand("echo hi")).toBe(false);
    expect(isGitPushCommand("git push origin main")).toBe(true);
    expect(isGitPushCommand("npm run test")).toBe(false);
  });
});