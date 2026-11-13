import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  fullscreenRichTranscriptEnabled,
  pushTranscriptChunks,
  transcriptLinesFromRendererEvents,
} from "../../src/tui/fullscreen-transcript";
import { colorEnabled, setColorEnabled } from "../../src/tui/style";

const DIFF = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -40,4 +40,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
].join("\n");

let was = false;
beforeAll(() => {
  was = colorEnabled();
  setColorEnabled(false);
});
afterAll(() => setColorEnabled(was));

describe("fullscreen transcript", () => {
  test("rich transcript follows liveEnabled on colour TTY, independent of approval gate", () => {
    const live = () => true;
    expect(fullscreenRichTranscriptEnabled({ isTty: false }, live)).toBe(false);
    expect(fullscreenRichTranscriptEnabled({ isTty: true }, () => false)).toBe(false);
    expect(fullscreenRichTranscriptEnabled({ isTty: true }, live)).toBe(true);
  });

  test("pushTranscriptChunks merges streaming chunks and strips ANSI", () => {
    const lines: string[] = [];
    pushTranscriptChunks(lines, "\u001b[32mhello");
    pushTranscriptChunks(lines, " world\u001b[0m\nnext");
    expect(lines).toEqual(["hello world", "next"]);
  });

  test("turn.diff and tool.card previews use diff.ts gutters in rich transcript", () => {
    const rich = transcriptLinesFromRendererEvents(
      [
        { type: "turn.diff", turn: 1, files: 1, diff: DIFF },
        {
          type: "tool.card",
          callId: "e1",
          name: "edit",
          args: { path: "src/app.ts" },
          status: "ok",
          summary: "ok",
          preview: DIFF,
        },
      ],
      { rich: true, level: 0, unicode: true },
    );
    const body = rich.join("\n");
    expect(body).toContain("\u2502");
    expect(body).toContain("   41 \u2502- const b = 2;");

    const plain = transcriptLinesFromRendererEvents([{ type: "turn.diff", turn: 1, files: 1, diff: DIFF }], {
      rich: false,
      level: 0,
    });
    expect(plain.join("\n")).toContain("  -const b = 2;");
    expect(plain.join("\n")).not.toContain("\u2502");
  });
});
