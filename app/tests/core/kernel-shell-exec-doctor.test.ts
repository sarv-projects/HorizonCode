import { describe, expect, test } from "bun:test";
import { assessKernelShellExecDoctorPosture } from "../../src/core/kernel-shell-exec-doctor";

describe("kernel-shell-exec-doctor", () => {
  test("require-wrap without binary fails closed", () => {
    const posture = assessKernelShellExecDoctorPosture({
      HZ_SANDBOX_REQUIRE: "1",
      HZ_SANDBOX_EXEC_BIN: "/nonexistent/hz-sandbox-exec",
    });
    expect(posture.status).toBe("fail");
    expect(posture.detail).toContain("730");
    expect(posture.detail).toContain("never shell-net enforced");
  });

  test("missing binary without require warns on bare argv fallback", () => {
    const posture = assessKernelShellExecDoctorPosture({
      HZ_SANDBOX_EXEC_BIN: "/nonexistent/hz-sandbox-exec",
    });
    expect(posture.status).toBe("warn");
    expect(posture.detail).toContain("bare argv");
  });

  test("HZ_SANDBOX_EXEC=0 with require fails", () => {
    const posture = assessKernelShellExecDoctorPosture({
      HZ_SANDBOX_EXEC: "0",
      HZ_SANDBOX_REQUIRE: "1",
    });
    expect(posture.status).toBe("fail");
    expect(posture.detail).toContain("HZ_SANDBOX_EXEC=0");
  });
});