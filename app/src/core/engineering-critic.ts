/**
 * Engineering Brain — adversarial critic pass (blueprint layer 8; ruling 640).
 *
 * Stateless harness critique of (goal, diff paths, verification evidence).
 * Designed to avoid sunk-cost bias: it does **not** read the model's prior
 * rationalizations — only the goal, changed paths, and optional evidence.
 *
 * Runs when `HZ_ENGINEERING_BRAIN=1` (same compose as viability). P0 findings
 * fail the turn (`RunExit.detail=engineering_critic`); P1 findings notice only.
 *
 * Ruling **645**: `enforced_egress_claim` scans **added diff lines** in
 * `evidenceText` only (never raw goal text / negations like "never claim …
 * enforced"). Ruling **685**: optional lexical symbol-impact summary from mutated
 * paths (repo_map patterns). Opt-in cross-model LLM pass: ruling **705**
 * (`engineering-critic-llm.ts`, `HZ_ENG_CRITIC_MODEL`). Ruling **727** adds
 * structural call-site reach (not tree-sitter AST call-graph). Full AST still OPEN.
 */

export type CriticSeverity = "P0" | "P1";

export type CriticFinding = {
  code:
    | "secret_path_mutation"
    | "policy_authority_mutation"
    | "license_mutation"
    | "test_deleted_without_replacement"
    | "deps_mutation_unannounced"
    | "enforced_egress_claim"
    | "mutation_without_verification"
    | "exported_surface_wide_reach"
    | "llm_adversarial_finding";
  severity: CriticSeverity;
  evidence: string;
};

export type CriticVerdict = "PASS" | "PASS_WITH_NOTES" | "FAIL";

export type CriticReport = {
  verdict: CriticVerdict;
  findings: CriticFinding[];
  summary: string;
};

export type CriticInput = {
  goal: string;
  changedPaths: readonly string[];
  /** Verification-shaped command that ran this turn, if any. */
  verifiedCommand?: string;
  /** Optional unified-diff or file excerpt text to scan. */
  evidenceText?: string;
  /** Lexical symbol impact summary for mutated code paths (ruling 685). */
  symbolImpactSummary?: string;
  /** When true, exported symbols likely reach many other files (lexical walk). */
  symbolHighBlastRadius?: boolean;
};

const SECRET_PATH = /(?:^|\/)(\.env(?:\..+)?|id_rsa|.*\.pem|credentials\.json|secrets?\.ya?ml)$/i;
const POLICY_PATH = /(?:^|\/)(policy\.json|allowlist\.json|hzk\.control)$/i;
const LICENSE_PATH = /(?:^|\/)(LICENSE(?:\..+)?|NOTICE)$/i;
const LOCKFILE = /(?:^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|bun\.lockb?)$/i;
const PACKAGE_MANIFEST = /(?:^|\/)(package\.json|Cargo\.toml)$/i;
const TEST_PATH = /(?:^|\/)(.+\.(?:test|spec)\.[jt]sx?|tests?\/.+)$/i;
const ENFORCED_EGRESS = /\b(shell[\s_-]?net|egress).{0,40}\benforced\b|\benforced\b.{0,40}\b(shell[\s_-]?net|egress)\b/i;
const EGRESS_NEGATION =
  /\b(never|not|don't|do\s+not|dont|avoid|forbid(?:den)?|must\s+not|shouldn't|should\s+not)\b.{0,80}\b(claim|say|assert|advertise)?.{0,40}\b(enforced|shell[\s_-]?net|egress)\b|\b(enforced|shell[\s_-]?net|egress)\b.{0,40}\b(never|not|forbidden|deferred|open|partial)\b/i;

function basenamePath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Added unified-diff lines only; falls back to whole evidence when not a diff. */
function addedEvidenceLines(evidence: string | undefined): string {
  if (evidence === undefined || evidence.trim() === "") return "";
  const lines = evidence.split(/\r?\n/);
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  if (added.length > 0) return added.map((l) => l.slice(1)).join("\n");
  return evidence;
}

function claimsEnforcedEgress(evidenceText: string | undefined): boolean {
  const scan = addedEvidenceLines(evidenceText);
  if (scan === "") return false;
  if (!ENFORCED_EGRESS.test(scan)) return false;
  // Negation / honesty residuals in the same evidence must not P0-fail the turn.
  if (EGRESS_NEGATION.test(scan)) return false;
  return true;
}

