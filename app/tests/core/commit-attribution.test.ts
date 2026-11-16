import { describe, expect, test } from "bun:test";
import {
  ATTRIBUTE_ENV_TABLE,
  ATTRIBUTE_TRAILER_TABLE,
  appendAttributionToMessage,
  commitAttributionTrailers,
  parseCommitAttributeArgs,
  resolveCommitAttribution,
  type AttributeFlag,
} from "../../src/core/commit-attribution";

describe("commit attribution", () => {
  test("parseCommitAttributeArgs strips flags", () => {
    const { attribution, rest } = parseCommitAttributeArgs([
      "--preview",
      "--attribute-coauthor",
      "Bot <bot@example.com>",
      "extra",
    ]);
    expect(attribution.coauthor).toBe("Bot <bot@example.com>");
    expect(rest).toEqual(["--preview", "extra"]);
  });

  test("trailers follow documented table", () => {
    expect(
      commitAttributionTrailers({
        coauthor: "A",
        signedOffBy: "B",
      }),
    ).toEqual(["Co-authored-by: A", "Signed-off-by: B"]);
    expect(appendAttributionToMessage("subject", { reviewedBy: "C" })).toBe("subject\n\nReviewed-by: C");
  });
});

describe("E-2 env-scoped attribution truth table", () => {
  test("CLI-only path stays byte-identical when the environment is empty", () => {
    const argv = [
      "--preview",
      "--attribute-coauthor",
      "Bot <bot@example.com>",
      "--attribute-signedOffBy",
      "Signer <s@example.com>",
      "extra",
    ];
    const reduced = parseCommitAttributeArgs(argv);
    const resolved = resolveCommitAttribution(argv, {});
    expect(resolved.attribution).toEqual(reduced.attribution);
    expect(resolved.rest).toEqual(reduced.rest);
    expect(resolved.conflicts).toEqual([]);
    expect(appendAttributionToMessage("subject", resolved.attribution)).toBe(
      appendAttributionToMessage("subject", reduced.attribution),
    );
  });

  test("every cell of the truth table, for every trailer", () => {
    const flags = Object.keys(ATTRIBUTE_TRAILER_TABLE) as AttributeFlag[];
    type Cell = {
      name: string;
      cli?: string;
      env?: string;
      chosen?: string;
      source: "cli" | "env" | "none";
      conflict: boolean;
    };
    const cases: Cell[] = [
      { name: "neither", chosen: undefined, source: "none", conflict: false },
      { name: "cli only", cli: "CLI-V", chosen: "CLI-V", source: "cli", conflict: false },
      { name: "env only", env: "ENV-V", chosen: "ENV-V", source: "env", conflict: false },
      { name: "both equal", cli: "SAME", env: "SAME", chosen: "SAME", source: "cli", conflict: false },
      { name: "both conflict", cli: "CLI-V", env: "ENV-V", chosen: "CLI-V", source: "cli", conflict: true },
    ];

    for (const flag of flags) {
      const trailer = ATTRIBUTE_TRAILER_TABLE[flag];
      const envKey = ATTRIBUTE_ENV_TABLE[flag];
      for (const c of cases) {
        const argv = c.cli === undefined ? [] : [`--attribute-${flag}`, c.cli];
        const env = c.env === undefined ? {} : { [envKey]: c.env };
        const resolved = resolveCommitAttribution(argv, env);
        const cell = resolved.cells.find((x) => x.flag === flag)!;
        expect(cell.trailer, `${flag}/${c.name}: trailer`).toBe(trailer);
        expect(cell.envKey, `${flag}/${c.name}: envKey`).toBe(envKey);
        expect(cell.chosen, `${flag}/${c.name}: chosen`).toBe(c.chosen);
        expect(cell.source, `${flag}/${c.name}: source`).toBe(c.source);
        expect(cell.conflict, `${flag}/${c.name}: conflict`).toBe(c.conflict);
        expect(resolved.attribution[flag], `${flag}/${c.name}: attribution`).toBe(c.chosen);
        const trailers = commitAttributionTrailers(resolved.attribution);
        expect(trailers, `${flag}/${c.name}: trailers`).toEqual(
          c.chosen === undefined ? [] : [`${trailer}: ${c.chosen}`],
        );
        expect(resolved.conflicts, `${flag}/${c.name}: conflicts`).toEqual(c.conflict ? [cell] : []);
      }
    }
  });

  test("conflict resolution keeps the CLI trailer byte-identical to CLI-only", () => {
    const cliOnly = resolveCommitAttribution(["--attribute-coauthor", "A <a@example.com>"], {});
    const conflict = resolveCommitAttribution(
      ["--attribute-coauthor", "A <a@example.com>"],
      { HZ_ATTRIBUTE_COAUTHOR: "B <b@example.com>" },
    );
    expect(appendAttributionToMessage("subject", conflict.attribution)).toBe(
      appendAttributionToMessage("subject", cliOnly.attribution),
    );
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0]?.envValue).toBe("B <b@example.com>");
    expect(conflict.conflicts[0]?.source).toBe("cli");
  });

  test("all three trailers resolve together in stable table order", () => {
    const resolved = resolveCommitAttribution(
      ["--attribute-coauthor", "A", "--attribute-reviewedBy", "R"],
      {
        HZ_ATTRIBUTE_COAUTHOR: "ENV-A",
        HZ_ATTRIBUTE_SIGNED_OFF_BY: "S",
        HZ_ATTRIBUTE_REVIEWED_BY: "ENV-R",
      },
    );
    expect(commitAttributionTrailers(resolved.attribution)).toEqual([
      "Co-authored-by: A",
      "Signed-off-by: S",
      "Reviewed-by: R",
    ]);
    expect(resolved.conflicts.map((c) => c.flag)).toEqual(["coauthor", "reviewedBy"]);
    expect(resolved.rest).toEqual([]);
  });

  test("empty / whitespace-only env values are unset; env values are trimmed", () => {
    const unset = resolveCommitAttribution([], { HZ_ATTRIBUTE_COAUTHOR: "   " });
    expect(unset.attribution).toEqual({});
    expect(unset.cells[0]?.source).toBe("none");
    const trimmed = resolveCommitAttribution([], { HZ_ATTRIBUTE_COAUTHOR: "  Env <e@example.com>  " });
    expect(trimmed.attribution.coauthor).toBe("Env <e@example.com>");
  });

  test("env-only attribution renders the documented trailer", () => {
    const resolved = resolveCommitAttribution([], { HZ_ATTRIBUTE_REVIEWED_BY: "R <r@example.com>" });
    expect(appendAttributionToMessage("subject", resolved.attribution)).toBe(
      "subject\n\nReviewed-by: R <r@example.com>",
    );
  });

  test("parse errors propagate unchanged for byte-identical CLI behavior", () => {
    expect(() => resolveCommitAttribution(["--attribute-nope", "x"], {})).toThrow("unknown attribute flag");
    expect(() => resolveCommitAttribution(["--attribute-coauthor"], {})).toThrow("requires a value");
  });
});
