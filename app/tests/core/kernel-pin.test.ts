/**
 * kernel-pin.test.ts — existence is not authenticity.
 *
 * The Rust kernel becomes the trust boundary, so the exact bytes that will be
 * spawned are hashed and compared with HZ_KERNEL_SHA256 (explicit) or the
 * repository manifest `kernel/kernel.sha256`. A mismatch/require-without-pin
 * must refuse to start the binary and must never send the client looking for a
 * different build to launch instead.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { checkKernel, type DoctorEnv } from "../../src/core/doctor";
import { KernelClient } from "../../src/core/kernel";
import {
  kernelPinManifestPath,
  parseKernelPinManifest,
  parseKernelPinMode,
  sha256File,
  verifyKernelPin,
} from "../../src/core/kernel-pin";
import {
  hasRustKernel,
  rustKernelPath,
  tempDir,
} from "./helpers";

const saved: Array<[string, string | undefined]> = [];
for (const key of ["HZ_KERNEL_BIN", "HZ_KERNEL_SHA256", "HZ_KERNEL_PIN"]) saved.push([key, process.env[key]]);

beforeAll(() => {
  delete process.env.HZ_KERNEL_BIN;
  delete process.env.HZ_KERNEL_SHA256;
  delete process.env.HZ_KERNEL_PIN;
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  delete process.env.HZ_KERNEL_SHA256;
  delete process.env.HZ_KERNEL_PIN;
});

/** A real file (not necessarily a runnable kernel) with a known digest. */
function fakeBinary(name = "hz-kernel"): { binary: string; digest: string } {
  const dir = tempDir("hz-pin-bin-");
  const binary = path.join(dir, name);
  writeFileSync(binary, `#!/bin/sh\necho fake-kernel\n`, "utf8");
  chmodSync(binary, 0o755);
  return { binary, digest: createHash("sha256").update(readFileSync(binary)).digest("hex") };
}

function manifestFile(text: string): string {
  const file = path.join(tempDir("hz-pin-manifest-"), "kernel.sha256");
  writeFileSync(file, text, "utf8");
  return file;
}

function missingManifest(): string {
  return path.join(tempDir("hz-pin-absent-"), "kernel.sha256");
}

test("parses sha256sum-style manifests and explicit modes", () => {
  expect(parseKernelPinManifest(`${"a".repeat(64)}  hz-kernel\n`)).toEqual({ digest: "a".repeat(64), filename: "hz-kernel" });
  expect(parseKernelPinManifest(`# pinned\n\n${"b".repeat(64)} *hz-kernel\n`)).toEqual({ digest: "b".repeat(64), filename: "hz-kernel" });
  expect(parseKernelPinManifest(`${"c".repeat(64)}\n`)).toEqual({ digest: "c".repeat(64) });
  expect(parseKernelPinManifest("not-a-digest\n")).toBeUndefined();
  expect(parseKernelPinManifest("# only comments\n")).toBeUndefined();

  expect(parseKernelPinMode(undefined)).toEqual({ mode: "auto" });
  expect(parseKernelPinMode(" REQUIRE ")).toEqual({ mode: "require" });
  expect(parseKernelPinMode("off")).toEqual({ mode: "off" });
  // A typo must fail closed, not silently downgrade to auto.
  expect(parseKernelPinMode("requrie")).toEqual({ mode: "require", invalid: "requrie" });
});

test("auto mode starts unverified when no pin exists", () => {
  const { binary, digest } = fakeBinary();
  const pin = verifyKernelPin({ binary, env: {}, manifestPath: missingManifest() });
  expect(pin.ok).toBe(true);
  expect(pin.status).toBe("unverified");
  expect(pin.mode).toBe("auto");
  expect(pin.actual).toBe(digest);
  expect(pin.reason).toContain("no kernel pin");
});

test("an explicit HZ_KERNEL_SHA256 verifies the exact bytes", () => {
  const { binary, digest } = fakeBinary();
  const ok = verifyKernelPin({ binary, env: { HZ_KERNEL_SHA256: digest.toUpperCase() }, manifestPath: missingManifest() });
  expect(ok).toMatchObject({ ok: true, status: "verified", source: "env", expected: digest, actual: digest });

  const bad = verifyKernelPin({ binary, env: { HZ_KERNEL_SHA256: "0".repeat(64) }, manifestPath: missingManifest() });
  expect(bad.ok).toBe(false);
  expect(bad.status).toBe("mismatch");
  expect(bad.reason).toContain(digest);
  expect(bad.reason).toContain("0".repeat(64));
});

