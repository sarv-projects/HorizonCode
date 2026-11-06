/**
 * banner.test.ts — the four lines a session opens with.
 *
 * The banner is where the human sees which model, which workspace and which
 * kernel mode they are about to talk to, so it is worth asserting literally.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { GREETING, printBanner, printGreeting, shortenPath } from "../../src/tui/banner";
import { setColorEnabled, visibleWidth } from "../../src/tui/style";

beforeAll(() => {
  setColorEnabled(false);
});

function captured() {
  const chunks: string[] = [];
  return {
    out: (chunk: string) => void chunks.push(chunk),
    text: () => chunks.join(""),
  };
}

describe("printBanner", () => {
  test("names the version, model, provider, workspace and kernel mode", () => {
    const c = captured();

    printBanner(
      { version: "0.1.0", model: "mock-1", provider: "mock", workspace: "/tmp/hzcode-ws", kernel: "trusted" },
      { out: c.out, width: 80 },
    );

    expect(c.text()).toBe(
      ["HzCode v0.1", "model mock-1 \u00b7 provider mock", "workspace /tmp/hzcode-ws", "kernel trusted"].join("\n") + "\n",
    );
  });

  test("shows the fallback kernel mode when the Rust kernel is absent", () => {
    const c = captured();

    printBanner(
      { version: "0.1.0", model: "mock-1", provider: "mock", workspace: "/tmp/hzcode-ws", kernel: "untrusted" },
      { out: c.out, width: 80 },
    );

    expect(c.text()).toContain("kernel untrusted");
  });

  test("wraps a deep workspace path instead of overflowing the terminal", () => {
    const c = captured();
    const workspace = "/tmp/" + Array.from({ length: 12 }, (_, i) => `folder-${i}`).join("/");

    printBanner(
      { version: "0.1.0", model: "mock-1", provider: "mock", workspace, kernel: "trusted" },
      { out: c.out, width: 30 },
    );

    const lines = c.text().split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    // every piece of the path is still on screen
    expect(lines.join("").replace(/[^\w/.-]/g, "")).toContain("folder-11");
  });

  test("never emits an escape sequence once colour is off", () => {
    const c = captured();

    printBanner(
      { version: "0.1.0", model: "mock-1", provider: "mock", workspace: "/tmp/hzcode-ws", kernel: "trusted" },
      { out: c.out, width: 80 },
    );

    expect(c.text()).not.toContain("\u001b");
  });
});

describe("printGreeting", () => {
  test("prints the one-line hint under the banner", () => {
    const c = captured();

    printGreeting({ out: c.out });

    expect(c.text()).toBe(GREETING + "\n");
    expect(c.text()).toContain("/help");
  });
});

describe("shortenPath", () => {
  test("leaves a path outside the home directory alone", () => {
    expect(shortenPath("/tmp/hzcode-ws")).toBe("/tmp/hzcode-ws");
  });

  test("keeps the abbreviated form short", () => {
    // ~ only for the home directory itself or something under it
    const home = process.env.HOME;
    if (home) {
      expect(shortenPath(home)).toBe("~");
      expect(shortenPath(`${home}/work`)).toBe("~/work");
    }
  });
});
