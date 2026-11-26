/**
 * alternating-roles.ts — port of aider ensure_alternating_roles (Group G).
 * Source: repo_take/aider/aider/sendchat.py:5-60.
 *
 * Reasoner models (DeepSeek R1) reject consecutive same-role messages. This
 * inserts an empty opposite-role stub between them; system messages are
 * interspersed freely and never break the alternation invariant. Pure helper,
 * opt-in at the provider message-format boundary.
 */

export interface RoleMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

/** Insert empty opposite-role stubs so non-system messages strictly alternate. */
export function ensureAlternatingRoles<T extends RoleMessage = RoleMessage>(
  messages: readonly T[],
): Array<T | { role: "user" | "assistant"; content: string }> {
  const fixed: Array<T | { role: "user" | "assistant"; content: string }> = [];
  let prevRole: string | undefined;
  for (const msg of messages) {
    // System messages are a cacheable prefix and may be interspersed freely;
    // they never participate in the alternation (HC prefix-sacred rule).
    if (msg.role === "system") {
      fixed.push({ ...msg });
      continue;
    }
    // Tool results (including parallel tool outputs) are exempt from
    // consecutive same-role stub insertion.
    if (msg.role === "tool") {
      fixed.push({ ...msg });
      prevRole = msg.role;
      continue;
    }
    if (msg.role === prevRole) {
      fixed.push({ role: msg.role === "user" ? "assistant" : "user", content: "" });
    }
    fixed.push({ ...msg });
    prevRole = msg.role;
  }
  return fixed;
}

/** True when non-system messages alternate and the last non-system role is user. */
export function sanityCheckMessages(messages: readonly RoleMessage[]): boolean {
  let lastRole: string | undefined;
  let lastNonSystemRole: string | undefined;
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (lastRole !== undefined && msg.role === lastRole) return false;
    lastRole = msg.role;
    lastNonSystemRole = msg.role;
  }
  return lastNonSystemRole === "user";
}
