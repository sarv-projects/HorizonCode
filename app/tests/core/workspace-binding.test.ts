import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  captureWorkspaceBinding,
  isWorkspaceBindingError,
  refuseWorkspaceIdentityDrift,
} from "../../src/core/workspace-binding";

describe("workspace-binding (H-31 Bun / ruling 734)", () => {
  test("captureWorkspaceBinding returns root device inode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hz-ws-bind-"));
    try {
      const cap = await captureWorkspaceBinding(root);
      expect(isWorkspaceBindingError(cap)).toBe(false);
      if (isWorkspaceBindingError(cap)) return;
      expect(cap.root).toBe(path.resolve(root));
      expect(typeof cap.device).toBe("number");
      expect(typeof cap.inode).toBe("number");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuseWorkspaceIdentityDrift ok when unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hz-ws-bind-ok-"));
    try {
      const cap = await captureWorkspaceBinding(root);
      expect(isWorkspaceBindingError(cap)).toBe(false);
      if (isWorkspaceBindingError(cap)) return;
      expect(await refuseWorkspaceIdentityDrift(root, cap)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuseWorkspaceIdentityDrift fails closed on missing root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hz-ws-bind-gone-"));
    const cap = await captureWorkspaceBinding(root);
    expect(isWorkspaceBindingError(cap)).toBe(false);
    if (isWorkspaceBindingError(cap)) return;
    await rm(root, { recursive: true, force: true });
    const drift = await refuseWorkspaceIdentityDrift(root, cap);
    expect(drift).toContain("HZ_PRECONDITION_FAILED");
  });

  test("captureWorkspaceBinding refuses non-directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hz-ws-bind-file-"));
    const file = path.join(root, "not-a-dir");
    try {
      await writeFile(file, "x");
      const cap = await captureWorkspaceBinding(file);
      expect(isWorkspaceBindingError(cap)).toBe(true);
      if (!isWorkspaceBindingError(cap)) return;
      expect(cap.error).toContain("not a directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("mkdir under root does not change binding identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hz-ws-bind-child-"));
    try {
      const cap = await captureWorkspaceBinding(root);
      expect(isWorkspaceBindingError(cap)).toBe(false);
      if (isWorkspaceBindingError(cap)) return;
      await mkdir(path.join(root, "child"));
      expect(await refuseWorkspaceIdentityDrift(root, cap)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
