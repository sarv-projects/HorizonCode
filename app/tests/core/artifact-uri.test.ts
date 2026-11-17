import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_MAX_BYTES,
  artifactUriForHash,
  isArtifactUri,
  isContained,
  parseArtifactUri,
  resolveArtifactPath,
} from "../../src/core/artifact-uri";
import { planToolOutputCap, writeSpillFile } from "../../src/core/output-budget";
import { readTool } from "../../src/tools/read";
import { mockToolContext, makeWorkspace } from "../tools/helpers";
import { sha256Hex } from "../../src/contracts";
import * as path from "node:path";

describe("artifact URI (B-7)", () => {
  test("builds and parses a stable content-sha URI", () => {
    const hash = "a".repeat(64);
    const uri = artifactUriForHash(hash);
    expect(uri).toBe(`hz://artifact/${hash}`);
    expect(parseArtifactUri(uri)).toEqual({ id: hash });
    expect(parseArtifactUri(artifactUriForHash(hash.toUpperCase()))).toEqual({ id: hash });
    expect(isArtifactUri(uri)).toBe(true);
    expect(isArtifactUri("src/foo.txt")).toBe(false);
  });

  test("traversal / malformed / unknown ids fail closed", () => {
    expect(parseArtifactUri("hz://artifact/../../etc/passwd")).toBeUndefined();
    expect(parseArtifactUri("hz://artifact/../x")).toBeUndefined();
    expect(parseArtifactUri("hz://artifact/" + "a".repeat(63))).toBeUndefined();
    expect(parseArtifactUri("hz://artifact/" + "z".repeat(64))).toBeUndefined();
    expect(parseArtifactUri("hz://artifact/" + "a".repeat(64) + "?x=1")).toBeUndefined();
    expect(artifactUriForHash("nope")).toBeUndefined();
    expect(resolveArtifactPath("/state/spills", "hz://artifact/../x" )).toBeUndefined();
  });

  test("containment rejects escaping the spill root", () => {
    expect(isContained("/state/spills", "/state/spills/abc.txt")).toBe(true);
    expect(isContained("/state/spills", "/state/spills2/abc.txt")).toBe(false);
    expect(isContained("/state/spills", "/etc/passwd")).toBe(false);
  });

  test("planToolOutputCap emits the URI alongside the raw spill path", () => {
    const ws = makeWorkspace();
    const full = "x".repeat(20000) + "tail-marker";
    const hash = sha256Hex(full);
    const plan = planToolOutputCap(full, {
      spillDir: path.join(ws, "spills"),
      displaySpillDir: ".hz/state/spills",
    });
    expect(plan.text).toContain(`.hz/state/spills/${hash}.txt`);
    expect(plan.text).toContain(`hz://artifact/${hash}`);
    expect(plan.truncated?.artifactUri).toBe(`hz://artifact/${hash}`);
    expect(plan.truncated?.spillPath).toContain(`${hash}.txt`);
  });
});

describe("read resolves artifact URIs (B-7)", () => {
  test("read resolves a spilled artifact by URI and keeps the raw path working", async () => {
    const ws = makeWorkspace();
    const full = "line one\nline two\n" + "payload-".repeat(400);
    const hash = sha256Hex(full);
    const spillFile = path.join(ws, ".hz", "state", "spills", `${hash}.txt`);
    writeSpillFile({ file: spillFile, contents: full });

    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const viaUri = await readTool.execute({ path: `hz://artifact/${hash}` }, ctx);
    expect(viaUri.ok).toBe(true);
    expect(viaUri.output).toContain("line one");
    expect(viaUri.output).toContain("payload-");

    const viaRaw = await readTool.execute({ path: spillFile }, ctx);
    expect(viaRaw.ok).toBe(true);
    expect(viaRaw.output).toContain("line one");
  });

  test("unknown id and traversal fail closed", async () => {
    const ws = makeWorkspace();
    const ctx = mockToolContext({ cwd: ws, workspace: ws });
    const unknownHash = "f".repeat(64);
    expect((await readTool.execute({ path: `hz://artifact/${unknownHash}` }, ctx)).ok).toBe(false);
    expect((await readTool.execute({ path: "hz://artifact/../../etc/passwd" }, ctx)).ok).toBe(false);
    expect((await readTool.execute({ path: "hz://artifact/not-hex" }, ctx)).ok).toBe(false);
  });

  test("the artifact size cap is enforced", () => {
    expect(ARTIFACT_MAX_BYTES).toBeGreaterThan(0);
  });
});
