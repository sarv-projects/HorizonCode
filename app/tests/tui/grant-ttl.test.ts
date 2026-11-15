import { describe, expect, test } from "bun:test";
import { formatGrantRemainingForApproval, grantRemainingMinutesFromMs } from "../../src/tui/grant-ttl";

describe("formatGrantRemainingForApproval", () => {
  test("sub-minute shows seconds", () => {
    expect(formatGrantRemainingForApproval(45_000)).toBe("~45s");
  });

  test("under five minutes shows m and s", () => {
    expect(formatGrantRemainingForApproval(125_000)).toBe("~2m 5s");
  });

  test("five minutes or more rounds to minutes", () => {
    expect(formatGrantRemainingForApproval(300_000)).toBe("~5 minutes");
    expect(formatGrantRemainingForApproval(60_000)).toBe("~1 minute");
  });

  test("grantRemainingMinutesFromMs unchanged ceiling", () => {
    expect(grantRemainingMinutesFromMs(90_000)).toBe(2);
  });
});