test("the repository manifest satisfies require only when it matches", () => {
  const { binary, digest } = fakeBinary();
  const manifest = manifestFile(`${digest}  hz-kernel\n`);
  const ok = verifyKernelPin({ binary, env: { HZ_KERNEL_PIN: "require" }, manifestPath: manifest });
  expect(ok.ok).toBe(true);
  expect(ok.status).toBe("verified");
  expect(ok.source).toBe("manifest");
  expect(ok.manifest).toBe(manifest);

  const wrong = verifyKernelPin({
    binary,
    env: { HZ_KERNEL_PIN: "require" },
    manifestPath: manifestFile(`${"f".repeat(64)}  hz-kernel\n`),
  });
  expect(wrong.ok).toBe(false);
  expect(wrong.status).toBe("mismatch");
});

test("require with no pin is a refusal, not a downgrade", () => {
  const { binary } = fakeBinary();
  const pin = verifyKernelPin({ binary, env: { HZ_KERNEL_PIN: "require" }, manifestPath: missingManifest() });
  expect(pin.ok).toBe(false);
  expect(pin.status).toBe("missing-required");
  expect(pin.reason).toContain("HZ_KERNEL_PIN=require");
  expect(pin.reason).toContain("kernel.sha256");
});

test("off is an explicit, reported downgrade", () => {
  const { binary, digest } = fakeBinary();
  const pin = verifyKernelPin({
    binary,
    env: { HZ_KERNEL_PIN: "off", HZ_KERNEL_SHA256: "0".repeat(64) },
    manifestPath: missingManifest(),
  });
  expect(pin.ok).toBe(true);
  expect(pin.status).toBe("disabled");
  expect(pin.actual).toBe(digest);
});

test("malformed pins are refusals (unreadable is not absent)", () => {
  const { binary } = fakeBinary();
  const badEnv = verifyKernelPin({ binary, env: { HZ_KERNEL_SHA256: "xyz" }, manifestPath: missingManifest() });
  expect(badEnv.ok).toBe(false);
  expect(badEnv.status).toBe("invalid");

  const badManifest = verifyKernelPin({ binary, env: {}, manifestPath: manifestFile("not a digest\n") });
  expect(badManifest.ok).toBe(false);
  expect(badManifest.status).toBe("invalid");

  const wrongName = verifyKernelPin({
    binary,
    env: {},
    manifestPath: manifestFile(`${"a".repeat(64)}  hz-kernel-debug\n`),
  });
  expect(wrongName.ok).toBe(false);
  expect(wrongName.status).toBe("mismatch");
});

test("the default manifest path is repository data under kernel/", () => {
  expect(kernelPinManifestPath("/repo")).toBe(path.join("/repo", "kernel", "kernel.sha256"));
});

test("KernelClient refuses a mismatched binary before spawning it", async () => {  const { binary, digest } = fakeBinary("hz-kernel");
  const workspace = tempDir("hz-pin-ws-");
  const stateDir = path.join(tempDir("hz-pin-state-"), "kernel");
  const client = new KernelClient({
    workspace,
    stateDir,
    pinEnv: { HZ_KERNEL_BIN: binary, HZ_KERNEL_PIN: "require", HZ_KERNEL_SHA256: "0".repeat(64) },
    pinManifestPath: missingManifest(),
  });
  try {
    expect(await client.start()).toBe("untrusted");
    expect(client.mode).toBe("untrusted");
    // Never spawned, and never retargeted at the release/debug builds.
    expect(client.binary).toBeUndefined();
    expect(client.modeReason).toContain("refused by the pin check");
    expect(client.modeReason).toContain("no other kernel binary will be tried");
    expect(client.modeReason).toContain(binary);
    expect(client.pin?.status).toBe("mismatch");
    expect(client.pin?.expected).toBe("0".repeat(64));
    expect(client.pin?.actual).toBe(digest);

    // The local fallback is still usable (as UNTRUSTED; createRuntime narrows it).
    const event = await client.appendEvent("session:pin", {
      id: "pin-1",
      ts: new Date().toISOString(),
      stream: "session:pin",
      type: "session.start",
      actor: { kind: "system", id: "test" },
      payload: {},
    });
    expect(event.seq).toBe(1);
  } finally {
    await client.close();
  }
});

