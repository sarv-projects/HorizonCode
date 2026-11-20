/**
 * ChatMsg multimodal content helpers (additive string | ContentPart[]).
 *
 * Pure conversions for storage, token estimates, and provider wire shapes.
 */

import type { ChatContentPart, ChatMsg, ChatMsgContent } from "../contracts";

/** Flatten text parts; string content passes through unchanged. */
export function chatContentText(content: ChatMsgContent | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ChatContentPart, { type: "text" }> => p?.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** @deprecated Alias for `chatContentText` — prefer the canonical name in new code. */
export const textFromChatContent = chatContentText;

/** True when content is a multipart array containing an image part. */
export function chatContentHasImage(content: ChatMsgContent | undefined): boolean {
  if (content === undefined || typeof content === "string") return false;
  return content.some(
    (p) => p?.type === "image" || p?.type === "image_url",
  );
}

export function isMultipartContent(content: ChatMsgContent | undefined): content is ChatContentPart[] {
  return Array.isArray(content);
}

/** Text-only fallback when the active model cannot accept images (ruling **731**). */
export function stripImagesFromChatContent(content: ChatMsgContent | undefined): ChatMsgContent {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const text = chatContentText(content);
  return text !== "" ? text : "";
}

export function stripImagesFromHistory(messages: readonly ChatMsg[]): ChatMsg[] {
  return messages.map((msg) =>
    chatContentHasImage(msg.content) ? { ...msg, content: stripImagesFromChatContent(msg.content) } : msg,
  );
}

/** SQLite `content` column value plus optional parts stored in message meta. */
export function contentForStorage(content: ChatMsgContent | undefined): {
  storedText: string;
  parts?: ChatContentPart[];
} {
  if (content === undefined) return { storedText: "" };
  if (typeof content === "string") return { storedText: content };
  return { storedText: textFromChatContent(content), parts: content };
}

export function contentFromStorage(storedText: string | null, parts: ChatContentPart[] | undefined): ChatMsgContent {
  if (parts !== undefined && parts.length > 0) return parts;
  return storedText ?? "";
}

function openAiImageFromPart(part: Extract<ChatContentPart, { type: "image" }>): Record<string, unknown> | undefined {
  if (typeof part.base64 === "string" && part.base64 !== "") {
    const media = part.media_type && part.media_type !== "" ? part.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${media};base64,${part.base64}` } };
  }
  if (typeof part.path === "string" && part.path !== "") {
    return { type: "image_url", image_url: { url: `file://${part.path}` } };
  }
  return undefined;
}

/** OpenAI chat `content` field from `ChatMsgContent`. */
export function wireOpenAiContent(content: ChatMsgContent | undefined): string | Array<Record<string, unknown>> {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text") {
      if (part.text !== "") out.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
      out.push({ type: "image_url", image_url: { url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) } });
      continue;
    }
    if (part.type === "image") {
      const mapped = openAiImageFromPart(part);
      if (mapped) out.push(mapped);
    }
  }
  if (out.length === 0) return "";
  if (out.length === 1 && out[0]!.type === "text") return (out[0] as { type: "text"; text: string }).text;
  return out;
}

function anthropicBlockFromPart(
  part: ChatContentPart,
): { type: "text"; text: string } | { type: "image"; source: Record<string, unknown> } | undefined {
  if (part.type === "text") {
    if (part.text === "") return undefined;
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url") {
    const url = part.image_url.url;
    if (url.startsWith("data:")) {
      const m = /^data:([^;,]+);base64,(.+)$/i.exec(url);
      if (m) {
        return {
          type: "image",
          source: { type: "base64", media_type: m[1] ?? "image/png", data: m[2] ?? "" },
        };
      }
    }
    return { type: "image", source: { type: "url", url } };
  }
  if (part.type === "image") {
    if (typeof part.base64 === "string" && part.base64 !== "") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.media_type && part.media_type !== "" ? part.media_type : "image/png",
          data: part.base64,
        },
      };
    }
    if (typeof part.path === "string" && part.path !== "") {
      return { type: "image", source: { type: "url", url: `file://${part.path}` } };
    }
  }
  return undefined;
}

/** Anthropic user/assistant text+image blocks from `ChatMsgContent`. */
export function wireAnthropicContentBlocks(
  content: ChatMsgContent | undefined,
): Array<{ type: "text"; text: string } | { type: "image"; source: Record<string, unknown> }> {
  if (content === undefined) return [];
  if (typeof content === "string") {
    return content !== "" ? [{ type: "text", text: content }] : [];
  }
  const blocks: Array<{ type: "text"; text: string } | { type: "image"; source: Record<string, unknown> }> = [];
  for (const part of content) {
    const block = anthropicBlockFromPart(part);
    if (block) blocks.push(block);
  }
  return blocks;
}

type AnthropicToolResultContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; source: Record<string, unknown> }>;

/** Anthropic `tool_result.content` — string default, multipart when images present. */
export function wireAnthropicToolResultContent(content: ChatMsgContent | undefined): AnthropicToolResultContent {
  if (content === undefined || typeof content === "string") {
    if (typeof content === "string" && content !== "") return content;
    return "";
  }
  if (!chatContentHasImage(content)) {
    const text = chatContentText(content);
    return text !== "" ? text : "";
  }
  const blocks = wireAnthropicContentBlocks(content);
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0]!.type === "text") return blocks[0]!.text;
  return blocks;
}

/** OpenAI tool message `content` — string default, multipart array when images present. */
export function wireOpenAiToolResultContent(
  content: ChatMsgContent | undefined,
): string | Array<Record<string, unknown>> {
  if (content === undefined || typeof content === "string") {
    if (typeof content === "string" && content !== "") return content;
    return "";
  }
  if (!chatContentHasImage(content)) {
    const text = chatContentText(content);
    return text !== "" ? text : "";
  }
  const wired = wireOpenAiContent(content);
  if (typeof wired === "string") return wired !== "" ? wired : "";
  return wired.length > 0 ? wired : "";
}