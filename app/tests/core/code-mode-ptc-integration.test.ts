import { describe, expect, it } from "bun:test";
import {
  createPtcEnvironment,
  type PtcToolDefinition,
} from "../../src/core/ptc-tool-environment";
import { HOST_CALL } from "../../src/core/code-mode-host-bridge";
import { Op } from "../../src/core/code-mode-vm";

describe("PTC Tool Environment (Code Mode 2.0)", () => {
  const sampleTools: PtcToolDefinition[] = [
    {
      name: "get_status",
      description: "Gets the current system status",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => ({ status: "ok", active: true }),
    },
    {
      name: "calculate",
      description: "Performs addition",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number", description: "first number" },
          b: { type: "number", description: "second number" },
        },
        required: ["a", "b"],
      },
      handler: async (args: unknown) => {
        const { a, b } = (args ?? {}) as { a?: number; b?: number };
        return (a ?? 0) + (b ?? 0);
      },
    },
  ];

  it("emits typed SDK declarations for tools in typescript and python", () => {
    const env = createPtcEnvironment({ tools: sampleTools });
    const tsSdk = env.getSdkDeclarations("typescript");
    const pySdk = env.getSdkDeclarations("python");

    expect(tsSdk).toContain("declare function get_status");
    expect(tsSdk).toContain("declare function calculate");
    expect(pySdk).toContain("def get_status");
    expect(pySdk).toContain("def calculate");
  });

  it("creates a module registry containing horizon/tools exports", () => {
    const env = createPtcEnvironment({ tools: sampleTools });
    const registry = env.getModuleRegistry();

    expect(registry.names()).toContain("horizon/tools");
    const toolsModule = registry.get("horizon/tools");
    expect(toolsModule).toBeDefined();
    expect(typeof toolsModule?.get_status).toBe("function");
    expect(typeof toolsModule?.calculate).toBe("function");
  });

  it("runs a host bridge program invoking a tool through PTC environment", async () => {
    const env = createPtcEnvironment({ tools: sampleTools });

    // Program: push args object, call calculate host function, return
    const program = {
      words: [
        Op.PUSH_CONST, 1, // push args object: { a: 10, b: 32 }
        HOST_CALL, 0,     // call host function named in consts[0] ("calculate")
        Op.RETURN,
      ],
      consts: ["calculate", { a: 10, b: 32 }],
    };

    const bridge = env.createBridge(program);
    const step1 = await bridge.start();

    expect(step1.kind).toBe("suspended");
    if (step1.kind === "suspended") {
      expect(step1.call.name).toBe("calculate");
      const result = await env.invokeHostTool(step1.call.name, step1.call.args[0]);
      const step2 = await bridge.resolveCall(step1.call.id, result);
      expect(step2.kind).toBe("done");
      if (step2.kind === "done") {
        expect(step2.value).toBe(42);
      }
    }
  });
});
