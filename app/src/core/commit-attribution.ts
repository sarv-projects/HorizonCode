/**
 * commit-attribution.ts — commit trailer truth table (docs/30 E-2 reduced).
 *
 * Maps `--attribute-*` CLI flags to documented git trailers. Full env-scoped truth
 * tables and co-authored-by policy matrices are out of scope.
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
