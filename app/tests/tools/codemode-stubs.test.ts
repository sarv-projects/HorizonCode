import { describe, expect, test } from "bun:test";
import {
  buildCodemodeStub,
  compactArgsSignature,
  codemodeTypedStubsEnabled,
  renderCodemodeCompactStubs,
  renderCodemodeTypedStubs,
} from "../../src/tools/codemode-stubs";
import { codemodeTool } from "../../src/tools/codemode";
import { editTool } from "../../src/tools/edit";

describe("codemode-stubs (ruling 641/645)", () => {
  test("buildCodemodeStub includes inputSchema and outputSchema", () => {
    const stub = buildCodemodeStub({
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    });
    expect(stub.outputSchema.properties?.ok?.type).toBe("boolean");
    expect(stub.dts).toContain("declare function read");
    expect(stub.dts).toContain("outputSchema");
    expect(stub.dts).toContain("inputSchema");
  });

  test("renderCodemodeTypedStubs declares tools.kv", () => {
    const text = renderCodemodeTypedStubs([
      {
        name: "grep",
        description: "Search",
        parameters: { type: "object", properties: { pattern: { type: "string" } } },
      },
    ]);
    expect(text).toContain("kv: { get(key: string)");
    expect(text).toContain("declare function grep");
  });

  test("compact stubs derive edit old/new from live editTool schema", () => {
    const sig = compactArgsSignature({
      name: editTool.name,
      description: editTool.description,
      parameters: editTool.parameters,
    });
    expect(sig).toContain("old?");
    expect(sig).toContain("new");
    expect(sig).not.toContain("old_string");
    expect(sig).not.toContain("new_string");
    const compact = renderCodemodeCompactStubs([
      { name: editTool.name, description: editTool.description, parameters: editTool.parameters },
    ]);
    expect(compact).toContain("edit({");
    expect(compact).toContain("old?");
  });

  test("codemode tool description embeds compact stubs under 1024 chars", () => {
    expect(codemodeTypedStubsEnabled({})).toBe(true);
    expect(codemodeTool.description).toContain("Typed stubs (ruling 641");
    expect(codemodeTool.description).toContain("edit({");
    expect(codemodeTool.description).toContain("old?");
    expect(codemodeTool.description).not.toContain("old_string");
    expect(codemodeTool.description.length).toBeLessThanOrEqual(1024);
  });

  test("HZ_CODEMODE_TYPED_STUBS=0 disables stub block", () => {
    expect(codemodeTypedStubsEnabled({ HZ_CODEMODE_TYPED_STUBS: "0" })).toBe(false);
  });
});
