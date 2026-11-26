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
import { filterModelOptions, moveModelIndex, updateModelQuery, type ModelNavState } from "./model-picker-nav";
import { bold, cyan, dim, green, red, sanitizeDisplay, yellow } from "./style";

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

const modelLabel = (m: CuratedModelOption): string => `${m.name} ${m.id} ${m.providerName}`;

/** Arrow-key/filter modal for real TTYs; returns null on Escape/Ctrl+C. */
function runArrowModelPicker(
  stdin: NodeJS.ReadableStream,
  write: (s: string) => void,
  currentModel: string,
): Promise<CuratedModelOption | null> {
  return new Promise((resolve) => {
    const input = stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (on: boolean) => void };
    const wasRaw = input.isRaw === true;
    let state: ModelNavState = { query: "", index: 0 };
    let filtered = filterModelOptions(CURATED_MODELS, state.query, modelLabel);
    let done = false;
    let altScreenEntered = false;

    const draw = (): void => {
      filtered = filterModelOptions(CURATED_MODELS, state.query, modelLabel);
      if (state.index >= filtered.length) state.index = 0;
      const lines = [
        bold(cyan("◆ Model Selector")) + "  (arrows move, type to filter, Enter selects, Esc cancels)",
        `current: ${sanitizeDisplay(currentModel)}   filter: ${state.query === "" ? "(all)" : sanitizeDisplay(state.query)}`,
        "",
      ];
      const shown = filtered.slice(0, 12);
      for (let i = 0; i < shown.length; i += 1) {
        const m = shown[i]!;
        lines.push(`${i === state.index ? green("❯ ") : "  "}${sanitizeDisplay(m.name)} ${dim(`(${sanitizeDisplay(m.providerName)}) ${sanitizeDisplay(m.id)}`)}`);
      }
      if (filtered.length > shown.length) lines.push(dim(`  ... ${filtered.length - shown.length} more`));
      if (filtered.length === 0) lines.push(dim("  no matching models"));
      // Redraw inside the alternate screen buffer so the user's scrollback is preserved.
      write(`\x1b[H\x1b[J${lines.join("\n")}`);
    };

    const onEnd = (): void => finish(null);
    const onSigint = (): void => finish(null);

    const finish = (choice: CuratedModelOption | null): void => {
      if (done) return;
      done = true;
      input.removeListener("keypress", onKey);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      process.removeListener("SIGINT", onSigint);
      try {
        input.setRawMode?.(wasRaw);
      } finally {
        write(altScreenEntered ? "\x1b[?2026l\x1b[?25h\x1b[?1049l" : "\x1b[?2026l\x1b[?25h");
      }
      resolve(choice);
    };

    const onKey = (_str: string, key: readline.Key | undefined): void => {
      if (key === undefined) return;
      if (key.name === "escape" || (key.ctrl === true && key.name === "c")) return finish(null);
      if (key.name === "return" || key.name === "enter") return finish(filtered[state.index] ?? null);
      if (key.name === "up" || key.name === "down" || key.name === "home" || key.name === "end") {
        state = { ...state, index: moveModelIndex(state, key.name, filtered.length) };
        draw();
        return;
      }
      if (key.name === "backspace") {
        state = updateModelQuery(state, "\x7f");
        draw();
        return;
      }
      if (typeof key.sequence === "string" && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        state = updateModelQuery(state, key.sequence);
        draw();
      }
    };

    try {
      input.setRawMode?.(true);
      readline.emitKeypressEvents(input);
      write("\x1b[?1049h\x1b[?25l");
      altScreenEntered = true;
      input.on("keypress", onKey);
      input.once("end", onEnd);
      input.once("close", onEnd);
      process.once("SIGINT", onSigint);
      draw();
    } catch {
      finish(null);
    }
  });
}

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
  write(dim(`  Current: ${bold(cyan(sanitizeDisplay(currentModel)))} (${sanitizeDisplay(currentProvider)})\n`));
  write(dim(`  Detected Providers with keys: ${Array.from(availableProviders).map(sanitizeDisplay).join(", ") || "none"}\n\n`));

  CURATED_MODELS.forEach((m, idx) => {
    const isCurrent = m.id === currentModel;
    const isConfigured = availableProviders.has(m.provider as any);
    const marker = isCurrent ? green("● [active]") : isConfigured ? cyan("○ [ready] ") : yellow("⚠ [no key]");
    const num = bold(`[${idx + 1}]`.padEnd(5));
    const title = bold(sanitizeDisplay(m.name).padEnd(26));
    const prov = dim(`(${sanitizeDisplay(m.providerName)})`.padEnd(16));
    const desc = dim(sanitizeDisplay(m.description));
    const think = m.supportsThinking ? cyan(" [thinking]") : "";
    write(`  ${num} ${marker} ${title} ${prov} ${desc}${think}\n`);
  });

  write(`  ${bold("[C]".padEnd(5))} ${cyan("Custom Model ID")} ${dim("Type an exact provider model identifier")}\n`);
  write(`  ${bold("[0]".padEnd(5))} ${dim("Cancel / Keep current")}\n\n`);

  const arrowCapable = Boolean(
    (stdin as any).isTTY && (stdout as any).isTTY && typeof (stdin as any).setRawMode === "function",
  );
  const rl = arrowCapable
    ? undefined
    : readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: Boolean((stdout as any).isTTY),
      });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (val: string): void => {
        if (settled) return;
        settled = true;
        rl!.off("close", onCancel);
        rl!.off("SIGINT", onCancel);
        resolve(val);
      };
      const onCancel = (): void => done("");
      rl!.once("close", onCancel);
      rl!.once("SIGINT", onCancel);
      rl!.question(prompt, (ans) => done(ans.trim()));
    });

  try {
    let targetModel = "";
    let targetProvider = "";

    if (arrowCapable) {
      const picked = await runArrowModelPicker(stdin, write, currentModel);
      if (picked === null) {
        renderer.notice("model unchanged");
        return { switched: false };
      }
      targetModel = picked.id;
      targetProvider = picked.provider;
    } else {
      const choiceStr = await question(bold(`❯ Select model [1-${CURATED_MODELS.length}, C for custom, 0 to cancel]: `));

      if (choiceStr === "0" || choiceStr === "") {
        renderer.notice("model unchanged");
        return { switched: false };
      }

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
    rl?.close();
  }
}
