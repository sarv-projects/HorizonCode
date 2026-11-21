import { describe, expect, it } from "bun:test";
import { runInteractiveCommandPalette } from "../../src/tui/interactive-command-palette";
import { Readable, Writable } from "node:stream";

describe("interactive-command-palette (stolen from opencode command-palette.tsx)", () => {
  it("selects a command by numerical index", async () => {
    const stdin = Readable.from(["1\n"]); // Select first command (/help)
    let out = "";
    const stdout = new Writable({
      write(chunk, _, cb) {
        out += chunk.toString();
        cb();
      },
    });

    const chosen = await runInteractiveCommandPalette([], { stdin, stdout });
    expect(chosen).toBe("/help");
  });

  it("selects a command by partial prefix name", async () => {
    const stdin = Readable.from(["mode\n"]);
    const stdout = new Writable({
      write(_, __, cb) {
        cb();
      },
    });

    const chosen = await runInteractiveCommandPalette([], { stdin, stdout });
    expect(chosen).toBe("/mode");
  });

  it("returns null on 0 or cancel", async () => {
    const stdin = Readable.from(["0\n"]);
    const stdout = new Writable({
      write(_, __, cb) {
        cb();
      },
    });

    const chosen = await runInteractiveCommandPalette([], { stdin, stdout });
    expect(chosen).toBeNull();
  });
});
