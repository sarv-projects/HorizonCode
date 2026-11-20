import { describe, expect, test } from "bun:test";
import {
  formatLegacyClassifySummary,
  legacyClassifyBlocksVerify,
  type LegacyClassifySessionSurface,
} from "../../src/core/effect-legacy-unverifiable";

describe("effect legacy unverifiable summary (ruling 709)", () => {
  test("format refused and clean summaries", () => {
    const badSurface: LegacyClassifySessionSurface = {
      kind: "kernel",
      report: {
        ok: false,
        refused: 1,
        classification: "legacy_unverifiable",
        scope: "owner_settled_without_digest_cas_or_stream_evidence",
        backfillRefusal: {
          allowed: false,
          reason: "pre_archive_ownerlog_rows_cannot_receive_cas_at_verify",
        },
        residual: "arbitrary_shell_fs_net_and_deleted_byte_reconstruction_still_open",
        rows: [
          {
            effectId: "legacy-e1",
            path: "/tmp/old.txt",
            classification: "legacy_unverifiable",
            reason: "present_row_missing_cas_archive",
            ok: false,
            backfillRefused: true,
            backfillRefusalReason: "pre_archive_ownerlog_rows_cannot_receive_cas_at_verify",
          },
        ],
      },
    };
    expect(formatLegacyClassifySummary(badSurface)).toContain("missing_cas_archive");
    expect(legacyClassifyBlocksVerify(badSurface)).toBe(true);

    const okSurface: LegacyClassifySessionSurface = {
      kind: "kernel",
      report: {
        ...badSurface.report,
        ok: true,
        refused: 0,
        rows: [],
      },
    };
    expect(formatLegacyClassifySummary(okSurface)).toContain("(none)");
    expect(legacyClassifyBlocksVerify(okSurface)).toBe(false);
  });

  test("skipped surface does not block verify", () => {
    const skipped: LegacyClassifySessionSurface = { kind: "skipped", reason: "no kernel" };
    expect(formatLegacyClassifySummary(skipped)).toContain("skipped");
    expect(legacyClassifyBlocksVerify(skipped)).toBe(false);
  });
});