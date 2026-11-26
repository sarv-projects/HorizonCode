/**
 * kernel-pin.ts — verify the Rust kernel binary BEFORE it is spawned.
 *
 * `resolveKernelBinary` only answers "a file exists at this path". That is not a
 * trust decision: a workspace can plant an executable at
 * `kernel/target/release/hz-kernel`, and a stray `HZ_KERNEL_BIN` can point at any
 * file on disk. This module is the second half of the boundary: the bytes that
 * will become the authority are hashed and compared with an expected digest.
 *
 * Expected digest, in precedence order:
 *
 *   1. `HZ_KERNEL_SHA256` — 64 hex characters, no filename (an explicit,
 *      per-invocation pin; it also lets a release pipeline pin without writing
 *      into the tree).
 *   2. `kernel/kernel.sha256` — one sha256sum-style line:
 *      `<64 hex> [ *]<optional filename>`. Comments (`#`) and blank lines are
 *      ignored. The manifest is repository data; it is not read from the
 *      workspace state dir.
 *
 * `HZ_KERNEL_PIN` selects the enforcement posture:
 *
 *   auto     (default) verify when a pin/manifest exists; with neither, the
 *            binary starts unverified (and doctor reports a warning).
 *            A configured pin that does NOT match always refuses.
 *   require  a pin must exist and match; otherwise the binary is not started.
 *   off      skip verification entirely. This is an explicit trust downgrade.
 *
 * Failure is never repaired by trying a different binary: the caller reports
 * `untrusted` and either runs the local fallback read-only or refuses to start.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export type KernelPinMode = "auto" | "require" | "off";

export type KernelPinStatus =
  | "verified"
  /** auto mode, no pin configured: the binary may start, but is not pinned. */
  | "unverified"
  /** HZ_KERNEL_PIN=off: verification was explicitly skipped. */
  | "disabled"
  /** require mode with neither HZ_KERNEL_SHA256 nor a manifest. */
  | "missing-required"
  | "mismatch"
  | "invalid"
  | "unreadable";

export interface KernelPinResult {
  /** True when the binary may be started (verified, or auto/off without a usable pin). */
  ok: boolean;
  status: KernelPinStatus;
  mode: KernelPinMode;
  /** sha256 of the binary, when it could be read. */
  actual?: string;
  /** The digest the pin asked for, when one was configured. */
  expected?: string;
  source: "env" | "manifest" | "none";
  manifest?: string;
  /** One-line, human-readable explanation; safe to show in a refusal. */
  reason: string;
}

export interface KernelPinOptions {
  binary: string;
  env?: Record<string, string | undefined>;
  /** Repository root that owns `kernel/kernel.sha256`. */
  repoRoot?: string;
  /** Explicit manifest path (tests). Defaults to the platform manifest or `<repoRoot>/kernel/kernel.sha256`. */
  manifestPath?: string;
  /** Platform whose manifest is preferred (defaults to `process.platform`; tests inject). */
  platform?: string;
}

/** The repository root (app/src/core -> repo root). */
export function kernelRepoRoot(): string {
  return path.resolve(import.meta.dir, "../../..");
}

/**
 * Candidate manifests, most specific first: `kernel/kernel.sha256.<platform>`
 * then the shared `kernel/kernel.sha256`. One shared digest can only match one
 * platform's build, so a multi-platform release pins each build separately
 * without the Windows file rewriting (and breaking) the Linux pin.
 */
export function kernelPinManifestCandidates(repoRoot: string, platform: string = process.platform): string[] {
  return [
    path.join(repoRoot, "kernel", `kernel.sha256.${platform}`),
    path.join(repoRoot, "kernel", "kernel.sha256"),
  ];
}

/** The repository-owned kernel digest manifest: the platform file when present, else the shared one. */
export function kernelPinManifestPath(repoRoot: string = kernelRepoRoot(), platform: string = process.platform): string {
  const candidates = kernelPinManifestCandidates(repoRoot, platform);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1]!;
}

/** sha256 of a file as lowercase hex. Throws when the file cannot be read. */
export function sha256File(file: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

/** Sha256 hex of a kernel binary path; undefined when unreadable (detach reattach checks). */
export function hashKernelBinary(binary: string): string | undefined {
  try {
    return sha256File(binary);
  } catch {
    return undefined;
  }
}

/** Parse one sha256sum-style manifest line; undefined when there is none. */
export function parseKernelPinManifest(text: string): { digest: string; filename?: string } | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(line);
    if (match === null) return undefined;
    const filename = match[2]?.trim();
    return { digest: match[1]!.toLowerCase(), ...(filename !== undefined && filename !== "" ? { filename } : {}) };
  }
  return undefined;
}

