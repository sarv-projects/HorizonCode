import { describe, expect, test } from "bun:test";
import {
  openCodeActionForGuardKind,
  permissionActionResourceLines,
} from "../../src/core/permission-vocabulary";

describe("permission-vocabulary", () => {
  test("maps guard kinds to OpenCode actions", () => {
    expect(openCodeActionForGuardKind("fs.read")).toBe("read");
    expect(openCodeActionForGuardKind("shell.exec")).toBe("shell");
    expect(openCodeActionForGuardKind("net.fetch")).toBe("webfetch");
  });

  test("action/resource lines use exact grant target", () => {
    expect(permissionActionResourceLines("shell.exec", "npm test")).toEqual([
      "action: shell",
      "resource: npm test",
    ]);
    expect(permissionActionResourceLines("fs.write", "")).toEqual([]);
  });
});