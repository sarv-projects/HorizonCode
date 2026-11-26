/**
 * codemode-mcp-fs.ts — Pillar 1: MCP Tools-as-Files projection for Code Mode.
 *
 * Projects registered `mcp__<serverId>__<toolName>` ToolSpecs into a read-only
 * TypeScript module tree under `<rootDir>/servers/<safeServerId>/<safeToolName>.ts`
 * plus `<rootDir>/servers/index.ts`.
 *
 * Security invariants:
 * - Sanitizes server/tool names against path traversal (`..`, `/`, `\`, NUL)
 *   and invisible Unicode (`U+E0000–U+E007F` Unicode tag block + bidi/zero-width).
 * - Verifies every materialized path remains strictly inside `<rootDir>/servers`.
 * - Escapes JSDoc terminators so untrusted MCP descriptions cannot inject code.
 */

import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ToolSpec } from "../contracts";

/**
 * Strip invisible Unicode tag characters (`U+E0000–U+E007F`), bidi override/isolate
 * controls, and zero-width formatters that can conceal prompt-injection payloads.
 */
export function stripInvisibleUnicode(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  return text
    .replace(/[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/g, "");
}

/**
 * Sanitize an MCP server or tool name into a safe single filesystem segment.
 * Rejects path traversal (`..`, `/`, `\`, NUL) and strips invisible Unicode.
 */
export function sanitizeMcpSegment(raw: string, fallback = "item"): string {
  const cleaned = stripInvisibleUnicode(raw)
    .replace(/\0/g, "")
    .replace(/\.\.+/g, "_")
    .replace(/[/\\]/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 80);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

const JS_RESERVED_KEYWORDS = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in", "instanceof",
  "interface", "let", "new", "null", "package", "private", "protected", "public",
  "return", "static", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "arguments", "eval",
]);

/** Convert a sanitized name into a valid TypeScript identifier. */
function toSafeIdentifier(name: string, fallback = "callTool"): string {
  const cleaned = sanitizeMcpSegment(name, fallback).replace(/[^A-Za-z0-9_]/g, "_");
  if (cleaned === "") return fallback;
  const ident = /^[A-Za-z_]/.test(cleaned) ? cleaned : `fn_${cleaned}`;
  return JS_RESERVED_KEYWORDS.has(ident) ? `${ident}_` : ident;
}

/** Parse `mcp__<serverId>__<toolName>` into its components, or null if not an MCP spec. */
export function parseMcpSpecName(name: string): { serverId: string; toolName: string } | null {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 1) return null;
  const serverId = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (serverId === "" || toolName === "") return null;
  return { serverId, toolName };
}

type JsonSchemaLike = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  examples?: unknown[];
};

export type ToolSpecWithExamples = ToolSpec & {
  input_examples?: ReadonlyArray<Record<string, unknown>>;
};

const MAX_JSDOC_EXAMPLES = 3;

function synthesizeMinimalValue(schema: JsonSchemaLike | undefined, key: string): unknown {
  if (!schema || typeof schema !== "object") return `<${key}>`;
  if (schema.type === "string") return `<${key}>`;
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object" || schema.properties) return {};
  return `<${key}>`;
}

function synthesizeMinimalExample(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  const schema = (parameters ?? {}) as JsonSchemaLike;
  const props = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const example: Record<string, unknown> = {};
  for (const key of required) {
    example[key] = synthesizeMinimalValue(props[key], key);
  }
  return example;
}

function collectInputExamples(spec: ToolSpecWithExamples): Array<Record<string, unknown>> {
  const raw = Array.isArray(spec.input_examples)
    ? spec.input_examples
    : Array.isArray((spec.parameters as JsonSchemaLike | undefined)?.examples)
      ? ((spec.parameters as JsonSchemaLike).examples as unknown[])
      : [];
  const valid = raw.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
  );
  if (valid.length > 0) return valid.slice(0, MAX_JSDOC_EXAMPLES);
  return [synthesizeMinimalExample(spec.parameters)];
}

/**
 * Format sanitized JSDoc `@example` lines for a tool wrapper function,
 * escaping JSDoc close sequences and stripping invisible Unicode characters.
 */
export function buildMcpJsDocExamples(fnName: string, spec: ToolSpecWithExamples): string[] {
  const examples = collectInputExamples(spec);
  const lines: string[] = [];
  for (const ex of examples) {
    let serialized: string;
    try {
      serialized = JSON.stringify(ex) ?? "{}";
    } catch {
      serialized = "{}";
    }
    const safeJson = escapeJsDoc(serialized);
    lines.push(" * @example");
    lines.push(` * await ${fnName}(${safeJson});`);
  }
  return lines;
}

function jsonSchemaToTs(schema: JsonSchemaLike | undefined, indent = ""): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return `Array<${jsonSchemaToTs(schema.items, indent)}>`;
  if (schema.type === "object" || schema.properties) {
    const props = schema.properties ?? {};
    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(props);
    if (entries.length === 0) return "Record<string, unknown>";
    const lines = entries.map(([k, v]) => {
      const opt = req.has(k) ? "" : "?";
      return `${indent}  ${JSON.stringify(k)}${opt}: ${jsonSchemaToTs(v, indent + "  ")};`;
    });
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return "unknown";
}

function renderInputInterface(parameters: Record<string, unknown> | undefined): string {
  const schema = (parameters ?? {}) as JsonSchemaLike;
  const props = schema.properties ?? {};
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  const entries = Object.entries(props);
  if (entries.length === 0) {
    return "export interface Input {\n  [key: string]: unknown;\n}";
  }
  const lines = entries.map(([k, v]) => {
    const opt = req.has(k) ? "" : "?";
    const desc = typeof v?.description === "string" && v.description.trim() !== ""
      ? `  /** ${escapeJsDoc(v.description)} */\n`
      : "";
    return `${desc}  ${JSON.stringify(k)}${opt}: ${jsonSchemaToTs(v, "  ")};`;
  });
  return `export interface Input {\n${lines.join("\n")}\n}`;
}

