import { describe, expect, test, afterEach } from "bun:test";
import { LocalKernel } from "../../src/core/kernel";
import { HUMAN_APPROVAL_PRINCIPAL, humanApprovalOwner, ownerVisibleToSession } from "../../src/core/human-approval-principal";
import { mintHumanApprovalLease } from "../../src/core/human-approval-principal";
import { HUMAN_PRINCIPAL_STRICT_ENV } from "../../src/core/human-approval-principal-strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("human approval principal (reduced)", () => {
  test("ownerVisibleToSession accepts human:<sessionId>", () => {
    expect(ownerVisibleToSession(humanApprovalOwner("sess-a"), "sess-a")).toBe(true);
    expect(ownerVisibleToSession("sess-a", "sess-a")).toBe(true);
    expect(ownerVisibleToSession(humanApprovalOwner("sess-a"), "sess-b")).toBe(false);
    expect(ownerVisibleToSession(undefined, "sess-a")).toBe(true);
  });

  test("mintHumanApprovalLease stamps owner and principal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-human-principal-"));
    const state = path.join(root, "state");
    fs.mkdirSync(path.join(state, "events"), { recursive: true });
    fs.writeFileSync(
      path.join(state, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
    );
    const ws = path.join(root, "ws");
    fs.mkdirSync(ws);
    const kernel = new LocalKernel({ stateDir: state, policy: [{ kind: "fs.write", scope: "workspace", decision: "ask" }] });
    const target = path.join(ws, "note.txt");
    const sessionId = "session-human-1";

    const lease = await mintHumanApprovalLease(kernel, "fs.write", target, sessionId, 60_000);
    expect(lease.owner).toBe(humanApprovalOwner(sessionId));
    expect(lease.principal).toBe(HUMAN_APPROVAL_PRINCIPAL);

    const admitted = await kernel.checkGuard({ kind: "fs.write", target }, "workspace", [], sessionId);
    expect(admitted.decision).toBe("ask");
    expect(admitted.leaseId).toBe(lease.leaseId);

    const childSession = await kernel.checkGuard({ kind: "fs.write", target }, "workspace", [], "child-session");
    expect(childSession.decision).toBe("ask");
    expect(childSession.leaseId).toBeUndefined();

    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("HZ_HUMAN_PRINCIPAL_STRICT=1 (ruling 717)", () => {
    const prev = process.env[HUMAN_PRINCIPAL_STRICT_ENV];
    afterEach(() => {
      if (prev === undefined) delete process.env[HUMAN_PRINCIPAL_STRICT_ENV];
      else process.env[HUMAN_PRINCIPAL_STRICT_ENV] = prev;
    });

    test("refuses raw makeLease; human approval path still mints", async () => {
      process.env[HUMAN_PRINCIPAL_STRICT_ENV] = "1";
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-human-strict-"));
      const state = path.join(root, "state");
      fs.mkdirSync(path.join(state, "events"), { recursive: true });
      fs.writeFileSync(
        path.join(state, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
      );
      const ws = path.join(root, "ws");
      fs.mkdirSync(ws);
      const kernel = new LocalKernel({
        stateDir: state,
        policy: [{ kind: "fs.write", scope: "workspace", decision: "ask" }],
      });
      const target = path.join(ws, "note.txt");
      const sessionId = "session-strict-1";

      await expect(kernel.makeLease("fs.write", target, 60_000, sessionId)).rejects.toThrow(
        /HZ_HUMAN_PRINCIPAL_STRICT/,
      );

      const lease = await mintHumanApprovalLease(kernel, "fs.write", target, sessionId, 60_000);
      expect(lease.principal).toBe(HUMAN_APPROVAL_PRINCIPAL);

      fs.rmSync(root, { recursive: true, force: true });
    });
  });
});