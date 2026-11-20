/**
 * Heuristic: shell command lines that look like test / build / typecheck runs.
 * Shared by completion-evidence (loop) and autonomy envelope auto-approve.
 */

export const VERIFICATION_SHELL_SHAPE =
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun|deno|npx)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|check|build|tsc)|(?:^|[\s;&|(])(?:pytest|jest|vitest|mocha|cargo|go\s+test|make|tsc|eslint|ruff|mypy|flake8)\b/;

export function isVerificationShellCommand(command: string): boolean {
  return VERIFICATION_SHELL_SHAPE.test(typeof command === "string" ? command : "");
}

/** Remote-changing git operations stay human-gated in autonomy envelopes. */
export function isGitPushCommand(command: string): boolean {
  return /\bgit\s+push\b/i.test(typeof command === "string" ? command : "");
}