import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { renderWorkspaceTrustReport } from "../../src/core/trust";

describe("renderWorkspaceTrustReport", () => {
  test("mentions folder trust framing", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-trust-"));
    const home = mkdtempSync(path.join(tmpdir(), "hz-trust-home-"));
    const text = renderWorkspaceTrustReport(ws, home, []);
    expect(text).toContain("Folder trust is not git trust");
    expect(text).toContain(ws);
  });
});
