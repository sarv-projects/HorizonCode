/**
 * ptc-sdk-emitter.test.ts — typed TS/Python SDK declaration emission
 * (deepseek/codex PTC "SDK in system prompt" ADAPT). Pure text generation from
 * tool specs; no V8 binding, no eval. Deterministic and bounded.
 */
import { describe, expect, test } from "bun:test";
import { emitToolSdk, type SdkToolSpec } from "../../src/tools/ptc-sdk-emitter";

const TOOLS: SdkToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        limit: { type: "number", description: "Max lines" },
      },
      required: ["path"],
    },
  },
];

describe("PTC SDK emitter", () => {
  test("emits a typed TypeScript declaration", () => {
    const sdk = emitToolSdk(TOOLS, "typescript");
    expect(sdk).toContain("declare function read_file");
    expect(sdk).toContain("path: string");
    expect(sdk).toContain("limit?: number"); // optional (not in required)
  });

  test("emits a typed Python declaration", () => {
    const sdk = emitToolSdk(TOOLS, "python");
    expect(sdk).toContain("def read_file(");
    expect(sdk).toContain("path: str");
    expect(sdk).toContain("limit");
  });

  test("description becomes a doc comment/string", () => {
    expect(emitToolSdk(TOOLS, "typescript")).toContain("Read a file");
    expect(emitToolSdk(TOOLS, "python")).toContain("Read a file");
  });

  test("empty tools and unknown types are handled honestly", () => {
    expect(emitToolSdk([], "typescript")).toBe("");
    expect(() => emitToolSdk(TOOLS, "ruby" as never)).toThrow(/language/i);
  });
});
