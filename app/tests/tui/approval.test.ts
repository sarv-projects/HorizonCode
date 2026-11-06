/**
 * approval.test.ts — the human side of the guard.
 *
 * These are unit-level calls to the same handler main.ts installs. The headless
 * loop has exactly one approval path and it must fail closed: every "nobody
 * answered" case ends in a denial — never a hang, never a silent yes.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalRequest, Lease, Runtime } from "../../src/contracts";
import { createApprovalHandler, createApprovalUi } from "../../src/tui/approval";
import { createRenderer } from "../../src/tui/render";

interface HarnessOptions {
  interactive: boolean;
  /** what the chat bar types back; omit it to leave the default "nobody there" ask */
  answer?: string;
  askThrows?: boolean;
}

function harness(opts: HarnessOptions) {
  const chunks: string[] = [];
  const ui = createApprovalUi(opts.interactive);
  // Capture the notices instead of writing them into the test runner's output.
  ui.renderer = createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) });
  if (opts.askThrows) {
    ui.ask = async () => {
      throw new Error("the chat bar went away");
    };
  } else if (typeof opts.answer === "string") {
    const answer = opts.answer;
    ui.ask = async () => answer;
  }
  return {
    ui,
    text: () => chunks.join(""),
    answer: (req: ApprovalRequest) => createApprovalHandler(ui)(req),
  };
}

const SHELL: ApprovalRequest = { kind: "shell.exec", title: "run this command", detail: "rm -rf /" };

function leaseRuntime(seen: Array<{ kind: string; pattern: string }> | "throw"): Runtime {
  return {
    grantLease(kind: string, pattern: string): Lease {
      if (seen === "throw") throw new Error("no leases here");
      seen.push({ kind, pattern });
      return { leaseId: "lease-1", kind, pattern, expiry: new Date(Date.now() + 60_000).toISOString() };
    },
  } as unknown as Runtime;
}

describe("approvals in headless mode", () => {
  test("an ask with nobody attached is denied, with a notice saying why", async () => {
    const h = harness({ interactive: false });

    expect(await h.answer(SHELL)).toBe(false);
    expect(h.text()).toContain("approval requested (shell.exec)");
    expect(h.text()).toContain("run this command");
    expect(h.text()).toContain("denied, no one is attached to say yes");
  });

  test("an empty answer denies rather than assuming yes", async () => {
    // interactive, but no line ever arrives (EOF, Ctrl+C, a broken pipe)
    const h = harness({ interactive: true });

    expect(await h.answer(SHELL)).toBe(false);
    expect(h.text()).toContain("no answer");
  });

  test("a prompt that throws denies instead of hanging the turn", async () => {
    const h = harness({ interactive: true, askThrows: true });

    expect(await h.answer(SHELL)).toBe(false);
    expect(h.text()).toContain("no answer");
  });

  test("a malformed request still names a kind and fails closed", async () => {
    const h = harness({ interactive: false });

    expect(await h.answer({} as ApprovalRequest)).toBe(false);
    expect(h.text()).toContain("approval requested (other)");
    expect(h.text()).toContain("denied, no one is attached to say yes");
  });
});

describe("approvals at the chat bar", () => {
  test("yes approves once", async () => {
    const h = harness({ interactive: true, answer: "y" });

    expect(await h.answer(SHELL)).toBe(true);
    expect(h.text()).toContain("approved (this time)");
  });

  test("no denies", async () => {
    const h = harness({ interactive: true, answer: "no" });

    expect(await h.answer(SHELL)).toBe(false);
    expect(h.text()).toContain("denied");
  });

  test("an unrecognised answer denies and echoes what it read", async () => {
    const h = harness({ interactive: true, answer: "maybe later" });

    expect(await h.answer(SHELL)).toBe(false);
    expect(h.text()).toContain('did not understand "maybe later"');
  });

  test("always approves and remembers the decision as a lease", async () => {
    const seen: Array<{ kind: string; pattern: string }> = [];
    const h = harness({ interactive: true, answer: "always" });
    h.ui.runtime = leaseRuntime(seen);

    expect(await h.answer(SHELL)).toBe(true);
    expect(seen).toEqual([{ kind: "shell.exec", pattern: "*" }]);
    expect(h.text()).toContain("approved, and shell.exec is allowed from now on");
  });

  test("always still approves this once when the lease cannot be remembered", async () => {
    const h = harness({ interactive: true, answer: "a" });
    h.ui.runtime = leaseRuntime("throw");

    expect(await h.answer(SHELL)).toBe(true);
    expect(h.text()).toContain("could not remember that decision");
    expect(h.text()).toContain("approved (this time)");
  });
});
