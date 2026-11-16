/**
 * commit-attribution.ts — commit trailer truth table (docs/30 E-2, ruling 202).
 *
 * Maps `--attribute-*` CLI flags AND the matching `HZ_ATTRIBUTE_*` environment
 * variables to documented git trailers. The reduced feature (CLI flags only)
 * is unchanged; this module now also documents and resolves the full
 * env-scoped matrix (docs/05 §2.8 "commit attribution is a configured,
 * documented truth table ... env-scoped implementation"). No provenance is
 * inferred from commit text or tooling defaults — it is explicit data.
 *
 * ── TRUTH TABLE (per trailer: coauthor / signedOffBy / reviewedBy) ──────────
 *
 *   cli?  env?   same?   chosen   source   conflict?   trailers
 *   ────  ────   ─────   ──────   ──────   ─────────   ────────
 *   no    no     —       (none)   none     no          no trailer
 *   yes   no     —       CLI      cli      no          CLI value
 *   no    yes    —       ENV      env      no          ENV value
 *   yes   yes    yes     CLI      cli      no          value once (dedupe)
 *   yes   yes    no      CLI      cli      YES         CLI wins (env ignored)
 *
 * PRECEDENCE: an explicit per-invocation CLI flag ALWAYS overrides the ambient
 * `HZ_ATTRIBUTE_*` environment variable (including when they conflict). The
 * environment is a default, never an authority that can silently override the
 * operator's explicit command. A conflict is reported to the caller via
 * `AttributionResolution.conflicts` so provenance stays reviewable, but the
 * emitted trailer is byte-identical to the CLI-only case.
 *
 * ENV KEYS (scoped, HZ_ prefixed; empty/whitespace-only values are unset):
 *   coauthor     -> HZ_ATTRIBUTE_COAUTHOR
 *   signedOffBy  -> HZ_ATTRIBUTE_SIGNED_OFF_BY
 *   reviewedBy   -> HZ_ATTRIBUTE_REVIEWED_BY
 *
 * The CLI-only path (`parseCommitAttributeArgs` + `appendAttributionToMessage`)
 * and `hzcode commit --attribute-*` output are byte-identical to before.
 */

export interface CommitAttribution {
  coauthor?: string;
  signedOffBy?: string;
  reviewedBy?: string;
}

export type AttributeFlag = keyof CommitAttribution;

/** Documented mapping from CLI flag suffix to trailer name. */
export const ATTRIBUTE_TRAILER_TABLE: Readonly<Record<AttributeFlag, string>> = {
  coauthor: "Co-authored-by",
  signedOffBy: "Signed-off-by",
  reviewedBy: "Reviewed-by",
};

/** Env-scoped counterpart of `ATTRIBUTE_TRAILER_TABLE` (E-2 full truth table). */
export const ATTRIBUTE_ENV_TABLE: Readonly<Record<AttributeFlag, string>> = {
  coauthor: "HZ_ATTRIBUTE_COAUTHOR",
  signedOffBy: "HZ_ATTRIBUTE_SIGNED_OFF_BY",
  reviewedBy: "HZ_ATTRIBUTE_REVIEWED_BY",
};

const FLAG_PREFIX = "--attribute-";

/** Parse `hzcode commit` argv for `--attribute-<name> <value>` pairs. */
export function parseCommitAttributeArgs(argv: readonly string[]): { attribution: CommitAttribution; rest: string[] } {
  const attribution: CommitAttribution = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith(FLAG_PREFIX)) {
      rest.push(arg);
      continue;
    }
    const key = arg.slice(FLAG_PREFIX.length) as AttributeFlag;
    if (!(key in ATTRIBUTE_TRAILER_TABLE)) {
      throw new Error(`unknown attribute flag ${arg} (known: ${Object.keys(ATTRIBUTE_TRAILER_TABLE).join(", ")})`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    attribution[key] = value;
    i += 1;
  }
  return { attribution, rest };
}

