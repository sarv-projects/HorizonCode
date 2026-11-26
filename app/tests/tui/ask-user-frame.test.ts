import { describe, expect, test } from "bun:test";
import type { AskUserRequest } from "../../src/contracts";
import type { ApprovalUi } from "../../src/tui/approval";
import { createAskUserHandler, formatClarifyFrame } from "../../src/tui/ask-user";

describe("TUI Clarify Frame (Ruling 876)", () => {
  test("formatClarifyFrame renders Unicode box borders and structured content", () => {
    const req: AskUserRequest = {
      question: "Which database migration should run?",
      context: "Found pending migrations in db/migrations/",
      options: [
        { label: "001_initial.sql", description: "Create tables", recommended: true },
        { label: "002_tokens.sql", description: "Add auth tokens" },
      ],
      defaultOption: "001_initial.sql",
      multiSelect: false,
      timeoutMs: 30_000,
    };

    const frame = formatClarifyFrame(req);
    expect(frame).toContain("┌─");
    expect(frame).toContain("Clarification Requested");
    expect(frame).toContain("Which database migration should run?");
    expect(frame).toContain("Found pending migrations in db/migrations/");
    expect(frame).toContain("1. 001_initial.sql");
    expect(frame).toContain("(Recommended)");
    expect(frame).toContain("Create tables");
    expect(frame).toContain("2. 002_tokens.sql");
    expect(frame).toContain("Add auth tokens");
    expect(frame).toContain("Enter: default (001_initial.sql)");
    expect(frame).toContain("1-N: select option number");
    expect(frame).toContain("timeout: 30s");
    expect(frame).toContain("└");
  });

  test("formatClarifyFrame supports multi-select hint", () => {
    const req: AskUserRequest = {
      question: "Select features to enable",
      options: [
        { label: "audit_log" },
        { label: "telemetry" },
      ],
      multiSelect: true,
    };

    const frame = formatClarifyFrame(req);
    expect(frame).toContain("1-N: comma-separated numbers");
  });

  test("createAskUserHandler renders clarify frame and resolves option", async () => {
    let written = "";
    const mockUi: ApprovalUi = {
      interactive: true,
      renderer: {
        ensureLineStart() {},
        write(s: string) {
          written += s;
        },
      } as any,
      ask: async () => "1",
    } as any;

    const handler = createAskUserHandler(mockUi);
    const answer = await handler({
      question: "Pick one",
      options: [{ label: "Option A" }, { label: "Option B" }],
    });

    expect(written).toContain("Clarification Requested");
    expect(written).toContain("Pick one");
    expect(answer).toBe("Option A");
  });
});