test.skipIf(!hasRustKernel)("a mismatched repository build is refused, not replaced by debug/release", async () => {
  const workspace = tempDir("hz-pin-ws-repo-");
  const stateDir = path.join(tempDir("hz-pin-state-repo-"), "kernel");
  const client = new KernelClient({
    workspace,
    stateDir,
    pinEnv: { HZ_KERNEL_PIN: "require" },
    pinManifestPath: manifestFile(`${"0".repeat(64)}  hz-kernel\n`),
  });
  try {
    expect(await client.start()).toBe("untrusted");
    expect(client.binary).toBeUndefined();
    expect(client.modeReason).toContain("refused by the pin check");
    expect(client.pin?.status).toBe("mismatch");
    // The resolution path would have found another build; the pin refusal must
    // stop there rather than start it.
    expect(client.modeReason).toContain(rustKernelPath);
  } finally {
    await client.close();
  }
});

test.skipIf(!hasRustKernel)("a correct require pin starts the real kernel and says it verified", async () => {
  const workspace = tempDir("hz-pin-ws-good-");
  const stateDir = path.join(tempDir("hz-pin-state-good-"), "kernel");
  const manifest = manifestFile(`${sha256File(rustKernelPath)}  hz-kernel\n`);
  const client = new KernelClient({
    workspace,
    stateDir,
    pinEnv: { HZ_KERNEL_BIN: rustKernelPath, HZ_KERNEL_PIN: "require" },
    pinManifestPath: manifest,
  });
  try {
    expect(await client.start()).toBe("trusted");
    expect(client.binary).toBe(rustKernelPath);
    expect(client.pin?.status).toBe("verified");
    expect(client.modeReason).toContain("sha256 verified");
  } finally {
    await client.close();
  }
});

function doctorEnv(binary: string, env: Record<string, string | undefined>, manifest: string, allowUntrusted = false): DoctorEnv {
  return {
    env,
    workspace: tempDir("hz-pin-doc-ws-"),
    home: tempDir("hz-pin-doc-home-"),
    bunVersion: "1.4.2",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    run: () => {
      throw new Error("doctor must not execute a binary whose pin failed");
    },
    kernelBinary: binary,
    kernelPinManifest: manifest,
    allowUntrusted,
  };
}

test("doctor shows path + sha256 and FAILs when require is unmet", () => {
  const { binary, digest } = fakeBinary();
  const checks = checkKernel(doctorEnv(binary, { HZ_KERNEL_PIN: "require" }, manifestFile(`${"0".repeat(64)}  hz-kernel\n`)));
  const binaryCheck = checks.find((c) => c.id === "kernel.binary");
  expect(binaryCheck?.status).toBe("ok");
  expect(binaryCheck?.detail).toContain(binary);
  expect(binaryCheck?.detail).toContain(digest);

  expect(checks.find((c) => c.id === "kernel.pin")?.status).toBe("fail");
  expect(checks.find((c) => c.id === "kernel.selftest")?.detail).toContain("not run");
  const mode = checks.find((c) => c.id === "kernel.mode");
  expect(mode?.status).toBe("warn");
  expect(mode?.detail).toContain("READ-ONLY");
  expect(mode?.hint).toContain("fix kernel.pin");
});

test("doctor reports the explicit --allow-untrusted posture", () => {
  const { binary } = fakeBinary();
  const checks = checkKernel(
    doctorEnv(binary, { HZ_KERNEL_PIN: "require" }, missingManifest(), true),
  );
  const mode = checks.find((c) => c.id === "kernel.mode");
  expect(mode?.status).toBe("warn");
  expect(mode?.detail).toContain("--allow-untrusted");
  expect(mode?.detail).toContain("not forced read-only");
});

test("doctor warns (not fails) for auto-with-no-pin, and verifies a good manifest", () => {
  const { binary, digest } = fakeBinary();
  const unverified = checkKernel(doctorEnv(binary, {}, missingManifest()));
  expect(unverified.find((c) => c.id === "kernel.pin")?.status).toBe("warn");

  const env: DoctorEnv = {
    ...doctorEnv(binary, { HZ_KERNEL_PIN: "require" }, manifestFile(`${digest}  hz-kernel\n`)),
    run: () => ({ ok: true, status: 0, stdout: "selftest ok\n", stderr: "" }),
  };
  const verified = checkKernel(env);
  expect(verified.find((c) => c.id === "kernel.pin")?.status).toBe("ok");
  expect(verified.find((c) => c.id === "kernel.mode")?.status).toBe("ok");
  expect(verified.find((c) => c.id === "kernel.mode")?.detail).toContain("trusted");
});

test("a fake binary's manifest can be produced by sha256File itself", () => {
  const { binary, digest } = fakeBinary();
  expect(sha256File(binary)).toBe(digest);
  const manifest = manifestFile(`${sha256File(binary)}  ${path.basename(binary)}\n`);
  expect(existsSync(manifest)).toBe(true);
  expect(verifyKernelPin({ binary, env: {}, manifestPath: manifest }).status).toBe("verified");
});
