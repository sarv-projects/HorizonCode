import { describe, expect, test } from "bun:test";
import type { ChatMsg } from "../../src/contracts";
import { extractBase64Images, googlePartFromPart, wireGoogleParts } from "../../src/core/chat-content";
import { toGoogleContents } from "../../src/core/providers/google";
import { toOllamaMessages } from "../../src/core/providers/ollama";

describe("multimodal-multipart-formatter (Ruling 872)", () => {
  const sampleBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  describe("Google Gemini multimodal formatting", () => {
    test("googlePartFromPart handles text, base64 data URIs, and raw image parts", () => {
      const textPart = googlePartFromPart({ type: "text", text: "Explain diagram" });
      expect(textPart).toEqual({ text: "Explain diagram" });

      const dataUriPart = googlePartFromPart({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${sampleBase64}` },
      });
      expect(dataUriPart).toEqual({
        inlineData: { mimeType: "image/png", data: sampleBase64 },
      });

      const rawImagePart = googlePartFromPart({
        type: "image",
        media_type: "image/jpeg",
        base64: sampleBase64,
      });
      expect(rawImagePart).toEqual({
        inlineData: { mimeType: "image/jpeg", data: sampleBase64 },
      });

      // Non-data URLs cannot be read inline; should return undefined
      const httpUrlPart = googlePartFromPart({
        type: "image_url",
        image_url: { url: "https://example.com/pic.png" },
      });
      expect(httpUrlPart).toBeUndefined();
    });

    test("toGoogleContents wires multipart user turn into Gemini parts", () => {
      const messages: ChatMsg[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this architecture" },
            { type: "image", media_type: "image/webp", base64: sampleBase64 },
          ],
        },
      ];

      const contents = toGoogleContents(messages);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe("user");
      expect(contents[0]!.parts).toEqual([
        { text: "Look at this architecture" },
        { inlineData: { mimeType: "image/webp", data: sampleBase64 } },
      ]);
    });

    test("toGoogleContents merges consecutive user messages including images", () => {
      const messages: ChatMsg[] = [
        { role: "user", content: "First instruction" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/gif;base64,${sampleBase64}` } },
          ],
        },
      ];

      const contents = toGoogleContents(messages);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe("user");
      expect(contents[0]!.parts).toHaveLength(2);
      expect(contents[0]!.parts[0]).toEqual({ text: "First instruction" });
      expect(contents[0]!.parts[1]).toEqual({ inlineData: { mimeType: "image/gif", data: sampleBase64 } });
    });
  });

  describe("Ollama multimodal formatting", () => {
    test("extractBase64Images extracts images from image and data-uri image_url parts", () => {
      const parts = [
        { type: "text" as const, text: "Some prompt" },
        { type: "image" as const, base64: "IMG1_BASE64" },
        { type: "image_url" as const, image_url: { url: "data:image/jpeg;base64,IMG2_BASE64" } },
        { type: "image_url" as const, image_url: { url: "https://remote.com/img.jpg" } },
      ];

      const extracted = extractBase64Images(parts);
      expect(extracted).toEqual(["IMG1_BASE64", "IMG2_BASE64"]);
    });

    test("toOllamaMessages attaches images array only when images exist", () => {
      const messages: ChatMsg[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Plain text question" },
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", base64: sampleBase64 },
          ],
        },
      ];

      const ollamaMsgs = toOllamaMessages(messages);
      expect(ollamaMsgs).toHaveLength(3);

      // System message has no images
      expect(ollamaMsgs[0]!.images).toBeUndefined();

      // Plain user message has no images
      expect(ollamaMsgs[1]!.images).toBeUndefined();

      // Multimodal user message has images attached
      expect(ollamaMsgs[2]!.content).toBe("What is this?");
      expect(ollamaMsgs[2]!.images).toEqual([sampleBase64]);
    });
  });
});
