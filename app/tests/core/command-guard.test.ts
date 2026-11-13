import { describe, expect, test } from "bun:test";
import { findPlanModeMutatingCommand, planModeShellRefusal } from "../../src/core/command-guard";

describe("command-guard (plan lane)", () => {
  test("allows read-only investigation commands", () => {
    expect(findPlanModeMutatingCommand("ls -la")).toBeUndefined();
    expect(findPlanModeMutatingCommand("git status")).toBeUndefined();
    expect(findPlanModeMutatingCommand("cat README.md")).toBeUndefined();
    expect(findPlanModeMutatingCommand("grep -r foo src")).toBeUndefined();
  });

  test("blocks in-place editors", () => {
    expect(findPlanModeMutatingCommand("sed -i 's/a/b/' file.txt")).toContain("sed");
    expect(findPlanModeMutatingCommand("perl -pi -e 's/a/b/' file.txt")).toContain("perl");
  });

  test("blocks redirect and tee writes", () => {
    expect(findPlanModeMutatingCommand("echo x > out.txt")).toContain("redirect");
    expect(findPlanModeMutatingCommand("tee notes.md")).toContain("tee");
    expect(findPlanModeMutatingCommand("echo x > /dev/null")).toBeUndefined();
    expect(findPlanModeMutatingCommand("echo x >> /tmp/log.txt")).toBeUndefined();
  });

  test("peels wrappers before classifying", () => {
    expect(findPlanModeMutatingCommand("sudo sed -i 's/a/b/' f")).toContain("sed");
    expect(findPlanModeMutatingCommand("env FOO=1 tee secret.txt")).toContain("tee");
    expect(findPlanModeMutatingCommand("xargs sed -i x f")).toContain("sed");
  });

  test("fail-closed on unparsed shell", () => {
    expect(findPlanModeMutatingCommand("echo $(whoami)")).toContain("unparsed");
  });

  test("planModeShellRefusal formats advisory", () => {
    const msg = planModeShellRefusal("sed -i x f");
    expect(msg).toContain("plan mode: shell refused");
    expect(planModeShellRefusal("pwd")).toBeUndefined();
  });
});
