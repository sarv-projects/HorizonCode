/**
 * code-mode-modules.ts — data-driven module registry for VM IMPORT
 * (opencode IMPORT opcode 24 ADAPT).
 *
 * Modules are injected as plain data (name → exports object). No filesystem,
 * no node require, no eval — the host decides exactly what a program may
 * import. Unknown modules resolve to undefined so the VM fails closed.
 */

export type ModuleExports = Record<string, unknown>;

export interface ModuleRegistry {
  get(name: string): ModuleExports | undefined;
  names(): string[];
}

export function createModuleRegistry(modules: Readonly<Record<string, ModuleExports>> = {}): ModuleRegistry {
  const map = new Map<string, ModuleExports>();
  for (const [name, exports] of Object.entries(modules)) {
    if (name.trim() === "") continue;
    map.set(name, exports);
  }
  return {
    get: (name) => map.get(name),
    names: () => [...map.keys()].sort(),
  };
}
