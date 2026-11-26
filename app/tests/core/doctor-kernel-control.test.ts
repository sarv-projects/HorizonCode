/**
 * doctor-kernel-control.test.ts — the launch credential channel is reported honestly.
 *
 * On unix the launch secret travels on an inherited private pipe (fd 3). On
 * Windows it travels in a one-shot file inside the kernel state dir, which a
 * same-user process could read during the launch window (ruling 908). Doctor must
 * say which one is in use rather than implying fd-3 strength everywhere.
 */

import { describe, expect, test } from "bun:test";
import { checkKernelControlChannel } from "../../src/core/doctor";

describe("kernel control channel doctor line", () => {
  test("unix reports the private pipe", () => {
    const check = checkKernelControlChannel("linux");
    expect(check.id).toBe("kernel.control.channel");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("fd 3");
  });

  test("windows reports the weaker one-shot file and the open named-pipe path", () => {
    const check = checkKernelControlChannel("win32");
    expect(check.id).toBe("kernel.control.channel");
    expect(check.status).toBe("warn");
    expect(check.detail.toLowerCase()).toContain("one-shot");
    expect(check.detail).toContain("H-29");
    expect(check.hint ?? "").toContain("named-pipe");
  });
});