/** `auto` by default. An unrecognised value fails closed as `require`. */
export function parseKernelPinMode(value: unknown): { mode: KernelPinMode; invalid?: string } {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "") return { mode: "auto" };
  if (raw === "auto" || raw === "require" || raw === "off") return { mode: raw };
  return { mode: "require", invalid: raw };
}

function normalizeDigest(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const digest = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

function basenameOf(value: string): string {
  return path.basename(value.replace(/\\/g, "/"));
}

/**
 * Verify `binary` against the configured pin. Never throws: a read/parse
 * failure is a refusal, because an unreadable pin is not an absent pin.
 */
export function verifyKernelPin(opts: KernelPinOptions): KernelPinResult {
  const env = opts.env ?? process.env;
  const parsedMode = parseKernelPinMode(env.HZ_KERNEL_PIN);
  const mode = parsedMode.mode;
  const invalidMode = parsedMode.invalid;

  let actual: string | undefined;
  let unreadable: string | undefined;
  try {
    actual = sha256File(opts.binary);
  } catch (err) {
    unreadable = err instanceof Error ? err.message : String(err);
  }

  if (mode === "off") {
    return {
      ok: true,
      status: "disabled",
      mode,
      ...(actual !== undefined ? { actual } : {}),
      source: "none",
      reason: "kernel pin verification disabled by HZ_KERNEL_PIN=off",
    };
  }

  const envDigestRaw = typeof env.HZ_KERNEL_SHA256 === "string" ? env.HZ_KERNEL_SHA256.trim() : "";
  const manifest = opts.manifestPath ?? kernelPinManifestPath(opts.repoRoot, opts.platform);

  let expected: string | undefined;
  let source: KernelPinResult["source"] = "none";
  let namedFile: string | undefined;
  let invalidReason: string | undefined;

  if (envDigestRaw !== "") {
    source = "env";
    expected = normalizeDigest(envDigestRaw);
    if (expected === undefined) {
      invalidReason = "HZ_KERNEL_SHA256 must be exactly 64 hex characters";
    }
  } else if (existsSync(manifest)) {
    source = "manifest";
    try {
      const parsed = parseKernelPinManifest(readFileSync(manifest, "utf8"));
      if (parsed === undefined) {
        invalidReason = `${manifest} contains no usable sha256 line (expected 64 hex characters, optional filename)`;
      } else {
        expected = parsed.digest;
        namedFile = parsed.filename;
      }
    } catch (err) {
      invalidReason = `cannot read ${manifest}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (invalidReason !== undefined) {
    return {
      ok: false,
      status: "invalid",
      mode,
      ...(actual !== undefined ? { actual } : {}),
      source,
      ...(source === "manifest" ? { manifest } : {}),
      reason: invalidReason,
    };
  }

  if (expected === undefined) {
    const invalidNote = invalidMode !== undefined ? ` (HZ_KERNEL_PIN=${JSON.stringify(invalidMode)} is not a mode; treated as require)` : "";
    if (mode === "require") {
      return {
        ok: false,
        status: "missing-required",
        mode,
        ...(actual !== undefined ? { actual } : {}),
        source: "none",
        reason: `HZ_KERNEL_PIN=require but no pin is configured: set HZ_KERNEL_SHA256 or write ${manifest}${invalidNote}`,
      };
    }
    return {
      ok: true,
      status: "unverified",
      mode,
      ...(actual !== undefined ? { actual } : {}),
      source: "none",
      manifest,
      reason: `no kernel pin configured (HZ_KERNEL_PIN=auto); sha256 is ${actual ?? "unavailable"}${invalidNote}`,
    };
  }

  if (actual === undefined) {
    return {
      ok: false,
      status: "unreadable",
      mode,
      expected,
      source,
      ...(source === "manifest" ? { manifest } : {}),
      reason: `cannot hash kernel binary ${opts.binary}: ${unreadable ?? "unknown error"}`,
    };
  }

  if (namedFile !== undefined && basenameOf(namedFile) !== basenameOf(opts.binary)) {
    return {
      ok: false,
      status: "mismatch",
      mode,
      actual,
      expected,
      source,
      manifest,
      reason: `${manifest} pins ${basenameOf(namedFile)}, not ${basenameOf(opts.binary)} (${opts.binary})`,
    };
  }

  if (actual !== expected) {
    return {
      ok: false,
      status: "mismatch",
      mode,
      actual,
      expected,
      source,
      ...(source === "manifest" ? { manifest } : {}),
      reason: `sha256 mismatch for ${opts.binary}: expected ${expected} (${source === "env" ? "HZ_KERNEL_SHA256" : manifest}), computed ${actual}`,
    };
  }

  return {
    ok: true,
    status: "verified",
    mode,
    actual,
    expected,
    source,
    ...(source === "manifest" ? { manifest } : {}),
    reason: `sha256 ${actual} matches ${source === "env" ? "HZ_KERNEL_SHA256" : manifest}`,
  };
}
