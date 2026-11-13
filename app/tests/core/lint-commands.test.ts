import { describe, expect, test } from "bun:test";
import {
  parseLintConfig,
  parseLintOutputLines,
  resolveLintCommand,
  substituteLintFile,
} from "../../src/core/lint-commands";

describe("F-3 lint commands", () => {
  test("parse + resolve by extension with catch-all", () => {
    const cfg = parseLintConfig({
      commands: [
        { extensions: ["ts"], command: "eslint {file}" },
        { extensions: ["*"], command: "echo {file}" },
      ],
    });
    expect(cfg?.commands.length).toBe(2);
    expect(resolveLintCommand("/w/foo.ts", cfg)?.command).toBe("eslint {file}");
    expect(resolveLintCommand("/w/foo.py", cfg)?.command).toBe("echo {file}");
  });

  test("substitute and parse filename:line", () => {
    const cmd = substituteLintFile("echo {file}", "/w/a.ts");
    expect(cmd).toContain('"/w/a.ts"');
    const rows = parseLintOutputLines("src/a.ts:3:1 error: bad\nnoise");
    expect(rows.length).toBe(1);
    expect(rows[0]?.line).toBe(3);
  });
});
