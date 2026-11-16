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

/**
 * The audit finding: the old mutation denylist allowed `rm -rf`, `git
 * checkout`, `make`, `npm install`, `find -delete` and `truncate`. Plan mode is
 * a conservative READ-ONLY allowlist now, so every one of those must be
 * refused even though the shell would accept it.
 */
describe("plan-mode shell allowlist (read-only, conservative)", () => {
  const DENIED = [
    "rm -rf src",
    "rm file.txt",
    "mv a b",
    "cp a b",
    "touch marker",
    "mkdir out",
    "truncate -s 0 f",
    "git checkout -- .",
    "git switch main",
    "git reset --hard",
    "git branch -D feature",
    "make",
    "make test",
    "npm install",
    "npm test",
    "bun install",
    "find . -name '*.ts' -delete",
    "find . -name '*.ts' -exec rm {} ;",
    "find . -name '*.ts' -execdir rm {} ;",
    "find . -maxdepth 1 -ok rm {} ;",
    "find . -fprint out.txt",
    "find . -fls out.txt",
    "sed -i 's/a/b/' f",
    "sed -Ei 's/a/b/' f",
    "sed --in-place=.bak 's/a/b/' f",
    "sed 'w /tmp/owned' f",
    "sed '1w /tmp/owned' f",
    "sed '1,$w /tmp/owned' f",
    "sed '/foo/w /tmp/owned' f",
    "sed 's/a/b/w /tmp/owned' f",
    "sed '1{e id}' f",
    "sed -f script.sed f",
    "awk 'BEGIN{system(\"touch pwned\")}'",
    "awk 'BEGIN{\"touch pwned\" | getline}'",
    "awk '{print $1 > \"/tmp/owned\"}'",
    "awk '{print $1 | \"sh\"}'",
    "awk -f script.awk f",
    "rg --pre 'sh -c id' pattern",
    "tree -o out.txt .",
    "sort -o out.txt f",
    "sort -T . f",
    "uniq in.txt out.txt",
    "file -C -m magic",
    "date -s 2020-01-01",
    "python -c 'print(1)'",
    "node -e '1'",
    "bun -e '1'",
    "sh -c 'ls'",
    "bash -c 'ls'",
    "perl -pi -e 's/a/b/' f",
    "cd src && rm -rf .",
    "ls; rm -rf .",
    "ls && rm -rf .",
    "ls & rm -rf .",
    "ls | xargs rm",
  ];

  const ALLOWED = [
    "ls -la",
    "ls -la src",
    "cat README.md",
    "head -20 file.ts",
    "tail -n 5 file.ts",
    "wc -l file.ts",
    "file file.ts",
    "stat file.ts",
    "pwd",
    "tree -L 2 src",
    "grep -rn TODO src",
    "rg TODO src",
    "find . -name '*.ts' -type f",
    "find . -maxdepth 2 -type f",
    "git status",
    "git status --porcelain",
    "git diff",
    "git diff --stat",
    "git log --oneline -5",
    "git show HEAD:README.md",
    "git rev-parse HEAD",
    "git branch --show-current",
    "git branch -a",
    "git ls-files",
    "awk '{print $1}' file.ts",
    "sed -n '1,20p' file.ts",
    "sed 's/a/b/' file.ts",
    "diff a.ts b.ts",
    "sort file.txt",
    "uniq file.txt",
    "du -sh src",
    "df -h .",
    "cd src",
    "cd src && ls -la",
    "cat f 2>&1",
    "ls > /dev/null 2>&1",
    "echo x > /tmp/hz-plan-scratch.txt",
  ];

  test("mutating commands are refused with the allowlist message", () => {
    for (const command of DENIED) {
      const reason = findPlanModeMutatingCommand(command);
      expect(reason, `expected refusal for: ${command}`).toBeDefined();
    }
    const msg = planModeShellRefusal("rm -rf src");
    expect(msg).toContain("plan mode: shell refused");
    expect(msg).toContain("not a read-only command");
  });

  test("read-only investigation commands stay allowed", () => {
    for (const command of ALLOWED) {
      expect(findPlanModeMutatingCommand(command), `expected allow for: ${command}`).toBeUndefined();
    }
  });

  test("newlines, backgrounding and quoted command names cannot smuggle a command", () => {
    expect(findPlanModeMutatingCommand("ls # comment\nrm -rf src")).toContain("multi-line");
    expect(findPlanModeMutatingCommand("ls\rrm -rf src")).toContain("multi-line");
    expect(findPlanModeMutatingCommand("ls & rm -rf src")).toContain("background");
    expect(findPlanModeMutatingCommand('"ls"')).toContain("empty command");
  });

  test("redirects are limited to the existing safe sinks", () => {
    expect(findPlanModeMutatingCommand("echo x > out.txt")).toContain("redirect");
    expect(findPlanModeMutatingCommand("echo x > .git/config")).toContain("redirect");
    expect(findPlanModeMutatingCommand("echo x > /tmp/../etc/passwd")).toContain("redirect");
    expect(findPlanModeMutatingCommand("echo x > /dev/null")).toBeUndefined();
    expect(findPlanModeMutatingCommand("echo x > /tmp/scratch")).toBeUndefined();
  });
});
