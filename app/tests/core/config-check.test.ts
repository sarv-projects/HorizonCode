import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONFIG_ERROR_DOC,
  checkConfigFile,
  configErrorGuidance,
  renderConfigCheck,
  rejectedConfigValueLine,
  unknownConfigKeyLine,
} from "../../src/core/config";

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

describe("I-7 $schema acceptance (editor metadata)", () => {
  test("a string URL or path $schema is accepted, not reported as unknown", () => {
    for (const ref of [
      "http://json-schema.org/draft-07/schema#",
      "https://example.com/hzcode.schema.json",
      "./hzcode.schema.json",
      "app/schema/hzcode.schema.json",
    ]) {
      const check = checkConfigFile(cfg(JSON.stringify({ $schema: ref, provider: "mock" })));
      expect(check.unknown).toEqual([]);
      expect(check.rejected).toEqual([]);
      expect(renderConfigCheck(check)).toContain("ok:");
    }
  });

  test("a malformed $schema is rejected while other unknown keys stay unknown", () => {
    for (const ref of [42, null, {}, [], "   ", "has a space"]) {
      const check = checkConfigFile(cfg(JSON.stringify({ $schema: ref, modle: "x" })));
      expect(check.rejected.join("\n")).toContain("$schema must be a string URL or file path");
      expect(check.unknown).toContain("modle");
      expect(check.unknown).not.toContain("$schema");
    }
  });

  test("the doc link points at the stable configuration-keys anchor", () => {
    expect(CONFIG_ERROR_DOC).toContain("docs/33-handoff.md#configuration-keys");
    expect(CONFIG_ERROR_DOC).not.toContain("§5");
    const line = configErrorGuidance("model", "set HZ_MODEL");
    expect(line).toContain("docs/33-handoff.md#configuration-keys");
    // The diagnostic still carries the uniform fix + escape hatch.
    expect(line).toContain("fix: ");
    expect(line).toContain("escape hatch: ");
  });
});

describe("I-7 self-documenting config errors", () => {
  const fix = "fix: ";
  const escape = "escape hatch: ";
  test("the shared helper always names fix, doc link and escape hatch", () => {
    const text = configErrorGuidance("permissionMode", "set a valid permission mode");
    expect(text).toContain(fix);
    expect(text).toContain("set a valid permission mode");
    expect(text).toContain(CONFIG_ERROR_DOC);
    expect(text).toContain(escape);
    expect(text).toContain('"permissionMode"');
  });

  test("unknown key lines are self-documenting and mask secrets", () => {
    const line = unknownConfigKeyLine("sk-super-secret-key");
    expect(line).toContain("unknown key (ignored)");
    expect(line).toContain(fix);
    expect(line).toContain(CONFIG_ERROR_DOC);
    expect(line).toContain(escape);
    expect(line).not.toContain("sk-super-secret-key");
  });

  test("rejected value lines are self-documenting, per-key, and mask secrets", () => {
    const line = rejectedConfigValueLine('providers[0].baseUrl must be an http(s) URL (got "ftp://user:hunter2@host/x")');
    expect(line).toContain("rejected:");
    expect(line).toContain(fix);
    expect(line).toContain(CONFIG_ERROR_DOC);
    expect(line).toContain(escape);
    expect(line).toContain('"providers"');
    expect(line).not.toContain("hunter2");
  });

  test("renderConfigCheck output is uniform across unknown and rejected keys", () => {
    const out = renderConfigCheck(
      checkConfigFile(cfg(JSON.stringify({ provider: "nope", modle: "x", permissionMode: "yolo" }))),
    );
    const diagnostics = out.split("\n").filter((l) => l.includes("unknown key") || l.includes("rejected:"));
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    for (const line of diagnostics) {
      expect(line).toContain(fix);
      expect(line).toContain(CONFIG_ERROR_DOC);
      expect(line).toContain(escape);
    }
  });
});
