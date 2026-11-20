/**
 * Engineering Brain — pre-flight viability gate (blueprint layer 8; ruling 639).
 *
 * Harness-enforced (not a prompt suggestion): classify a user goal before the
 * mutate ladder runs. Returns structured evidence so the loop can interrupt
 * with NOT_VIABLE / ARCHITECTURE_CONFLICT instead of cheerfully patching.
 *
 * Opt-in via `HZ_ENGINEERING_BRAIN=1`, or composed for autonomy=
 * `autonomous` / `regulated` / `unattended` when the env is unset.
 *
 * Ruling **645**: regex-only credential / destructive mentions are advisory
 * (`tradeoff`) unless paired with explicit elevation/wipe intent verbs —
 * read-only questions that name `.env.production` / `id_rsa` must not hard-abort.
 * Does **not** yet spawn a fresh-context adversarial critic; post-mutation lexical
 * symbol impact is ruled separately (rulings 685 lexical, 727 structural); tree-sitter AST call-graph still OPEN.
 */

export type ViabilityVerdict = "VIABLE" | "VIABLE_WITH_TRADEOFFS" | "NOT_VIABLE";

export type ViabilityFinding = {
  code:
    | "irreversible_external"
    | "credential_elevation"
    | "destructive_root"
    | "architecture_conflict"
    | "empty_goal";
  severity: "block" | "tradeoff";
  evidence: string;
};

export type ViabilityAssessment = {
  verdict: ViabilityVerdict;
  findings: ViabilityFinding[];
  /** One-line operator summary (safe for system-interrupt). */
  summary: string;
};

const IRREVERSIBLE =
  /\b(git\s+push|gh\s+pr\s+merge|kubectl\s+apply|terraform\s+apply|npm\s+publish|cargo\s+publish|docker\s+push|production\s+deploy|drop\s+table|migrate\s+prod)\b/i;
/** Leading `\b` cannot precede `.env…` (dot is non-word); use a non-alnum lookbehind-ish class. */
const CREDENTIAL_TOKEN =
  /(?:^|[^A-Za-z0-9_])(\.env\.production|aws_secret|SSH_PRIVATE|id_rsa|cloud\s+iam|secrets?\s+vault)\b/i;
