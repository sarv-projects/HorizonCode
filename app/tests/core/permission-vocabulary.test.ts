import { describe, expect, test } from "bun:test";
import {
  foldPermissionEffects,
  openCodeActionForGuardKind,
  permissionActionResourceLines,
  permissionMultiResourceLines,
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

  test("foldPermissionEffects prefers deny over ask over allow (ruling 563)", () => {
    expect(foldPermissionEffects([])).toBe("allow");
    expect(foldPermissionEffects(["allow", "allow"])).toBe("allow");
    expect(foldPermissionEffects(["allow", "ask"])).toBe("ask");
    expect(foldPermissionEffects(["ask", "deny", "allow"])).toBe("deny");
    expect(foldPermissionEffects(["ask", "ask"])).toBe("ask");
  });

  test("permissionMultiResourceLines projects one action and N resources", () => {
    expect(permissionMultiResourceLines("fs.write", ["a.ts", "b.ts"])).toEqual([
      "action: edit",
      "resource: a.ts",
      "resource: b.ts",
    ]);
    expect(permissionMultiResourceLines("fs.write", ["a.ts", "a.ts", "  "])).toEqual([
      "action: edit",
      "resource: a.ts",
    ]);
  });
});