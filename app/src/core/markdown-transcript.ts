/**
 * markdown-transcript.ts — E-4 reduced (docs/30): opt-in continuous Markdown
 * chat transcript under state (`HZ_MARKDOWN_TRANSCRIPT=1`).
 *
 * After each completed turn the runtime appends new chat messages to
 * `<stateRoot>/transcripts/<sessionId>.md` (0600). Off by default. Secrets are
 * masked like `/export`. Parser + resume-from-transcript helpers restore
 * `ChatMsg[]` from that file (aider `split_chat_history_markdown` /
 * `--restore-chat-history` spirit, adapted to HZ `## role` sections).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMsg, ToolCall } from "../contracts";
import { maskSecrets } from "./compaction";
import { stateRoot } from "./paths";

/** In-process cursor: messages already mirrored for each session. */
const cursors = new Map<string, number>();

const ROLE_HEAD =
  /^## (system|user|assistant|tool)(?:\s+(\S.*?))?\s*$/;
const TOOL_CALL_HEAD = /^### tool call:\s+(\S.*?)\s*$/;

export function markdownTranscriptEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.HZ_MARKDOWN_TRANSCRIPT === "1";
}

/** @internal test hook */
export function clearMarkdownTranscriptCursors(sessionId?: string): void {
  if (sessionId === undefined) cursors.clear();
  else cursors.delete(sessionId);
}

/** Cursor map key shared by sync + resume seed. */
export function markdownTranscriptCursorKey(workspace: string, sessionId: string): string {
  return `${path.resolve(workspace)}::${sessionId}`;
}

/** @internal — seed sync cursor after a successful resume parse. */
export function seedMarkdownTranscriptCursor(
  workspace: string,
  sessionId: string,
  count: number,
): void {
  cursors.set(markdownTranscriptCursorKey(workspace, sessionId), Math.max(0, count));
}

export function safeTranscriptSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === "" ? "session" : safe;
}

/** `<stateRoot>/transcripts/<sessionId>.md` — mirrors `/export` under state. */
export function markdownTranscriptPath(workspace: string, sessionId: string): string {
  return path.join(stateRoot(workspace), "transcripts", `${safeTranscriptSessionId(sessionId)}.md`);
}

export interface MarkdownTranscriptMeta {
  sessionId: string;
  title?: string;
  model?: string;
  startedAt?: string;
}

export interface ParsedMarkdownTranscript {
  meta: MarkdownTranscriptMeta;
  messages: ChatMsg[];
}

/** Count prior `## role` message sections (restart-safe cursor seed). */
export function countMarkdownMessageSections(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (ROLE_HEAD.test(line)) n += 1;
  }
  return n;
}

function stripTicks(value: string): string {
  const t = value.trim();
  if (t.startsWith("`") && t.endsWith("`") && t.length >= 2) return t.slice(1, -1);
  return t;
}

/** Parse optional `- key: value` header lines before the first `## role` section. */
export function parseMarkdownTranscriptMeta(text: string): MarkdownTranscriptMeta {
  const meta: MarkdownTranscriptMeta = { sessionId: "" };
  for (const raw of text.split("\n")) {
    if (ROLE_HEAD.test(raw)) break;
    const m = raw.match(/^- ([a-z]+):\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = stripTicks(m[2] ?? "");
    if (key === "session") meta.sessionId = value;
    else if (key === "title" && value !== "") meta.title = value;
    else if (key === "model" && value !== "") meta.model = value;
    else if (key === "started" && value !== "") meta.startedAt = value;
  }
  return meta;
}

/**
 * Parse HZ continuous / export Markdown (`## role` sections + optional
 * `### tool call: name` lines) back into wire `ChatMsg[]`.
 * Tool-call ids/arguments are not in the file — resume synthesizes stable
 * placeholders (`md_tc_<n>`, `{}`) so the shape is valid for further turns.
 */
export function parseMarkdownTranscript(text: string): ParsedMarkdownTranscript {
  const meta = parseMarkdownTranscriptMeta(text);
  const messages: ChatMsg[] = [];
  const lines = text.split("\n");
  let i = 0;
  let toolCallSeq = 0;

  while (i < lines.length && !ROLE_HEAD.test(lines[i]!)) i += 1;

  while (i < lines.length) {
    const head = lines[i]!.match(ROLE_HEAD);
    if (!head) {
      i += 1;
      continue;
    }
    const role = head[1] as ChatMsg["role"];
    const roleExtra = head[2]?.trim();
    i += 1;

    const bodyLines: string[] = [];
    const toolCalls: ToolCall[] = [];
    while (i < lines.length && !ROLE_HEAD.test(lines[i]!)) {
      const tc = lines[i]!.match(TOOL_CALL_HEAD);
      if (tc) {
        toolCallSeq += 1;
        toolCalls.push({
          id: `md_tc_${toolCallSeq}`,
          name: tc[1]!.trim(),
          arguments: "{}",
        });
        i += 1;
        continue;
      }
      bodyLines.push(lines[i]!);
      i += 1;
    }

    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
      bodyLines.pop();
    }
    const content = bodyLines.join("\n");
    const msg: ChatMsg = { role, content };
    if (role === "tool" && roleExtra) msg.toolName = roleExtra;
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
    messages.push(msg);
  }

  return { meta, messages };
}