/** Imperative elevation near a credential token — hard block. Mentions alone are tradeoff. */
const CREDENTIAL_ELEVATION =
  /\b(upload|exfiltrate|steal|leak|dump|exfil|send|post|publish|mint|elevate|grant|copy\s+to|write\s+to|create\s+in)\b.{0,80}(?:^|[^A-Za-z0-9_]|[\s`"'([{])(\.env\.production|aws_secret|SSH_PRIVATE|id_rsa|cloud\s+iam|secrets?\s+vault)\b|(?:^|[^A-Za-z0-9_])(\.env\.production|aws_secret|SSH_PRIVATE|id_rsa|cloud\s+iam|secrets?\s+vault)\b.{0,80}\b(upload|exfiltrate|steal|leak|dump|exfil|send|post|publish|mint|elevate|grant)\b/i;
const DESTRUCTIVE_ROOT =
  /\b(rm\s+-rf\s+\/(?:\s|$)|format\s+c:|mkfs\.|dd\s+if=.*of=\/dev\/)\b/i;
const DESTRUCTIVE_INTENT =
  /\b(wipe|destroy|erase|format)\b.{0,40}\b(root|filesystem|\/dev\/|disk|drive)\b|\b(rm\s+-rf\s+\/(?:\s|$)|format\s+c:|mkfs\.|dd\s+if=.*of=\/dev\/)\b/i;
const ARCH_CONFLICT =
  /\b(zero[\s-]?dep(?:endency)?s?).{0,80}\b(add|install|introduce).{0,40}\b(npm|pnpm|node_modules|runtime\s+dep)/i;
/** Questions about destructive patterns — not imperatives to run them. */
const DESTRUCTIVE_EXPLANATORY =
  /(?:^|[\s?¿])(?:why|how|what\s+happens\s+if|explain|describe|tell\s+me|can\s+you\s+explain|what\s+is|what's|is\s+.+\s+blocked)\b/i;

function matchesDestructivePattern(text: string): boolean {
  return DESTRUCTIVE_INTENT.test(text) || DESTRUCTIVE_ROOT.test(text);
}

function isActionableDestructiveGoal(text: string): boolean {
  if (!matchesDestructivePattern(text)) return false;
  if (DESTRUCTIVE_EXPLANATORY.test(text)) return false;
  if (/^\s*(?:sudo\s+)?(?:rm\s+-rf|format\s+c:|mkfs\.|dd\s+)/im.test(text)) return true;
  if (/\b(run|execute)\s+(?:sudo\s+)?rm\b/i.test(text)) return true;
  if (/\b(wipe|destroy|erase|format)\b/i.test(text)) return true;
  return false;
}

export function assessEngineeringViability(goal: string): ViabilityAssessment {
  const text = goal.trim();
  const findings: ViabilityFinding[] = [];
  if (text === "") {
    findings.push({
      code: "empty_goal",
      severity: "block",
      evidence: "goal text is empty",
    });
  }
  if (IRREVERSIBLE.test(text)) {
    findings.push({
      code: "irreversible_external",
      severity: "tradeoff",
      evidence: "goal names an irreversible external effect (push/deploy/publish/prod migrate)",
    });
  }
  if (CREDENTIAL_ELEVATION.test(text)) {
    findings.push({
      code: "credential_elevation",
      severity: "block",
      evidence: "goal requests credential / production-secret elevation or exfiltration",
    });
  } else if (CREDENTIAL_TOKEN.test(text)) {
    findings.push({
      code: "credential_elevation",
      severity: "tradeoff",
      evidence: "goal mentions credential-shaped paths/tokens without clear elevation intent (advisory)",
    });
  }
  if (isActionableDestructiveGoal(text)) {
    findings.push({
      code: "destructive_root",
      severity: "block",
      evidence: "goal names a destructive root/filesystem wipe pattern",
    });
  }
  if (ARCH_CONFLICT.test(text)) {
    findings.push({
      code: "architecture_conflict",
      severity: "block",
      evidence: "goal asks to add runtime deps while preserving a zero-dependency constraint",
    });
  }

  const blocked = findings.filter((f) => f.severity === "block");
  const tradeoffs = findings.filter((f) => f.severity === "tradeoff");
  let verdict: ViabilityVerdict = "VIABLE";
  if (blocked.length > 0) verdict = "NOT_VIABLE";
  else if (tradeoffs.length > 0) verdict = "VIABLE_WITH_TRADEOFFS";

  const summary =
    verdict === "VIABLE"
      ? "engineering viability: VIABLE"
      : verdict === "VIABLE_WITH_TRADEOFFS"
        ? `engineering viability: VIABLE_WITH_TRADEOFFS (${tradeoffs.map((f) => f.code).join(", ")})`
        : `engineering viability: NOT_VIABLE (${blocked.map((f) => f.code).join(", ")})`;

  return { verdict, findings, summary };
}

export type EnvLike = { [key: string]: string | undefined };

/** True when the Engineering Brain gate should run on intake. */
export function engineeringBrainEnabled(env: EnvLike = process.env): boolean {
  const raw = env.HZ_ENGINEERING_BRAIN?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Compose `HZ_ENGINEERING_BRAIN=1` for envelope autonomy aliases when unset
 * (ruling **639**). Explicit env (including `0`/`false`) always wins.
 */
export function applyEngineeringBrainFromAutonomy(
  env: EnvLike,
  autonomyId: string | undefined,
): { applied?: true; notice?: string } {
  const raw = env.HZ_ENGINEERING_BRAIN;
  if (raw !== undefined && String(raw).trim() !== "") return {};
  const id = (autonomyId ?? "").trim().toLowerCase();
  if (id !== "autonomous" && id !== "regulated" && id !== "unattended") return {};
  env.HZ_ENGINEERING_BRAIN = "1";
  return {
    applied: true,
    notice: `[engineering-brain] HZ_ENGINEERING_BRAIN=1 (runtime: autonomy=${id}; env was unset — pre-flight viability + post-mutation critic + lexical/structural symbol impact (**727**); opt-in cross-model critic via HZ_ENG_CRITIC_MODEL=1; tree-sitter AST call-graph still OPEN)`,
  };
}

export function formatViabilityInterrupt(assessment: ViabilityAssessment): string {
  return [
    `<system-interrupt reason="engineering_viability">`,
    assessment.summary,
    ...assessment.findings.map((f) => `- [${f.severity}] ${f.code}: ${f.evidence}`),
    `</system-interrupt>`,
  ].join("\n");
}
