/**
 * Code Mode 2.0 typed stubs (ruling 641) — inputSchema + outputSchema.
 *
 * Declared return shapes swing Code Mode accuracy on small/open models
 * (Beyond Plain MCP / Cloudflare Code Mode evidence). Stubs are generated
 * from ToolSpec parameters plus a closed per-tool outputSchema table.
 * Does **not** yet persist session KV or crystallize skills.
 */

import type { ToolSpec } from "../contracts";

/** JSON-schema-ish object used for both input and output declarations. */
export type StubSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, StubSchema>;
  required?: string[];
  items?: StubSchema;
  additionalProperties?: boolean | StubSchema;
};

/** Closed output schemas for builtins (additive; unknown tools get ToolResult). */
export const CODEMODE_OUTPUT_SCHEMAS: Readonly<Record<string, StubSchema>> = {
  read: {
    type: "object",
    required: ["ok", "output"],
    properties: {
      ok: { type: "boolean" },
      output: { type: "string", description: "File contents or error text" },
      error: { type: "string" },
    },
  },
  write: {
    type: "object",
    required: ["ok", "output"],
    properties: {
      ok: { type: "boolean" },
      output: { type: "string" },
      error: { type: "string" },
    },
  },
  edit: {
    type: "object",
    required: ["ok", "output"],
    properties: {
      ok: { type: "boolean" },
      output: { type: "string" },
      error: { type: "string" },
    },
  },
  grep: {
    type: "object",
    required: ["ok", "output"],
    properties: {
      ok: { type: "boolean" },
      output: { type: "string", description: "Match lines" },
      error: { type: "string" },
    },
  },
  glob: {
    type: "object",
    required: ["ok", "output"],
    properties: {
      ok: { type: "boolean" },
      output: { type: "string", description: "Newline-separated paths" },
      error: { type: "string" },
    },
  },
  shell: {
    type: "object",
    required: ["ok", "output"],
    properties: {
      ok: { type: "boolean" },
      output: { type: "string" },
      error: { type: "string" },
      exitCode: { type: "number" },
    },
  },
  todo: {
    type: "object",
    required: ["ok", "output"],
    properties: {
      ok: { type: "boolean" },
      output: { type: "string" },
      error: { type: "string" },
    },
  },
};

const DEFAULT_OUTPUT: StubSchema = {
  type: "object",
  required: ["ok", "output"],
  properties: {
    ok: { type: "boolean" },
    output: { type: "string" },
    error: { type: "string" },
  },
};

function schemaToTs(schema: StubSchema | undefined, indent: string): string {
  if (!schema) return "unknown";
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") {
    return `Array<${schemaToTs(schema.items, indent)}>`;
  }
  if (schema.type === "object" || schema.properties) {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const lines = Object.entries(props).map(([key, child]) => {
      const opt = required.has(key) ? "" : "?";
      return `${indent}  ${JSON.stringify(key)}${opt}: ${schemaToTs(child, indent + "  ")};`;
    });
    if (lines.length === 0) return "Record<string, unknown>";
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return "unknown";
}

export type CodemodeStub = {
  name: string;
  inputSchema: StubSchema;
  outputSchema: StubSchema;
  dts: string;
};

/** Build one typed stub for a ToolSpec (input from parameters, output from table). */
export function buildCodemodeStub(spec: ToolSpec): CodemodeStub {
  const inputSchema = (spec.parameters ?? { type: "object" }) as StubSchema;
  const outputSchema = CODEMODE_OUTPUT_SCHEMAS[spec.name] ?? DEFAULT_OUTPUT;
  const inTs = schemaToTs(inputSchema, "");
  const outTs = schemaToTs(outputSchema, "");
  const dts = [
    `/** ${spec.description?.replace(/\s+/g, " ").trim() ?? spec.name} */`,
    `declare function ${safeIdent(spec.name)}(args: ${inTs}): Promise<${outTs}>;`,
    `// outputSchema: ${JSON.stringify(outputSchema)}`,
    `// inputSchema: ${JSON.stringify(inputSchema)}`,
  ].join("\n");
  return { name: spec.name, inputSchema, outputSchema, dts };
}

function safeIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `tool_${cleaned}`;
}

/** Compact arg signature from a ToolSpec parameters object (no description prose). */
export function compactArgsSignature(spec: ToolSpec): string {
  const params = (spec.parameters ?? {}) as StubSchema;
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);
  const parts = Object.keys(props).map((key) => (required.has(key) ? key : `${key}?`));
  return `{${parts.join(",")}}`;
}

/**
 * Compact one-line stubs for the `code_mode` tool description (≤1024 budget).
 * Full `.d.ts` + JSON schemas stay available via `renderCodemodeTypedStubs`
 * for on-demand/system-rail use — never paste those into every-turn schemas.
 */
export function renderCodemodeCompactStubs(specs: readonly ToolSpec[]): string {
  const lines = specs.map((s) => {
    const out = CODEMODE_OUTPUT_SCHEMAS[s.name] ?? DEFAULT_OUTPUT;
    const outKeys = Object.keys(out.properties ?? {});
    return `${s.name}(${compactArgsSignature(s)})→{${outKeys.join(",")}}`;
  });
  return [
    "Typed stubs (ruling 641; HZ_CODEMODE_TYPED_STUBS=0 disables):",
    "tools.call(name,args); tools.kv.get/set; each call returns Promise<{ok,output,error?}>.",
    ...lines,
  ].join(" ");
}

/** Render a .d.ts-style preamble for Code Mode programs (not for tool.description). */
export function renderCodemodeTypedStubs(specs: readonly ToolSpec[]): string {
  const header = [
    "// HorizonCode Code Mode typed stubs (ruling 641) — inputSchema + outputSchema",
    "// Use: await tools.call(\"name\", args) — stubs document declared return shapes.",
    "declare const tools: {",
    "  call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string; error?: string }>;",
    "  kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };",
    "};",
    "",
  ];
  const body = specs.map((s) => buildCodemodeStub(s).dts);
  return [...header, ...body, ""].join("\n");
}

/** True when typed stubs should be injected (default ON; set 0 to disable). */
export function codemodeTypedStubsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HZ_CODEMODE_TYPED_STUBS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw === "true" || raw === "yes";
}
