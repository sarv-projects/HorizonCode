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

const JS_RESERVED_KEYWORDS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "arguments", "eval",
]);

function stripInvisibleForStub(text: string): string {
  return text
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "");
}

function escapeJsDoc(text: string): string {
  return stripInvisibleForStub(text)
    .replace(/\*\//g, "*\\/")
    .replace(/\s+/g, " ")
    .trim();
}

export type ToolSpecWithExamples = ToolSpec & {
  input_examples?: ReadonlyArray<Record<string, unknown>>;
};

const MAX_STUB_EXAMPLES = 3;

function synthesizeStubExampleValue(schema: StubSchema | undefined, key: string): unknown {
  if (!schema || typeof schema !== "object") return `<${key}>`;
  if (schema.type === "string") return `<${key}>`;
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object" || schema.properties) return {};
  return `<${key}>`;
}

function collectStubExamples(spec: ToolSpecWithExamples, inputSchema: StubSchema): Array<Record<string, unknown>> {
  const raw = Array.isArray(spec.input_examples)
    ? spec.input_examples
    : Array.isArray((spec.parameters as { examples?: unknown[] } | undefined)?.examples)
      ? ((spec.parameters as { examples: unknown[] }).examples)
      : [];
  const valid = raw.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
  );
  if (valid.length > 0) return valid.slice(0, MAX_STUB_EXAMPLES);
  const props = inputSchema.properties ?? {};
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const minimal: Record<string, unknown> = {};
  for (const key of required) {
    minimal[key] = synthesizeStubExampleValue(props[key], key);
  }
  return [minimal];
}

/** Format sanitized `@example` JSDoc lines for a Code Mode stub. */
export function buildStubJsDocExamples(fnName: string, spec: ToolSpecWithExamples): string[] {
  const inputSchema = (spec.parameters ?? { type: "object" }) as StubSchema;
  const examples = collectStubExamples(spec, inputSchema);
  const lines: string[] = [];
  for (const ex of examples) {
    let serialized: string;
    try {
      serialized = JSON.stringify(ex) ?? "{}";
    } catch {
      serialized = "{}";
    }
    lines.push(" * @example");
    lines.push(` * await ${fnName}(${escapeJsDoc(serialized)});`);
  }
  return lines;
}

/** Build one typed stub for a ToolSpec (input from parameters, output from table). */
export function buildCodemodeStub(spec: ToolSpecWithExamples): CodemodeStub {
  const inputSchema = (spec.parameters ?? { type: "object" }) as StubSchema;
  const outputSchema = CODEMODE_OUTPUT_SCHEMAS[spec.name] ?? DEFAULT_OUTPUT;
  const inTs = schemaToTs(inputSchema, "");
  const outTs = schemaToTs(outputSchema, "");
  const fnName = safeIdent(spec.name);
  const exampleLines = buildStubJsDocExamples(fnName, spec);
  const dts = [
    "/**",
    ` * ${escapeJsDoc(spec.description ?? spec.name)}`,
    ...exampleLines,
    " */",
    `declare function ${fnName}(args: ${inTs}): Promise<${outTs}>;`,
    `// outputSchema: ${JSON.stringify(outputSchema)}`,
    `// inputSchema: ${JSON.stringify(inputSchema)}`,
  ].join("\n");
  return { name: spec.name, inputSchema, outputSchema, dts };
}

function safeIdent(name: string): string {
  const cleaned = stripInvisibleForStub(name).replace(/[^A-Za-z0-9_]/g, "_");
  const ident = cleaned === "" ? "tool_unnamed" : /^[A-Za-z_]/.test(cleaned) ? cleaned : `tool_${cleaned}`;
  return JS_RESERVED_KEYWORDS.has(ident) ? `${ident}_` : ident;
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

/**
 * Render compact on-demand stubs for MCP tools (Pillar 1/3) without bloating
 * the static `code_mode` tool description.
 */
export function renderMcpCodemodeStubs(mcpSpecs: readonly ToolSpec[]): string {
  if (mcpSpecs.length === 0) return "";
  const lines = mcpSpecs.map((s) => `${s.name}(${compactArgsSignature(s)})→{ok,output,error?}`);
  return `MCP tools via tools.call: ${lines.join(" ")}`;
}

/** True when typed stubs should be injected (default ON; set 0 to disable). */
export function codemodeTypedStubsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.HZ_CODEMODE_TYPED_STUBS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw === "true" || raw === "yes";
}
