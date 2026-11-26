/**
 * ptc-tool-environment.ts — Code Mode 2.0 PTC SDK & Tool Environment
 *
 * Integrates:
 *   - ptc-sdk-emitter.ts (typed SDK declaration generation)
 *   - code-mode-modules.ts (in-memory data module registry)
 *   - code-mode-host-bridge.ts (async host function bridge)
 *   - code-mode-vm.ts (bytecode execution)
 *
 * Source: repo_take/opencode (codemode modules & host bridge) + deepseek-harness PTC.
 */

import { emitToolSdk, type SdkLanguage, type SdkToolSpec } from "../tools/ptc-sdk-emitter";
import { createModuleRegistry, type ModuleExports, type ModuleRegistry } from "./code-mode-modules";
import type { BytecodeProgram } from "./code-mode-vm";
import {
  createHostBridge,
  type HostBridge,
  type HostFunction,
} from "./code-mode-host-bridge";

export interface PtcToolDefinition extends SdkToolSpec {
  handler: HostFunction;
}

export interface PtcEnvironmentOptions {
  tools: readonly PtcToolDefinition[];
}

export interface PtcEnvironment {
  getSdkDeclarations(language: SdkLanguage): string;
  getModuleRegistry(): ModuleRegistry;
  createBridge(program: BytecodeProgram): HostBridge;
  invokeHostTool(name: string, ...args: unknown[]): Promise<unknown>;
}

export function createPtcEnvironment(opts: PtcEnvironmentOptions): PtcEnvironment {
  const toolsMap = new Map<string, PtcToolDefinition>();
  for (const t of opts.tools) {
    toolsMap.set(t.name, t);
  }

  const hostFunctions: Record<string, HostFunction> = {};
  const toolsExports: ModuleExports = {};

  for (const [name, def] of toolsMap.entries()) {
    hostFunctions[name] = def.handler;
    toolsExports[name] = def.handler;
  }

  const moduleRegistry = createModuleRegistry({
    "horizon/tools": toolsExports,
  });

  return {
    getSdkDeclarations(language: SdkLanguage): string {
      return emitToolSdk(opts.tools, language);
    },

    getModuleRegistry(): ModuleRegistry {
      return moduleRegistry;
    },

    createBridge(program: BytecodeProgram): HostBridge {
      return createHostBridge(program, { hosts: hostFunctions });
    },

    async invokeHostTool(name: string, ...args: unknown[]): Promise<unknown> {
      const tool = toolsMap.get(name);
      if (!tool) {
        throw new Error(`HZ_PRECONDITION_FAILED: unknown tool ${name}`);
      }
      return tool.handler(...args);
    },
  };
}