function escapeJsDoc(text: string): string {
  return stripInvisibleUnicode(text)
    .replace(/\*\//g, "*\\/")
    .replace(/\r?\n+/g, " ")
    .trim();
}

function assertNotSymlink(target: string): void {
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`refusing to write through symlink: ${target}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

function assertInside(baseDir: string, candidate: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedBase, resolvedCandidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes serversDir: ${candidate}`);
  }
}

function renderToolModule(spec: ToolSpecWithExamples, fnName: string): string {
  const doc = escapeJsDoc(spec.description || spec.name);
  const safeCallName = stripInvisibleUnicode(spec.name).replace(/\0/g, "");
  const inputIface = renderInputInterface(spec.parameters);
  const exampleLines = buildMcpJsDocExamples(fnName, spec);
  return [
    "/**",
    ` * ${doc}`,
    " *",
    ` * Auto-generated Code Mode wrapper for ${JSON.stringify(escapeJsDoc(safeCallName))}.`,
    ...exampleLines,
    " */",
    "",
    "declare const tools: {",
    "  call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string; error?: string }>;",
    "};",
    "",
    inputIface,
    "",
    "export interface McpCallNormalizedResult {",
    "  text: string;",
    "  json?: unknown;",
    "  raw: unknown;",
    "}",
    "",
    "function tryParseJsonPayload(text: string): unknown {",
    "  const trimmed = text.trim();",
    "  if (trimmed === \"\") return undefined;",
    "  try {",
    "    return JSON.parse(trimmed);",
    "  } catch {",
    "    // Unwrap untrusted MCP data fence if present.",
    "    const lines = trimmed.split(\"\\n\");",
    "    if (",
    "      lines.length >= 3 &&",
    "      lines[0]?.startsWith(\"=== BEGIN UNTRUSTED MCP DATA ===\") &&",
    "      lines[lines.length - 1]?.startsWith(\"=== END UNTRUSTED MCP DATA ===\")",
    "    ) {",
    "      const inner = lines.slice(2, -1).join(\"\\n\").trim();",
    "      try {",
    "        return JSON.parse(inner);",
    "      } catch {",
    "        return undefined;",
    "      }",
    "    }",
    "    return undefined;",
    "  }",
    "}",
    "",
    `export async function ${fnName}(input: Input): Promise<McpCallNormalizedResult> {`,
    `  const raw = await tools.call(${JSON.stringify(safeCallName)}, (input ?? {}) as Record<string, unknown>);`,
    "  const text = typeof raw?.output === \"string\" ? raw.output : String(raw ?? \"\");",
    "  const json = tryParseJsonPayload(text);",
    "  return json !== undefined ? { text, json, raw } : { text, raw };",
    "}",
    "",
  ].join("\n");
}

export interface MaterializedMcpTree {
  serversDir: string;
  fileCount: number;
  manifest: string[];
}

/**
 * Materialize registered MCP tool specs into `<rootDir>/servers/<safeServerId>/<safeToolName>.ts`
 * plus `<rootDir>/servers/index.ts`.
 */
export function materializeMcpServerTree(
  rootDir: string,
  mcpSpecs: readonly ToolSpec[],
): MaterializedMcpTree {
  const resolvedRoot = path.resolve(rootDir);
  const serversDir = path.join(resolvedRoot, "servers");
  assertNotSymlink(resolvedRoot);
  assertNotSymlink(serversDir);
  mkdirSync(serversDir, { recursive: true });

  const manifest: string[] = [];
  const serverIndex: Record<string, string[]> = {};
  const usedPaths = new Set<string>();

  for (const spec of mcpSpecs) {
    if (!spec || typeof spec.name !== "string") continue;
    const parsed = parseMcpSpecName(spec.name);
    if (!parsed) continue;

    const safeServer = sanitizeMcpSegment(parsed.serverId, "server");
    const baseTool = sanitizeMcpSegment(parsed.toolName, "tool");
    let safeTool = baseTool;
    let suffix = 2;
    while (usedPaths.has(`${safeServer}/${safeTool}`)) {
      safeTool = `${baseTool}_${suffix}`;
      suffix += 1;
    }
    usedPaths.add(`${safeServer}/${safeTool}`);

    const serverDir = path.join(serversDir, safeServer);
    assertInside(serversDir, serverDir);
    assertNotSymlink(serverDir);
    mkdirSync(serverDir, { recursive: true });

    const filePath = path.join(serverDir, `${safeTool}.ts`);
    assertInside(serversDir, filePath);
    assertNotSymlink(filePath);

    const fnName = toSafeIdentifier(safeTool, "invoke");
    writeFileSync(filePath, renderToolModule(spec, fnName), "utf8");

    const relPath = `servers/${safeServer}/${safeTool}.ts`;
    manifest.push(relPath);
    if (!serverIndex[safeServer]) serverIndex[safeServer] = [];
    serverIndex[safeServer]!.push(relPath);
  }

  const indexPath = path.join(serversDir, "index.ts");
  assertInside(serversDir, indexPath);
  assertNotSymlink(indexPath);
  const indexContent = [
    "// Auto-generated MCP tools-as-files index for Code Mode.",
    `export const MCP_SERVERS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(serverIndex, null, 2)};`,
    `export const MCP_TOOL_MANIFEST: readonly string[] = ${JSON.stringify(manifest, null, 2)};`,
    "",
  ].join("\n");
  writeFileSync(indexPath, indexContent, "utf8");

  return {
    serversDir,
    fileCount: manifest.length,
    manifest,
  };
}
