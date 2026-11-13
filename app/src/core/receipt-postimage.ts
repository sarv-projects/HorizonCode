/**
 * receipt-postimage.ts — independent observation digest for mutating file tools
 * (honesty P0 / EffectHost precursor; docs/33 priority overview).
 *
 * Today receipts digest the tool's self-reported `result.output`. For write/edit
 * (and apply_patch when a single path is known), re-read the workspace file after
 * the tool returns and hash those bytes as `postimageDigest`. Two independent
 * reads must agree or observation is marked unstable (fail-closed; docs/28 **256**).
 * A mismatch does not fail the tool; unstable observation forces EffectHost `unknown`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { applyPatchKernelPath, astEditKernelPath } from "./effect-kernel-tool-projection";

const POSTIMAGE_TOOLS = new Set(["write", "edit", "apply_patch", "ast_edit", "multi_edit"]);

export interface ReceiptPostimage {
  path: string;
  digest: string;
  /** False when independent re-read digests disagree (observation not trusted). */
  observationStable: boolean;
  /** Present when `observationStable` is false. */
  confirmDigest?: string;
}

export function postimagePathForTool(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
): string | undefined {
  if (!POSTIMAGE_TOOLS.has(tool)) return undefined;
  if (tool === "apply_patch") return applyPatchKernelPath(args, workspace);
  if (tool === "ast_edit") return astEditKernelPath(args, workspace);
  const raw =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file === "string" && args.file) ||
    (typeof args.file_path === "string" && args.file_path) ||
    undefined;
  if (!raw) return undefined;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw);
  // Refuse escaping the workspace for observation (best-effort lexical).
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

/** sha256 hex of file bytes from one read, or undefined if unreadable. */
export function observePostimageDigest(filePath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Pure: whether two independent observation digests agree. */
export function assessPostimageObservation(
  primaryDigest: string | undefined,
  confirmDigest: string | undefined,
): Pick<ReceiptPostimage, "observationStable" | "confirmDigest"> {
  if (primaryDigest === undefined || confirmDigest === undefined) {
    return { observationStable: false };
  }
  if (primaryDigest === confirmDigest) {
    return { observationStable: true };
  }
  return { observationStable: false, confirmDigest };
}

export function postimageObservationNotice(obs: ReceiptPostimage): string {
  const detail =
    obs.confirmDigest !== undefined
      ? `${obs.digest.slice(0, 12)}… vs ${obs.confirmDigest.slice(0, 12)}…`
      : "re-read failed";
  return `postimage observation unstable (independent re-read disagree): ${obs.path} (${detail}); effect marked unknown`;
}

export function computeReceiptPostimage(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
  ok: boolean,
  observe: (filePath: string) => string | undefined = observePostimageDigest,
): ReceiptPostimage | undefined {
  if (!ok) return undefined;
  const filePath = postimagePathForTool(tool, args, workspace);
  if (!filePath) return undefined;
  const digest = observe(filePath);
  if (!digest) return undefined;
  const confirmDigest = observe(filePath);
  const stability = assessPostimageObservation(digest, confirmDigest);
  return {
    path: filePath,
    digest,
    observationStable: stability.observationStable,
    ...(stability.confirmDigest !== undefined ? { confirmDigest: stability.confirmDigest } : {}),
  };
}

/** Digest fields safe to attach to a receipt (omitted when observation is unstable). */
export function receiptPostimageFields(
  postimage: ReceiptPostimage | undefined,
): { postimageDigest: string; postimagePath: string } | undefined {
  if (!postimage?.observationStable) return undefined;
  return { postimageDigest: postimage.digest, postimagePath: postimage.path };
}

/** Kernel `effect.execute` postimage facts mirrored into loop observe (ruling **280**). */
export interface KernelExecutePostimageObserve {
  contentDigest?: string;
  postimageObservationStable?: boolean;
  postimageConfirmDigest?: string;
  /** Kernel canonical tool-output digest for write/edit/shell observe (**314**, **327**). */
  resultDigest?: string;
  /** Kernel double-hash observe on result payload (**314** shell; **327** write/edit). */
  resultDigestStable?: boolean;
  stdoutDigest?: string;
  stderrDigest?: string;
}

/**
 * Map kernel fs.write/fs.edit double-read into the same receipt shape as TS **256**.
 * Falls back to ordinary file re-read when kernel did not supply a stable digest.
 */
export function computeReceiptPostimageFromKernel(
  tool: string,
  args: Record<string, unknown>,
  workspace: string,
  ok: boolean,
  kernel: KernelExecutePostimageObserve | undefined,
  observe: (filePath: string) => string | undefined = observePostimageDigest,
): ReceiptPostimage | undefined {
  if (!ok) return undefined;
  const filePath = postimagePathForTool(tool, args, workspace);
  if (!filePath || kernel === undefined) return undefined;
  const kernelStable =
    kernel.postimageObservationStable !== false && typeof kernel.contentDigest === "string" && kernel.contentDigest !== "";
  if (kernelStable) {
    return { path: filePath, digest: kernel.contentDigest!, observationStable: true };
  }
  if (kernel.postimageObservationStable === false) {
    const fallback = observe(filePath);
    return {
      path: filePath,
      digest: fallback ?? kernel.contentDigest ?? "",
      observationStable: false,
      ...(kernel.postimageConfirmDigest !== undefined ? { confirmDigest: kernel.postimageConfirmDigest } : {}),
    };
  }
  return computeReceiptPostimage(tool, args, workspace, ok, observe);
}
