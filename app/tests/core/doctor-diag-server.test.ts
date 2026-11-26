/**
 * doctor-diag-server.test.ts — diag-server response model reachable via hzcode doctor.
 */

import { describe, expect, test } from "bun:test";
import { checkDiagServerModel } from "../../src/core/doctor";

describe("doctor diag server check", () => {
  test("checkDiagServerModel returns ok when readiness, statusz and log ring models pass", () => {
    const check = checkDiagServerModel();
    expect(check.status).toBe("ok");
    expect(check.id).toBe("diag_server.model");
    expect(check.detail).toContain("verified");
  });
});
