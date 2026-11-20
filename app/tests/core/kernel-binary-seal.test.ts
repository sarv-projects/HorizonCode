import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  assertSupervisorBinarySeal,
  assessKernelSupervisorBinary,
} from "../../src/core/kernel-binary-seal";
import { kernelBinarySealPath, readKernelBinarySeal } from "../../src/core/kernel-socket";
import { sha256File } from "../../src/core/kernel-pin";
import { tempDir } from "./helpers";
import { rustKernelPath, hasRustKernel } from "./helpers";

describe("assertSupervisorBinarySeal (ruling 710)", () => {
  test("allows absent seal and absent ping (legacy orphan)", () => {
    const dir = tempDir("hz-bin-assert-");
    mkdirSync(dir, { recursive: true });
    expect(() => assertSupervisorBinarySeal(dir, "a".repeat(64), undefined)).not.toThrow();
  });

  test("refuses client/disk mismatch with named error", () => {
    const dir = tempDir("hz-bin-assert2-");
    mkdirSync(dir, { recursive: true });
    const seal = "c".repeat(64);
    writeFileSync(kernelBinarySealPath(dir), `${seal}\n`);
    expect(() => assertSupervisorBinarySeal(dir, "d".repeat(64), seal)).toThrow(
      /supervisor\.binary mismatch/,
    );
  });

  test("readKernelBinarySeal round-trip", () => {
    const dir = tempDir("hz-bin-read-");
    mkdirSync(dir, { recursive: true });
    const seal = "e".repeat(64);
    writeFileSync(kernelBinarySealPath(dir), `${seal}\n`);
    expect(readKernelBinarySeal(dir)).toBe(seal);
  });
});

describe.skipIf(!hasRustKernel)("assessKernelSupervisorBinary doctor posture", () => {
  test("ok when detach seal matches built kernel", () => {
    const dir = tempDir("hz-bin-doc-");
    mkdirSync(dir, { recursive: true });
    const binary = rustKernelPath;
    const digest = sha256File(binary);
    writeFileSync(kernelBinarySealPath(dir), `${digest}\n`);
    const p = assessKernelSupervisorBinary({
      detachRequested: true,
      stateDir: dir,
      kernelBinary: binary,
    });
    expect(p.status).toBe("ok");
  });
});