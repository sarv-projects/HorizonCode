/**
 * Verification Artifacts (ruling 643) — Antigravity-style proof bundles.
 *
 * Human-scannable bundle: plan + diff + test output + optional browser
 * screenshots + cryptographic receipt digests. Written as JSON under
 * `<workspace>/.hz/verification/` (or an injected path).
 *
 * Does **not** claim live browser capture without a CDP endpoint. Auto-emit
 * after succeeded turns / passing session verify is opt-in (`HZ_VERIFY_ARTIFACT_AUTO_EMIT`;
 * ruling **708**); default-off.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { canonicalJson } from "./canon";

export const VERIFICATION_ARTIFACT_SCHEMA = "hz.verification.artifact.v1" as const;

export type VerificationScreenshot = {
  path: string;
  sha256: string;
  note?: string;
};

export type VerificationReceiptLink = {
  receiptId: string;
  digest: string;
};

export type VerificationArtifactV1 = {
  schema: typeof VERIFICATION_ARTIFACT_SCHEMA;
  createdAt: string;
  goal: string;
  plan?: string;
  diffSummary?: string;
  testOutput?: string;
  browserScreenshots: VerificationScreenshot[];
  receiptChain: VerificationReceiptLink[];
  /** sha256 over canonical JSON of the fields above excluding this digest. */
  artifactDigest: string;
};

export type BuildVerificationArtifactInput = {
  goal: string;
  plan?: string;
  diffSummary?: string;
  testOutput?: string;
  browserScreenshots?: VerificationScreenshot[];
  receiptChain?: VerificationReceiptLink[];
  createdAt?: string;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reject traversal; allow a single path segment file name only. */
export function safeVerificationBaseName(fileName: string): string {
  const trimmed = fileName.trim();
  if (
    trimmed === "" ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..")
  ) {
    throw new Error(`verification file name is not allowed: ${fileName}`);
  }
  const base = path.basename(trimmed);
  if (base === "" || base === "." || base === "..") {
    throw new Error(`verification file name is not allowed: ${fileName}`);
  }
  return base;
}

function hzRoot(workspace: string): string {
  return path.resolve(workspace, ".hz");
}

function assertUnderHzRoot(workspace: string, dir: string): void {
  const root = hzRoot(workspace);
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("verification path must stay under workspace .hz/");
  }
}

function assertUnderDir(dir: string, target: string): void {
  const resolvedDir = path.resolve(dir);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedDir, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("verification write path escapes directory");
  }
}

/** Resolve a write path under `<workspace>/.hz/<segments…>/<fileName>`. */
export function resolveHzVerificationPath(
  workspace: string,
  segments: string[],
  fileName: string,
): string {
  const root = path.resolve(workspace);
  const dir = path.resolve(root, ".hz", ...segments);
  assertUnderHzRoot(workspace, dir);
  const base = safeVerificationBaseName(fileName);
  const out = path.join(dir, base);
  assertUnderDir(dir, out);
  return out;
}

function resolveVerificationArtifactDir(workspace: string, optsDir?: string): string {
  const dir = path.resolve(optsDir ?? path.join(hzRoot(workspace), "verification"));
  assertUnderHzRoot(workspace, dir);
  return dir;
}

/**
 * Under-admission: Guard `fs.write` on verification artifact paths before persist.
 */
export async function admitVerificationFsWrite(
  target: string,
  workspace: string,
): Promise<string | undefined> {
  const { admitPredsOutWrite } = await import("./preds-writer");
  const refused = await admitPredsOutWrite(target, workspace);
  if (refused === undefined) return undefined;
  return refused
    .replace(/^preds write refused:/, "verification write refused:")
    .replace(/^preds write denied/, "verification write denied")
    .replace(/^preds fs\.write requires approval/, "verification fs.write requires approval");
}

/** Build a Verification Artifact with a stable content digest. */
export function buildVerificationArtifact(
  input: BuildVerificationArtifactInput,
): VerificationArtifactV1 {
  const body = {
    schema: VERIFICATION_ARTIFACT_SCHEMA,
    createdAt: input.createdAt ?? new Date().toISOString(),
    goal: input.goal.trim(),
    plan: input.plan?.trim() || undefined,
    diffSummary: input.diffSummary?.trim() || undefined,
    testOutput: input.testOutput?.trim() || undefined,
    browserScreenshots: input.browserScreenshots ?? [],
    receiptChain: input.receiptChain ?? [],
  };
  const artifactDigest = sha256Hex(canonicalJson(body));
  return { ...body, artifactDigest };
}

/** Persist artifact JSON after Guard admit; returns absolute path. */
export async function writeVerificationArtifact(
  workspace: string,
  artifact: VerificationArtifactV1,
  opts: { dir?: string; fileName?: string } = {},
): Promise<string> {
  const dir = resolveVerificationArtifactDir(workspace, opts.dir);
  const fileName = opts.fileName ?? `artifact-${artifact.artifactDigest.slice(0, 16)}.json`;
  const out = path.join(dir, safeVerificationBaseName(fileName));
  assertUnderDir(dir, out);
  const refused = await admitVerificationFsWrite(out, workspace);
  if (refused !== undefined) throw new Error(refused);
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return out;
}

/** Hash a screenshot file's bytes for the artifact entry (caller supplies bytes). */
export function screenshotEntry(filePath: string, bytes: Uint8Array | Buffer, note?: string): VerificationScreenshot {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path: filePath, sha256, ...(note !== undefined ? { note } : {}) };
}
