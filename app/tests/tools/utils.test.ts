/** `src/tools/helpers.ts` — truncation, path display and binary sniffing. */

import { describe, expect, test } from "bun:test";
import { isBinary, relPath, resolvePath, scrubEnv, truncate } from "../../src/tools/helpers";

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

describe("scrubEnv", () => {
  test("drops credential-shaped names and DSN-shaped values, keeps harmless URLs", () => {
    process.env.HZ_TEST_API_KEY = "sk-1";
    process.env.HZ_TEST_DB_DSN = "postgres://u:p@h/db";
    process.env.HZ_TEST_CREDENTIALS = "user:pass";
    process.env.HZ_TEST_DATABASE_URL = "postgres://app:s3cr3t@db.internal:5432/app";
    process.env.HZ_TEST_LOCAL_URL = "redis://127.0.0.1:6379";
    process.env.HZ_TEST_INDEX_URL = "https://pypi.org/simple";
    try {
      const env = scrubEnv();
      // Credentials by name and by value never reach a child process.
      expect(env.HZ_TEST_API_KEY).toBeUndefined();
      expect(env.HZ_TEST_DB_DSN).toBeUndefined();
      expect(env.HZ_TEST_CREDENTIALS).toBeUndefined();
      expect(env.HZ_TEST_DATABASE_URL).toBeUndefined();
      // A credential-free URL is not a secret; a build tool may need it.
      expect(env.HZ_TEST_LOCAL_URL).toBe("redis://127.0.0.1:6379");
      expect(env.HZ_TEST_INDEX_URL).toBe("https://pypi.org/simple");
    } finally {
      for (const k of ["HZ_TEST_API_KEY", "HZ_TEST_DB_DSN", "HZ_TEST_CREDENTIALS", "HZ_TEST_DATABASE_URL", "HZ_TEST_LOCAL_URL", "HZ_TEST_INDEX_URL"]) {
        delete process.env[k];
      }
    }
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
