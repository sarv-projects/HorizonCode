/** `src/tools/helpers.ts` — truncation, path display and binary sniffing. */

import { describe, expect, test } from "bun:test";
import { isBinary, relPath, resolvePath, truncate } from "../../src/tools/helpers";

describe("truncate", () => {
  test("leaves short text untouched", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("ab", 3)).toBe("ab");
  });

  test("marks the cut explicitly", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcde\n[truncated]");
  });
});

describe("resolvePath", () => {
  test("resolves relative paths against the base", () => {
    expect(resolvePath("/work", "src/a.ts")).toBe("/work/src/a.ts");
    expect(resolvePath("/work", "../out")).toBe("/out");
  });

  test("keeps absolute paths", () => {
    expect(resolvePath("/work", "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("relPath", () => {
  test("renders paths inside the base as relative", () => {
    expect(relPath("/work", "/work/src/a.ts")).toBe("src/a.ts");
  });

  test("falls back to the basename for the base itself", () => {
    expect(relPath("/work/sub", "/work/sub")).toBe("sub");
  });

  test("keeps paths outside the base absolute", () => {
    expect(relPath("/work", "/etc/hosts")).toBe("/etc/hosts");
    expect(relPath("/work/sub", "/work/a.ts")).toBe("/work/a.ts");
  });
});

describe("isBinary", () => {
  test("detects a NUL byte", () => {
    expect(isBinary(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toBe(true);
  });

  test("accepts plain text", () => {
    expect(isBinary(new TextEncoder().encode("line one\nline two\n"))).toBe(false);
  });

  test("only sniffs the head of large buffers", () => {
    const late = new Uint8Array(9001).fill(0x41);
    late[9000] = 0;
    expect(isBinary(late)).toBe(false);

    const early = new Uint8Array(9001).fill(0x41);
    early[10] = 0;
    expect(isBinary(early)).toBe(true);
  });
});
