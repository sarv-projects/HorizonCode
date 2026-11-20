/**
 * resource-path-overlap.ts — R170 resource path overlap for latch / observe-pending gates.
 *
 * Extends realpathish prefix equality with lexical `resolveSymlinkChain` overlap
 * (dangling links whose final target is absent) and `(device, inode)` identity when
 * both paths exist on disk (hardlink aliases whose path strings diverge after
 * realpathish failure). Fail-closed `uncertain` when an existing path's identity
 * cannot be read or a symlink chain cannot be proved disjoint (rulings **695**, **699**).
 */

import { lstatSync } from "node:fs";
import * as path from "node:path";
import { resolveSymlinkChain } from "./kernel";
import { realpathish } from "./paths";

export type ResourcePathOverlap = "disjoint" | "overlap" | "uncertain";

export type ResourcePathOverlapUncertainReason =
  | "lstat_identity"
  | "symlink_chain_unresolved"
  | "dangling_symlink_target";

export type ResourcePathOverlapAssessment = {
  overlap: ResourcePathOverlap;
  uncertainReason?: ResourcePathOverlapUncertainReason;
};

function lstatIdentity(p: string): { device: number; inode: number } | undefined {
  try {
    const st = lstatSync(p);
    return { device: st.dev, inode: st.ino };
  } catch {
    return undefined;
  }
}

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Symlink present on disk whose walked final target does not exist (write-through landing). */
function danglingSymlinkMissingFinalTarget(p: string): boolean {
  if (!isSymlink(p)) return false;
  const resolved = resolveSymlinkChain(p);
  if (resolved === undefined) return true;
  return !pathExists(resolved);
}

function pathStringOverlap(a: string, b: string): boolean {
  const ra = realpathish(a);
  const rb = realpathish(b);
  if (ra === rb) return true;
  return ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

/**
 * Assess whether two workspace resource paths overlap for reduced R170 gates.
 */
export function assessResourcePathOverlapDetailed(a: string, b: string): ResourcePathOverlapAssessment {
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  if (pathStringOverlap(pa, pb)) return { overlap: "overlap" };

  const ra = resolveSymlinkChain(pa);
  const rb = resolveSymlinkChain(pb);
  if (ra === undefined || rb === undefined) {
    return { overlap: "uncertain", uncertainReason: "symlink_chain_unresolved" };
  }
  if (pathStringOverlap(ra, rb)) return { overlap: "overlap" };

  if (danglingSymlinkMissingFinalTarget(pa) || danglingSymlinkMissingFinalTarget(pb)) {
    return { overlap: "uncertain", uncertainReason: "dangling_symlink_target" };
  }

  const aExists = pathExists(pa);
  const bExists = pathExists(pb);
  const ia = aExists ? lstatIdentity(pa) : undefined;
  const ib = bExists ? lstatIdentity(pb) : undefined;

  if (aExists && ia === undefined) {
    return { overlap: "uncertain", uncertainReason: "lstat_identity" };
  }
  if (bExists && ib === undefined) {
    return { overlap: "uncertain", uncertainReason: "lstat_identity" };
  }

  if (ia !== undefined && ib !== undefined && ia.device === ib.device && ia.inode === ib.inode) {
    return { overlap: "overlap" };
  }

  return { overlap: "disjoint" };
}

export function assessResourcePathOverlap(a: string, b: string): ResourcePathOverlap {
  return assessResourcePathOverlapDetailed(a, b).overlap;
}

/** Fail-closed overlap for in-run gates (observe-pending, frozen UNKNOWN). */
export function resourcePathsOverlap(a: string, b: string): boolean {
  const r = assessResourcePathOverlap(a, b);
  return r === "overlap" || r === "uncertain";
}

export function formatResourcePathOverlapUncertainReason(
  reason: ResourcePathOverlapUncertainReason | undefined,
): string {
  switch (reason) {
    case "dangling_symlink_target":
      return "dangling symlink — final link target absent; cannot prove disjoint from blocked path(s)";
    case "symlink_chain_unresolved":
      return "symlink chain unresolved; cannot prove disjoint from blocked path(s)";
    case "lstat_identity":
    default:
      return "existing path — lstat (device,inode) identity cannot be proven against blocked path(s)";
  }
}