/**
 * interactive-model-picker.ts — Interactive TTY Model & Provider Selector
 *
 * Stolen & adapted from:
 *   - repo_take/claude-code-src/claude-code-source-code/src/components/ModelPicker.tsx
 *   - repo_take/opencode/packages/tui/src/component/dialog-model.tsx
 *   - repo_take/aider/aider/commands.py (SwitchCoder)
 *
 * Provides a rich, interactive selector for switching active LLM models,
 * providers, and thinking reasoning effort in real time.
 */

import * as readline from "node:readline";
import type { Runtime } from "../contracts";
import { detectAvailableProviders } from "../core/config";
import { bold, cyan, dim, green, red, yellow } from "./style";

export interface CuratedModelOption {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  description: string;
  supportsThinking?: boolean;
}

export const CURATED_MODELS: readonly CuratedModelOption[] = [
  // OpenAI
  { provider: "openai", providerName: "OpenAI", id: "gpt-4o", name: "GPT-4o", description: "Flagship multi-modal model" },
  { provider: "openai", providerName: "OpenAI", id: "chat-latest", name: "GPT-4o (Chat Latest)", description: "Latest general chat endpoint" },
  { provider: "openai", providerName: "OpenAI", id: "o3-mini", name: "o3-mini", description: "Fast STEM/coding reasoning model", supportsThinking: true },
  { provider: "openai", providerName: "OpenAI", id: "o1", name: "o1", description: "Deep reasoning for complex algorithms", supportsThinking: true },

  // Anthropic
  { provider: "anthropic", providerName: "Anthropic", id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet", description: "Hybrid reasoning & coding flagship", supportsThinking: true },
  { provider: "anthropic", providerName: "Anthropic", id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", description: "Fast, accurate agentic coder" },
  { provider: "anthropic", providerName: "Anthropic", id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", description: "Ultra-fast lightweight model" },

  // Groq (OpenAI-compatible)
  { provider: "openai", providerName: "Groq", id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B (Groq)", description: "Sub-second inference speed" },
  { provider: "openai", providerName: "Groq", id: "deepseek-r1-distill-llama-70b", name: "DeepSeek R1 70B (Groq)", description: "Open reasoning model at 300+ tok/s", supportsThinking: true },

  // Google Gemini
  { provider: "google", providerName: "Google Gemini", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Long-context reasoning powerhouse", supportsThinking: true },
  { provider: "google", providerName: "Google Gemini", id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", description: "Low-latency multimode speed" },

  // Ollama
  { provider: "ollama", providerName: "Ollama (Local)", id: "llama3.2", name: "Llama 3.2", description: "Local private inference" },
  { provider: "ollama", providerName: "Ollama (Local)", id: "qwen2.5-coder", name: "Qwen 2.5 Coder", description: "Specialized open-source coding model" },
];

export async function runInteractiveModelPicker(
  runtime: Runtime,
  renderer: { notice: (msg: string) => void },
  opts: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
  } = {}
): Promise<{ switched: boolean; model?: string; provider?: string }> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const write = (s: string) => stdout.write(s);

  const availableProviders = new Set(detectAvailableProviders(process.env));
  const currentModel = runtime.model;
  const currentProvider = (runtime as any).providerName ?? "openai";

  write("\n" + bold(cyan("◆ HorizonCode Model Selector")) + " · Switch Model & Thinking Effort\n");
  write(dim(`  Current: ${bold(cyan(currentModel))} (${currentProvider})\n`));
  write(dim(`  Detected Providers with keys: ${Array.from(availableProviders).join(", ") || "none"}\n\n`));

  CURATED_MODELS.forEach((m, idx) => {
    const isCurrent = m.id === currentModel;
    const isConfigured = availableProviders.has(m.provider as any);
    const marker = isCurrent ? green("● [active]") : isConfigured ? cyan("○ [ready] ") : yellow("⚠ [no key]");
    const num = bold(`[${idx + 1}]`.padEnd(5));
    const title = bold(m.name.padEnd(26));
    const prov = dim(`(${m.providerName})`.padEnd(16));
    const desc = dim(m.description);
    const think = m.supportsThinking ? cyan(" [thinking]") : "";
    write(`  ${num} ${marker} ${title} ${prov} ${desc}${think}\n`);
  });

  write(`  ${bold("[C]".padEnd(5))} ${cyan("Custom Model ID")} ${dim("Type an exact provider model identifier")}\n`);
  write(`  ${bold("[0]".padEnd(5))} ${dim("Cancel / Keep current")}\n\n`);

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean((stdout as any).isTTY),
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, (ans) => resolve(ans.trim())));

  try {
    const choiceStr = await question(bold("❯ Select model [1-12, C for custom, 0 to cancel]: "));

    if (choiceStr === "0" || choiceStr === "") {
      renderer.notice("model unchanged");
      return { switched: false };
    }

    let targetModel = "";
    let targetProvider = "";

    if (choiceStr.toLowerCase() === "c") {
      targetModel = await question(bold("❯ Enter model identifier: "));
      if (!targetModel) {
        renderer.notice("model unchanged");
        return { switched: false };
      }
    } else {
      const idx = parseInt(choiceStr, 10);
      if (isNaN(idx) || idx < 1 || idx > CURATED_MODELS.length) {
        renderer.notice("invalid selection — model unchanged");
        return { switched: false };
      }
      const selected = CURATED_MODELS[idx - 1]!;
      targetModel = selected.id;
      targetProvider = selected.provider;
    }

    const setModel = (runtime as any).setModel;
    if (typeof setModel === "function") {
      const applied = await Promise.resolve(setModel.call(runtime, targetModel));
      const finalModel = typeof applied === "string" && applied !== "" ? applied : targetModel;
      renderer.notice(`model \u2192 ${bold(cyan(finalModel))}${targetProvider ? ` (${targetProvider})` : ""}`);
      return { switched: true, model: finalModel, provider: targetProvider };
    } else {
      renderer.notice(`runtime does not support dynamic model switching in this session`);
      return { switched: false };
    }
  } finally {
    rl.close();
  }
}
