import { describe, expect, test } from "bun:test";
import { copyAssistantFromHistory, copyText, isWslLinux } from "../../src/tui/clipboard";

describe("clipboard", () => {
  test("empty text refused", () => {
    expect(copyText("").ok).toBe(false);
  });

  test("OSC 52 path runs without throw", () => {
    let out = "";
    const res = copyText("hi", (c) => {
      out += c;
    });
    expect(res.ok).toBe(true);
    expect(out).toContain("\u001b]52;");
  });

  test("wsl detection helper", () => {
    expect(isWslLinux({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(process.platform === "linux");
  });

  test("copy from history notice", () => {
    const { notice } = copyAssistantFromHistory(
      [{ role: "assistant", content: "hello" }],
      () => {},
    );
    expect(notice).toContain("copied");
  });
});
