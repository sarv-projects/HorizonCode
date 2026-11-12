import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { maybeDumpProviderRequest } from "../../src/core/providers/request-dump";

const prev = process.env.HZ_DEBUG_REQUESTS;
let file: string;

afterEach(() => {
  if (prev === undefined) delete process.env.HZ_DEBUG_REQUESTS;
  else process.env.HZ_DEBUG_REQUESTS = prev;
  if (file) {
    try {
      rmSync(path.dirname(file), { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

describe("HZ_DEBUG_REQUESTS", () => {
  test("writes masked JSONL at mode 0600", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-req-dump-"));
    file = path.join(dir, "req.jsonl");
    process.env.HZ_DEBUG_REQUESTS = file;
    maybeDumpProviderRequest("openai", { apiKey: "sk-secret-abc", messages: [] });
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const line = readFileSync(file, "utf8").trim();
    expect(line).toContain("openai");
    expect(line).not.toContain("sk-secret-abc");
    chmodSync(file, 0o600);
  });
});
