import { describe, expect, it } from "bun:test";
import { renderGoalRoundPrompt, runAutonomousGoalLoop } from "../../src/core/goal-runner";

describe("goal-runner (stolen from deepseek-harness goal-round-driver & lecture-13)", () => {
  it("renders goal round prompt with objective and round number", () => {
    const prompt = renderGoalRoundPrompt("Implement payment gateway", 1, 5);
    expect(prompt).toContain("<goal_round>");
    expect(prompt).toContain('Objective: "Implement payment gateway"');
    expect(prompt).toContain("Round: 1/5");
    expect(prompt).toContain("</goal_round>");
  });

  it("includes previous feedback when provided", () => {
    const prompt = renderGoalRoundPrompt("Implement payment gateway", 2, 5, "Layer 2 test failed: AssertionError");
    expect(prompt).toContain("[VERIFICATION FEEDBACK FROM PREVIOUS ROUND]");
    expect(prompt).toContain("Layer 2 test failed: AssertionError");
  });

  it("runs autonomous goal loop and marks achieved when verification gate passes", async () => {
    const sentPrompts: string[] = [];
    let goalStatus = "";

    const fakeRuntime: any = {
      send: async (prompt: string, cb?: any) => {
        sentPrompts.push(prompt);
      },
      setGoal: async (objective: string, status: string) => {
        goalStatus = status;
      },
      lastChangedPaths: [], // No unverified files
    };

    const lines: string[] = [];
    const fakeRenderer = {
      line: (msg: string) => lines.push(msg),
      notice: (msg: string) => lines.push(msg),
    };

    const result = await runAutonomousGoalLoop("Build feature X", fakeRuntime, fakeRenderer, {
      workspace: "/tmp",
      maxRounds: 3,
    });

    expect(result.status).toBe("achieved");
    expect(result.roundsRun).toBe(1);
    expect(goalStatus).toBe("achieved");
    expect(sentPrompts.length).toBe(1);
  });
});