/** Trailer lines in stable table order. */
export function commitAttributionTrailers(attr: CommitAttribution): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(ATTRIBUTE_TRAILER_TABLE) as AttributeFlag[]) {
    const value = attr[key]?.trim();
    if (value === undefined || value === "") continue;
    lines.push(`${ATTRIBUTE_TRAILER_TABLE[key]}: ${value}`);
  }
  return lines;
}

export function appendAttributionToMessage(message: string, attr: CommitAttribution): string {
  const trailers = commitAttributionTrailers(attr);
  if (trailers.length === 0) return message;
  return `${message.trimEnd()}\n\n${trailers.join("\n")}`;
}

/* --------------------- E-2 env-scoped truth table ------------------------- */

/** Where a trailer's value came from after resolution. */
export type AttributionSource = "cli" | "env" | "none";

/** One resolved row of the E-2 truth table (one per trailer). */
export interface AttributionCell {
  flag: AttributeFlag;
  trailer: string;
  envKey: string;
  /** Raw CLI value, when `--attribute-<flag>` was supplied. */
  cliValue?: string;
  /** Trimmed environment value, when the `HZ_ATTRIBUTE_*` key was set. */
  envValue?: string;
  /** The value that will be emitted, if any. */
  chosen?: string;
  source: AttributionSource;
  /** True only when CLI and env BOTH supplied DIFFERENT values (CLI wins). */
  conflict: boolean;
}

export interface AttributionResolution {
  /** Final attribution to pass to `appendAttributionToMessage`. */
  attribution: CommitAttribution;
  /** Argv with `--attribute-*` pairs removed (identical to the reduced path). */
  rest: string[];
  /** The full per-trailer truth table, in stable table order. */
  cells: AttributionCell[];
  /** Cells whose CLI and env values disagreed (resolved in favour of CLI). */
  conflicts: AttributionCell[];
}

/**
 * Resolve `hzcode commit` attribution from CLI flags and the environment per
 * the E-2 truth table above. CLI wins on conflict; env is a scoped default.
 * `env` defaults to `process.env`; pass an explicit object for deterministic
 * tests. `parseCommitAttributeArgs` errors (unknown flag / missing value) are
 * propagated unchanged so the existing CLI contract stays identical.
 */
export function resolveCommitAttribution(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): AttributionResolution {
  // Reduced CLI path first — unchanged, including error text and `rest`.
  const { attribution: cli, rest } = parseCommitAttributeArgs(argv);
  const attribution: CommitAttribution = {};
  const cells: AttributionCell[] = [];
  const conflicts: AttributionCell[] = [];

  for (const flag of Object.keys(ATTRIBUTE_TRAILER_TABLE) as AttributeFlag[]) {
    const cliRaw = cli[flag];
    const envRaw = env[ATTRIBUTE_ENV_TABLE[flag]];
    const cliPresent = cliRaw !== undefined && cliRaw.trim() !== "";
    const envValue = envRaw === undefined ? undefined : envRaw.trim();
    const envPresent = envValue !== undefined && envValue !== "";

    const cell: AttributionCell = {
      flag,
      trailer: ATTRIBUTE_TRAILER_TABLE[flag],
      envKey: ATTRIBUTE_ENV_TABLE[flag],
      ...(cliPresent ? { cliValue: cliRaw } : {}),
      ...(envPresent ? { envValue } : {}),
      source: cliPresent ? "cli" : envPresent ? "env" : "none",
      conflict: cliPresent && envPresent && (cliRaw as string).trim() !== envValue,
    };

    // PRECEDENCE: explicit CLI flag overrides the ambient env default (even on
    // conflict). A CLI value is used verbatim (byte-identical to the reduced
    // path); an env-only value is taken trimmed.
    if (cliPresent) {
      attribution[flag] = cliRaw;
      cell.chosen = cliRaw;
    } else if (envPresent) {
      attribution[flag] = envValue;
      cell.chosen = envValue;
    }

    cells.push(cell);
    if (cell.conflict) conflicts.push(cell);
  }

  return { attribution, rest, cells, conflicts };
}
