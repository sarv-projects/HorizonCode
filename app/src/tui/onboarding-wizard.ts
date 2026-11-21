/**
 * onboarding-wizard.ts — First-Time Interactive Auth Wizard
 *
 * Stolen & adapted from:
 *   - repo_take/aider/aider/onboarding.py (provider selection & auto fallback)
 *   - repo_take/codex/codex-rs/tui/src/onboarding (gateway / API key setup)
 *
 * Guides first-time or unauthenticated users to configure their provider credentials,
 * persists the secret safely to `<userConfigDir>/env` (0600 permissions, no symlinks),
 * and activates the key immediately in `process.env`.
 */

import * as readline from "node:readline";
import { saveUserEnvVar, type ProviderName } from "../core/config";
import { bold, dim, cyan, green, yellow, red } from "./style";

export interface WizardProviderOption {
  id: ProviderName | "openrouter";
  name: string;
  envVar: string;
  keyPrefix?: string;
  defaultModel: string;
  description: string;
}

export const WIZARD_PROVIDERS: readonly WizardProviderOption[] = [
  {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    keyPrefix: "sk-",
    defaultModel: "gpt-4o",
    description: "Industry standard models (GPT-4o, o1, o3-mini)",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    keyPrefix: "sk-ant-",
    defaultModel: "claude-3-7-sonnet-20250219",
    description: "Claude 3.7 Sonnet, Claude 3.5 Sonnet",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    keyPrefix: "sk-or-",
    defaultModel: "anthropic/claude-3.7-sonnet",
    description: "Unified API for 100+ models (OpenRouter)",
  },
  {
    id: "openai", // Groq uses openai-compatible adapter
    name: "Groq",
    envVar: "GROQ_API_KEY",
    keyPrefix: "gsk_",
    defaultModel: "llama-3.3-70b-versatile",
    description: "Ultra-fast inference (Llama 3.3, DeepSeek)",
  },
  {
    id: "google",
    name: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-pro",
    description: "Gemini 2.5 Pro, 2.0 Flash",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    envVar: "NVIDIA_API_KEY",
    keyPrefix: "nvapi-",
    defaultModel: "meta/llama-3.3-70b-instruct",
    description: "NVIDIA hosted models and enterprise NIMs",
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    envVar: "OLLAMA_HOST",
    defaultModel: "llama3.2",
    description: "Local models via Ollama (no API key required)",
  },
];

/**
 * Asks a single question on a readline interface.
 */
function askQuestion(rl: readline.Interface, promptText: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Runs the interactive First-Time Auth Wizard in terminal TTY.
 */
export async function runAuthWizard(opts: {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
} = {}): Promise<{
  configured: boolean;
  provider?: ProviderName | "openrouter";
  envVar?: string;
  savedPath?: string;
}> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  const write = (text: string) => stdout.write(text);

  write("\n" + bold(cyan("◆ HorizonCode Setup Wizard")) + " · Configure your AI Provider\n");
  write(dim("  Keys are stored securely in ~/.config/horizon/env (0600 permissions).\n\n"));

  WIZARD_PROVIDERS.forEach((prov, idx) => {
    write(`  ${bold(`[${idx + 1}]`)} ${cyan(prov.name.padEnd(16))} ${dim(prov.description)}\n`);
  });
  write(`  ${bold(`[0]`)} ${dim("Skip for now (offline mock / manual config)")}\n\n`);

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean((stdout as unknown as { isTTY?: boolean }).isTTY),
  });

  try {
    const choiceStr = await askQuestion(rl, bold("❯ Select a provider [1-7, 0 to skip]: "));
    const choice = parseInt(choiceStr, 10);

    if (isNaN(choice) || choice < 1 || choice > WIZARD_PROVIDERS.length) {
      write(dim("  Skipping setup. You can run /auth or /model anytime.\n\n"));
      return { configured: false };
    }

    const selected = WIZARD_PROVIDERS[choice - 1];

    if (selected.id === "ollama") {
      const host = await askQuestion(rl, `❯ Enter Ollama host (default: http://localhost:11434): `);
      const effectiveHost = host || "http://localhost:11434";
      const result = saveUserEnvVar("OLLAMA_HOST", effectiveHost);
      if (result.saved) {
        write(green(`✔ Saved OLLAMA_HOST to ${result.path}\n\n`));
        return { configured: true, provider: "ollama", envVar: "OLLAMA_HOST", savedPath: result.path };
      } else {
        write(red(`✖ Failed to save: ${result.error}\n\n`));
        return { configured: false };
      }
    }

    const key = await askQuestion(rl, bold(`❯ Enter your ${selected.name} API key (${selected.envVar}): `));
    if (!key) {
      write(yellow("  No key entered. Setup cancelled.\n\n"));
      return { configured: false };
    }

    // Pattern warnings
    if (selected.keyPrefix && !key.startsWith(selected.keyPrefix)) {
      write(
        yellow(
          `  Notice: Expected key starting with '${selected.keyPrefix}'. Proceeding with entered key...\n`,
        ),
      );
    }

    const result = saveUserEnvVar(selected.envVar, key);
    if (result.saved) {
      // If configuring Groq or OpenRouter, also set convenient defaults
      if (selected.envVar === "GROQ_API_KEY") {
        saveUserEnvVar("OPENAI_BASE_URL", "https://api.groq.com/openai/v1");
      } else if (selected.envVar === "OPENROUTER_API_KEY") {
        saveUserEnvVar("OPENAI_BASE_URL", "https://openrouter.ai/api/v1");
      }

      write(green(`✔ Successfully saved ${selected.envVar} to ${result.path}\n`));
      write(green(`✔ Active in current session. Default model: ${selected.defaultModel}\n\n`));
      return {
        configured: true,
        provider: selected.id,
        envVar: selected.envVar,
        savedPath: result.path,
      };
    } else {
      write(red(`✖ Failed to save key: ${result.error}\n\n`));
      return { configured: false };
    }
  } finally {
    rl.close();
  }
}