export interface ResumeFromMarkdownTranscriptResult {
  ok: boolean;
  path: string;
  messages: ChatMsg[];
  meta: MarkdownTranscriptMeta;
  sectionCount: number;
  missing?: boolean;
  error?: string;
}

/**
 * Load `<state>/transcripts/<sessionId>.md` (or `path`) into `ChatMsg[]` for
 * resume / post-mortem. Optionally seeds the sync cursor so a later
 * `syncMarkdownTranscript` append does not duplicate restored messages.
 * Does not mutate the session store or `/export` paths.
 */
export function resumeMessagesFromMarkdownTranscript(opts: {
  workspace: string;
  sessionId: string;
  path?: string;
  seedCursor?: boolean;
}): ResumeFromMarkdownTranscriptResult {
  const file = opts.path ?? markdownTranscriptPath(opts.workspace, opts.sessionId);
  if (!existsSync(file)) {
    return {
      ok: false,
      path: file,
      messages: [],
      meta: { sessionId: opts.sessionId },
      sectionCount: 0,
      missing: true,
      error: "markdown transcript not found",
    };
  }
  try {
    const text = readFileSync(file, "utf8");
    const parsed = parseMarkdownTranscript(text);
    const meta: MarkdownTranscriptMeta = {
      sessionId: parsed.meta.sessionId || opts.sessionId,
      title: parsed.meta.title,
      model: parsed.meta.model,
      startedAt: parsed.meta.startedAt,
    };
    if (opts.seedCursor !== false) {
      seedMarkdownTranscriptCursor(opts.workspace, opts.sessionId, parsed.messages.length);
    }
    return {
      ok: true,
      path: file,
      messages: parsed.messages,
      meta,
      sectionCount: parsed.messages.length,
    };
  } catch (err) {
    return {
      ok: false,
      path: file,
      messages: [],
      meta: { sessionId: opts.sessionId },
      sectionCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatMarkdownMessage(msg: ChatMsg): string {
  const role = msg.role ?? "user";
  const who =
    role === "tool" ? `tool${msg.toolName ? ` ${msg.toolName}` : ""}` : role;
  const lines: string[] = [`## ${who}`];
  const body = typeof msg.content === "string" ? msg.content : "";
  if (body.trim() !== "") lines.push(body.trimEnd());
  for (const call of msg.toolCalls ?? []) {
    lines.push(`### tool call: ${call.name}`);
  }
  lines.push("");
  return maskSecrets(lines.join("\n"));
}

export function formatMarkdownMessages(messages: readonly ChatMsg[]): string {
  return messages.map(formatMarkdownMessage).join("");
}

export function formatMarkdownTranscriptHeader(meta: MarkdownTranscriptMeta): string {
  const lines = [
    "# Chat transcript",
    "",
    `- session: \`${meta.sessionId}\``,
  ];
  if (meta.title) lines.push(`- title: ${maskSecrets(meta.title)}`);
  if (meta.model) lines.push(`- model: \`${maskSecrets(meta.model)}\``);
  lines.push(`- started: ${meta.startedAt ?? new Date().toISOString()}`, "");
  return lines.join("\n");
}

export interface SyncMarkdownTranscriptResult {
  attempted: boolean;
  written: boolean;
  path: string;
  appended: number;
  created: boolean;
  error?: string;
}

/**
 * Mirror `history` into the continuous Markdown file. Creates the file with a
 * header + full history on first write; thereafter appends only unseen messages
 * (cursor from memory, or section count on disk after restart).
 */
export function syncMarkdownTranscript(opts: {
  workspace: string;
  sessionId: string;
  history: readonly ChatMsg[];
  meta?: Omit<MarkdownTranscriptMeta, "sessionId">;
  env?: Record<string, string | undefined>;
}): SyncMarkdownTranscriptResult {
  const file = markdownTranscriptPath(opts.workspace, opts.sessionId);
  const env = opts.env ?? process.env;
  if (!markdownTranscriptEnabled(env)) {
    return { attempted: false, written: false, path: file, appended: 0, created: false };
  }

  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const key = markdownTranscriptCursorKey(opts.workspace, opts.sessionId);
    const exists = existsSync(file);
    let from = cursors.get(key);
    if (from === undefined) {
      if (exists) {
        from = countMarkdownMessageSections(readFileSync(file, "utf8"));
      } else {
        from = 0;
      }
    }

    // Clamp: truncation / rewind can shrink history.
    if (from > opts.history.length) from = opts.history.length;

    if (!exists) {
      const header = formatMarkdownTranscriptHeader({
        sessionId: opts.sessionId,
        title: opts.meta?.title,
        model: opts.meta?.model,
        startedAt: opts.meta?.startedAt,
      });
      const body = formatMarkdownMessages(opts.history);
      writeFileSync(file, header + body, { mode: 0o600 });
      cursors.set(key, opts.history.length);
      return {
        attempted: true,
        written: true,
        path: file,
        appended: opts.history.length,
        created: true,
      };
    }

    const slice = opts.history.slice(from);
    if (slice.length === 0) {
      cursors.set(key, opts.history.length);
      return { attempted: true, written: false, path: file, appended: 0, created: false };
    }
    appendFileSync(file, formatMarkdownMessages(slice), { mode: 0o600 });
    cursors.set(key, opts.history.length);
    return {
      attempted: true,
      written: true,
      path: file,
      appended: slice.length,
      created: false,
    };
  } catch (err) {
    return {
      attempted: true,
      written: false,
      path: file,
      appended: 0,
      created: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
