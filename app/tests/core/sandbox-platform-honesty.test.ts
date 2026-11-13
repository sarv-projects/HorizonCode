import { describe, expect, test } from "bun:test";
import { sandboxPlatformHonesty } from "../../src/core/sandbox-platform-honesty";

describe("sandbox platform honesty", () => {
  test("never claims Seatbelt or macOS child_net enforced on Linux", () => {
    const h = sandboxPlatformHonesty();
    expect(h.detail.toLowerCase()).toContain("seatbelt");
    expect(h.detail.toLowerCase()).not.toMatch(/\b(is|are) enforced\b/);
    const notes = h.platformNotes.join(" ").toLowerCase();
    expect(notes).toContain("seatbelt");
    expect(notes).toContain("never reported as enforced");
  });
});
