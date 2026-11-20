/**
 * H-31 Bun file-tool workspace identity (rulings 623, 629, 636, 674, 734).
 *
 * Mirrors `kernel/src/workspace_binding.rs`: authority binds to (root, device, inode),
 * not the path string alone. File tools capture at guard time and re-stat at effect time.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import type { LeaseWorkspaceBinding } from "../contracts";

export type WorkspaceBindingCapture = LeaseWorkspaceBinding | { error: string };

function bindingError(msg: string): { error: string } {
  return { error: msg };
}

/** Resolve and stat the workspace directory `(device, inode)`. */
export async function captureWorkspaceBinding(workspace: string): Promise<WorkspaceBindingCapture> {
  const root = path.resolve(workspace);
  let st;
  try {
    st = await stat(root);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return bindingError(`HZ_PRECONDITION_FAILED: workspace binding could not stat ${root}: ${detail}`);
  }
  if (!st.isDirectory()) {
    return bindingError(`HZ_PRECONDITION_FAILED: workspace binding root is not a directory: ${root}`);
  }
  return { root, device: st.dev, inode: st.ino };
}

export function isWorkspaceBindingError(
  cap: WorkspaceBindingCapture,
): cap is { error: string } {
  return "error" in cap;
}

/**
 * Fail-closed when the live workspace root drifts from the guard-time binding
 * (rename-swap / remount). Returns a refusal message or `undefined` when ok.
 */
export async function refuseWorkspaceIdentityDrift(
  workspace: string,
  expected: LeaseWorkspaceBinding,
): Promise<string | undefined> {
  const live = await captureWorkspaceBinding(workspace);
  if (isWorkspaceBindingError(live)) return live.error;
  if (path.resolve(live.root) !== path.resolve(expected.root)) {
    return "HZ_PRECONDITION_FAILED: mutation refused: workspace root path does not equal bound workspace root";
  }
  if (live.device !== expected.device || live.inode !== expected.inode) {
    return (
      "HZ_PRECONDITION_FAILED: mutation refused: workspace identity (device,inode) drifted since guard " +
      "(remount or rename-swap); nothing was written"
    );
  }
  return undefined;
}