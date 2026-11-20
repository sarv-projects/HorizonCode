import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { resolveKernelSocketPath } from "../../src/core/kernel";

describe("resolveKernelSocketPath (H-29 / ruling 626)", () => {
  test("unset → undefined (stdio-only product default)", () => {
    expect(resolveKernelSocketPath({}, "/tmp/hz-state")).toBeUndefined();
  });

  test("HZ_KERNEL_SOCKET wins over detach default", () => {
    expect(
      resolveKernelSocketPath(
        { HZ_KERNEL_SOCKET: "/tmp/custom.sock", HZ_KERNEL_DETACH: "1" },
        "/tmp/hz-state",
      ),
    ).toBe("/tmp/custom.sock");
  });

  test("HZ_KERNEL_DETACH=1 defaults to <stateDir>/hzk.sock", () => {
    expect(resolveKernelSocketPath({ HZ_KERNEL_DETACH: "1" }, "/tmp/hz-state")).toBe(
      path.join("/tmp/hz-state", "hzk.sock"),
    );
  });

  test("blank HZ_KERNEL_SOCKET is ignored", () => {
    expect(resolveKernelSocketPath({ HZ_KERNEL_SOCKET: "  " }, "/tmp/hz-state")).toBeUndefined();
  });

  test("native win32 ignores detach env (no peer-proven socket lease)", () => {
    expect(
      resolveKernelSocketPath({ HZ_KERNEL_DETACH: "1" }, "/tmp/hz-state", "win32"),
    ).toBeUndefined();
  });
});