export function runAdversarialCritic(input: CriticInput): CriticReport {
  const findings: CriticFinding[] = [];
  const goal = input.goal.trim();
  const paths = input.changedPaths.map((p) => p.replace(/\\/g, "/"));

  for (const p of paths) {
    if (SECRET_PATH.test(p) || SECRET_PATH.test(basenamePath(p))) {
      findings.push({
        code: "secret_path_mutation",
        severity: "P0",
        evidence: `changed secret/credential-shaped path: ${p}`,
      });
    }
    if (POLICY_PATH.test(p) || POLICY_PATH.test(basenamePath(p))) {
      findings.push({
        code: "policy_authority_mutation",
        severity: "P0",
        evidence: `changed kernel authority policy/control path: ${p}`,
      });
    }
    if (LICENSE_PATH.test(p) || LICENSE_PATH.test(basenamePath(p))) {
      findings.push({
        code: "license_mutation",
        severity: "P0",
        evidence: `changed LICENSE/NOTICE path: ${p} (LICENSE remains deferred unless owner decides)`,
      });
    }
  }

  const touchedDeps = paths.some((p) => PACKAGE_MANIFEST.test(p) || LOCKFILE.test(p));
  if (touchedDeps && !/\b(dependenc|package\.json|cargo\.toml|lockfile|npm|pnpm|bun\s+add)\b/i.test(goal)) {
    findings.push({
      code: "deps_mutation_unannounced",
      severity: "P1",
      evidence: "dependency manifest/lockfile changed without goal announcing a dependency change",
    });
  }

  const touchedTests = paths.filter((p) => TEST_PATH.test(p));
  if (
    touchedTests.length > 0 &&
    /\b(delete|remove|drop)\b.{0,40}\btests?\b|\btests?\b.{0,40}\b(delete|remove|drop)\b/i.test(goal) &&
    !/\b(replace|rewrite|add|new)\b.{0,40}\btests?\b/i.test(goal)
  ) {
    findings.push({
      code: "test_deleted_without_replacement",
      severity: "P1",
      evidence: `test paths touched (${touchedTests.slice(0, 3).join(", ")}) while goal deletes/removes tests without replacement intent`,
    });
  }

  if (claimsEnforcedEgress(input.evidenceText)) {
    findings.push({
      code: "enforced_egress_claim",
      severity: "P0",
      evidence: "added diff lines appear to claim shell-net/egress `enforced` (forbidden honesty residual)",
    });
  }

  if (paths.length > 0 && input.verifiedCommand === undefined) {
    findings.push({
      code: "mutation_without_verification",
      severity: "P1",
      evidence: `mutated ${paths.length} path(s) with no verification-shaped command this turn`,
    });
  }

  if (input.symbolHighBlastRadius) {
    findings.push({
      code: "exported_surface_wide_reach",
      severity: "P1",
      evidence:
        input.symbolImpactSummary?.split("\n").find((l) => l.startsWith("reach:")) ??
        "mutated exported symbols appear in many other workspace files (structural call-site / lexical reach scan)",
    });
  }

  return finalizeCriticReport(findings);
}

/** Recompute verdict/summary from a finding list (harness + optional LLM merge). */
export function finalizeCriticReport(findings: CriticFinding[]): CriticReport {
  const p0 = findings.filter((f) => f.severity === "P0");
  const p1 = findings.filter((f) => f.severity === "P1");
  const verdict: CriticVerdict =
    p0.length > 0 ? "FAIL" : p1.length > 0 ? "PASS_WITH_NOTES" : "PASS";
  const summary =
    verdict === "PASS"
      ? "engineering critic: PASS"
      : verdict === "PASS_WITH_NOTES"
        ? `engineering critic: PASS_WITH_NOTES (${p1.map((f) => f.code).join(", ")})`
        : `engineering critic: FAIL (${p0.map((f) => f.code).join(", ")})`;

  return { verdict, findings, summary };
}

/** Union findings; dedupe by severity+code+evidence; recompute verdict. */
export function mergeCriticReports(base: CriticReport, extra: readonly CriticFinding[]): CriticReport {
  if (extra.length === 0) return base;
  const merged = [...base.findings];
  for (const f of extra) {
    if (merged.some((x) => x.severity === f.severity && x.code === f.code && x.evidence === f.evidence)) continue;
    merged.push(f);
  }
  return finalizeCriticReport(merged);
}

export function formatCriticInterrupt(report: CriticReport, symbolImpactSummary?: string): string {
  const impactBlock =
    symbolImpactSummary !== undefined && symbolImpactSummary.trim() !== ""
      ? [symbolImpactSummary.trim()]
      : [];
  return [
    `<system-interrupt reason="engineering_critic">`,
    report.summary,
    ...impactBlock,
    ...report.findings.map((f) => `- [${f.severity}] ${f.code}: ${f.evidence}`),
    `</system-interrupt>`,
  ].join("\n");
}
