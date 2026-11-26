/**
 * d10-saved-allows-strict.test.ts — D-10: a saved allow must survive strict mode.
 *
 * A saved allow is an explicit human decision recorded earlier. Replaying it on
 * session start must mint through the human-attested path (principal:"human"),
 * because HZ_HUMAN_PRINCIPAL_STRICT=1 refuses a raw mint. The recall used to
 * call makeGrant with no principal and swallow the refusal, silently disabling
 * every saved allow in strict mode.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { KernelClient } from "../../src/core/kernel";
import { appendSavedAllow, hydrateSavedGrants } from "../../src/core/saved-allows";
import { assertHumanApprovalPathAttestationForMint } from "../../src/core/human-approval-principal-strict";

let workspace = "";
const previous = process.env.HZ_HUMAN_PRINCIPAL_STRICT;

afterEach(() => {
  if (workspace) {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* SQLite handle still open on some hosts (Windows); the OS reclaims it */
    }
  }
  workspace = "";
  if (previous === undefined) delete process.env.HZ_HUMAN_PRINCIPAL_STRICT;
  else process.env.HZ_HUMAN_PRINCIPAL_STRICT = previous;
});

describe("saved-allow recall under strict human principal", () => {
  test("hydrates through the human-attested mint", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-saved-strict-"));
    await appendSavedAllow(workspace, "shell.exec", "npm test");
    process.env.HZ_HUMAN_PRINCIPAL_STRICT = "1";

    const calls: Array<{ principal?: string } | undefined> = [];
    const kernel = {
      async makeGrant(_kind: string, _pattern: string, _ttl: number, _session: string, opts?: { principal?: string }) {
        // Mirror the product gate: strict mode refuses an unattested mint.
        assertHumanApprovalPathAttestationForMint(opts);
        calls.push(opts);
        return { id: "l1", kind: "shell.exec", pattern: "npm test", expiry: new Date(Date.now() + 60_000).toISOString(), owner: "s" };
      },
    } as unknown as KernelClient;

    const count = await hydrateSavedGrants(kernel, workspace, "s1", 60_000);
    expect(count).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.principal).toBe("human");
  }, 30_000);
});
