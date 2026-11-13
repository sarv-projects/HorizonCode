import { describe, expect, test } from "bun:test";
import {
  permissionAlwaysLines,
  permissionPresentationForRequest,
} from "../../src/tui/permission-presentation";

describe("permission presentation", () => {
  test("shell shows command line", () => {
    const p = permissionPresentationForRequest({
      kind: "shell.exec",
      title: "run this command",
      detail: "npm test",
    });
    expect(p.title).toBe("Shell command");
    expect(p.lines[0]).toBe("$ npm test");
  });

  test("relative path when workspace set", () => {
    const p = permissionPresentationForRequest(
      { kind: "fs.read", title: "read", detail: "/tmp/ws/src/a.ts" },
      "/tmp/ws",
    );
    expect(p.title).toContain("Read");
    expect(p.lines[0]).toContain("src/a.ts");
  });

  test("always lines name the target", () => {
    expect(permissionAlwaysLines("shell.exec", "npm test")[1]).toContain("npm test");
  });
});
