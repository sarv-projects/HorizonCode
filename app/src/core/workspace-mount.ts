/**
 * workspace-mount.ts — network-mount honesty for workspaces (docs/12 F9 reduced).
 *
 * Does not switch SQLite journal mode; only surfaces a WARN hint for doctor.
 */

const NETWORK_FS = /^(nfs\d*|cifs|smb\d*|fuse\.sshfs|fuse\.glusterfs)$/i;

export function isNetworkFilesystemType(fstype: string): boolean {
  const t = fstype.trim().toLowerCase();
  return t !== "" && NETWORK_FS.test(t);
}

/** Pick the mount table line whose mount point is the longest prefix of `target`. */
export function mountFilesystemForPath(
  target: string,
  mountinfoLines: readonly string[],
): { mountPoint: string; fstype: string } | undefined {
  const resolved = target.replace(/\/+$/, "") || "/";
  let best: { mountPoint: string; fstype: string; len: number } | undefined;
  for (const raw of mountinfoLines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const dash = line.lastIndexOf(" - ");
    if (dash === -1) continue;
    const tail = line.slice(dash + 3).trim().split(/\s+/);
    const fstype = tail[0] ?? "";
    const parts = line.slice(0, dash).trim().split(/\s+/);
    if (parts.length < 5) continue;
    const mountPoint = parts[4]!.replace(/\\040/g, " ");
    const mp = mountPoint.replace(/\/+$/, "") || "/";
    if (resolved === mp || resolved.startsWith(mp + "/") || (mp === "/" && resolved.startsWith("/"))) {
      const len = mp.length;
      if (!best || len > best.len) best = { mountPoint: mp, fstype, len };
    }
  }
  return best ? { mountPoint: best.mountPoint, fstype: best.fstype } : undefined;
}

export type WorkspaceMountPosture = { kind: "local" | "network" | "unknown"; detail: string };

export function workspaceMountPosture(
  workspace: string,
  opts?: { mountinfo?: string; findmntFstype?: string },
): WorkspaceMountPosture {
  if (opts?.findmntFstype !== undefined && opts.findmntFstype.trim() !== "") {
    const fs = opts.findmntFstype.trim();
    if (isNetworkFilesystemType(fs)) {
      return {
        kind: "network",
        detail: `workspace is on ${fs} (SQLite WAL and POSIX locks are unsafe across hosts; advisory locks are host-local)`,
      };
    }
    return { kind: "local", detail: `workspace filesystem: ${fs}` };
  }
  if (opts?.mountinfo !== undefined) {
    const hit = mountFilesystemForPath(workspace, opts.mountinfo.split("\n"));
    if (hit && isNetworkFilesystemType(hit.fstype)) {
      return {
        kind: "network",
        detail: `workspace is on ${hit.fstype} at ${hit.mountPoint} (network mount — see docs/12 F9)`,
      };
    }
    if (hit) return { kind: "local", detail: `workspace filesystem: ${hit.fstype} at ${hit.mountPoint}` };
  }
  return { kind: "unknown", detail: "could not determine workspace mount type (F9 NFS detection not fully built)" };
}
