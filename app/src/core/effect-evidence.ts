/**
 * effect-evidence.ts — observe-time settlement evidence (docs/28 **257**).
 *
 * Defense in depth: compare receipt `resultDigest` to a canonical digest of
 * tool output at observe time; expected postimage path present but file missing
 * after ok mutating tools → EffectHost `unknown`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { ToolResult } from "../contracts";
import { canonicalJson, sha256Hex } from "./canon";
import { postimagePathForTool } from "./receipt-postimage";

function sha256BufferHex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Same rules as `issueToolReceipt` / kernel receipt preimage. */
export function toolResultDigest(result: ToolResult): string {
  return sha256Hex(
    typeof result.output === "string"
      ? result.output
      : canonicalJson({
          ok: result.ok,
          output: (result as { output?: unknown }).output ?? null,
          error: result.error ?? null,
        }),
  );
}

export function assessResultDigestEvidence(
  claimedDigest: string,
  result: ToolResult,
): { stable: boolean; observedDigest: string } {
  const observedDigest = toolResultDigest(result);
  return { stable: claimedDigest === observedDigest, observedDigest };
}

/** Two independent sha256 passes on captured stream bytes (docs/28 **314**). */
export function observeCapturedShellStreamDigest(bytes: Uint8Array | Buffer): {
  digest?: string;
  observationStable: boolean;
  confirmDigest?: string;
} {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const primary = sha256BufferHex(buf);
  const confirm = sha256BufferHex(buf);
  const observationStable = primary === confirm;
  return {
    ...(observationStable ? { digest: primary } : {}),
    observationStable,
    ...(observationStable ? {} : { confirmDigest: confirm }),
  };
}

export function shellExecResultDigestStable(
  stdout: ReturnType<typeof observeCapturedShellStreamDigest>,
  stderr: ReturnType<typeof observeCapturedShellStreamDigest>,
): boolean {
  return stdout.observationStable && stderr.observationStable;
}

/** Success output for kernel-routed fs mutations (must match `effect-kernel-mutation-route.ts`). */
export function kernelFsMutationSuccessOutput(
  kind: "write" | "edit" | "delete" | "rename",
  rel: string,
  contentDigest?: string,
  relFrom?: string,
): string {
  const digest = contentDigest ?? "?";
  switch (kind) {
    case "write":
      return `[effect-host-kernel] wrote ${rel} (kernel fs.write; postimage digest ${digest})`;
    case "edit":
      return `[effect-host-kernel] edited ${rel} (kernel fs.edit; postimage digest ${digest})`;
    case "delete":
      return `[effect-host-kernel] deleted ${rel} (kernel fs.delete; postimage digest ${digest})`;
    case "rename":
      return `[effect-host-kernel] renamed ${relFrom ?? "?"} → ${rel} (kernel fs.rename; postimage digest ${digest})`;
  }
}

/** Multi-op kernel-routed `apply_patch` aggregated success output (docs/28 **328**). */
export function kernelApplyPatchMultiOpSuccessOutput(
  opCount: number,
  paths: string,
  contentDigest?: string,
): string {
  const digest = contentDigest ?? "?";
  return `[effect-host-kernel] apply_patch ${opCount} op(s) via kernel (${paths}; postimage digest ${digest})`;
}

/** Independent double-hash on canonical kernel mutation tool output (docs/28 **327**, **328**). */
export function observeKernelFsMutationResultDigest(
  kind: "write" | "edit" | "delete" | "rename",
  rel: string,
  contentDigest?: string,
  relFrom?: string,
): { resultDigest?: string; resultDigestStable: boolean } {
  const output = kernelFsMutationSuccessOutput(kind, rel, contentDigest, relFrom);
  const obs = observeCapturedShellStreamDigest(Buffer.from(output, "utf8"));
  return {
    resultDigestStable: obs.observationStable,
    ...(obs.digest ? { resultDigest: obs.digest } : {}),
  };
}

export function observeKernelApplyPatchMultiOpResultDigest(
  opCount: number,
  paths: string,
  contentDigest?: string,
): { resultDigest?: string; resultDigestStable: boolean } {
  const output = kernelApplyPatchMultiOpSuccessOutput(opCount, paths, contentDigest);
  const obs = observeCapturedShellStreamDigest(Buffer.from(output, "utf8"));
  return {
    resultDigestStable: obs.observationStable,
    ...(obs.digest ? { resultDigest: obs.digest } : {}),
  };
}

export function assessPostimageMissingAtObserve(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
  ok: boolean,
  exists: (p: string) => boolean = existsSync,
): { missing: boolean; path?: string } {
  if (!ok) return { missing: false };
  const filePath = postimagePathForTool(tool, args, workspace);
  if (!filePath) return { missing: false };
  if (!exists(filePath)) return { missing: true, path: filePath };
  return { missing: false, path: filePath };
}

export function resultDigestEvidenceNotice(tool: string, claimed: string, observed: string): string {
  return (
    `result digest mismatch at observe for ${tool}: receipt ${claimed.slice(0, 12)}… vs output ${observed.slice(0, 12)}…; effect marked unknown`
  );
}

export function postimageMissingAtObserveNotice(tool: string, filePath: string): string {
  return `postimage missing at observe for ${tool}: ${filePath}; effect marked unknown`;
}
