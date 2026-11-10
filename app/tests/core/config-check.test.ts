import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkConfigFile, renderConfigCheck } from "../../src/core/config";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function cfg(body: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "hz-cc-"));
  dirs.push(d);
  const f = path.join(d, "config.json");
  writeFileSync(f, body);
  return f;
}

test("a clean file passes, a missing one is not an error", () => {
  const ok = checkConfigFile(cfg('{"provider":"mock","model":"m"}'));
  expect(ok.unknown).toEqual([]);
  expect(ok.rejected).toEqual([]);
  expect(renderConfigCheck(ok)).toContain("ok:");
  expect(checkConfigFile("/nonexistent/config.json").exists).toBe(false);
});

test("unknown and rejected keys are named, secrets are not echoed", () => {
  const c = checkConfigFile(
    cfg(
      JSON.stringify({
        provider: "nope",
        apiKey: "sk-secret-value",
        modle: "x",
        permissionMode: "yolo",
        mcp: { servers: [{ id: "a", command: "x", extra: 1 }, { id: "BAD" }], other: 1 },
        providers: [{ id: "p1", baseUrl: "ftp://x" }],
      }),
    ),
  );
  expect(c.unknown).toEqual(expect.arrayContaining(["modle", "mcp.servers[0].extra", "mcp.other"]));
  expect(c.rejected.join("\n")).toContain("provider");
  expect(c.rejected.join("\n")).toContain("mcp.servers[1]");
  expect(c.rejected.join("\n")).toContain("providers[0].baseUrl");
  expect(renderConfigCheck(c)).not.toContain("sk-secret-value");
});

test("invalid JSON is reported", () => {
  expect(checkConfigFile(cfg("{nope")).rejected[0]).toContain("not valid JSON");
});

import { renderConfigCheck as __render } from "../../src/core/config";
import { test as __t, expect as __e } from "bun:test";
__t("config check masks credentials in a rejected baseUrl", () => {
  const out = __render({ file: "f", exists: true, unknown: [], rejected: ['providers[0].baseUrl must be an http(s) URL (got "ftp://user:hunter2secret@host/x")'] });
  __e(out).not.toContain("hunter2secret");
});
