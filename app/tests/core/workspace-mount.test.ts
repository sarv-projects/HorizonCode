import { describe, expect, test } from "bun:test";
import { isNetworkFilesystemType, mountFilesystemForPath, workspaceMountPosture } from "../../src/core/workspace-mount";

describe("workspace mount honesty", () => {
  test("network fstypes", () => {
    expect(isNetworkFilesystemType("nfs4")).toBe(true);
    expect(isNetworkFilesystemType("ext4")).toBe(false);
  });

  test("mountinfo longest prefix", () => {
    const sample = [
      "25 30 0:51 / /mnt/nfs rw,relatime - nfs4 server:/export rw",
      "26 25 0:52 /project /mnt/nfs/project rw,relatime - nfs4 server:/export/project rw",
    ];
    const hit = mountFilesystemForPath("/mnt/nfs/project/work", sample);
    expect(hit?.fstype).toBe("nfs4");
    expect(hit?.mountPoint).toBe("/mnt/nfs/project");
  });

  test("doctor posture warns on nfs", () => {
    const p = workspaceMountPosture("/mnt/nfs/ws", { findmntFstype: "nfs" });
    expect(p.kind).toBe("network");
  });
});
