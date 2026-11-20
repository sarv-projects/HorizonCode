import { describe, expect, test } from "bun:test";
import {
  absenceReconstructBlocksVerify,
  formatAbsenceReconstructSummary,
  type AbsenceReconstructSessionSurface,
} from "../../src/core/effect-absent-path-reconstruct";

describe("effect absent-path reconstruct summary (ruling 698)", () => {
  test("format ok and uncertain summaries", () => {
    const okSurface: AbsenceReconstructSessionSurface = {
      kind: "kernel",
      report: {
        ok: true,
        reconstructed: 2,
        paths: [
          {
            effectId: "e-del",
            path: "/tmp/gone.txt",
            classification: "explicit_absent",
            source: "independent_probe",
          },
        ],
        uncertain: [],
        scope: "latest_settled_absent_paths_only",
      },
      historicalChecked: 1,
    };
    expect(formatAbsenceReconstructSummary(okSurface)).toContain("explicitly absent");
    expect(formatAbsenceReconstructSummary(okSurface)).toContain("superseded signed absence");

    const badSurface: AbsenceReconstructSessionSurface = {
      kind: "kernel",
      report: {
        ok: false,
        reconstructed: 0,
        paths: [],
        uncertain: [
          { effectId: "e1", path: "/secret/path", classification: "identity_uncertain" },
        ],
        scope: "latest_settled_absent_paths_only",
      },
    };
    expect(formatAbsenceReconstructSummary(badSurface)).toContain("identity_uncertain");
    expect(absenceReconstructBlocksVerify(badSurface)).toBe(true);
    expect(absenceReconstructBlocksVerify(okSurface)).toBe(false);
  });

  test("skipped surface does not block verify", () => {
    const skipped: AbsenceReconstructSessionSurface = { kind: "skipped", reason: "no kernel" };
    expect(formatAbsenceReconstructSummary(skipped)).toContain("skipped");
    expect(absenceReconstructBlocksVerify(skipped)).toBe(false);
  });
});