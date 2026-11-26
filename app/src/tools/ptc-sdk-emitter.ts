/**
 * ptc-sdk-emitter.ts — typed TS/Python SDK declaration emission
 * (deepseek/codex PTC "typed SDK in system prompt" ADAPT).
 *
 * Pure text generation: turns tool specs (name, description, JSON-schema-style
 * parameters) into typed function declarations the model can see in the system
 * prompt. No V8 binding, no eval, no import of runtime code. Deterministic,
 * bounded (name/description caps), and honest about optional vs required args.
 */

export interface SdkToolSpec {
  name: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: readonly string[];
  };
}

export type SdkLanguage = "typescript" | "python";

const MAX_NAME = 64;
const MAX_DESC = 500;

function tsType(t: string | undefined): string {
  switch (t) {
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "array": return "unknown[]";
    case "object": return "Record<string, unknown>";
    default: return "string";
  }
}

function pyType(t: string | undefined): string {
  switch (t) {
    case "integer": return "int";
    case "number": return "float";
    case "boolean": return "bool";
    case "array": return "list";
    case "object": return "dict";
    default: return "str";
  }
}

function safeName(name: string): string {
  const n = name.trim().slice(0, MAX_NAME);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new Error(`HZ_PRECONDITION_FAILED: invalid SDK tool name ${name}`);
  return n;
}

export function emitToolSdk(tools: readonly SdkToolSpec[], language: SdkLanguage): string {
  if (language !== "typescript" && language !== "python") {
    throw new Error(`HZ_PRECONDITION_FAILED: unsupported SDK language ${language}`);
  }
  if (tools.length === 0) return "";
  const lines: string[] = [
    language === "typescript" ? "// Tool SDK (typed declarations)" : "# Tool SDK (typed declarations)",
  ];
  for (const tool of tools) {
    const name = safeName(tool.name);
    const desc = tool.description.trim().slice(0, MAX_DESC);
    const props = tool.parameters?.properties ?? {};
    const required = new Set(tool.parameters?.required ?? []);
    const args = Object.entries(props);
    if (language === "typescript") {
      lines.push(`/** ${desc} */`);
      const params = args
        .map(([key, spec]) => `${key.replace(/[^A-Za-z0-9_]/g, "_")}${required.has(key) ? "" : "?"}: ${tsType(spec.type)}`)
        .join(", ");
      lines.push(`declare function ${name}(${params}): Promise<unknown>;`);
    } else {
      lines.push(`"""${desc}"""`);
      const params = args
        .map(([key, spec]) => {
          const k = key.replace(/[^A-Za-z0-9_]/g, "_");
          return required.has(key) ? `${k}: ${pyType(spec.type)}` : `${k}: ${pyType(spec.type)} | None = None`;
        })
        .join(", ");
      lines.push(`def ${name}(${params}) -> dict:`);
      lines.push("    ...");
    }
  }
  return lines.join("\n") + "\n";
}
