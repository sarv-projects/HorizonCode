import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  findRelevantMemoryTopics,
  listMemoryTopicFiles,
  summarizeMemoryTopics,
  loadMemoryManifest,
  loadMemoryTopicBodies,
  MEMORY_MAX_LINES,
  memoryPromptSection,
  truncateEntrypointContent,
} from "../../src/core/memory/manifest";
import { stateRoot } from "../../src/core/paths";

let workspace = "";
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("MEMORY.md manifest", () => {
  test("loads from .hz/MEMORY.md", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mem-"));
    const dir = stateRoot(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "MEMORY.md"), "remember: use rg\n");
    expect(loadMemoryManifest(workspace)).toContain("use rg");
  });

  test("dual-cap truncation warns like Claude memdir", () => {
    const lines = Array.from({ length: MEMORY_MAX_LINES + 5 }, (_, i) => `- fact ${i}`).join("\n");
    const t = truncateEntrypointContent(lines);
    expect(t.wasLineTruncated).toBe(true);
    expect(t.content).toContain("WARNING");
    expect(t.content).toContain("memory/*.md");
  });

  test("topic files list and seed prompt note", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mem-topics-"));
    const dir = stateRoot(workspace);
    mkdirSync(path.join(dir, "memory"), { recursive: true });
    writeFileSync(path.join(dir, "MEMORY.md"), "- see deploy.md for deploy rules\n");
    writeFileSync(path.join(dir, "memory", "deploy.md"), "never deploy on Fridays\n");
    expect(listMemoryTopicFiles(workspace)).toEqual(["deploy.md"]);
    expect(loadMemoryTopicBodies(workspace)[0]).toContain("never deploy");
    expect(memoryPromptSection(workspace)).toContain("memory/deploy.md");
  });

  test("findRelevantMemoryTopics ranks by query overlap", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mem-rel-"));
    const dir = stateRoot(workspace);
    mkdirSync(path.join(dir, "memory"), { recursive: true });
    writeFileSync(path.join(dir, "MEMORY.md"), "- deploy rules\n");
    writeFileSync(path.join(dir, "memory", "deploy.md"), "x");
    writeFileSync(path.join(dir, "memory", "testing.md"), "x");
    expect(findRelevantMemoryTopics(workspace, "how do we deploy to prod")).toEqual(["deploy.md"]);
    expect(memoryPromptSection(workspace, "deploy prod")).toContain("Query-relevant topics");
  });

  test("prefetches topic blurbs when query matches nothing", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mem-pref-"));
    const dir = stateRoot(workspace);
    mkdirSync(path.join(dir, "memory"), { recursive: true });
    writeFileSync(path.join(dir, "MEMORY.md"), "- misc\n");
    writeFileSync(path.join(dir, "memory", "alpha.md"), "# Alpha\nfirst alpha detail");
    writeFileSync(path.join(dir, "memory", "beta.md"), "beta-only body text");
    const section = memoryPromptSection(workspace, "zzzzno-match-token");
    expect(section).toContain("Prefetched topic blurbs");
    expect(section).toContain("memory/alpha.md: Alpha");
    expect(section).toContain("beta-only body text");
  });

  test("topic picker ranks body text when filename is generic", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mem-body-"));
    const dir = stateRoot(workspace);
    mkdirSync(path.join(dir, "memory"), { recursive: true });
    writeFileSync(path.join(dir, "MEMORY.md"), "- misc notes\n");
    writeFileSync(path.join(dir, "memory", "notes.md"), "Landlock egress proxy must stay ask-gated.");
    writeFileSync(path.join(dir, "memory", "deploy.md"), "unrelated");
    expect(findRelevantMemoryTopics(workspace, "Landlock egress proxy")).toEqual(["notes.md"]);
    const section = memoryPromptSection(workspace, "Landlock egress");
    expect(section).toContain("<memory-topic-excerpts>");
    expect(section).toContain("ask-gated");
  });

  test("summarizeMemoryTopics counts files and names prefetch caps", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-mem-sum-"));
    expect(summarizeMemoryTopics(workspace)).toContain("no memory");
    const dir = stateRoot(workspace);
    mkdirSync(path.join(dir, "memory"), { recursive: true });
    writeFileSync(path.join(dir, "memory", "a.md"), "x");
    expect(summarizeMemoryTopics(workspace)).toContain("1 topic");
    expect(summarizeMemoryTopics(workspace)).toContain("prefetch");
  });
});
